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
import { OctokitGitHub, type GitHub, type GitHubFor } from './github.js';
import { FactoryConfig } from './factories.js';
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

/** `FACTORY_ROOT`, else the nearest parent folder of the cwd that contains `core/` and `plugin/`. */
export function findRoot(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.FACTORY_ROOT) return resolve(env.FACTORY_ROOT);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'core')) && existsSync(join(dir, 'plugin'))) return dir;
    if (dirname(dir) === dir) throw new Error('factory root not found (set FACTORY_ROOT or run inside the factory folder)');
  }
}

/** One GitHub client per Keychain account, each created on its first call, so commands that never touch GitHub need no PAT. A failed read is not cached. */
class LazyGitHub implements GitHub {
  private inner: Promise<GitHub> | undefined;
  constructor(
    private readonly account: string,
    private readonly read: (account: string) => Promise<string>,
    private readonly make: (pat: string) => GitHub,
  ) {}
  private get gh(): Promise<GitHub> {
    if (!this.inner) {
      const loading = this.read(this.account).then((pat) => this.make(pat));
      loading.catch(() => { if (this.inner === loading) this.inner = undefined; });
      this.inner = loading;
    }
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
  async mergePr(url: string, base: string, protectedBranches?: readonly string[]) {
    return (await this.gh).mergePr(url, base, protectedBranches);
  }
}

/** `GitHubFor` over the Keychain: lazy, and one client per account. */
export function lazyGitHubFor(
  read: (account: string) => Promise<string> = (account) => readSecret(account),
  make: (pat: string) => GitHub = (pat) => new OctokitGitHub(pat),
): GitHubFor {
  const clients = new Map<string, GitHub>();
  return (account) => {
    let c = clients.get(account);
    if (!c) clients.set(account, (c = new LazyGitHub(account, read, make)));
    return c;
  };
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
  listFactoryDefs() { return this.store.then((s) => s.listFactoryDefs()); }
  listFactoryRepos(factoryId?: string) { return this.store.then((s) => s.listFactoryRepos(factoryId)); }
  saveFactoryDef(before: Parameters<BoardStore['saveFactoryDef']>[0], after: Parameters<BoardStore['saveFactoryDef']>[1]) { return this.store.then((s) => s.saveFactoryDef(before, after)); }
  saveFactoryRepo(before: Parameters<BoardStore['saveFactoryRepo']>[0], after: Parameters<BoardStore['saveFactoryRepo']>[1]) { return this.store.then((s) => s.saveFactoryRepo(before, after)); }
  retireLegacySettings() { return this.store.then((s) => s.retireLegacySettings()); }
  listFactoryHealth() { return this.store.then((s) => s.listFactoryHealth()); }
  setFactoryHealth(h: Parameters<BoardStore['setFactoryHealth']>[0]) { return this.store.then((s) => s.setFactoryHealth(h)); }
  getSettings() { return this.store.then((s) => s.getSettings()); }
  setSettings(v: Parameters<BoardStore['setSettings']>[0]) { return this.store.then((s) => s.setSettings(v)); }
  startRun(r: Parameters<BoardStore['startRun']>[0]) { return this.store.then((s) => s.startRun(r)); }
  openRun(taskId: string, step: Parameters<BoardStore['openRun']>[1]) { return this.store.then((s) => s.openRun(taskId, step)); }
  finishRun(runId: string, p: Parameters<BoardStore['finishRun']>[1]) { return this.store.then((s) => s.finishRun(runId, p)); }
  addEvents(e: Parameters<BoardStore['addEvents']>[0]) { return this.store.then((s) => s.addEvents(e)); }
  listEvents(taskId?: string) { return this.store.then((s) => s.listEvents(taskId)); }
  listDocs(taskId: string, kind: Parameters<BoardStore['listDocs']>[1]) { return this.store.then((s) => s.listDocs(taskId, kind)); }
  listRuns(taskId: string) { return this.store.then((s) => s.listRuns(taskId)); }
  updateSettingsScope(...a: Parameters<BoardStore['updateSettingsScope']>) { return this.store.then((s) => s.updateSettingsScope(...a)); }
}

export async function wire(o: WireOptions): Promise<{ engine: Engine; store: BoardStore }> {
  const store: BoardStore = o.store === 'blocks' ? new LazyBlocksStore(o.loadCredential) : new FileStore(join(o.root, '.factory', 'board.json'), { factoriesDir: join(o.root, 'factories'), ...(o.log ? { log: o.log } : {}) });
  const engine = new Engine({
    store,
    git: new LocalGitRepos(o.root),
    githubFor: lazyGitHubFor(),
    factories: async () => new FactoryConfig(await store.listFactoryDefs(), await store.listFactoryRepos()),
    exec: shellExec,
    now: () => new Date(),
    mode: o.mode,
    claimant: process.env.FACTORY_CLAIMANT || `${o.mode}:${hostname()}`,
    ...(o.log ? { log: o.log } : {}),
  });
  return { engine, store };
}
