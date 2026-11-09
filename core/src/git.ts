import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HOOK_PATH, assertPushAllowed } from './branchGuard.js';
import type { RepoConfig } from './repoConfig.js';

const execFileP = promisify(execFile);

export interface GitRepos {
  ensureClone(cfg: RepoConfig): Promise<string>;
  worktree(cfg: RepoConfig, taskId: string, branch: string): Promise<string>;
  push(worktreePath: string, branch: string): Promise<void>;
  isClean(path: string): Promise<boolean>;
}

async function git(cwd: string | undefined, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr ?? err.message ?? '').trim()}`);
  }
}

async function branchExists(clone: string, branch: string): Promise<boolean> {
  try {
    await execFileP('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: clone });
    return true;
  } catch {
    return false;
  }
}

export class LocalGitRepos implements GitRepos {
  constructor(private readonly root: string) {}

  async ensureClone(cfg: RepoConfig): Promise<string> {
    const clones = join(this.root, '.clones');
    const clone = join(clones, cfg.repo);
    if (!existsSync(clone)) {
      mkdirSync(clones, { recursive: true });
      await git(undefined, ['clone', cfg.remote, clone]);
    }
    await git(clone, ['fetch', 'origin', '--prune']);
    const hooks = join(clone, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-push');
    copyFileSync(HOOK_PATH, hook);
    chmodSync(hook, 0o755);
    return clone;
  }

  async worktree(cfg: RepoConfig, taskId: string, branch: string): Promise<string> {
    const path = join(this.root, '.clones', 'worktrees', taskId);
    if (existsSync(path)) return path;
    const clone = await this.ensureClone(cfg);
    mkdirSync(join(this.root, '.clones', 'worktrees'), { recursive: true });
    // A worktree folder deleted by hand still holds its branch until pruned.
    await git(clone, ['worktree', 'prune']);
    if (await branchExists(clone, branch)) {
      await git(clone, ['worktree', 'add', path, branch]);
    } else {
      await git(clone, ['worktree', 'add', '-b', branch, path, `origin/${cfg.baseBranch}`]);
    }
    return path;
  }

  async push(worktreePath: string, branch: string): Promise<void> {
    assertPushAllowed(branch);
    const common = (await git(worktreePath, ['rev-parse', '--git-common-dir'])).trim();
    const commonDir = isAbsolute(common) ? common : resolve(worktreePath, common);
    const hooksDir = join(commonDir, 'hooks');
    await git(worktreePath, [
      '-c',
      `core.hooksPath=${hooksDir}`,
      'push',
      '-u',
      'origin',
      `${branch}:refs/heads/${branch}`,
    ]);
  }

  async isClean(path: string): Promise<boolean> {
    return (await git(path, ['status', '--porcelain'])).trim() === '';
  }
}
