import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS } from './defaults.js';
import type { FactoryDef, FactoryHealth, FactoryRepo } from './factories.js';
import { loadFactoriesFromDir } from './factoriesFs.js';
import { withLinkDefaults, type GitHubLink } from './githubLink.js';
import type {
  Approval, Doc, DocKind, FactoryEvent, Mode, RepoSettings, Run, Settings, Step, Task,
} from './types.js';

export {
  canonicalJson, CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, sameApproval, updateHeld,
  VersionConflictError,
} from './boardStore.js';
export type { BoardStore, NewApproval, StoredSettings, StoreIdentity } from './boardStore.js';
import {
  CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, sameApproval, updateHeld,
  VersionConflictError, assertNewStatus, canonicalJson, parseScope, settingsConflict, type BoardStore, type NewApproval, type NewTask, type StoredSettings,
  type StoreIdentity,
} from './boardStore.js';

interface State {
  tasks: Task[];
  docs: Doc[];
  /** `approvalId` only when the caller gave one; never returned. */
  approvals: (Approval & { approvalId?: string })[];
  settings: StoredSettings | null;
  runs: Run[];
  events: FactoryEvent[];
  factoryDefs: FactoryDef[];
  factoryRepos: FactoryRepo[];
  health: FactoryHealth[];
  githubLinks: GitHubLink[];
}

const emptyState = (): State => ({
  tasks: [], docs: [], approvals: [], settings: null, runs: [], events: [], factoryDefs: [], factoryRepos: [], health: [], githubLinks: [],
});
const clone = <T>(v: T): T => structuredClone(v);
const num = (id: string) => Number(id.slice(id.indexOf('-') + 1)) || 0;
const publicApproval = ({ approvalId: _id, ...a }: Approval & { approvalId?: string }): Approval => clone(a);
const byStart = (a: Run, b: Run) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);
/** The row a compare-and-set save stores: version 1 for an insert, else the stored version + 1. */
function versionedSave<T extends { version: number }>(what: string, current: T | undefined, before: T | null, after: T): T {
  if (before === null) {
    if (current) throw new VersionConflictError(what, 0, current.version, `${what} already exists; reload and save again`);
    return { ...clone(after), version: 1 };
  }
  if (!current || current.version !== before.version) {
    throw new VersionConflictError(what, before.version, current?.version ?? 0, `${what} changed since it was read; reload and save again`);
  }
  return { ...clone(after), version: current.version + 1 };
}
const nextId = (prefix: string, ids: string[]) => `${prefix}-${1 + Math.max(0, ...ids.map(num))}`;

export interface MemoryStoreOptions {
  /** Who calls: the owner-only and core-only methods refuse the other. Left out, nothing is checked (tests, dev). */
  identity?: StoreIdentity;
  /** Definitions the store starts with (tests, dev). A FileStore reads them from `<dir>/factories` instead. */
  factories?: { defs: FactoryDef[]; repos: FactoryRepo[] };
}

export class MemoryStore implements BoardStore {
  protected state: State = emptyState();
  protected readonly identity: StoreIdentity | undefined;

  constructor(opts: MemoryStoreOptions = {}) {
    this.identity = opts.identity;
    if (opts.factories) this.state = { ...emptyState(), factoryDefs: clone(opts.factories.defs), factoryRepos: clone(opts.factories.repos) };
  }

  private ownerOnly(method: string): void {
    if (this.identity === 'core') throw new OwnerOnlyError(`${method} is done on the Board, not by the factory core`);
  }

  private coreOnly(method: string): void {
    if (this.identity === 'owner') throw new ForbiddenError(`${method} is done by the factory core, not on the Board`);
  }

  /** Runs a read against the current state. */
  protected async read<T>(fn: () => T): Promise<T> {
    return fn();
  }

  /** Runs a mutation against the current state; FileStore makes it a locked reload-modify-persist. */
  protected async write<T>(fn: () => T): Promise<T> {
    return fn();
  }

  private find(id: string): Task {
    const t = this.state.tasks.find((x) => x.taskId === id);
    if (!t) throw new NotFoundError(`task ${id}`);
    return t;
  }

  listTasks() {
    return this.read(() => clone(this.state.tasks));
  }

  getTask(id: string) {
    return this.read(() => clone(this.find(id)));
  }

