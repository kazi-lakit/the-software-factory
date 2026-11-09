import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ProtectedBranchError } from '../src/branchGuard.js';
import { LocalGitRepos } from '../src/git.js';
import type { RepoConfig } from '../src/repoConfig.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();

describe('LocalGitRepos', () => {
  let tmp: string;
  let root: string;
  let bare: string;
  let cfg: RepoConfig;
  let repos: LocalGitRepos;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gitrepos-'));
    bare = join(tmp, 'remote.git');
    root = join(tmp, 'factory');
    const seed = join(tmp, 'seed');
    git(tmp, 'init', '--bare', '-b', 'dev', bare);
    git(tmp, 'clone', bare, seed);
    git(seed, 'checkout', '-b', 'dev');
    git(seed, 'commit', '--allow-empty', '-m', 'init');
    git(seed, 'push', 'origin', 'dev');
    cfg = { repo: 'os', remote: bare, baseBranch: 'dev' } as RepoConfig;
    repos = new LocalGitRepos(root);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test('ensureClone is idempotent and installs an executable hook', async () => {
    const a = await repos.ensureClone(cfg);
    const b = await repos.ensureClone(cfg);
    expect(a).toBe(join(root, '.clones', 'os'));
    expect(b).toBe(a);
    const hook = join(a, '.git', 'hooks', 'pre-push');
    expect(existsSync(hook)).toBe(true);
    accessSync(hook, constants.X_OK);
  });

  test('worktree branches from origin/dev and is reused', async () => {
    const branch = 'factory/T-1-x';
    const wt = await repos.worktree(cfg, 'T-1', branch);
    expect(wt).toBe(join(root, '.clones', 'worktrees', 'T-1'));
    expect(git(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(git(wt, 'rev-parse', 'HEAD').trim()).toBe(git(wt, 'rev-parse', 'origin/dev').trim());
    expect(await repos.worktree(cfg, 'T-1', branch)).toBe(wt);
  });

  test('worktree reuses an existing local branch when its worktree folder is gone', async () => {
    const branch = 'factory/T-2-y';
    const wt = await repos.worktree(cfg, 'T-2', branch);
    git(wt, 'commit', '--allow-empty', '-m', 'kept work');
    const head = git(wt, 'rev-parse', 'HEAD').trim();
    rmSync(wt, { recursive: true, force: true }); // the folder was deleted; git still lists the worktree
    const again = await repos.worktree(cfg, 'T-2', branch);
    expect(again).toBe(wt);
    expect(git(again, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(branch);
    expect(git(again, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  test('isClean reflects uncommitted files', async () => {
    const wt = await repos.worktree(cfg, 'T-1', 'factory/T-1-x');
    expect(await repos.isClean(wt)).toBe(true);
    writeFileSync(join(wt, 'f.txt'), 'x');
    expect(await repos.isClean(wt)).toBe(false);
    rmSync(join(wt, 'f.txt'));
  });

  test('push publishes a task branch, refuses dev', async () => {
    const wt = await repos.worktree(cfg, 'T-1', 'factory/T-1-x');
    git(wt, 'commit', '--allow-empty', '-m', 'work');
    await repos.push(wt, 'factory/T-1-x');
    expect(git(tmp, 'ls-remote', bare, 'refs/heads/factory/T-1-x')).toContain('refs/heads/factory/T-1-x');
    const before = git(tmp, 'ls-remote', bare, 'refs/heads/dev');
    await expect(repos.push(wt, 'dev')).rejects.toBeInstanceOf(ProtectedBranchError);
    expect(git(tmp, 'ls-remote', bare, 'refs/heads/dev')).toBe(before);
  });

  test('hook still guards when pushing a protected refspec via git directly with global hooksPath ignored', async () => {
    const wt = await repos.worktree(cfg, 'T-1', 'factory/T-1-x');
    expect(() =>
      execFileSync('git', ['-c', `core.hooksPath=${join(root, '.clones', 'os', '.git', 'hooks')}`, 'push', 'origin', 'HEAD:refs/heads/dev'], { cwd: wt, stdio: 'pipe' }),
    ).toThrow();
  });
});
