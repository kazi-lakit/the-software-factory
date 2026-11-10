import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../hooks/decide.mjs';
import { isFactoryAgent, factoryRoot, sessionFile } from '../hooks/lib.mjs';

const root = '/f/root';
const home = '/h';
const wt = '/f/root/.clones/worktrees/T-1';
const session = { taskId: 'T-1', step: 'implement', worktree: wt };
const impl = { agent_type: 'factory:implementer' };

const bash = (command, who = {}) => ({ ...who, tool_name: 'Bash', tool_input: { command } });
const write = (file_path, who = {}, tool_name = 'Write') => ({ ...who, tool_name, tool_input: { file_path } });
const run = (input, s = session) => decide(input, { root, home, session: s });

describe('guard decide', () => {
  const cases = [
    ['implementer git commit', bash('git commit -m x', impl), false],
    ['main git push', bash('git push origin x'), true],
    ['security keychain', bash('security find-generic-password -s x'), true],
    ['gh pr list', bash('gh pr list'), true],
    ['echo ghost', bash('echo ghost'), false],
    ['piped gh', bash('echo a | gh api x'), true],
    ['remote add', bash('git remote add o u'), true],
    ['remote -v', bash('git remote -v'), false],
    ['config set', bash('git config user.email x'), true],
    ['config get', bash('git config --get user.email'), false],
    ['ssh', bash('ssh host'), true],
    ['.ssh', bash('cat ~/.ssh/id_rsa'), true],
    ['token', bash('echo $GH_TOKEN'), true],
    ['api', bash('curl https://api.github.com/x'), true],
    ['checkout path', bash('ls ~/scratchpad/selise/blocks/x'), true],
    ['vault path', bash('cat scratchpad/selise/vaultS/a.md'), true],
    ['main cli', bash('node core/dist/cli.js next'), false],
    ['impl cli', bash('node core/dist/cli.js next', impl), true],
    ['impl factory cmd', bash('factory next', impl), true],
    ['impl checkout file', bash('git checkout -- file.ts', impl), false],
    ['impl checkout -b', bash('git checkout -b other', impl), true],
    ['impl switch', bash('git switch x', impl), true],
    ['impl rebase', bash('git rebase main', impl), true],
    ['main switch ok', bash('git switch x'), false],
    ['impl write in wt', write(`${wt}/src/a.ts`, impl), false],
    ['impl write core', write(`${root}/core/src/x.ts`, impl), true],
    ['impl write escape', write(`${wt}/../../../core/x.ts`, impl), true],
    ['impl edit in wt', write(`${wt}/a`, impl, 'Edit'), false],
    ['main write runs', write(`${root}/runs/T-1/spec.reply.md`), false],
    ['main write worktrees', write(`${root}/.clones/worktrees/T-1/a`), false],
    ['main write core', write(`${root}/core/x.ts`), true],
    ['vault write', write(`${home}/scratchpad/selise/vaultS/x.md`), true],
    ['vault write impl', write(`${home}/scratchpad/selise/vaultS/x.md`, impl), true],
    ['checkout write', write(`${home}/scratchpad/selise/blocks/r/x`), true],
    ['read vault', { tool_name: 'Read', tool_input: { file_path: `${home}/scratchpad/selise/vaultS/projects/blocks-x/blocks-x-overview.md` } }, false],
    ['git -C push', bash('git -C wt push origin x'), true],
    ['git -c push', bash('git -c k=v push'), true],
    ['git --no-pager push', bash('git --no-pager push'), true],
    ['git -C remote add', bash('git -C wt remote add o u'), true],
    ['git -C config set', bash('git -C wt config user.email x'), true],
    ['git -C config get', bash('git -C wt config --get x'), false],
    ['git -C commit', bash('git -C wt commit -m x', impl), false],
    ['impl git -C checkout -b', bash('git -C wt checkout -b y', impl), true],
    ['impl git -c switch', bash('git -c k=v switch y', impl), true],
    ['impl git -C rebase', bash('git -C wt rebase main', impl), true],
    ['impl git -C merge', bash('git -C wt merge x', impl), true],
    ['impl git -C branch', bash('git -C wt branch x', impl), true],
    ['vaults casing bash', bash('cat ~/scratchpad/selise/vaults/x'), true],
    ['BLOCKS casing bash', bash('ls ~/scratchpad/selise/BLOCKS'), true],
    ['grep security ok', bash('grep -rn security src', impl), false],
    ['vitest src/security ok', bash('npx vitest run src/security', impl), false],
    ['security add', bash('security add-generic-password -s x'), true],
    ['impl relative write', { ...impl, tool_name: 'Write', tool_input: { file_path: 'core/src/x.ts' } }, true],
    ['main relative write', { tool_name: 'Write', tool_input: { file_path: 'runs/x' } }, true],
    ['multiedit in wt', write(`${wt}/a`, impl, 'MultiEdit'), false],
    ['multiedit outside', write(`${root}/core/a`, impl, 'MultiEdit'), true],
    ['notebook in wt', { ...impl, tool_name: 'NotebookEdit', tool_input: { notebook_path: `${wt}/n.ipynb` } }, false],
    ['no tool name', {}, true],
    ['other tool', { tool_name: 'WebFetch', tool_input: {} }, false],
  ];
  for (const [name, input, deny] of cases) {
    it(name, () => {
      const r = run(input);
      expect(r.deny).toBe(deny);
      if (deny) expect(r.reason).toMatch(/^factory guard:/);
    });
  }

  it('implementer write with null session is denied', () => {
    const r = run(write(`${wt}/a`, impl), null);
    expect(r).toEqual({ deny: true, reason: expect.stringContaining('no active factory step') });
    expect(r.reason).toMatch(/^factory guard:/);
  });

  it('notebook_path is resolved', () => {
    const r = run({ ...impl, tool_name: 'NotebookEdit', tool_input: { notebook_path: `${root}/x.ipynb` } });
    expect(r.deny).toBe(true);
    expect(r.reason).toContain('inside the step worktree');
  });

  it('agent with a session lacking worktree is denied', () => {
    const r = run(write(`${wt}/a`, impl), { taskId: 'T-1', step: 'implement' });
    expect(r.deny).toBe(true);
    expect(r.reason).toContain('no active factory step');
  });

  it('darwin compares protected roots case-insensitively', () => {
    const input = write(`${home}/scratchpad/selise/VAULTS/x.md`);
    expect(decide(input, { root, home, session: null, platform: 'darwin' }).deny).toBe(true);
    expect(decide(input, { root, home, session: null, platform: 'linux' }).reason).toContain('main session may write only');
  });
});

