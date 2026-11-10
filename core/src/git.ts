import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HOOK_PATH, assertPushAllowed } from './branchGuard.js';
import type { FactoryRepo } from './factories.js';

const execFileP = promisify(execFile);

export interface GitIdentity {
  gitName: string;
  gitEmail: string;
}

export interface GitRepos {
  /** The clone is at `.clones/<factoryId>/<repoId>`. */
  ensureClone(factoryId: string, repo: FactoryRepo, protectedBranches: string[]): Promise<string>;
  /** `identity` (the factory's gitName/gitEmail, empty means unset) goes into the worktree's own config, never the global one. */
  worktree(factoryId: string, repo: FactoryRepo, taskId: string, branch: string, protectedBranches: string[], identity?: GitIdentity): Promise<string>;
  /** Refuses a branch in `protectedBranches` (default dev/stg/main plus main always). */
  push(worktreePath: string, branch: string, protectedBranches?: readonly string[]): Promise<void>;
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

  async ensureClone(factoryId: string, repo: FactoryRepo, protectedBranches: string[]): Promise<string> {
    const factoryClones = join(this.root, '.clones', factoryId);
    const clone = join(factoryClones, repo.repoId);
    if (!existsSync(clone)) {
      mkdirSync(factoryClones, { recursive: true });
      await git(undefined, ['clone', repo.remote, clone]);
    }
    await git(clone, ['fetch', 'origin', '--prune']);
    const hooks = join(clone, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, 'pre-push');
    copyFileSync(HOOK_PATH, hook);
    chmodSync(hook, 0o755);
    // The hook reads the factory's list from here (through the common git dir, so worktrees find it too).
    writeFileSync(join(clone, '.git', 'factory-protected-branches'), protectedBranches.map((b) => `${b}\n`).join(''));
    return clone;
  }

  async worktree(factoryId: string, repo: FactoryRepo, taskId: string, branch: string, protectedBranches: string[], identity?: GitIdentity): Promise<string> {
    const path = join(this.root, '.clones', 'worktrees', taskId);
    if (existsSync(path)) {
      await this.setIdentity(join(this.root, '.clones', factoryId, repo.repoId), path, identity);
      return path;
    }
    const clone = await this.ensureClone(factoryId, repo, protectedBranches);
    mkdirSync(join(this.root, '.clones', 'worktrees'), { recursive: true });
    // A worktree folder deleted by hand still holds its branch until pruned.
    await git(clone, ['worktree', 'prune']);
    if (await branchExists(clone, branch)) {
      await git(clone, ['worktree', 'add', path, branch]);
    } else {
      await git(clone, ['worktree', 'add', '-b', branch, path, `origin/${repo.baseBranch}`]);
    }
    await this.setIdentity(clone, path, identity);
    return path;
  }

  /** Sets user.name / user.email in the worktree's own config; the owner's global config is never touched. */
  private async setIdentity(clone: string, worktree: string, identity?: GitIdentity): Promise<void> {
    const values: [string, string][] = [['user.name', identity?.gitName ?? ''], ['user.email', identity?.gitEmail ?? '']];
    if (values.every(([, v]) => v === '')) return;
    const on = await execFileP('git', ['config', '--get', 'extensions.worktreeConfig'], { cwd: clone }).then((r) => r.stdout.trim() === 'true', () => false);
    if (!on) await git(clone, ['config', 'extensions.worktreeConfig', 'true']);
    for (const [key, value] of values) if (value !== '') await git(worktree, ['config', '--worktree', key, value]);
  }

  async push(worktreePath: string, branch: string, protectedBranches?: readonly string[]): Promise<void> {
    assertPushAllowed(branch, protectedBranches);
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
