import { ForbiddenError, OwnerOnlyError, updateHeld, VersionConflictError, type BoardStore, type StoredSettings } from './boardStore.js';
import { GATE_DOC } from './gates.js';
import { diffEvents } from './history.js';
import { assertMove } from './status.js';
import {
  REPO_IDS, type Approval, type DocKind, type FactoryEvent, type Gate, type RepoId, type RepoSettings, type Settings, type Status, type Task,
} from './types.js';

// The owner's actions, shared by the Board page and `factory dev`. Pure (no Node API): the browser entry exports them.

export type OwnerActionCode = 'not-waiting' | 'not-blocked' | 'not-editable' | 'invalid';

/** The owner may not do this now, or sent a value outside the rules. Nothing was written. */
export class OwnerActionError extends Error {
  constructor(readonly code: OwnerActionCode, message: string) {
    super(message);
    this.name = 'OwnerActionError';
  }
}

/** The owner decided on a doc version that is no longer the current one. Nothing was written. */
export class StaleDocError extends Error {
  constructor(readonly taskId: string, readonly kind: DocKind, readonly seenVersion: number, readonly currentVersion: number) {
    super(`${taskId} ${kind} is now v${currentVersion}, not v${seenVersion}`);
    this.name = 'StaleDocError';
  }
}

export const OWNER_ACTOR = 'you';
const GATES: readonly Gate[] = ['spec', 'plan', 'pr'];
/** The status a task waits in for each gate. */
export const GATE_STATUS: Readonly<Record<Gate, Status>> = { spec: 'spec_review', plan: 'plan_review', pr: 'pr_open' };
/** Later the core is working on the task, so its definition is fixed. */
export const EDITABLE_STATUSES: readonly Status[] = ['inbox', 'ready'];
const EDITABLE_FIELDS = ['title', 'description', 'repo', 'baseBranch', 'gateOverrides'] as const;
export type TaskEdit = Partial<Pick<Task, (typeof EDITABLE_FIELDS)[number]>>;
export type SettingsScope = 'global' | RepoId;
const SETTING_KEYS = ['maxParallel', 'maxTurnsPerStage', 'maxCostPerTaskUsd', 'paused', 'gates'] as const;
/** Inclusive ranges; maxParallel and maxTurnsPerStage are whole numbers. */
export const SETTING_RANGES = {
  maxParallel: { min: 1, max: 10, integer: true },
  maxTurnsPerStage: { min: 1, max: 500, integer: true },
  maxCostPerTaskUsd: { min: 0, max: 1000, integer: false },
} as const;