describe('lib', () => {
  it('isFactoryAgent', () => {
    expect(isFactoryAgent({ agent_type: 'factory:verifier' })).toBe(true);
    expect(isFactoryAgent({})).toBe(false);
    expect(isFactoryAgent({ agent_type: 'other:x' })).toBe(false);
  });
  it('factoryRoot', () => {
    expect(factoryRoot({ CLAUDE_PROJECT_DIR: '/a', FACTORY_ROOT: '/b' })).toBe('/a');
    expect(factoryRoot({ FACTORY_ROOT: '/b' })).toBe('/b');
    expect(() => factoryRoot({})).toThrow();
  });
  it('sessionFile', () => {
    expect(sessionFile('/r', 's1')).toBe('/r/runs/.sessions/s1.json');
  });
});

describe('entry script', () => {
  const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const link = path.join(tmp, 'link');
  fs.symlinkSync(pluginDir, link);
  const runScript = (dir, stdin, env = { CLAUDE_PROJECT_DIR: tmp }) =>
    spawnSync('node', [path.join(dir, 'hooks', 'guard.mjs')], { input: stdin, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const gitPush = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, session_id: 's' });

  it('denies through a symlinked plugin dir', () => {
    const r = runScript(link, gitPush);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('allows a harmless call with no output', () => {
    const r = runScript(pluginDir, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
  it('denies on empty stdin', () => {
    const r = runScript(pluginDir, '');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain('no tool name');
  });
  it('denies on invalid stdin with a guard error', () => {
    const r = runScript(pluginDir, '{not json');
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^factory guard error:/);
  });
  it('fails closed when the factory root is unknown', () => {
    const r = runScript(pluginDir, gitPush.replace('git push', 'ls'), {});
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/^factory guard error:/);
  });
});