  async createTask(t: NewTask) {
    assertNewStatus(t.status);
    return this.write(() => {
      const task: Task = {
        taskId: nextId('T', this.state.tasks.map((x) => x.taskId)),
        factoryId: t.factoryId,
        title: t.title,
        description: t.description,
        repo: t.repo,
        baseBranch: t.baseBranch ?? 'dev',
        status: t.status ?? 'inbox',
        stage: null,
        branch: null,
        prUrl: null,
        attempt: 0,
        blockedReason: null,
        question: null,
        answer: null,
        gateOverrides: {},
        dependsOn: [...(t.dependsOn ?? [])],
        claimBy: null,
        claimUntil: null,
        costUsd: 0,
        version: 1,
      };
      this.state.tasks.push(task);
      return clone(task);
    });
  }

  async updateTask(id: string, expectedVersion: number, patch: Partial<Task>) {
    if ('taskId' in patch || 'version' in patch) throw new Error('patch must not change taskId or version');
    return this.write(() => {
      const t = this.find(id);
      if (t.version !== expectedVersion) throw new VersionConflictError(id, expectedVersion, t.version);
      Object.assign(t, clone(patch));
      t.version += 1;
      return clone(t);
    });
  }

  addDoc(taskId: string, kind: DocKind, body: string, author: string) {
    return this.write(() => {
      const prior = this.state.docs.filter((d) => d.taskId === taskId && d.kind === kind);
      for (const d of prior) d.status = 'superseded';
      const doc: Doc = {
        taskId, kind, version: Math.max(0, ...prior.map((d) => d.version)) + 1, body, author, status: 'current',
      };
      this.state.docs.push(doc);
      return clone(doc);
    });
  }

  currentDoc(taskId: string, kind: DocKind) {
    return this.read(() => {
      const d = this.state.docs.find((x) => x.taskId === taskId && x.kind === kind && x.status === 'current');
      return d ? clone(d) : undefined;
    });
  }

  listDocs(taskId: string, kind: DocKind) {
    return this.read(() => {
      const docs = this.state.docs.filter((d) => d.taskId === taskId && d.kind === kind).sort((a, b) => a.version - b.version);
      return docs.map((d, i): Doc => ({ ...clone(d), status: i === docs.length - 1 ? 'current' : 'superseded' }));
    });
  }

  addApproval({ approvalId, ...a }: NewApproval) {
    return this.write(() => {
      const stored = approvalId === undefined ? undefined : this.state.approvals.find((x) => x.approvalId === approvalId);
      if (stored) {
        if (!sameApproval(stored, a)) throw new Error('addApproval: approval id already taken');
        return publicApproval(stored);
      }
      const approval: Approval = { ...a, at: new Date().toISOString() };
      this.state.approvals.push(approvalId === undefined ? approval : { ...approval, approvalId });
      return clone(approval);
    });
  }

  listApprovals(taskId: string) {
    return this.read(() => this.state.approvals.filter((a) => a.taskId === taskId).map(publicApproval));
  }

  listFactoryDefs() {
    return this.read(() => clone(this.state.factoryDefs));
  }

  listFactoryRepos(factoryId?: string) {
    return this.read(() => clone(this.state.factoryRepos.filter((r) => factoryId === undefined || r.factoryId === factoryId)));
  }

  async saveFactoryDef(before: FactoryDef | null, after: FactoryDef) {
    this.ownerOnly('saveFactoryDef');
    return this.write(() => {
      const defs = this.state.factoryDefs;
      const i = defs.findIndex((d) => d.factoryId === after.factoryId);
      const stored = versionedSave(`factory ${after.factoryId}`, defs[i], before, after);
      if (i < 0) defs.push(stored);
      else defs[i] = stored;
      return clone(stored);
    });
  }

  async saveFactoryRepo(before: FactoryRepo | null, after: FactoryRepo) {
    this.ownerOnly('saveFactoryRepo');
    return this.write(() => {
      const repos = this.state.factoryRepos;
      const i = repos.findIndex((r) => r.factoryId === after.factoryId && r.repoId === after.repoId);
      const stored = versionedSave(`repo ${after.factoryId}/${after.repoId}`, repos[i], before, after);
      if (i < 0) repos.push(stored);
      else repos[i] = stored;
      return clone(stored);
    });
  }

  listGitHubLinks(factoryId?: string) {
    return this.read(() => clone(this.state.githubLinks.filter((l) => factoryId === undefined || l.factoryId === factoryId).map(withLinkDefaults)));
  }

