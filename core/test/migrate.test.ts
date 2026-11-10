import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { migrate, type MigrateReport } from '../src/migrate.js';
import type { ExecFile } from '../src/secrets.js';
import { FileStore, MemoryStore, type BoardStore } from '../src/store.js';

const SECRET = 'ghp_s3cr3t"value\\x';
const REPOS = join(__dirname, '..', '..', 'repos');

/** A Memory store holding the pre-factories shape: untagged tasks and `{ global, repos }` settings. */
class LegacyMemory extends MemoryStore {
  seedLegacy(): void {
    this.state.tasks.push({ taskId: 'T-1', title: 't', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', version: 1 } as never);
    this.state.settings = { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } as never;
  }
}

/** A fake `security`: a map of accounts to values, `security -i` takes add-generic-password from stdin. Never the real Keychain. */
function fakeKeychain(initial: Record<string, string>) {
  const entries = new Map(Object.entries(initial));
  const calls: { args: string[]; stdin?: string }[] = [];
  const exec: ExecFile = async (file, args, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    if (file !== 'security') throw new Error(`unexpected command ${file}`);
    if (args[0] === 'find-generic-password') {
      const v = entries.get(args[args.indexOf('-a') + 1]!);
      if (v === undefined) return { code: 44, stdout: '', stderr: '' };
      return { code: 0, stdout: args.includes('-w') ? `${v}\n` : '', stderr: '' };
    }
    if (args[0] === '-i') {
      const m = /^add-generic-password -U -s \S+ -a (\S+) -w "((?:[^"\\]|\\.)*)"\n$/.exec(stdin ?? '');
      if (!m) return { code: 1, stdout: '', stderr: '' };
      entries.set(m[1]!, m[2]!.replace(/\\(.)/g, '$1'));
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security ${args[0]}`);
  };
  return { exec, entries, calls };
}

const names = (r: MigrateReport) => r.steps.map((s) => `${s.name}:${s.done}`);
const ALL_NOW = ['create-factory:now', 'tag-tasks:now', 'move-settings:now', 'copy-pat:now', 'read-back:now', 'repos-folder:now'];
const ALL_ALREADY = ['create-factory:already', 'tag-tasks:already', 'move-settings:already', 'copy-pat:already', 'read-back:already', 'repos-folder:already'];

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'factory-migrate-'));
  home = join(root, 'home');
  cpSync(REPOS, join(root, 'repos'), { recursive: true });
});

const kinds: [string, () => BoardStore][] = [
  ['memory', () => { const s = new LegacyMemory(); s.seedLegacy(); return s; }],
  ['file', () => {
    const dir = join(root, '.factory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'board.json'), JSON.stringify({
      tasks: [{ taskId: 'T-1', title: 't', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', version: 1 }],
      events: [{ taskId: 'T-1', actor: 'you', action: 'create', field: null, from: null, to: 'inbox', reason: '', at: '2026-01-01T00:00:00.000Z' }],
      settings: { global: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } },
    }));
    return new FileStore(join(dir, 'board.json'));
  }],
];

describe.each(kinds)('migrate on a %s store', (_name, make) => {
  test('a fresh migrate runs every step now, a second run is all already', async () => {
    const store = make();
    const kc = fakeKeychain({ 'github-pat': SECRET });
    const first = await migrate(store, root, home, kc.exec);
    expect(names(first)).toEqual(ALL_NOW);
    const def = (await store.listFactoryDefs())[0]!;
    expect(def).toMatchObject({
      factoryId: 'blocks', name: 'Blocks', protectedBranches: ['dev', 'stg', 'main'], patAccount: 'github-pat:blocks',
      docsPath: join(home, 'scratchpad', 'selise', 'vaultS', 'projects'),
    });
    expect((await store.listFactoryRepos('blocks')).map((r) => r.repoId)).toEqual(['data', 'iam', 'localization', 'logic', 'monitor', 'os', 'release']);
    expect((await store.getTask('T-1')).factoryId).toBe('blocks');
    expect((await store.getSettings()).factories.blocks).toEqual({ factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } });
    expect(kc.entries.get('github-pat:blocks')).toBe(SECRET);
    expect(names(await migrate(store, root, home, kc.exec))).toEqual(ALL_ALREADY);
  });

  test('the PAT goes on stdin of `security -i`, never on a command line or into the report', async () => {
    const store = make();
    const kc = fakeKeychain({ 'github-pat': SECRET });
    const report = await migrate(store, root, home, kc.exec);
    expect(JSON.stringify(report)).not.toContain('s3cr3t');
    const write = kc.calls.find((c) => c.args[0] === '-i')!;
    expect(write.args).toEqual(['-i']);
    expect(write.stdin).toContain('add-generic-password -U');
    expect(kc.calls.flatMap((c) => c.args).join(' ')).not.toContain('s3cr3t');
  });

  test('an existing target entry is left alone; a missing source is skipped', async () => {
    const kc = fakeKeychain({ 'github-pat': SECRET, 'github-pat:blocks': 'mine' });
    expect(names(await migrate(make(), root, home, kc.exec))).toContain('copy-pat:already');
    expect(kc.entries.get('github-pat:blocks')).toBe('mine');
    const none = fakeKeychain({});
    expect(names(await migrate(new LegacyMemory(), root, home, none.exec))).toContain('copy-pat:skipped');
    expect(none.calls.some((c) => c.args[0] === '-i')).toBe(false);
  });

  test('a failure at step 3, then a re-run, completes', async () => {
    const store = make();
    const real = store.setSettings.bind(store);
    let fail = true;
    store.setSettings = async (s) => {
      if (fail) { fail = false; throw new Error('write refused'); }
      return real(s);
    };
    const kc = fakeKeychain({ 'github-pat': SECRET });
    const seen: string[] = [];
    await expect(migrate(store, root, home, kc.exec, { onStep: (s) => seen.push(s.name) })).rejects.toThrow('write refused');
    expect(seen).toEqual(['create-factory', 'tag-tasks']);
    const again = await migrate(store, root, home, kc.exec);
    expect(again.steps.map((s) => s.done)).not.toContain('skipped');
    expect(again.steps[0]!.done).toBe('already');
    expect((await store.getSettings()).factories.blocks).toEqual({ factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } });
    expect(kc.entries.get('github-pat:blocks')).toBe(SECRET);
    expect(names(await migrate(store, root, home, kc.exec))).toEqual(ALL_ALREADY);
  });

  test('a failure in step 1 after some repos leaves no factory, and the re-run resumes', async () => {
    const store = make();
    const real = store.saveFactoryRepo.bind(store);
    let n = 0;
    store.saveFactoryRepo = async (b, a) => {
      if (++n === 3) throw new Error('boom');
      return real(b, a);
    };
    const kc = fakeKeychain({ 'github-pat': SECRET });
    await expect(migrate(store, root, home, kc.exec)).rejects.toThrow('boom');
    expect(await store.listFactoryDefs()).toEqual([]);
    await migrate(store, root, home, kc.exec);
    expect((await store.listFactoryRepos('blocks'))).toHaveLength(7);
    expect(await store.listFactoryDefs()).toHaveLength(1);
  });

  test('--dry-run writes nothing and says what it would do', async () => {
    const store = make();
    const kc = fakeKeychain({ 'github-pat': SECRET });
    const report = await migrate(store, root, home, kc.exec, { dryRun: true });
    expect(names(report)).toEqual(['create-factory:now', 'tag-tasks:now', 'move-settings:now', 'copy-pat:now', 'read-back:skipped', 'repos-folder:now']);
    expect(report.steps[0]!.detail).toMatch(/^would create blocks/);
    expect(await store.listFactoryDefs()).toEqual([]);
    expect(kc.entries.has('github-pat:blocks')).toBe(false);
    expect(kc.calls.some((c) => c.args[0] === '-i')).toBe(false);
  });

  test('old-layout clones are reported as a note and not moved', async () => {
    mkdirSync(join(root, '.clones', 'os', '.git'), { recursive: true });
    mkdirSync(join(root, '.clones', 'blocks', 'data', '.git'), { recursive: true });
    mkdirSync(join(root, '.clones', 'worktrees', 'T-1'), { recursive: true });
    const report = await migrate(make(), root, home, fakeKeychain({}).exec);
    expect(report.notes).toEqual([expect.stringContaining('.clones/os')]);
    expect(report.notes[0]).not.toContain('.clones/blocks');
    expect(existsSync(join(root, '.clones', 'os', '.git'))).toBe(true);
  });
});

test('step 3 includes the retire result of the store', async () => {
  const store = new LegacyMemory();
  store.seedLegacy();
  store.retireLegacySettings = async () => ({ retired: ['data', 'global'], remaining: ['os'] });
  const report = await migrate(store, root, home, fakeKeychain({}).exec);
  expect(report.steps[2]!.detail).toContain('retired legacy rows: data, global');
  expect(report.notes).toContain('legacy settings rows not retired: os');
});

test('a read-back mismatch stops before step 6', async () => {
  const store = new LegacyMemory();
  store.seedLegacy();
  const real = store.listFactoryRepos.bind(store);
  store.listFactoryRepos = async (f) => (await real(f)).slice(1);
  const seen: string[] = [];
  await expect(migrate(store, root, home, fakeKeychain({}).exec, { onStep: (s) => seen.push(s.name) })).rejects.toThrow(/read-back failed: repo data is missing/);
  expect(seen).not.toContain('repos-folder');
});
