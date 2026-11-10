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

describe('session-start.mjs', () => {
  it('writes the four export lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
    const envFile = path.join(dir, 'env');
    const env = { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: '/f/root' };
    delete env.FACTORY_STORE;
    const r = spawnSync('node', [path.join(hooks, 'session-start.mjs')], { input: '{"session_id":"abcdef123456"}', env });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean)).toEqual([
      `export FACTORY_CLAIMANT=claude:${os.hostname()}:abcdef12`,
      'export HUSKY=0',
      'export FACTORY_ROOT="/f/root"',
      'export FACTORY_STORE=${FACTORY_STORE:-blocks}',
    ]);
  });
  it('quotes a root with spaces so the env file stays valid shell', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
    const envFile = path.join(dir, 'env');
    const env = { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: '/f/my root' };
    spawnSync('node', [path.join(hooks, 'session-start.mjs')], { input: '{"session_id":"abcdef123456"}', env });
    const r = spawnSync('sh', ['-c', `. "${envFile}" && printf %s "$FACTORY_ROOT"`], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(r.stdout).toBe('/f/my root');
  });
  it('exits 0 without CLAUDE_ENV_FILE', () => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: '/f/root' };
    delete env.CLAUDE_ENV_FILE;
    const r = spawnSync('node', [path.join(hooks, 'session-start.mjs')], { input: '{"session_id":"abcdef123456"}', env });
    expect(r.status).toBe(0);
    expect(r.stderr.toString().trim().split('\n')).toHaveLength(1);
  });
});

describe('subagent-stop.mjs', () => {
  it('writes the reply file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
    fs.mkdirSync(path.join(dir, 'runs', '.sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs', '.sessions', 's1.json'), JSON.stringify(session));
    const input = { session_id: 's1', agent_type: 'factory:implementer', last_assistant_message: 'hello' };
    const r = spawnSync('node', [path.join(hooks, 'subagent-stop.mjs')], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'runs', 'T-1', 'build.reply.md'), 'utf8')).toBe('hello');
  });
});