  getGitHubLink(taskId: string) {
    return this.read(() => {
      const l = this.state.githubLinks.find((x) => x.taskId === taskId);
      return l ? clone(withLinkDefaults(l)) : undefined;
    });
  }

  async saveGitHubLink(before: GitHubLink | null, after: GitHubLink) {
    this.coreOnly('saveGitHubLink');
    return this.write(() => {
      const links = this.state.githubLinks;
      const i = links.findIndex((l) => l.taskId === after.taskId);
      const stored = versionedSave(`GitHub link ${after.taskId}`, links[i], before, after);
      if (i < 0) links.push(stored);
      else links[i] = stored;
      return clone(stored);
    });
  }

  listFactoryHealth() {
    return this.read(() => clone(this.state.health));
  }

  async setFactoryHealth(h: FactoryHealth) {
    this.coreOnly('setFactoryHealth');
    return this.write(() => {
      const i = this.state.health.findIndex((x) => x.factoryId === h.factoryId);
      if (i < 0) this.state.health.push(clone(h));
      else this.state.health[i] = clone(h);
    });
  }

  /** A file or memory store converts the legacy shape on load: there is nothing to retire. */
  async retireLegacySettings(): Promise<{ retired: string[]; remaining: string[] }> {
    this.ownerOnly('retireLegacySettings');
    return { retired: [], remaining: [] };
  }

  async legacySettingsStatus(): Promise<{ unmoved: string[]; unretired: string[] }> {
    return { unmoved: [], unretired: [] };
  }

  getSettings(): Promise<StoredSettings> {
    return this.read(() => clone(this.state.settings ?? { factories: {} }));
  }

  setSettings(s: StoredSettings) {
    return this.write(() => {
      this.state.settings = clone(s);
    });
  }

  async updateSettingsScope(scope: string, before: unknown, after: Settings | RepoSettings | null) {
    this.ownerOnly('updateSettingsScope');
    const { factoryId, repoId } = parseScope(scope);
    if (repoId === undefined && after === null) throw new Error('factory settings cannot be removed');
    return this.write(() => {
      const s: StoredSettings = this.state.settings ?? { factories: {} };
      const entry = s.factories[factoryId];
      const current = repoId === undefined ? (entry?.factory ?? DEFAULT_SETTINGS) : entry?.repos[repoId];
      if (canonicalJson(current) !== canonicalJson(before)) throw settingsConflict(scope);
      const target = (s.factories[factoryId] ??= { factory: clone(DEFAULT_SETTINGS), repos: {} });
      if (repoId === undefined) target.factory = clone(after as Settings);
      else if (after === null) delete target.repos[repoId];
      else target.repos[repoId] = clone(after as RepoSettings);
      this.state.settings = s;
    });
  }

  startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }) {
    return this.write(() => {
      const run: Run = {
        runId: nextId('R', this.state.runs.map((x) => x.runId)),
        ...r,
        startedAt: new Date().toISOString(),
        endedAt: null,
        result: null,
        turns: null,
        costUsd: null,
      };
      this.state.runs.push(run);
      return clone(run);
    });
  }

  openRun(taskId: string, step: Step) {
    return this.read(() => {
      const open = this.state.runs.filter((r) => r.taskId === taskId && r.step === step && r.endedAt === null);
      const last = open[open.length - 1];
      return last ? clone(last) : undefined;
    });
  }

  finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }) {
    return this.write(() => {
      const run = this.state.runs.find((r) => r.runId === runId);
      if (!run) throw new NotFoundError(`run ${runId}`);
      Object.assign(run, p, { endedAt: new Date().toISOString() });
    });
  }

  listRuns(taskId: string) {
    return this.read(() => clone(this.state.runs.filter((r) => r.taskId === taskId).sort(byStart)));
  }

  addEvents(e: FactoryEvent[]) {
    return this.write(() => {
      this.state.events.push(...clone(e));
    });
  }

  listEvents(taskId?: string) {
    return this.read(() =>
      clone(taskId === undefined ? this.state.events : this.state.events.filter((e) => e.taskId === taskId)),
    );
  }
}

/** Until `factory migrate` runs, what a store written before factories holds is the Blocks factory's. */
const LEGACY_FACTORY = 'blocks';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FileStoreOptions extends Omit<MemoryStoreOptions, 'factories'> {
  /** How long a write waits for the lock before it gives up (default 5 s). */
  lockTimeoutMs?: number;
  /** Where definitions are seeded from the first time the store has none (`<root>/factories`). Left out: no seeding. */
  factoriesDir?: string;
  /** Told why a definition file was skipped while seeding. */
  log?: (line: string) => void;
}

