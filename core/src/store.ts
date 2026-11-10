import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS } from './defaults.js';
import type {
  Approval, Doc, DocKind, FactoryEvent, Mode, RepoId, RepoSettings, Run, Settings, Step, Task,
} from './types.js';

export {
  canonicalJson, CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, sameApproval, updateHeld,
  VersionConflictError,
} from './boardStore.js';
export type { BoardStore, NewApproval, StoredSettings } from './boardStore.js';
import {
  CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, sameApproval, updateHeld,
  VersionConflictError, assertNewStatus, canonicalJson, settingsConflict, type BoardStore, type NewApproval, type NewTask, type StoredSettings,
} from './boardStore.js';

interface State {
  tasks: Task[];
  docs: Doc[];
  /** `approvalId` only when the caller gave one; never returned. */
  approvals: (Approval & { approvalId?: string })[];
  settings: StoredSettings | null;
  runs: Run[];
  events: FactoryEvent[];
}

const emptyState = (): State => ({ tasks: [], docs: [], approvals: [], settings: null, runs: [], events: [] });
const clone = <T>(v: T): T => structuredClone(v);
const num = (id: string) => Number(id.slice(id.indexOf('-') + 1)) || 0;
const publicApproval = ({ approvalId: _id, ...a }: Approval & { approvalId?: string }): Approval => clone(a);
const byStart = (a: Run, b: Run) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0);
const nextId = (prefix: string, ids: string[]) => `${prefix}-${1 + Math.max(0, ...ids.map(num))}`;

export class MemoryStore implements BoardStore {
  protected state: State = emptyState();

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

  getSettings(): Promise<StoredSettings> {
    return this.read(() => clone(this.state.settings ?? { global: DEFAULT_SETTINGS, repos: {} }));
  }

  setSettings(s: StoredSettings) {
    return this.write(() => {
      this.state.settings = clone(s);
    });
  }

  updateSettingsScope(scope: 'global' | RepoId, before: unknown, after: Settings | RepoSettings | null) {
    if (scope === 'global' && after === null) return Promise.reject(new Error('global settings cannot be removed'));
    return this.write(() => {
      const s = this.state.settings ?? { global: clone(DEFAULT_SETTINGS), repos: {} };
      const current = scope === 'global' ? s.global : s.repos[scope];
      if (canonicalJson(current) !== canonicalJson(before)) throw settingsConflict(scope);
      if (scope === 'global') s.global = clone(after as Settings);
      else if (after === null) delete s.repos[scope];
      else s.repos[scope] = clone(after as RepoSettings);
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface FileStoreOptions {
  /** How long a write waits for the lock before it gives up (default 5 s). */
  lockTimeoutMs?: number;
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

  constructor(private readonly path: string, opts: FileStoreOptions = {}) {
    super();
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
    this.state = existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as State) : emptyState();
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