const invalid = (message: string): never => {
  throw new OwnerActionError('invalid', message);
};
const nonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isRepoId = (v: unknown): v is RepoId => typeof v === 'string' && (REPO_IDS as readonly string[]).includes(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Drops undefined values: a key set to undefined is a key not sent. */
const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
/** JSON with sorted object keys, so equal values compare equal whatever their key order. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (isObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x)) ?? 'undefined';
const randomUUID = (): string => globalThis.crypto.randomUUID();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function checkGates(v: unknown, what: string): void {
  if (!isObject(v)) invalid(`${what} must be an object of gate switches`);
  for (const [gate, on] of Object.entries(v as object)) {
    if (!(GATES as readonly string[]).includes(gate)) invalid(`${what}: unknown gate ${gate}`);
    if (on !== undefined && typeof on !== 'boolean') invalid(`${what}.${gate} must be true or false`);
  }
}

/**
 * The events are built once by the caller; a retry sends the same rows (BlocksStore derives each event id from its
 * content, so a retry after a lost reply does not duplicate them). A refusal is final.
 */
async function writeEvents(store: BoardStore, events: FactoryEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (let attempt = 0; ; attempt++) {
    try {
      return await store.addEvents(events);
    } catch (e) {
      if (attempt >= 2 || e instanceof ForbiddenError || e instanceof OwnerOnlyError) throw e;
      await sleep(200 * 2 ** attempt);
    }
  }
}

/** One compare-and-set write with the owner's events. */
async function ownerUpdate(store: BoardStore, now: () => Date, task: Task, patch: Partial<Task>, reason: string): Promise<Task> {
  const at = now().toISOString();
  const updated = await updateHeld(store, task, patch);
  const events = [...diffEvents(task, updated, OWNER_ACTOR, reason, at), ...ownerFieldEvents(task, updated, reason, at)];
  await writeEvents(store, events);
  return updated;
}

/** diffEvents covers the core's fields; these are the owner's (title … gateOverrides). */
function ownerFieldEvents(before: Task, after: Task, reason: string, at: string): FactoryEvent[] {
  const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return EDITABLE_FIELDS.filter((f) => canon(before[f]) !== canon(after[f])).map((field) => ({
    taskId: after.taskId, actor: OWNER_ACTOR, action: 'set' as const, field, from: text(before[field]), to: text(after[field]), reason, at,
  }));
}

export async function createTask(
  store: BoardStore, now: () => Date, input: { title: string; description: string; repo: RepoId; baseBranch?: string },
): Promise<Task> {
  if (!nonBlank(input.title)) invalid('title must not be blank');
  if (typeof input.description !== 'string') invalid('description must be text');
  if (!isRepoId(input.repo)) invalid(`repo must be one of ${REPO_IDS.join(', ')}`);
  if (input.baseBranch !== undefined && !nonBlank(input.baseBranch)) invalid('base branch must not be blank');
  const at = now().toISOString();
  const task = await store.createTask({
    title: input.title, description: input.description, repo: input.repo, ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
  });
  await writeEvents(store, [
    { taskId: task.taskId, actor: OWNER_ACTOR, action: 'create', field: null, from: null, to: task.status, reason: 'created', at },
  ]);
  return task;
}

async function move(store: BoardStore, now: () => Date, taskId: string, to: Status, reason: string): Promise<Task> {
  const task = await store.getTask(taskId);
  assertMove(task.status, to, 'you');
  // The claim is the engine's: a cancelled task keeps it until the engine releases it or it lapses.
  return ownerUpdate(store, now, task, { status: to }, reason);
}

export function markReady(store: BoardStore, now: () => Date, taskId: string): Promise<Task> {
  return move(store, now, taskId, 'ready', 'marked ready');
}

export function cancelTask(store: BoardStore, now: () => Date, taskId: string): Promise<Task> {
  return move(store, now, taskId, 'cancelled', 'cancelled');
}

/** The engine's sync resumes the task once it sees the answer. */
export async function answerTask(store: BoardStore, now: () => Date, taskId: string, text: string): Promise<Task> {
  if (!nonBlank(text)) invalid('answer must not be blank');
  const task = await store.getTask(taskId);
  if (task.status !== 'blocked') throw new OwnerActionError('not-blocked', `${taskId} is not blocked`);
  return ownerUpdate(store, now, task, { answer: text }, 'answered');
}

/**
 * Records the owner's decision on the doc version they saw. It only records: the engine's sync applies it (moves the
 * task on, back for changes, or merges an approved PR when it may).
 */
export async function decideGate(
  store: BoardStore, now: () => Date, taskId: string, gate: Gate, decision: 'approve' | 'changes', seenDocVersion: number, comment: string,
): Promise<Approval> {
  if (!(GATES as readonly string[]).includes(gate)) invalid(`gate must be one of ${GATES.join(', ')}`);
  if (decision !== 'approve' && decision !== 'changes') invalid('decision must be approve or changes');
  if (!Number.isInteger(seenDocVersion) || seenDocVersion < 1) invalid('seen doc version must be a whole number from 1');
  if (typeof comment !== 'string') invalid('comment must be text');
  const task = await store.getTask(taskId);
  if (task.status !== GATE_STATUS[gate]) throw new OwnerActionError('not-waiting', `${taskId} is not waiting at the ${gate} gate`);
  const kind = GATE_DOC[gate];
  const doc = await store.currentDoc(taskId, kind);
  if (!doc) return invalid(`no current ${kind} doc for ${taskId}`);
  if (doc.version !== seenDocVersion) throw new StaleDocError(taskId, kind, seenDocVersion, doc.version);
  const reason = comment.trim() || (decision === 'approve' ? 'approved' : 'changes requested');
  const events: FactoryEvent[] = [{
    taskId, actor: OWNER_ACTOR, action: 'set', field: 'approval', from: null, to: `${gate}:${decision}@v${doc.version}`, reason, at: now().toISOString(),
  }];
  const approval = await store.addApproval({ approvalId: randomUUID(), taskId, gate, docVersion: doc.version, decision, comment });
  await writeEvents(store, events);
  return approval;
}

/** Edits the task's definition while it is in the inbox or ready. A write since `expectedVersion` is a VersionConflictError. */
export async function editTask(store: BoardStore, now: () => Date, taskId: string, expectedVersion: number, patch: TaskEdit): Promise<Task> {
  if (!isObject(patch)) invalid('edit must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(key)) invalid(`${key} cannot be edited`);
    if (value === undefined) continue;
    if (key === 'title' && !nonBlank(value)) invalid('title must not be blank');
    if (key === 'description' && typeof value !== 'string') invalid('description must be text');
    if (key === 'repo' && !isRepoId(value)) invalid(`repo must be one of ${REPO_IDS.join(', ')}`);
    if (key === 'baseBranch' && !nonBlank(value)) invalid('base branch must not be blank');
    if (key === 'gateOverrides') checkGates(value, 'gateOverrides');
  }
  const clean: TaskEdit = defined(patch);
  if (clean.gateOverrides) clean.gateOverrides = defined(clean.gateOverrides);
  const task = await store.getTask(taskId);
  if (!EDITABLE_STATUSES.includes(task.status)) {
    throw new OwnerActionError('not-editable', `${taskId} is ${task.status}; only inbox and ready tasks can be edited`);
  }
  if (task.version !== expectedVersion) throw new VersionConflictError(taskId, expectedVersion, task.version);
  if (!EDITABLE_FIELDS.some((f) => f in clean && canon(clean[f]) !== canon(task[f]))) return task;
  return ownerUpdate(store, now, task, clean, 'edited');
}

/**
 * Merges `patch` over the global settings or over one repo's overrides (a key left out, or undefined, is kept) and
 * writes one event per changed key. Returns the stored settings.
 */
export async function saveSettings(
  store: BoardStore, now: () => Date, scope: SettingsScope, patch: RepoSettings | Settings,
): Promise<StoredSettings> {
  if (scope !== 'global' && !isRepoId(scope)) invalid(`scope must be global or one of ${REPO_IDS.join(', ')}`);
  if (!isObject(patch)) invalid('settings must be an object');
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) invalid(`unknown setting ${key}`);
    if (value === undefined) continue;
    if (key === 'paused' && typeof value !== 'boolean') invalid('paused must be true or false');
    if (key === 'gates') checkGates(value, 'gates');
    if (key in SETTING_RANGES) {
      const r = SETTING_RANGES[key as keyof typeof SETTING_RANGES];
      const ok = typeof value === 'number' && Number.isFinite(value) && value >= r.min && value <= r.max && (!r.integer || Number.isInteger(value));
      if (!ok) invalid(`${key} must be ${r.integer ? 'a whole number' : 'a number'} from ${r.min} to ${r.max}`);
    }
  }
  const { gates, ...rest } = defined(patch as RepoSettings);
  const stored = await store.getSettings();
  const current: RepoSettings = scope === 'global' ? stored.global : (stored.repos[scope] ?? {});
  const next: RepoSettings = { ...current, ...rest, ...(gates ? { gates: { ...current.gates, ...defined(gates) } } : {}) };
  const changed = SETTING_KEYS.filter((k) => canon(current[k]) !== canon(next[k]));
  if (changed.length === 0) return stored;
  const at = now().toISOString();
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  const events: FactoryEvent[] = changed.map((k) => ({
    taskId: '-', actor: OWNER_ACTOR, action: 'set', field: `settings.${scope}.${k}`, from: json(current[k]), to: json(next[k]), reason: 'settings saved', at,
  }));
  const updated: StoredSettings =
    scope === 'global' ? { global: next as Settings, repos: stored.repos } : { global: stored.global, repos: { ...stored.repos, [scope]: next } };
  await store.setSettings(updated);
  await writeEvents(store, events);
  return updated;
}
