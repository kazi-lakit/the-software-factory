import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS } from './defaults.js';
import type {
  Approval, Doc, DocKind, FactoryEvent, Mode, RepoId, RepoSettings, Run, Settings, Step, Task,
} from './types.js';

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class VersionConflictError extends Error {
  constructor(taskId: string, expected: number, actual: number) {
    super(`version conflict on ${taskId}: expected ${expected}, found ${actual}`);
    this.name = 'VersionConflictError';
  }
}

export interface StoredSettings {
  global: Settings;
  repos: Partial<Record<RepoId, RepoSettings>>;
}

export interface BoardStore {
  listTasks(): Promise<Task[]>;
  /** Throws NotFoundError. */
  getTask(id: string): Promise<Task>;
  createTask(t: { title: string; description: string; repo: RepoId; baseBranch?: string }): Promise<Task>;
  /** Throws VersionConflictError; returns the stored task with version + 1. */
  updateTask(id: string, expectedVersion: number, patch: Partial<Task>): Promise<Task>;
  addDoc(taskId: string, kind: DocKind, body: string, author: string): Promise<Doc>;
  currentDoc(taskId: string, kind: DocKind): Promise<Doc | undefined>;
  addApproval(a: Omit<Approval, 'at'>): Promise<Approval>;
  listApprovals(taskId: string): Promise<Approval[]>;
  getSettings(): Promise<StoredSettings>;
  /** Dev use only. */
  setSettings(s: StoredSettings): Promise<void>;
  startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }): Promise<Run>;
  openRun(taskId: string, step: Step): Promise<Run | undefined>;
  finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }): Promise<void>;
  addEvents(e: FactoryEvent[]): Promise<void>;
  listEvents(taskId?: string): Promise<FactoryEvent[]>;
}

interface State {
  tasks: Task[];
  docs: Doc[];
  approvals: Approval[];
  settings: StoredSettings | null;
  runs: Run[];
  events: FactoryEvent[];
}

const clone = <T>(v: T): T => structuredClone(v);
const num = (id: string) => Number(id.slice(id.indexOf('-') + 1)) || 0;
const nextId = (prefix: string, ids: string[]) => `${prefix}-${1 + Math.max(0, ...ids.map(num))}`;

export class MemoryStore implements BoardStore {
  protected state: State = { tasks: [], docs: [], approvals: [], settings: null, runs: [], events: [] };

  /** Called synchronously after every mutation. */
  protected persist(): void {}

  private find(id: string): Task {
    const t = this.state.tasks.find((x) => x.taskId === id);
    if (!t) throw new NotFoundError(`task ${id}`);
    return t;
  }

  async listTasks() {
    return clone(this.state.tasks);
  }

  async getTask(id: string) {
    return clone(this.find(id));
  }

  async createTask(t: { title: string; description: string; repo: RepoId; baseBranch?: string }) {
    const task: Task = {
      taskId: nextId('T', this.state.tasks.map((x) => x.taskId)),
      title: t.title,
      description: t.description,
      repo: t.repo,
      baseBranch: t.baseBranch ?? 'dev',
      status: 'inbox',
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
    this.persist();
    return clone(task);
  }

  async updateTask(id: string, expectedVersion: number, patch: Partial<Task>) {
    if ('taskId' in patch || 'version' in patch) throw new Error('patch must not change taskId or version');
    const t = this.find(id);
    if (t.version !== expectedVersion) throw new VersionConflictError(id, expectedVersion, t.version);
    Object.assign(t, clone(patch));
    t.version += 1;
    this.persist();
    return clone(t);
  }

  async addDoc(taskId: string, kind: DocKind, body: string, author: string) {
    const prior = this.state.docs.filter((d) => d.taskId === taskId && d.kind === kind);
    for (const d of prior) d.status = 'superseded';
    const doc: Doc = {
      taskId, kind, version: Math.max(0, ...prior.map((d) => d.version)) + 1, body, author, status: 'current',
    };
    this.state.docs.push(doc);
    this.persist();
    return clone(doc);
  }

  async currentDoc(taskId: string, kind: DocKind) {
    const d = this.state.docs.find((x) => x.taskId === taskId && x.kind === kind && x.status === 'current');
    return d ? clone(d) : undefined;
  }

  async addApproval(a: Omit<Approval, 'at'>) {
    const approval: Approval = { ...a, at: new Date().toISOString() };
    this.state.approvals.push(approval);
    this.persist();
    return clone(approval);
  }

  async listApprovals(taskId: string) {
    return clone(this.state.approvals.filter((a) => a.taskId === taskId));
  }

  async getSettings(): Promise<StoredSettings> {
    return clone(this.state.settings ?? { global: DEFAULT_SETTINGS, repos: {} });
  }

  async setSettings(s: StoredSettings) {
    this.state.settings = clone(s);
    this.persist();
  }

  async startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }) {
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
    this.persist();
    return clone(run);
  }

  async openRun(taskId: string, step: Step) {
    const open = this.state.runs.filter((r) => r.taskId === taskId && r.step === step && r.endedAt === null);
    const last = open[open.length - 1];
    return last ? clone(last) : undefined;
  }

  async finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }) {
    const run = this.state.runs.find((r) => r.runId === runId);
    if (!run) throw new NotFoundError(`run ${runId}`);
    Object.assign(run, p, { endedAt: new Date().toISOString() });
    this.persist();
  }

  async addEvents(e: FactoryEvent[]) {
    this.state.events.push(...clone(e));
    this.persist();
  }

  async listEvents(taskId?: string) {
    return clone(taskId === undefined ? this.state.events : this.state.events.filter((e) => e.taskId === taskId));
  }
}

export class FileStore extends MemoryStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) this.state = JSON.parse(readFileSync(path, 'utf8')) as State;
  }

  protected override persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}
