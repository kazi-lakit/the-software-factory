import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimantFor, replyTarget, shouldRenew, renewCommand, AGENT_FOR } from '../hooks/lib.mjs';
import { AGENT_FOR as CORE_AGENT_FOR } from '../../core/src/defaults.ts';

const hooks = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const root = '/f/root';
const session = { taskId: 'T-1', step: 'build', mode: 'session', store: 'blocks' };

describe('claimantFor', () => {
  it('uses host and first 8 chars', () => {
    expect(claimantFor('0123456789ab', 'mac')).toBe('claude:mac:01234567');
  });
  it('differs per session', () => {
    expect(claimantFor('aaaaaaaa1', 'h')).not.toBe(claimantFor('bbbbbbbb1', 'h'));
  });
});

describe('AGENT_FOR', () => {
  it('matches core', () => {
    expect(AGENT_FOR).toEqual(CORE_AGENT_FOR);
  });
});

describe('replyTarget', () => {
  it('returns the reply path for a matching stop', () => {
    expect(replyTarget({ agent_type: 'factory:implementer' }, { root, session }))
      .toBe('/f/root/runs/T-1/build.reply.md');
  });
  it('null for other agent types', () => {
    expect(replyTarget({ agent_type: 'general-purpose' }, { root, session })).toBeNull();
  });
  it('null when the step does not match the agent', () => {
    expect(replyTarget({ agent_type: 'factory:reviewer' }, { root, session: { ...session, step: 'spec' } })).toBeNull();
  });
  it('null without a session', () => {
    expect(replyTarget({ agent_type: 'factory:implementer' }, { root, session: null })).toBeNull();
  });
});

describe('shouldRenew', () => {
  it('renews when never renewed or 60s elapsed', () => {
    expect(shouldRenew(null, 0)).toBe(true);
    expect(shouldRenew(0, 59_999)).toBe(false);
    expect(shouldRenew(0, 60_000)).toBe(true);
  });
});

describe('renewCommand', () => {
  it('builds the CLI invocation', () => {
    const c = renewCommand({ root, session, sessionId: '0123456789ab', host: 'mac', node: 'node' });
    expect(c.file).toBe('node');
    expect(c.args).toEqual(['/f/root/core/dist/cli.js', '--mode', 'session', '--store', 'blocks', 'renew', 'T-1']);
    expect(c.env.FACTORY_CLAIMANT).toBe('claude:mac:01234567');
    expect(c.env.FACTORY_ROOT).toBe('/f/root');
    expect(c.log).toBe('/f/root/runs/T-1/renew.log');
  });
});

// Temp folders: a factory root (repos/, core/, plugin/), a plain project folder, and a home with no factory.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')));
const makeRoot = (r) => { for (const d of ['repos', 'core', 'plugin']) fs.mkdirSync(path.join(r, d), { recursive: true }); return r; };
const froot = makeRoot(path.join(tmp, 'factory'));
const plain = path.join(tmp, 'plain');
fs.mkdirSync(plain);
const bareHome = path.join(tmp, 'home');
fs.mkdirSync(bareHome);
const baseEnv = () => {
  const env = { ...process.env, HOME: bareHome };
  for (const k of ['FACTORY_ROOT', 'FACTORY_STORE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_ENV_FILE']) delete env[k];
  return env;
};
const runHook = (name, input, env) =>
  spawnSync('node', [path.join(hooks, name)], { input: typeof input === 'string' ? input : JSON.stringify(input), env, encoding: 'utf8' });

