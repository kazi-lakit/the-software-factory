import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DocTooLargeError, MAX_DOC_BYTES } from '../limits.js';
import { DEFAULT_SETTINGS } from '../defaults.js';
import type { FactoryDef, FactoryHealth, FactoryRepo } from '../factories.js';
import {
  assertNewStatus, canonicalJson, parseScope, CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, OwnerOnlyError, RereadAfterUpdateError, sameApproval,
  settingsConflict, VersionConflictError, type BoardStore, type NewApproval, type NewTask, type StoredSettings,
} from '../boardStore.js';
import type {
  Approval, Doc, DocKind, FactoryEvent, Gate, Mode, RepoId, RepoSettings, Run, Settings, Step, Task,
} from '../types.js';
import { BlocksForbiddenError, BlocksUnauthorizedError, type BlocksData, type Filter, type Row } from './data.js';
import { FIELDS, type SchemaName } from './schema.js';
import { classifyUpdate, settleConditionalUpdate, type RereadResult, type WriteOutcome } from './update.js';

export { DocTooLargeError, MAX_DOC_BYTES, OwnerOnlyError };

/** Task fields the factory core may change; everything else is the owner's, on the Board. */
export const CORE_TASK_FIELDS: readonly (keyof Task)[] = [
  'status', 'stage', 'branch', 'prUrl', 'attempt', 'blockedReason', 'question', 'answer', 'claimBy', 'claimUntil', 'costUsd',
];

