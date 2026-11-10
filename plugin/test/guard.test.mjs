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
  const inWt = { ...impl, cwd: wt };
  const cases = [
    ['implementer git commit in wt cwd', bash('git commit -m x', inWt), false],
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
    ['impl checkout file', bash('git checkout -- file.ts', inWt), false],
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
    ['git -C wt commit', bash(`git -C ${wt} commit -m x`, impl), false],
    ['impl git -C checkout -b', bash('git -C wt checkout -b y', impl), true],
    ['impl git -c switch', bash('git -c k=v switch y', impl), true],
    ['impl git -C rebase', bash('git -C wt rebase main', impl), true],
    ['impl git -C merge', bash('git -C wt merge x', impl), true],
    ['impl git -C branch', bash('git -C wt branch x', impl), true],
    ['vaults casing bash', bash('cat ~/scratchpad/selise/vaults/x'), true],
    ['BLOCKS casing bash', bash('ls ~/scratchpad/selise/BLOCKS'), true],
    ['grep security ok', bash('grep -rn security src', impl), false],
    ['grep -r security ok', bash('grep -r security .', impl), false],
    ['vitest src/security ok', bash('npx vitest run src/security', impl), false],
    ['security add', bash('security add-generic-password -s x'), true],
    ['impl relative write', { ...impl, tool_name: 'Write', tool_input: { file_path: 'core/src/x.ts' } }, true],
    ['main relative write', { tool_name: 'Write', tool_input: { file_path: 'runs/x' } }, true],
    ['multiedit in wt', write(`${wt}/a`, impl, 'MultiEdit'), false],
    ['multiedit outside', write(`${root}/core/a`, impl, 'MultiEdit'), true],
    ['notebook in wt', { ...impl, tool_name: 'NotebookEdit', tool_input: { notebook_path: `${wt}/n.ipynb` } }, false],
    ['no tool name', {}, true],
    ['other tool', { tool_name: 'WebFetch', tool_input: {} }, false],

    // I7: vault and checkouts by any path, Keychain, hooks
    ['vaultS anywhere', bash('cat /some/where/vaultS/a.md'), true],
    ['VAULTS casing anywhere', bash('ls /x/VAULTS'), true],
    ['relative vault append', bash('echo x >> ../vaultS/j.md'), true],
    ['relative vault append impl', bash('echo x >> ../vaultS/j.md', impl), true],
    ['relative checkout cd', bash('cd ../blocks/blocks-data && git status'), true],
    ['relative checkout ../../', bash('ls ../../blocks'), true],
    ['relative checkout quoted', bash('ls "../blocks/x"'), true],
    ['relative checkout =', bash('X=../blocks/x node a.js'), true],
    ['relative checkout ..//', bash('ls ..//blocks'), true],
    ['relative checkout casing', bash('ls ../BLOCKS'), true],
    ['blocks word ok', bash('npm test -- blocks'), false],
    ['relative other dir ok', bash('ls ../other'), false],
    ['security -v find', bash('security -v find-generic-password -s x'), true],
    ['security -i dump', bash('security -q dump-keychain'), true],
    ['find-internet-password anywhere', bash('/usr/bin/x find-internet-password'), true],
    ['dump-keychain anywhere', bash('echo dump-keychain'), true],
    ['.git/hooks', bash('rm .clones/data/.git/hooks/pre-push'), true],
    ['hooksPath', bash('git -c core.hooksPath=/dev/null commit -m x'), true],
    ['--no-verify', bash(`cd "${wt}" && git commit --no-verify -m x`, impl), true],
    ['main core/dist/cli.js ok', bash('node "/f/root/core/dist/cli.js" --mode session next --json'), false],
    ['impl core/dist secrets', bash(`node -e "import('/f/root/core/dist/secrets.js').then(m=>m.readSecret('github-pat'))"`, impl), true],
    ['impl core/src', bash('cat core/src/secrets.ts', impl), true],
    ['impl git --work-tree push', bash('git --work-tree x push', impl), true],
    ['impl git -C quoted push', bash('git -C "a b" push', impl), true],
    ['impl git push after cd', bash(`cd "${wt}" && git push origin x`, impl), true],
    ['impl git log --grep push (over-deny ok)', bash('git log --grep push', impl), true],
    ['impl echo push ok', bash('echo push', impl), false],
    ['impl git status then push word ok', bash('git status; echo push', impl), false],

    // I2: state-changing git for factory agents needs the step worktree
    ['impl git commit no wt', bash('git commit -m x', impl), true],
    ['impl git add no wt', bash('git add -A', impl), true],
    ['impl git cherry-pick no wt', bash('git cherry-pick abc', impl), true],
    ['impl git -C other commit', bash('git -C /f/root commit -m x', impl), true],
    ['impl cd other commit', bash('cd /f/root && git commit -m x', impl), true],
    ['impl cd wt quoted commit', bash(`cd "${wt}" && git commit -m x`, impl), false],
    ['impl cd wt bare commit', bash(`cd ${wt} && git add -A && git commit -m x`, impl), false],
    ['impl -C wt quoted add', bash(`git -C "${wt}" add a.ts`, impl), false],
    ['impl cd wt prefix lookalike', bash(`cd ${wt}0 && git commit -m x`, impl), true],
    ['impl cwd outside wt', bash('git commit -m x', { ...impl, cwd: root }), true],
    ['impl cwd inside wt subdir', bash('git commit -m x', { ...impl, cwd: `${wt}/src` }), false],
    ['impl git status no wt ok', bash('git status', impl), false],
    ['impl git diff no wt ok', bash('git diff HEAD', impl), false],
    ['impl git log no wt ok', bash('git log --oneline -5', impl), false],
    ['main git commit no wt ok', bash('git commit -m x'), false],

    // M8: only branch-creating or deleting forms of git branch
    ['impl git branch --show-current ok', bash(`git -C ${wt} branch --show-current`, impl), false],
    ['impl git branch list ok', bash('git branch', impl), false],
    ['impl git branch -D', bash('git branch -D x', impl), true],
    ['impl git branch -m', bash('git branch -m x y', impl), true],
    ['impl git branch create', bash('git branch newb', impl), true],
  ];
  for (const [name, input, deny] of cases) {
    it(name, () => {
      const r = run(input);
      expect(r.deny).toBe(deny);
      if (deny) expect(r.reason).toMatch(/^factory guard:/);
    });
  }

  describe('worktree subfolders and Blocks.slnx', () => {
    const w3 = `${root}/.clones/worktrees/T-3`;
    const s3 = { taskId: 'T-3', step: 'implement', worktree: w3 };
    const abs = '/Users/x/scratchpad/selise/the-software-factory/.clones/worktrees/T-3';
    const table = [
      ['cd wt quoted', bash(`cd "${w3}" && git commit -m x`, impl), false],
      ['cd wt/server quoted', bash(`cd "${w3}/server" && git commit -m x`, impl), false],
      ['cd wt/server bare', bash(`cd ${w3}/server && git commit -m x`, impl), false],
      ['-C wt/client quoted', bash(`git -C "${w3}/client" add src/a.ts`, impl), false],
      ['cd wt/ trailing slash', bash(`cd "${w3}/" && git commit -m x`, impl), false],
      ['cd wt/../.. escape', bash(`cd "${w3}/../.." && git commit -m x`, impl), true],
      ['cd wt/../T-30 escape', bash(`cd ${w3}/../T-30 && git commit -m x`, impl), true],
      ['-C wt/../../.. escape', bash(`git -C ${w3}/../../.. add .`, impl), true],
      ['cd wt/./../.. escape', bash(`cd "${w3}/./../.." && git commit -m x`, impl), true],
      ['cd T-30 lookalike', bash(`cd "${root}/.clones/worktrees/T-30" && git commit -m x`, impl), true],
      ['cd root', bash(`cd "${root}" && git commit -m x`, impl), true],
      ['dotnet test ../../Blocks.slnx', bash(`cd "${w3}/server/src" && dotnet test ../../Blocks.slnx`, impl), false],
      ['dotnet build ../Blocks.slnx', bash('dotnet build ../Blocks.slnx', impl), false],
      ['cd ../blocks/blocks-data', bash('cd ../blocks/blocks-data && git status', impl), true],
      ['ls ../../blocks/', bash('ls ../../blocks/', impl), true],
      ['ls ../blocks', bash('ls ../blocks', impl), true],
      ['ls ../blocks main', bash('ls ../blocks'), true],
      ['echo >> ../vaultS', bash('echo x >> ../vaultS/journal/a.md', impl), true],
      ['cat ../VAULTS', bash('cat ../VAULTS/x.md', impl), true],
      ['absolute wt Blocks.slnx', bash(`dotnet test ${abs}/Blocks.slnx`, impl), false],
    ];
    for (const [name, input, deny] of table) {
      it(name, () => {
        const sess = name.startsWith('absolute') ? { ...s3, worktree: abs } : s3;
        expect(run(input, sess).deny).toBe(deny);
      });
    }
  });

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

  it('state-changing git without the worktree names the subcommand', () => {
    expect(run(bash('git commit -m x', impl)).reason).toBe('factory guard: git commit must run in the step worktree');
    expect(run(bash('git -C x stash', impl)).reason).toBe('factory guard: git stash must run in the step worktree');
  });

  it('state-changing git with no active step is denied', () => {
    expect(run(bash(`cd "${wt}" && git commit -m x`, impl), null).deny).toBe(true);
  });

  it('darwin compares protected roots case-insensitively', () => {
    const input = write(`${home}/scratchpad/selise/VAULTS/x.md`);
    expect(decide(input, { root, home, session: null, platform: 'darwin' }).deny).toBe(true);
    expect(decide(input, { root, home, session: null, platform: 'linux' }).reason).toContain('main session may write only');
  });
});