describe('session-start.mjs', () => {
  const envFile = () => path.join(fs.mkdtempSync(path.join(tmp, 'ss-')), 'env');
  const start = (env) => runHook('session-start.mjs', { session_id: 'abcdef123456' }, env);

  it('writes the export lines with HUSKY=0 in project mode', () => {
    const file = envFile();
    const r = start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: froot });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([
      `export FACTORY_ROOT="${froot}"`,
      `export FACTORY_CLAIMANT=claude:${os.hostname()}:abcdef12`,
      'export FACTORY_STORE="${FACTORY_STORE:-blocks}"',
      'export HUSKY=0',
    ]);
  });
  it('exports the root found through FACTORY_ROOT from another folder, without HUSKY', () => {
    const file = envFile();
    start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: froot });
    expect(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).toEqual([
      `export FACTORY_ROOT="${froot}"`,
      `export FACTORY_CLAIMANT=claude:${os.hostname()}:abcdef12`,
      'export FACTORY_STORE="${FACTORY_STORE:-blocks}"',
    ]);
  });
  it('exports the default root under home', () => {
    const home = path.join(tmp, 'home2');
    const dflt = makeRoot(path.join(home, 'scratchpad', 'selise', 'the-software-factory'));
    const file = envFile();
    start({ ...baseEnv(), HOME: home, CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain });
    expect(fs.readFileSync(file, 'utf8')).toContain(`export FACTORY_ROOT="${dflt}"\n`);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('HUSKY');
  });
  it('writes nothing when no root resolves', () => {
    const file = envFile();
    const r = start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: plain });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').toBe('');
  });
  it('keeps a FACTORY_STORE from the launch shell and defaults it to blocks', () => {
    const file = envFile();
    start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: froot });
    const sh = (env) => spawnSync('sh', ['-c', `. "${file}" && printf %s "$FACTORY_STORE"`], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).stdout;
    expect(sh({})).toBe('blocks');
    expect(sh({ FACTORY_STORE: 'file' })).toBe('file');
  });
  it('quotes a root with spaces so the env file stays valid shell', () => {
    const spaced = makeRoot(path.join(tmp, 'my root'));
    const file = envFile();
    start({ ...baseEnv(), CLAUDE_ENV_FILE: file, CLAUDE_PROJECT_DIR: spaced });
    const r = spawnSync('sh', ['-c', `. "${file}" && printf %s "$FACTORY_ROOT"`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(r.stdout).toBe(spaced);
  });
  it('exits 0 without CLAUDE_ENV_FILE', () => {
    const r = start({ ...baseEnv(), CLAUDE_PROJECT_DIR: froot });
    expect(r.status).toBe(0);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });
});

describe('subagent-stop.mjs', () => {
  const withStep = (r, sid) => {
    fs.mkdirSync(path.join(r, 'runs', '.sessions'), { recursive: true });
    fs.writeFileSync(path.join(r, 'runs', '.sessions', `${sid}.json`), JSON.stringify(session));
  };
  const stop = (sid, env) => runHook('subagent-stop.mjs', { session_id: sid, agent_type: 'factory:implementer', last_assistant_message: 'hello' }, env);

  it('writes the reply file in project mode', () => {
    withStep(froot, 's1');
    const r = stop('s1', { ...baseEnv(), CLAUDE_PROJECT_DIR: froot });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(froot, 'runs', 'T-1', 'build.reply.md'), 'utf8')).toBe('hello');
  });
  it('writes the reply file under FACTORY_ROOT when started elsewhere', () => {
    const r2 = makeRoot(path.join(tmp, 'factory2'));
    withStep(r2, 's2');
    const r = stop('s2', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: r2 });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(r2, 'runs', 'T-1', 'build.reply.md'), 'utf8')).toBe('hello');
  });
  it('does nothing when no root resolves', () => {
    const r = stop('s3', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(plain, 'runs'))).toBe(false);
  });
});

describe('renew.mjs', () => {
  const renew = (sid, env) => runHook('renew.mjs', { session_id: sid, agent_type: 'factory:implementer', tool_name: 'Read' }, env);
  const marker = (r, sid) => path.join(r, 'runs', '.sessions', `${sid}.renew`);

  it('renews under FACTORY_ROOT when started elsewhere', () => {
    const r3 = makeRoot(path.join(tmp, 'factory3'));
    fs.mkdirSync(path.join(r3, 'runs', '.sessions'), { recursive: true });
    fs.writeFileSync(path.join(r3, 'runs', '.sessions', 'r1.json'), JSON.stringify(session));
    const r = renew('r1', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain, FACTORY_ROOT: r3 });
    expect(r.status).toBe(0);
    expect(fs.existsSync(marker(r3, 'r1'))).toBe(true);
  });
  it('does nothing when no root resolves', () => {
    const r = renew('r2', { ...baseEnv(), CLAUDE_PROJECT_DIR: plain });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(fs.existsSync(path.join(plain, 'runs'))).toBe(false);
  });
});
