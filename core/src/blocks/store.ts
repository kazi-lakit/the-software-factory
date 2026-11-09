import { createHash, randomUUID } from 'node:crypto';
import { DocTooLargeError, MAX_DOC_BYTES } from '../limits.js';
import { DEFAULT_SETTINGS } from '../defaults.js';
import {
  CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, VersionConflictError,
  type BoardStore, type StoredSettings,
} from '../store.js';
import type {
  Approval, Doc, DocKind, FactoryEvent, Gate, Mode, RepoId, RepoSettings, Run, Settings, Step, Task,
} from '../types.js';
import { BlocksForbiddenError, BlocksUnauthorizedError, type BlocksData, type Filter, type Row } from './data.js';
import type { SchemaName } from './schema.js';
import { classifyUpdate, settleConditionalUpdate, type RereadResult, type WriteOutcome } from './update.js';

export { DocTooLargeError, MAX_DOC_BYTES, OwnerOnlyError };

/** Task fields the factory core may change; everything else is the owner's, on the Board. */
export const CORE_TASK_FIELDS: readonly (keyof Task)[] = [
  'status', 'stage', 'branch', 'prUrl', 'attempt', 'blockedReason', 'question', 'answer', 'claimBy', 'claimUntil', 'costUsd',
];

type Value = string | number | null;
const TASK_KEYS = new Set<string>([
  'title', 'description', 'repo', 'baseBranch', 'gateOverrides', ...CORE_TASK_FIELDS,
]);
/** A current doc with the same body and author counts as a lost-reply retry only if it was created this recently. */
export const DOC_RETRY_WINDOW_MS = 120_000;
/** createTask and addDoc re-read and retry a duplicate key this many times. */
const DUPLICATE_RETRIES = 3;
/** updateTask reads the task back this many times after its write landed. */
const REREAD_ATTEMPTS = 3;

