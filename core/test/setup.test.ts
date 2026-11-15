import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// These tests run setup.sh in a temp copy of a clone, with stub tools only: nothing is installed on the machine.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const win = process.platform === 'win32';
/** The few system tools setup.sh and the launcher use, linked into the stub PATH so the real gh/claude/npm are never found. */
const SYSTEM_TOOLS = ['dirname', 'basename', 'cat', 'chmod', 'grep', 'sed', 'head', 'tr', 'uname', 'printf', 'rm', 'mkdir'];

let dir: string;
let clone: string;
let bin: string;
let log: string;

/** A stub tool that appends `<name> <args> @<cwd folder>` to the log, then runs `body`. */
function stub(name: string, body = ''): void {
  const f = join(bin, name);
  writeFileSync(f, `#!/bin/sh\necho "${name} $* @\${PWD##*/}" >> "${log}"\n${body}\n`);
  chmodSync(f, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'factory-setup-'));
  clone = join(dir, 'clone');
  bin = join(dir, 'bin');
  log = join(dir, 'log.txt');
  mkdirSync(join(clone, 'core', 'dist'), { recursive: true });
  mkdirSync(join(clone, 'plugin'), { recursive: true });
  mkdirSync(bin);
  if (win) return;
  copyFileSync(join(REPO, 'setup.sh'), join(clone, 'setup.sh'));
  chmodSync(join(clone, 'setup.sh'), 0o755);
  // The stub core/dist/cli.js logs its arguments and FACTORY_ROOT.
  writeFileSync(join(clone, 'core', 'dist', 'cli.js'),
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'cli ' + process.argv.slice(2).join(' ') + ' root=' + process.env.FACTORY_ROOT + '\\n');\n`);
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const t of SYSTEM_TOOLS) for (const d of ['/usr/bin', '/bin']) if (existsSync(join(d, t)) && !existsSync(join(bin, t))) symlinkSync(join(d, t), join(bin, t));
  stub('npm');
  stub('git');
  stub('gh');
  stub('claude', 'if [ "$1 $2" = "plugin list" ] && [ -n "$CLAUDE_HAS_PLUGIN" ]; then echo "  factory@the-software-factory"; fi\nexit 0');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs setup.sh with only the stubs on PATH. */
function setup(env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', [join(clone, 'setup.sh')], { encoding: 'utf8', cwd: dir, env: { PATH: bin, HOME: dir, ...env } });
}
const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);

describe.skipIf(win)('setup.sh', () => {
  test('first run: npm ci in core and plugin, build, launchers, plugin install, then init', () => {
    const r = setup();
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(lines()).toEqual([
      'npm ci @core', 'npm ci @plugin', 'npm run build @core',
      'claude plugin list @clone',
      `claude plugin marketplace add ${clone} @clone`,
      'claude plugin install factory@the-software-factory @clone',
      `cli init root=${clone}`,
    ]);
    expect(statSync(join(clone, 'factory')).mode & 0o111).not.toBe(0);
    expect(existsSync(join(clone, 'factory.cmd'))).toBe(true);
  });

  test('second run skips the plugin install when claude plugin list shows it', () => {
    const r = setup({ CLAUDE_HAS_PLUGIN: '1' });
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const l = lines();
    expect(l).toContain('claude plugin list @clone');
    expect(l.some((x) => x.startsWith('claude plugin marketplace add') || x.startsWith('claude plugin install'))).toBe(false);
    expect(l[l.length - 1]).toBe(`cli init root=${clone}`);
  });

  test('a missing gh stops with the install hint and exit 1', () => {
    rmSync(join(bin, 'gh'));
    const r = setup();
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('gh is missing: install it from https://cli.github.com');
    expect(lines()).toEqual([]);
  });

  test('./factory sets FACTORY_ROOT to the clone and forwards arguments', () => {
    expect(setup().status).toBe(0);
    writeFileSync(log, '');
    const r = spawnSync(join(clone, 'factory'), ['doctor', '--json'], { encoding: 'utf8', cwd: tmpdir(), env: { PATH: bin, HOME: dir, FACTORY_ROOT: '/elsewhere' } });
    expect(r.status, r.stderr).toBe(0);
    expect(lines()).toEqual([`cli doctor --json root=${clone}`]);
  });
});