type Value = string | number | null;
const TASK_KEYS = new Set<string>([
  'factoryId', 'title', 'description', 'repo', 'baseBranch', 'gateOverrides', 'dependsOn', ...CORE_TASK_FIELDS,
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

/** A JSON array of strings, or [] for null, malformed JSON or anything else. */
function parseStringArray(v: Value | undefined): string[] {
  if (v === null || v === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(String(v));
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Blocks may send CreatedDate without a zone; it is UTC then, never local time. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const parseUtc = (v: Value | undefined): number => {
  const s = text(v);
  return Date.parse(ZONED.test(s) ? s : `${s}Z`);
};

/**
 * Nullable String fields. The live gateway acknowledges an update that sets a field to null but keeps the old value
 * (seen 2026-11-10), so a clear is sent as '' and '' reads back as null. Inserts still send null; both read as null.
 */
export const CLEARABLE_FIELDS: Partial<Record<SchemaName, readonly string[]>> = {
  FactoryTask: ['stage', 'branch', 'prUrl', 'blockedReason', 'question', 'answer', 'claimBy', 'claimUntil'],
  FactoryRun: ['endedAt', 'result', 'costUsd'],
};

/** Rows written before plan 6 have no factoryId; they belong to factory `blocks`. */
const LEGACY_FACTORY = 'blocks';
/** Settings rows written before plan 6: scope `global` is factory `blocks`, any other scope a repo of it. */
const LEGACY_FACTORY_SCOPE = 'global';
/** The repo ids that had a bare settings scope before plan 6. */
const LEGACY_REPO_IDS: ReadonlySet<string> = new Set(['os', 'iam', 'monitor', 'logic', 'data', 'localization', 'release']);
/** A stored settings json that holds an object (not null, not malformed). */
const isLive = (json: Value | undefined): boolean => parseObject(json) !== undefined;
/** A json that was not retired: anything but null or the text `null` (a malformed one still counts as a row). */
const hasJson = (json: Value | undefined): boolean => json !== null && json !== undefined && String(json) !== 'null';
/** The legacy rows count only while the raw `global` row holds a value; `retireLegacySettings` nulls it. */
const legacyIsOn = (all: Row[]): boolean => all.some((r) => r.scope === LEGACY_FACTORY_SCOPE && hasJson(r.json));
const isLegacyRepoRow = (r: Row, on: boolean): boolean => on && LEGACY_REPO_IDS.has(text(r.scope)) && hasJson(r.json);

/** An update input with every clear as ''. A null for any other field (an Int, a required String) cannot be stored. */
function encodeUpdate(schema: SchemaName, input: Record<string, Value>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null) out[key] = value;
    else if (CLEARABLE_FIELDS[schema]?.includes(key)) out[key] = '';
    else {
      const type = FIELDS[schema].find((f) => f.name === key)?.type ?? 'unknown';
      throw new Error(`${schema}.${key} (${type}) cannot be cleared: Blocks ignores null in an update`);
    }
  }
  return out;
}

const utf8 = new TextEncoder();
const sha256 = (s: string) => bytesToHex(nobleSha256(utf8.encode(s)));
/** Wrapped so `this` stays bound to crypto (a bare reference throws Illegal invocation in browsers). */
const randomUUID = (): string => globalThis.crypto.randomUUID();
const str = (v: Value | undefined): string | null => (v === null || v === undefined ? null : String(v));
/** A clearable field: '' is how a clear is stored. */
const opt = (v: Value | undefined): string | null => (v === '' ? null : str(v));
const text = (v: Value | undefined): string => String(v ?? '');
const num = (v: Value | undefined): number => Number(v ?? 0);
const decimalText = (n: number | null): string | null => (n === null ? null : String(n));

function encodeTaskValue(key: keyof Task, value: Task[keyof Task]): Value {
  if (key === 'gateOverrides' || key === 'dependsOn') return JSON.stringify(value);
  if (key === 'costUsd') return String(value);
  return value as Value;
}

function decodeTask(r: Row): Task {
  return {
    taskId: text(r.taskId),
    factoryId: str(r.factoryId) ?? LEGACY_FACTORY,
    title: text(r.title),
    description: text(r.description),
    repo: text(r.repo) as RepoId,
    baseBranch: text(r.baseBranch),
    status: text(r.status) as Task['status'],
    stage: opt(r.stage) as Step | null,
    branch: opt(r.branch),
    prUrl: opt(r.prUrl),
    attempt: num(r.attempt),
    blockedReason: opt(r.blockedReason),
    question: opt(r.question),
    answer: opt(r.answer),
    gateOverrides: (parseObject(r.gateOverrides) ?? {}) as Task['gateOverrides'],
    dependsOn: parseStringArray(r.dependsOn),
    claimBy: opt(r.claimBy),
    claimUntil: opt(r.claimUntil),
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
  startedAt: text(r.startedAt), endedAt: opt(r.endedAt), result: opt(r.result),
  turns: r.turns === null || r.turns === undefined ? null : Number(r.turns),
  costUsd: opt(r.costUsd) === null ? null : Number(r.costUsd),
});

const decodeEvent = (r: Row): FactoryEvent => ({
  taskId: text(r.taskId), factoryId: str(r.factoryId) ?? LEGACY_FACTORY, actor: text(r.actor), action: text(r.action) as FactoryEvent['action'],
  field: str(r.field), from: str(r.from), to: str(r.to), reason: text(r.reason), at: text(r.at),
});

/**
 * A list as stored; anything else (malformed JSON, not a list, missing) decodes to the raw text, which validation
 * refuses, so FactoryConfig skips the factory with a reason. Never `[]` (ensureMain would make it main only and fail
 * open) and never null (validation would take the default list: the factory never guesses).
 */
const decodeBranches = (v: Value | undefined): string[] => {
  try {
    const parsed: unknown = JSON.parse(text(v));
    if (Array.isArray(parsed)) return parsed as string[];
  } catch {
    // falls through to the refused value
  }
  return text(v) as unknown as string[];
};

/**
 * A missing column, empty text or `{}` means no agentModels. Text that is not a JSON object decodes to the raw text,
 * which validation refuses, so the factory is skipped with a reason instead of guessing.
 */
const decodeAgentModels = (v: Value | undefined): FactoryDef['agentModels'] | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(text(v));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.keys(parsed).length === 0 ? undefined : (parsed as FactoryDef['agentModels']);
    }
  } catch {
    // falls through to the refused value
  }
  return text(v) as never;
};

const decodeDef = (r: Row): FactoryDef => {
  const agentModels = decodeAgentModels(r.agentModels);
  return {
    factoryId: text(r.factoryId), name: text(r.name), protectedBranches: decodeBranches(r.protectedBranches), gitName: text(r.gitName),
    gitEmail: text(r.gitEmail), docsPath: text(r.docsPath), ghUser: text(r.ghUser), active: num(r.active) === 1,
    ...(agentModels === undefined ? {} : { agentModels }), version: num(r.version),
  };
};

