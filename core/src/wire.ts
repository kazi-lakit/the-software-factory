import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { shellExec } from './checks.js';
import { Engine } from './engine.js';
import { LocalGitRepos } from './git.js';
import { OctokitGitHub, type GitHub } from './github.js';
import { loadAllRepoConfigs } from './repoConfig.js';
import { readSecret } from './secrets.js';
import { FileStore, type BoardStore } from './store.js';
import type { Mode } from './types.js';

export interface WireOptions {
  root: string;
  mode: Mode;
  store: 'file' | 'blocks';
}

/** `FACTORY_ROOT`, else the nearest parent folder of the cwd that contains `repos/`. */
export function findRoot(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.FACTORY_ROOT) return resolve(env.FACTORY_ROOT);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'repos'))) return dir;
    if (dirname(dir) === dir) throw new Error('factory root not found (set FACTORY_ROOT or run inside the factory folder)');
  }
}

/** Creates the real GitHub client on first use, so commands that never touch GitHub need no PAT. */
class LazyGitHub implements GitHub {
  private inner: Promise<GitHub> | undefined;
  private get gh(): Promise<GitHub> {
    this.inner ??= readSecret('github-pat').then((pat) => new OctokitGitHub(pat));
    return this.inner;
  }
  async openPr(p: Parameters<GitHub['openPr']>[0]) {
    return (await this.gh).openPr(p);
  }
  async prState(url: string) {
    return (await this.gh).prState(url);
  }
  async mergePr(url: string, base: string) {
    return (await this.gh).mergePr(url, base);
  }
}

export async function wire(o: WireOptions): Promise<{ engine: Engine; store: BoardStore }> {
  const store = new FileStore(join(o.root, '.factory', 'board.json'));
  const engine = new Engine({
    store,
    git: new LocalGitRepos(o.root),
    github: new LazyGitHub(),
    repos: loadAllRepoConfigs(join(o.root, 'repos')),
    exec: shellExec,
    now: () => new Date(),
    mode: o.mode,
    claimant: process.env.FACTORY_CLAIMANT || `${o.mode}:${hostname()}`,
  });
  return { engine, store };
}