/** A lock file older than this belongs to a crashed writer and may be removed. */
const STALE_LOCK_MS = 30_000;

/**
 * A JSON file shared by several factory processes. Every call reloads the file; every write holds
 * `<path>.lock` while it reloads, changes and persists, so no process overwrites another's write.
 */
export class FileStore extends MemoryStore {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly factoriesDir: string | undefined;
  private readonly log: ((line: string) => void) | undefined;
  /** Read again only when a factory.yaml changed (newest mtime + file count): a bad file is reported once per change. */
  private seeded: { key: string; defs: FactoryDef[]; repos: FactoryRepo[] } | undefined;

  constructor(private readonly path: string, opts: FileStoreOptions = {}) {
    super(opts);
    this.factoriesDir = opts.factoriesDir;
    this.log = opts.log;
    this.lockPath = `${path}.lock`;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5_000;
    this.reload();
  }

  protected override async read<T>(fn: () => T): Promise<T> {
    this.reload();
    return fn();
  }

  protected override async write<T>(fn: () => T): Promise<T> {
    const fd = await this.lock();
    try {
      this.reload();
      const result = fn();
      this.persist();
      return result;
    } finally {
      closeSync(fd);
      rmSync(this.lockPath, { force: true });
    }
  }

  private reload(): void {
    const raw = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>) : {};
    this.state = this.upgrade(raw);
  }

  /**
   * A file written before factories: its tasks and events belong to factory `blocks`, and its `{ global, repos }`
   * settings are that factory's. Definitions the file lacks are seeded from `factoriesDir` (see loadFactoriesFromDir), and
   * each stored definition's `github` block is taken from its valid `factory.yaml` (re-read when one changed), or removed.
   */
  private upgrade(raw: Record<string, unknown>): State {
    const state = { ...emptyState(), ...raw } as State;
    state.tasks = state.tasks.map((t) => ({ ...t, factoryId: t.factoryId ?? LEGACY_FACTORY, dependsOn: t.dependsOn ?? [] }));
    state.events = state.events.map((e) => ({ ...e, factoryId: e.factoryId ?? LEGACY_FACTORY }));
    const legacy = state.settings as unknown as { global?: Settings; repos?: Record<string, RepoSettings> } | null;
    if (legacy && 'global' in legacy) {
      state.settings = { factories: { [LEGACY_FACTORY]: { factory: legacy.global ?? clone(DEFAULT_SETTINGS), repos: legacy.repos ?? {} } } };
    }
    if (this.factoriesDir === undefined) return state;
    const key = this.yamlKey(this.factoriesDir);
    if (this.seeded?.key !== key) {
      this.seeded = { key, ...loadFactoriesFromDir(this.factoriesDir, (file, reason) => this.log?.(`skipped ${file}: ${reason}`)) };
    }
    if (state.factoryDefs.length === 0 && state.factoryRepos.length === 0) {
      state.factoryDefs = clone(this.seeded.defs);
      state.factoryRepos = clone(this.seeded.repos);
    }
    // factory.yaml is the source of truth for `github`: a stored def takes the valid YAML's block, or none.
    const yaml = new Map(this.seeded.defs.map((d) => [d.factoryId, d]));
    state.factoryDefs = state.factoryDefs.map(({ github: _stored, ...def }) => {
      const github = yaml.get(def.factoryId)?.github;
      return github ? { ...def, github: clone(github) } : def;
    });
    return state;
  }

  /** The newest mtime of every factory.yaml under the factories dir, plus their count: it changes when one is edited, added or removed. */
  private yamlKey(dir: string): string {
    let newest = 0;
    let count = 0;
    if (existsSync(dir)) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        try {
          newest = Math.max(newest, statSync(join(dir, e.name, 'factory.yaml')).mtimeMs);
          count++;
        } catch { /* no factory.yaml here */ }
      }
    }
    return `${newest}:${count}`;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }

  private async lock(): Promise<number> {
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        return openSync(this.lockPath, 'wx');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      if (this.lockIsStale()) {
        rmSync(this.lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`board store is locked (${this.lockPath}); another factory process is writing, or remove the lock file`);
      }
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }

  private lockIsStale(): boolean {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      return false; // released meanwhile: just try again
    }
  }
}