describe('guard symlinks (M3)', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ln-')));
  const fhome = path.join(tmp, 'home');
  const froot = path.join(tmp, 'root');
  const fwt = path.join(froot, '.clones', 'worktrees', 'T-1');
  const vault = path.join(fhome, 'scratchpad', 'selise', 'vaultS');
  fs.mkdirSync(fwt, { recursive: true });
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(path.join(froot, 'core'), { recursive: true });
  fs.symlinkSync(froot, path.join(fwt, 'up'));
  fs.symlinkSync(vault, path.join(fwt, 'v'));
  // The same worktree reached through a symlinked parent still counts as the worktree.
  fs.symlinkSync(froot, path.join(tmp, 'alias'));
  const ctx = { root: froot, home: fhome, session: { taskId: 'T-1', step: 'build', worktree: fwt } };
  const go = (p, who = impl) => decide(write(p, who), ctx);

  it('a plain write in the worktree is allowed', () => {
    expect(go(path.join(fwt, 'src', 'a.ts')).deny).toBe(false);
  });
  it('a write through a worktree symlink that leaves it is denied', () => {
    const r = go(path.join(fwt, 'up', 'core', 'x.ts'));
    expect(r.deny).toBe(true);
    expect(r.reason).toContain('inside the step worktree');
  });
  it('a write through a symlink to a missing deeper path is denied', () => {
    expect(go(path.join(fwt, 'up', 'newdir', 'deeper', 'x.ts')).deny).toBe(true);
  });
  it('a write through a worktree symlink into the vault is denied for everyone', () => {
    expect(go(path.join(fwt, 'v', 'journal', 'x.md')).reason).toContain('writes under vaultS');
    expect(go(path.join(fwt, 'v', 'x.md'), {}).reason).toContain('writes under vaultS');
  });
  it('the worktree through a symlinked parent is still the worktree', () => {
    expect(go(path.join(tmp, 'alias', '.clones', 'worktrees', 'T-1', 'a.ts')).deny).toBe(false);
  });
  it('a git commit from a symlinked cwd inside the worktree is allowed', () => {
    const cwd = path.join(tmp, 'alias', '.clones', 'worktrees', 'T-1');
    expect(decide(bash('git commit -m x', { ...impl, cwd }), ctx).deny).toBe(false);
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