/** A repo whose checks are not a JSON object decodes with empty checks, which validation then skips. */
const decodeRepo = (r: Row): FactoryRepo => ({
  factoryId: text(r.factoryId), repoId: text(r.repoId), remote: text(r.remote), baseBranch: text(r.baseBranch),
  checks: (parseObject(r.checks) ?? {}) as FactoryRepo['checks'], version: num(r.version),
});

const decodeHealth = (r: Row): FactoryHealth => ({ factoryId: text(r.factoryId), ghLoggedIn: num(r.ghLoggedIn) === 1, checkedAt: text(r.checkedAt) });

const encodeDef = (d: FactoryDef): Record<string, Value> => ({
  name: d.name, protectedBranches: JSON.stringify(d.protectedBranches), gitName: d.gitName, gitEmail: d.gitEmail, docsPath: d.docsPath,
  ghUser: d.ghUser, active: d.active ? 1 : 0,
  // Always written, so an edit can clear every entry: Blocks ignores null in an update.
  agentModels: JSON.stringify(d.agentModels ?? {}),
});

const encodeRepo = (r: FactoryRepo): Record<string, Value> => ({ remote: r.remote, baseBranch: r.baseBranch, checks: canonicalJson(r.checks) });

const repoKey = (factoryId: string, repoId: string) => `${factoryId}/${repoId}`;

/** Fixed key order, so a retried event hashes to the same eventId; the factory is part of it, so two factories never collide. */
const eventId = (e: FactoryEvent) =>
  sha256(JSON.stringify({ taskId: e.taskId, factoryId: e.factoryId, actor: e.actor, action: e.action, field: e.field, from: e.from, to: e.to, reason: e.reason, at: e.at }));

const highest = (rows: Row[]): Row | undefined =>
  rows.reduce<Row | undefined>((top, r) => (top === undefined || num(r.version) > num(top.version) ? r : top), undefined);

const taskNumber = (id: Value | undefined) => {
  const m = /^T-(\d+)$/.exec(text(id));
  return m ? Number(m[1]) : 0;
};

/** A settled update; `seenVersion` is the version the last re-read found (NaN if none). */
type Settled = { kind: 'applied' | 'forbidden' } | { kind: 'conflict' | 'unauthorized' | 'reconcile'; seenVersion: number };

/** A stored version that is not a number (null, a row made outside the factory) cannot take a compare-and-set. */
const hasVersion = (r: Row): boolean => typeof r.version === 'number';

/**
 * A settings row's value as getSettings gives it: a factory scope is merged over the defaults; a repo scope with a null
 * json (removed: rows are never deleted) or a malformed one is undefined.
 */
function scopeValue(isFactory: boolean, json: Value | undefined): Settings | RepoSettings | undefined {
  const value = parseObject(json) as Partial<Settings> | RepoSettings | undefined;
  if (!isFactory) return value as RepoSettings | undefined;
  return { ...DEFAULT_SETTINGS, ...value, gates: { ...DEFAULT_SETTINGS.gates, ...value?.gates } } as Settings;
}