/** A JSON object, or undefined for null, malformed JSON or any non-object: one bad Board row must not stop a read. */
function parseObject(v: Value | undefined): Record<string, unknown> | undefined {
  if (v === null || v === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(v));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Blocks may send CreatedDate without a zone; it is UTC then, never local time. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const parseUtc = (v: Value | undefined): number => {
  const s = text(v);
  return Date.parse(ZONED.test(s) ? s : `${s}Z`);
};

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const str = (v: Value | undefined): string | null => (v === null || v === undefined ? null : String(v));
const text = (v: Value | undefined): string => String(v ?? '');
const num = (v: Value | undefined): number => Number(v ?? 0);
const decimalText = (n: number | null): string | null => (n === null ? null : String(n));

function encodeTaskValue(key: keyof Task, value: Task[keyof Task]): Value {
  if (key === 'gateOverrides') return JSON.stringify(value);
  if (key === 'costUsd') return String(value);
  return value as Value;
}

function decodeTask(r: Row): Task {
  return {
    taskId: text(r.taskId),
    title: text(r.title),
    description: text(r.description),
    repo: text(r.repo) as RepoId,
    baseBranch: text(r.baseBranch),
    status: text(r.status) as Task['status'],
    stage: str(r.stage) as Step | null,
    branch: str(r.branch),
    prUrl: str(r.prUrl),
    attempt: num(r.attempt),
    blockedReason: str(r.blockedReason),
    question: str(r.question),
    answer: str(r.answer),
    gateOverrides: (parseObject(r.gateOverrides) ?? {}) as Task['gateOverrides'],
    claimBy: str(r.claimBy),
    claimUntil: str(r.claimUntil),
    costUsd: num(r.costUsd),
    version: num(r.version),
  };
}

const decodeDoc = (r: Row): Doc => ({
  taskId: text(r.taskId), kind: text(r.kind) as DocKind, version: num(r.version), body: text(r.body), author: text(r.author), status: 'current',
});

const decodeApproval = (r: Row): Approval => ({
  taskId: text(r.taskId), gate: text(r.gate) as Gate, docVersion: num(r.docVersion),
  decision: text(r.decision) as Approval['decision'], comment: text(r.comment), at: text(r.at),
});

const decodeRun = (r: Row): Run => ({
  runId: text(r.runId), taskId: text(r.taskId), step: text(r.step) as Step, mode: text(r.mode) as Mode, agent: text(r.agent),
  startedAt: text(r.startedAt), endedAt: str(r.endedAt), result: str(r.result),
  turns: r.turns === null || r.turns === undefined ? null : Number(r.turns),
  costUsd: r.costUsd === null || r.costUsd === undefined ? null : Number(r.costUsd),
});

const decodeEvent = (r: Row): FactoryEvent => ({
  taskId: text(r.taskId), actor: text(r.actor), action: text(r.action) as FactoryEvent['action'],
  field: str(r.field), from: str(r.from), to: str(r.to), reason: text(r.reason), at: text(r.at),
});

/** Fixed key order, so a retried event hashes to the same eventId. */
const eventId = (e: FactoryEvent) =>
  sha256(JSON.stringify({ taskId: e.taskId, actor: e.actor, action: e.action, field: e.field, from: e.from, to: e.to, reason: e.reason, at: e.at }));

const highest = (rows: Row[]): Row | undefined =>
  rows.reduce<Row | undefined>((top, r) => (top === undefined || num(r.version) > num(top.version) ? r : top), undefined);

const taskNumber = (id: Value) => {
  const m = /^T-(\d+)$/.exec(text(id));
  return m ? Number(m[1]) : 0;
};

/** A settled update; `seenVersion` is the version the last re-read found (NaN if none). */
type Settled = { kind: 'applied' | 'forbidden' } | { kind: 'conflict' | 'unauthorized' | 'reconcile'; seenVersion: number };

/** A stored version that is not a number (null, a row made outside the factory) cannot take a compare-and-set. */
const hasVersion = (r: Row): boolean => typeof r.version === 'number';

const byAt = <T extends { at: string }>(xs: T[]) => xs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

/**
 * A BoardStore on Blocks Data. `identity` says who is calling: the factory core may only change the
 * CORE_TASK_FIELDS of a task and may not create tasks, approvals or settings (the owner does those on
 * the Board). Every conditional update goes through settleConditionalUpdate.
 */
export class BlocksStore implements BoardStore {
  private readonly now: () => Date;
  /**
   * Writes whose outcome a settle left unknown, per row and expected version. The caller's retry of the same update
   * (same row, same version) re-sends with a new writeId; these let it recognise an earlier write that has landed since.
   */
  private readonly pending = new Map<string, string[]>();

  /** `now` decides the addDoc retry window (default: real time). */
  constructor(private readonly data: BlocksData, private readonly identity: 'core' | 'owner', opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  private ownerOnly(method: string): void {
    if (this.identity !== 'owner') throw new OwnerOnlyError(`${method} is done on the Board, not by the factory core`);
  }

  async listTasks(): Promise<Task[]> {
    const rows = await this.data.list('FactoryTask', {});
    return rows.map(decodeTask).sort((a, b) => taskNumber(a.taskId) - taskNumber(b.taskId));
  }

  async getTask(id: string): Promise<Task> {
    const rows = await this.data.list('FactoryTask', { taskId: id });
    if (rows.length === 0) throw new NotFoundError(`task ${id}`);
    if (rows.length > 1) throw new Error(`task ${id} has ${rows.length} rows`);
    return decodeTask(rows[0]!);
  }

  async createTask(t: { title: string; description: string; repo: RepoId; baseBranch?: string }): Promise<Task> {
    this.ownerOnly('createTask');
    for (let attempt = 0; attempt <= DUPLICATE_RETRIES; attempt++) {
      const ids = await this.data.list('FactoryTask', {}, ['taskId']);
      const taskId = `T-${1 + Math.max(0, ...ids.map((r) => taskNumber(r.taskId)))}`;
      const task: Task = {
        taskId,
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
      const row: Record<string, Value> = {};
      for (const [key, value] of Object.entries(task)) row[key] = encodeTaskValue(key as keyof Task, value);
      const r = await this.data.insert('FactoryTask', row);
      if (r.kind === 'inserted') return task;
      if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactoryTask');
    }
    throw new Error(`createTask: task id still taken after ${DUPLICATE_RETRIES} retries`);
  }

  async updateTask(id: string, expectedVersion: number, patch: Partial<Task>): Promise<Task> {
    if ('taskId' in patch || 'version' in patch) throw new Error('patch must not change taskId or version');
    const input: Record<string, Value> = {};
    for (const [key, value] of Object.entries(patch) as [keyof Task, Task[keyof Task] | undefined][]) {
      if (this.identity === 'core' && !CORE_TASK_FIELDS.includes(key)) throw new CoreFieldError(key);
      if (!TASK_KEYS.has(key)) throw new Error(`unknown task field ${key}`);
      if (value !== undefined) input[key] = encodeTaskValue(key, value);
    }
    // getTask reads a null version as 0; no factory row has version 0, so only then is the row checked.
    if (!(expectedVersion >= 1)) {
      const [row] = await this.data.list('FactoryTask', { taskId: id }, ['version']);
      if (row && !hasVersion(row)) throw new MissingVersionError('FactoryTask', id);
    }
    const outcome = await this.settle('FactoryTask', { taskId: id }, expectedVersion, input);
    if (outcome.kind === 'applied') return this.rereadTask(id);
    throw this.settleError(outcome, `task ${id}`, id, expectedVersion);
  }

  /** The write landed: sending it again would conflict with itself, so only the read is retried. */
  private async rereadTask(id: string): Promise<Task> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.getTask(id);
      } catch {
        if (attempt >= REREAD_ATTEMPTS) throw new RereadAfterUpdateError(id);
      }
    }
  }

  async addDoc(taskId: string, kind: DocKind, body: string, author: string): Promise<Doc> {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MAX_DOC_BYTES) throw new DocTooLargeError(bytes);
    const bodySha256 = sha256(body);
    for (let attempt = 0; attempt <= DUPLICATE_RETRIES; attempt++) {
      const top = highest(await this.data.list('FactoryDoc', { taskId, kind }, ['version', 'bodySha256', 'author', 'CreatedDate']));
      // The same body from the same author, created moments ago, is a retry whose reply was lost. Later, an
      // identical body is a new version (as in MemoryStore): a rewrite after "changes" must not keep the old
      // version, or the "changes" approval would still match it.
      if (top && top.bodySha256 === bodySha256 && top.author === author && this.isRecent(top.CreatedDate)) {
        return { taskId, kind, version: num(top.version), body, author, status: 'current' };
      }
      const version = (top ? num(top.version) : 0) + 1;
      const r = await this.data.insert('FactoryDoc', { docKey: `${taskId}:${kind}:${version}`, taskId, kind, version, body, bodySha256, author });
      if (r.kind === 'inserted') return { taskId, kind, version, body, author, status: 'current' };
      if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactoryDoc');
    }
    throw new Error(`addDoc: ${taskId} ${kind} version still taken after ${DUPLICATE_RETRIES} retries`);
  }

  /** A CreatedDate in the future (clock skew) counts as recent. */
  private isRecent(createdDate: Value | undefined): boolean {
    const created = parseUtc(createdDate);
    return Number.isFinite(created) && this.now().getTime() - created <= DOC_RETRY_WINDOW_MS;
  }

  /** Older versions are superseded only in that a higher version exists; no status is stored. */
  async currentDoc(taskId: string, kind: DocKind): Promise<Doc | undefined> {
    const top = highest(await this.data.list('FactoryDoc', { taskId, kind }, ['version', 'docKey']));
    if (!top) return undefined;
    const [row] = await this.data.list('FactoryDoc', { docKey: text(top.docKey) });
    return row ? decodeDoc(row) : undefined;
  }

  async addApproval(a: Omit<Approval, 'at'>): Promise<Approval> {
    this.ownerOnly('addApproval');
    const approval: Approval = { taskId: a.taskId, gate: a.gate, docVersion: a.docVersion, decision: a.decision, comment: a.comment, at: this.now().toISOString() };
    const r = await this.data.insert('FactoryApproval', { approvalId: randomUUID(), ...approval });
    if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactoryApproval');
    if (r.kind === 'duplicate') throw new Error('addApproval: approval id already taken');
    return approval;
  }

  async listApprovals(taskId: string): Promise<Approval[]> {
    return byAt((await this.data.list('FactoryApproval', { taskId })).map(decodeApproval));
  }

  async getSettings(): Promise<StoredSettings> {
    const rows = await this.data.list('FactorySettings', {});
    const global: Settings = { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates } };
    const repos: StoredSettings['repos'] = {};
    for (const r of rows) {
      // A null json is a repo scope that setSettings removed (rows are never deleted); a malformed one is skipped.
      const value = parseObject(r.json) as Partial<Settings> | RepoSettings | undefined;
      if (value === undefined) continue;
      if (r.scope === 'global') Object.assign(global, value, { gates: { ...global.gates, ...value.gates } });
      else repos[text(r.scope) as RepoId] = value as RepoSettings;
    }
    return { global, repos };
  }

  async setSettings(s: StoredSettings): Promise<void> {
    this.ownerOnly('setSettings');
    const existing = await this.data.list('FactorySettings', {}, ['scope']);
    const wanted = new Map<string, string>([['global', JSON.stringify(s.global)]]);
    for (const [scope, value] of Object.entries(s.repos)) if (value !== undefined) wanted.set(scope, JSON.stringify(value));
    // Rows cannot be deleted, so a repo scope left out is written as null json.
    for (const r of existing) if (!wanted.has(text(r.scope))) wanted.set(text(r.scope), 'null');
    for (const [scope, json] of wanted) await this.writeSettings(scope, json);
  }

  private async writeSettings(scope: string, json: string, raced = false): Promise<void> {
    const [row] = await this.data.list('FactorySettings', { scope }, ['version', 'json']);
    if (!row) {
      const r = await this.data.insert('FactorySettings', { scope, json, version: 1 });
      if (r.kind === 'inserted') return;
      if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactorySettings');
      // Someone inserted the scope meanwhile: update their row instead, once.
      if (raced) throw new Error(`settings ${scope} insert is a duplicate but the row cannot be read`);
      return this.writeSettings(scope, json, true);
    }
    if (row.json === json) return;
    if (!hasVersion(row)) throw new MissingVersionError('FactorySettings', scope);
    const expected = num(row.version);
    const outcome = await this.settle('FactorySettings', { scope }, expected, { json });
    if (outcome.kind !== 'applied') throw this.settleError(outcome, `settings ${scope}`, `settings ${scope}`, expected);
  }

  async startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }): Promise<Run> {
    const run: Run = {
      runId: `R-${randomUUID()}`, taskId: r.taskId, step: r.step, mode: r.mode, agent: r.agent,
      startedAt: this.now().toISOString(), endedAt: null, result: null, turns: null, costUsd: null,
    };
    const res = await this.data.insert('FactoryRun', { ...run, version: 1 });
    if (res.kind === 'forbidden') throw new BlocksForbiddenError('insertFactoryRun');
    if (res.kind === 'duplicate') throw new Error('startRun: run id already taken');
    return run;
  }

  async openRun(taskId: string, step: Step): Promise<Run | undefined> {
    const open = (await this.data.list('FactoryRun', { taskId, step })).map(decodeRun).filter((r) => r.endedAt === null);
    open.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
    return open[open.length - 1];
  }

  async finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }): Promise<void> {
    const [row] = await this.data.list('FactoryRun', { runId }, ['version']);
    if (!row) throw new NotFoundError(`run ${runId}`);
    if (!hasVersion(row)) throw new MissingVersionError('FactoryRun', runId);
    const expected = num(row.version);
    const outcome = await this.settle('FactoryRun', { runId }, expected, {
      result: p.result, turns: p.turns, costUsd: decimalText(p.costUsd), endedAt: this.now().toISOString(),
    });
    if (outcome.kind !== 'applied') throw this.settleError(outcome, `run ${runId}`, runId, expected);
  }

  async addEvents(events: FactoryEvent[]): Promise<void> {
    for (const e of events) {
      const r = await this.data.insert('FactoryEvent', {
        eventId: eventId(e), taskId: e.taskId, actor: e.actor, action: e.action, field: e.field, from: e.from, to: e.to, reason: e.reason, at: e.at,
      });
      // A duplicate is an event an earlier, lost-reply call already wrote.
      if (r.kind === 'forbidden') throw new ForbiddenError(`${this.identity === 'core' ? 'factory core' : 'owner'} may not write events`);
    }
  }

  async listEvents(taskId?: string): Promise<FactoryEvent[]> {
    return byAt((await this.data.list('FactoryEvent', taskId === undefined ? {} : { taskId })).map(decodeEvent));
  }

  /** One compare-and-set update keyed by `key` plus the row version; bumps the version and stamps a writeId. */
  private async settle(schema: SchemaName, key: Filter, expectedVersion: number, input: Record<string, Value>): Promise<Settled> {
    let seenVersion = Number.NaN;
    const slot = JSON.stringify([schema, key, expectedVersion]);
    const outcome = await settleConditionalUpdate({
      expectedVersion,
      priorWriteIds: this.pending.get(slot) ?? [],
      // Must never reject: a rejection is an unknown outcome. Forbidden (a 403 or a column refusal) is final.
      send: async (writeId): Promise<WriteOutcome | { kind: 'forbidden' }> => {
        try {
          return await this.data.update(schema, { ...key, version: expectedVersion }, { ...input, version: expectedVersion + 1, writeId });
        } catch (error) {
          return classifyUpdate(error instanceof Error ? error : new Error(String(error)));
        }
      },
      // Must never reject either.
      reread: async (): Promise<RereadResult> => {
        try {
          const rows = await this.data.list(schema, key, ['version', 'writeId']);
          if (rows.length === 1) seenVersion = Number(rows[0]!.version);
          return { rows: rows.map((r) => ({ version: Number(r.version), writeId: str(r.writeId) })) };
        } catch (error) {
          const denied = error instanceof BlocksForbiddenError || error instanceof BlocksUnauthorizedError;
          return { error: denied ? 'denied' : 'failed' };
        }
      },
    });
    if (outcome.kind === 'reconcile') this.pending.set(slot, outcome.pendingWriteIds);
    else this.pending.delete(slot);
    return outcome.kind === 'applied' || outcome.kind === 'forbidden' ? { kind: outcome.kind } : { kind: outcome.kind, seenVersion };
  }

  private settleError(
    outcome: Exclude<Settled, { kind: 'applied' }>,
    what: string, conflictId: string, expectedVersion: number,
  ): Error {
    if (outcome.kind === 'forbidden') return new ForbiddenError(`${what} update forbidden`);
    if (outcome.kind === 'conflict') return new VersionConflictError(conflictId, expectedVersion, outcome.seenVersion);
    if (outcome.kind === 'unauthorized') return new NotFoundError(what);
    return new Error(`${what} update outcome unknown; re-read before retrying`);
  }
}
