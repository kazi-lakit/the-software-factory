import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ClientCredentialsToken } from './blocks/token.js';
import { loadBlocksCredential, type BlocksCredential } from './blocks/credential.js';
import { SdkBlocksData } from './blocks/data.js';
import { BlocksStore } from './blocks/store.js';
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
  /** Test seam: replaces the Keychain credential read for `--store blocks`. */
  loadCredential?: () => Promise<BlocksCredential>;
  /** Where the engine's operational notes go. */
  log?: (msg: string) => void;
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
  async findOpenPr(p: Parameters<GitHub['findOpenPr']>[0]) {
    return (await this.gh).findOpenPr(p);
  }
  async prState(url: string) {
    return (await this.gh).prState(url);
  }
  async mergePr(url: string, base: string) {
    return (await this.gh).mergePr(url, base);
  }
}

/** Builds the Blocks store on the first call (one credential read, a failure is not cached), so file-store commands never touch the Keychain. */
export class LazyBlocksStore implements BoardStore {
  private inner: Promise<BoardStore> | undefined;
  constructor(
    private readonly load: () => Promise<BlocksCredential> = () => loadBlocksCredential(),
    private readonly make: (cred: BlocksCredential) => BoardStore = (cred) =>
      new BlocksStore(
        new SdkBlocksData({ apiUrl: cred.apiUrl, projectKey: cred.projectKey, token: new ClientCredentialsToken(cred) }),
        'core',
      ),
  ) {}
  private get store(): Promise<BoardStore> {
    if (!this.inner) {
      const loading = this.load().then((cred) => this.make(cred));
      // One handler per load, and it clears only its own load: a newer one started meanwhile is kept.
      loading.catch(() => { if (this.inner === loading) this.inner = undefined; });
      this.inner = loading;
    }
    return this.inner;
  }
  listTasks() { return this.store.then((s) => s.listTasks()); }
  getTask(id: string) { return this.store.then((s) => s.getTask(id)); }
  createTask(t: Parameters<BoardStore['createTask']>[0]) { return this.store.then((s) => s.createTask(t)); }
  updateTask(id: string, v: number, patch: Parameters<BoardStore['updateTask']>[2]) { return this.store.then((s) => s.updateTask(id, v, patch)); }
  addDoc(taskId: string, kind: Parameters<BoardStore['addDoc']>[1], body: string, author: string) { return this.store.then((s) => s.addDoc(taskId, kind, body, author)); }
  currentDoc(taskId: string, kind: Parameters<BoardStore['currentDoc']>[1]) { return this.store.then((s) => s.currentDoc(taskId, kind)); }
  addApproval(a: Parameters<BoardStore['addApproval']>[0]) { return this.store.then((s) => s.addApproval(a)); }
  listApprovals(taskId: string) { return this.store.then((s) => s.listApprovals(taskId)); }
  getSettings() { return this.store.then((s) => s.getSettings()); }
  setSettings(v: Parameters<BoardStore['setSettings']>[0]) { return this.store.then((s) => s.setSettings(v)); }
  startRun(r: Parameters<BoardStore['startRun']>[0]) { return this.store.then((s) => s.startRun(r)); }
  openRun(taskId: string, step: Parameters<BoardStore['openRun']>[1]) { return this.store.then((s) => s.openRun(taskId, step)); }
  finishRun(runId: string, p: Parameters<BoardStore['finishRun']>[1]) { return this.store.then((s) => s.finishRun(runId, p)); }
  addEvents(e: Parameters<BoardStore['addEvents']>[0]) { return this.store.then((s) => s.addEvents(e)); }
  listEvents(taskId?: string) { return this.store.then((s) => s.listEvents(taskId)); }
}

export async function wire(o: WireOptions): Promise<{ engine: Engine; store: BoardStore }> {
  const store: BoardStore = o.store === 'blocks' ? new LazyBlocksStore(o.loadCredential) : new FileStore(join(o.root, '.factory', 'board.json'));
  const engine = new Engine({
    store,
    git: new LocalGitRepos(o.root),
    github: new LazyGitHub(),
    repos: loadAllRepoConfigs(join(o.root, 'repos')),
    exec: shellExec,
    now: () => new Date(),
    mode: o.mode,
    claimant: process.env.FACTORY_CLAIMANT || `${o.mode}:${hostname()}`,
    ...(o.log ? { log: o.log } : {}),
  });
  return { engine, store };
}