const byStartedAt = (runs: Run[]) => runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
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
  constructor(
    private readonly data: BlocksData, private readonly identity: 'core' | 'owner',
    opts: { now?: () => Date } = {},
  ) {
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

  async createTask(t: NewTask): Promise<Task> {
    assertNewStatus(t.status);
    // Both identities may insert a task: the core only through `factory new` (see createTaskAsCore).
    for (let attempt = 0; attempt <= DUPLICATE_RETRIES; attempt++) {
      const ids = await this.data.list('FactoryTask', {}, ['taskId']);
      const taskId = `T-${1 + Math.max(0, ...ids.map((r) => taskNumber(r.taskId)))}`;
      const task: Task = {
        taskId,
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
      // The writeId finds this row again if the insert's reply is lost.
      const writeId = randomUUID();
      const row: Record<string, Value> = { writeId };
      for (const [key, value] of Object.entries(task)) {
        // An empty list is left out so creates work before the schema has the field; a missing value reads as [].
        if (key === 'dependsOn' && task.dependsOn.length === 0) continue;
        row[key] = encodeTaskValue(key as keyof Task, value);
      }
      let r: Awaited<ReturnType<BlocksData['insert']>>;
      try {
        r = await this.data.insert('FactoryTask', row);
      } catch (error) {
        // A lost reply: if the row is stored it is ours. A retry under a new task id would make a second task.
        const [found] = await this.data.list('FactoryTask', { writeId }).catch((): Row[] => []);
        if (found) return decodeTask(found);
        throw error;
      }
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
    const bytes = utf8.encode(body).length;
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

  /** No status is stored: the highest version is current. */
  async listDocs(taskId: string, kind: DocKind): Promise<Doc[]> {
    const docs = (await this.data.list('FactoryDoc', { taskId, kind })).map(decodeDoc).sort((a, b) => a.version - b.version);
    return docs.map((d, i) => ({ ...d, status: i === docs.length - 1 ? 'current' : 'superseded' }));
  }

  async addApproval(a: NewApproval): Promise<Approval> {
    this.ownerOnly('addApproval');
    const approvalId = a.approvalId ?? randomUUID();
    const approval: Approval = { taskId: a.taskId, gate: a.gate, docVersion: a.docVersion, decision: a.decision, comment: a.comment, at: this.now().toISOString() };
    // The approval stored under this id, if it is this one: a retry (lost reply, or the caller's own) returns it.
    const stored = async (): Promise<Approval | undefined> => {
      const [row] = await this.data.list('FactoryApproval', { approvalId });
      const found = row ? decodeApproval(row) : undefined;
      return found && sameApproval(found, a) ? found : undefined;
    };
    let r: Awaited<ReturnType<BlocksData['insert']>>;
    try {
      r = await this.data.insert('FactoryApproval', { approvalId, ...approval });
    } catch (error) {
      const found = await stored().catch(() => undefined);
      if (found) return found;
      throw error;
    }
    if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactoryApproval');
    if (r.kind === 'duplicate') {
      const found = await stored();
      if (found) return found;
      throw new Error('addApproval: approval id already taken');
    }
    return approval;
  }

  async listApprovals(taskId: string): Promise<Approval[]> {
    return byAt((await this.data.list('FactoryApproval', { taskId })).map(decodeApproval));
  }

  async listFactoryDefs(): Promise<FactoryDef[]> {
    return (await this.data.list('FactoryDef', {})).map(decodeDef).sort((a, b) => (a.factoryId < b.factoryId ? -1 : a.factoryId > b.factoryId ? 1 : 0));
  }

  async listFactoryRepos(factoryId?: string): Promise<FactoryRepo[]> {
    const rows = await this.data.list('FactoryRepo', factoryId === undefined ? {} : { factoryId });
    return rows.map(decodeRepo).sort((a, b) => {
      const x = repoKey(a.factoryId, a.repoId);
      const y = repoKey(b.factoryId, b.repoId);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  async saveFactoryDef(before: FactoryDef | null, after: FactoryDef): Promise<FactoryDef> {
    this.ownerOnly('saveFactoryDef');
    const what = `factory ${after.factoryId}`;
    const fields = encodeDef(after);
    if (before === null) {
      const all = await this.data.list('FactorySettings', {}, ['scope', 'json']);
      if (all.some((r) => r.scope === after.factoryId && isLegacyRepoRow(r, legacyIsOn(all)))) {
        throw new Error(`factory id ${after.factoryId} collides with legacy settings; run factory migrate first`);
      }
      await this.insertVersioned('FactoryDef', { factoryId: after.factoryId }, { factoryId: after.factoryId, ...fields }, what);
      return { ...structuredClone(after), version: 1 };
    }
    await this.updateVersioned('FactoryDef', { factoryId: after.factoryId }, before.version, fields, what);
    return { ...structuredClone(after), version: before.version + 1 };
  }

  async saveFactoryRepo(before: FactoryRepo | null, after: FactoryRepo): Promise<FactoryRepo> {
    this.ownerOnly('saveFactoryRepo');
    const key = repoKey(after.factoryId, after.repoId);
    const what = `repo ${key}`;
    const fields = encodeRepo(after);
    if (before === null) {
      await this.insertVersioned('FactoryRepo', { repoKey: key }, { repoKey: key, factoryId: after.factoryId, repoId: after.repoId, ...fields }, what);
      return { ...structuredClone(after), version: 1 };
    }
    await this.updateVersioned('FactoryRepo', { repoKey: key }, before.version, fields, what);
    return { ...structuredClone(after), version: before.version + 1 };
  }

  /** Inserts a version 1 row; an existing row is a version conflict. A lost reply is recognised by its writeId. */
  private async insertVersioned(schema: SchemaName, key: Filter, row: Record<string, Value>, what: string): Promise<void> {
    const writeId = randomUUID();
    let r: Awaited<ReturnType<BlocksData['insert']>>;
    try {
      r = await this.data.insert(schema, { ...row, version: 1, writeId });
    } catch (error) {
      const [found] = await this.data.list(schema, key, ['writeId']).catch((): Row[] => []);
      if (found?.writeId === writeId) return;
      throw error;
    }
    if (r.kind === 'forbidden') throw new BlocksForbiddenError(`insert${schema}`);
    if (r.kind === 'duplicate') {
      const [found] = await this.data.list(schema, key, ['version']).catch((): Row[] => []);
      throw new VersionConflictError(what, 0, num(found?.version), `${what} already exists; reload and save again`);
    }
  }

  /** One compare-and-set update of a definition row, keyed by `key` plus the version the caller read. */
  private async updateVersioned(schema: SchemaName, key: Filter, expectedVersion: number, fields: Record<string, Value>, what: string): Promise<void> {
    const [row] = await this.data.list(schema, key, ['version']);
    if (row && !hasVersion(row)) throw new MissingVersionError(schema, String(Object.values(key)[0]));
    const outcome = await this.settle(schema, key, expectedVersion, fields);
    if (outcome.kind === 'applied') return;
    if (outcome.kind === 'conflict') {
      throw new VersionConflictError(what, expectedVersion, outcome.seenVersion, `${what} changed since it was read; reload and save again`);
    }
    throw this.settleError(outcome, what, what, expectedVersion);
  }

  async listFactoryHealth(): Promise<FactoryHealth[]> {
    return (await this.data.list('FactoryHealth', {})).map(decodeHealth).sort((a, b) => (a.factoryId < b.factoryId ? -1 : a.factoryId > b.factoryId ? 1 : 0));
  }

  async setFactoryHealth(h: FactoryHealth): Promise<void> {
    if (this.identity !== 'core') throw new ForbiddenError('setFactoryHealth is done by the factory core, not on the Board');
    const fields: Record<string, Value> = { ghLoggedIn: h.ghLoggedIn ? 1 : 0, checkedAt: h.checkedAt };
    const key = { factoryId: h.factoryId };
    // The core is the only writer: an insert that finds the row (or an update that loses a race) is retried once against it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [row] = await this.data.list('FactoryHealth', key, ['version']);
      if (!row) {
        const r = await this.data.insert('FactoryHealth', { ...key, ...fields, version: 1, writeId: randomUUID() });
        if (r.kind === 'inserted') return;
        if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactoryHealth');
        continue;
      }
      if (!hasVersion(row)) throw new MissingVersionError('FactoryHealth', h.factoryId);
      const expected = num(row.version);
      const outcome = await this.settle('FactoryHealth', key, expected, fields);
      if (outcome.kind === 'applied') return;
      if (outcome.kind === 'conflict') continue;
      throw this.settleError(outcome, `health ${h.factoryId}`, `health ${h.factoryId}`, expected);
    }
    throw new Error(`setFactoryHealth: health of ${h.factoryId} kept changing`);
  }

  /**
   * Every settings value by its current scope name (`<f>` or `<f>/<r>`), and the rows stored under those names.
   * While the raw `global` row holds a value (until `retireLegacySettings`), rows from before plan 6 count as factory
   * `blocks`: `global` is its factory scope and a bare legacy repo id (with a value) its repo. A row under the current
   * name wins over a legacy one; a bare scope with a null json holds no value.
   */
  private async settingsView(): Promise<{ values: Map<string, Settings | RepoSettings | undefined>; rows: Map<string, Row> }> {
    const all = await this.data.list('FactorySettings', {}, ['scope', 'json', 'version']);
    const values = new Map<string, Settings | RepoSettings | undefined>();
    const rows = new Map<string, Row>();
    const on = legacyIsOn(all);
    for (const r of all) {
      const scope = text(r.scope);
      if (scope === LEGACY_FACTORY_SCOPE) {
        if (on) values.set(LEGACY_FACTORY, scopeValue(true, r.json));
      } else if (isLegacyRepoRow(r, on)) values.set(repoKey(LEGACY_FACTORY, scope), scopeValue(false, r.json));
    }
    for (const r of all) {
      const scope = text(r.scope);
      if (scope === LEGACY_FACTORY_SCOPE || isLegacyRepoRow(r, on)) continue;
      rows.set(scope, r);
      if (scope.includes('/') || isLive(r.json)) values.set(scope, scopeValue(!scope.includes('/'), r.json));
    }
    return { values, rows };
  }

  async retireLegacySettings(): Promise<{ retired: string[]; remaining: string[] }> {
    this.ownerOnly('retireLegacySettings');
    const all = await this.data.list('FactorySettings', {}, ['scope', 'json', 'version']);
    if (!legacyIsOn(all)) return { retired: [], remaining: [] };
    const newRows = new Set(all.filter((r) => !isLegacyRepoRow(r, true) && r.scope !== LEGACY_FACTORY_SCOPE).map((r) => text(r.scope)));
    // `global` goes only once a LIVE `blocks` row holds its value: a null or malformed one would leave the factory with defaults.
    const liveBlocks = all.some((r) => text(r.scope) === LEGACY_FACTORY && isLive(r.json));
    const retired: string[] = [];
    const remaining: string[] = [];
    // The repo rows first: nulling `global` first would make the rest read as factory scopes.
    for (const r of all) {
      if (!isLegacyRepoRow(r, true)) continue;
      const scope = text(r.scope);
      if (!newRows.has(repoKey(LEGACY_FACTORY, scope))) { remaining.push(scope); continue; }
      await this.writeSettings(scope, 'null');
      retired.push(scope);
    }
    if (remaining.length === 0 && liveBlocks) {
      await this.writeSettings(LEGACY_FACTORY_SCOPE, 'null');
      retired.push(LEGACY_FACTORY_SCOPE);
    } else {
      remaining.push(LEGACY_FACTORY_SCOPE);
    }
    return { retired, remaining };
  }

  async legacySettingsStatus(): Promise<{ unmoved: string[]; unretired: string[] }> {
    const all = await this.data.list('FactorySettings', {}, ['scope', 'json']);
    const unmoved: string[] = [];
    const unretired: string[] = [];
    if (!legacyIsOn(all)) return { unmoved, unretired };
    const newRows = new Set(all.filter((r) => !isLegacyRepoRow(r, true) && r.scope !== LEGACY_FACTORY_SCOPE).map((r) => text(r.scope)));
    for (const r of all) {
      const scope = text(r.scope);
      if (scope === LEGACY_FACTORY_SCOPE) {
        const moved = all.some((x) => text(x.scope) === LEGACY_FACTORY && isLive(x.json));
        (moved ? unretired : unmoved).push(scope);
      } else if (isLegacyRepoRow(r, true)) (newRows.has(repoKey(LEGACY_FACTORY, scope)) ? unretired : unmoved).push(scope);
    }
    return { unmoved, unretired };
  }

  async getSettings(): Promise<StoredSettings> {
    const { values } = await this.settingsView();
    const out: StoredSettings = { factories: {} };
    const entry = (factoryId: string) => (out.factories[factoryId] ??= { factory: scopeValue(true, undefined) as Settings, repos: {} });
    for (const [scope, value] of values) {
      const { factoryId, repoId } = parseScope(scope);
      if (repoId === undefined) entry(factoryId).factory = value as Settings;
      else if (value !== undefined) entry(factoryId).repos[repoId] = value as RepoSettings;
    }
    return out;
  }

  async updateSettingsScope(scope: string, before: unknown, after: Settings | RepoSettings | null): Promise<void> {
    this.ownerOnly('updateSettingsScope');
    const isFactory = parseScope(scope).repoId === undefined;
    if (isFactory && after === null) throw new Error('factory settings cannot be removed');
    const { values, rows } = await this.settingsView();
    if (canonicalJson(values.has(scope) ? values.get(scope) : scopeValue(isFactory, undefined)) !== canonicalJson(before)) throw settingsConflict(scope);
    const row = rows.get(scope);
    const json = after === null ? 'null' : JSON.stringify(after);
    if (!row) {
      if (after === null && !values.has(scope)) return;
      const r = await this.data.insert('FactorySettings', { scope, json, version: 1 });
      if (r.kind === 'forbidden') throw new BlocksForbiddenError('insertFactorySettings');
      // Someone created the scope since the read: their value is not the `before` this caller saw.
      if (r.kind === 'duplicate') throw settingsConflict(scope);
      return;
    }
    if (row.json === json) return;
    if (!hasVersion(row)) throw new MissingVersionError('FactorySettings', scope);
    const expected = num(row.version);
    const outcome = await this.settle('FactorySettings', { scope }, expected, { json });
    if (outcome.kind === 'conflict') throw settingsConflict(scope);
    if (outcome.kind !== 'applied') throw this.settleError(outcome, `settings ${scope}`, `settings ${scope}`, expected);
  }

  async setSettings(s: StoredSettings): Promise<void> {
    this.ownerOnly('setSettings');
    const { values } = await this.settingsView();
    const wanted = new Map<string, string>();
    for (const [factoryId, entry] of Object.entries(s.factories)) {
      wanted.set(factoryId, JSON.stringify(entry.factory));
      for (const [repoId, value] of Object.entries(entry.repos)) wanted.set(repoKey(factoryId, repoId), JSON.stringify(value));
    }
    // Rows cannot be deleted, so a scope left out is written as null json (this also hides a legacy row of that scope).
    for (const scope of values.keys()) if (!wanted.has(scope)) wanted.set(scope, 'null');
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
    const open = byStartedAt((await this.data.list('FactoryRun', { taskId, step })).map(decodeRun).filter((r) => r.endedAt === null));
    return open[open.length - 1];
  }

  async finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }): Promise<void> {
    const [row] = await this.data.list('FactoryRun', { runId }, ['version']);
    if (!row) throw new NotFoundError(`run ${runId}`);
    if (!hasVersion(row)) throw new MissingVersionError('FactoryRun', runId);
    const expected = num(row.version);
    // turns is an Int (cannot be cleared) and still null from startRun: unknown turns are left out.
    const outcome = await this.settle('FactoryRun', { runId }, expected, {
      result: p.result, ...(p.turns === null ? {} : { turns: p.turns }), costUsd: decimalText(p.costUsd), endedAt: this.now().toISOString(),
    });
    if (outcome.kind !== 'applied') throw this.settleError(outcome, `run ${runId}`, runId, expected);
  }

  async listRuns(taskId: string): Promise<Run[]> {
    return byStartedAt((await this.data.list('FactoryRun', { taskId })).map(decodeRun));
  }

  async addEvents(events: FactoryEvent[]): Promise<void> {
    for (const e of events) {
      const r = await this.data.insert('FactoryEvent', {
        eventId: eventId(e), taskId: e.taskId, factoryId: e.factoryId, actor: e.actor, action: e.action, field: e.field, from: e.from, to: e.to, reason: e.reason, at: e.at,
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
    const encoded = encodeUpdate(schema, input);
    let seenVersion = Number.NaN;
    const slot = JSON.stringify([schema, key, expectedVersion]);
    const outcome = await settleConditionalUpdate({
      expectedVersion,
      priorWriteIds: this.pending.get(slot) ?? [],
      // Must never reject: a rejection is an unknown outcome. Forbidden (a 403 or a column refusal) is final.
      send: async (writeId): Promise<WriteOutcome | { kind: 'forbidden' }> => {
        try {
          return await this.data.update(schema, { ...key, version: expectedVersion }, { ...encoded, version: expectedVersion + 1, writeId });
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
