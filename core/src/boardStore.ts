import type { Approval, Doc, DocKind, FactoryEvent, Mode, RepoId, RepoSettings, Run, Settings, Step, Task } from './types.js';

// The store contract, its errors and updateHeld. Pure (no Node API), so the browser entry can import it; store.ts re-exports it.

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class VersionConflictError extends Error {
  /** `message` replaces the version wording when the conflict is a changed value, not a version number. */
  constructor(taskId: string, expected: number, actual: number, message?: string) {
    super(message ?? `version conflict on ${taskId}: expected ${expected}, found ${actual}`);
    this.name = 'VersionConflictError';
  }
}

/** The store refused the write (an access or column rule): nothing was written, and the same call is refused again. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** The caller's identity may not do this at all (the owner does it on the Board). */
export class OwnerOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerOnlyError';
  }
}

/** The factory core tried to change a task field that is the owner's. */
export class CoreFieldError extends Error {
  constructor(readonly field: string) {
    super(`factory core may not change ${field}`);
    this.name = 'CoreFieldError';
  }
}

/** A row without a version cannot take a compare-and-set update. */
export class MissingVersionError extends Error {
  constructor(table: string, key: string) {
    super(`${table} row ${key} has no version; rows made outside the factory must set version 1`);
    this.name = 'MissingVersionError';
  }
}

/**
 * The task update landed (version + 1) but the task could not be read back. Final: sending the update again
 * would be a version conflict with our own write. The caller knows the result: its task plus its patch.
 */
export class RereadAfterUpdateError extends Error {
  constructor(readonly taskId: string) {
    super(`task ${taskId} updated; re-read failed`);
    this.name = 'RereadAfterUpdateError';
  }
}

export type NewApproval = Omit<Approval, 'at'> & { approvalId?: string };

/** The same approval content: a stored one with the caller's id is a retry only if this matches. */
export const sameApproval = (a: Omit<Approval, 'at'>, b: Omit<Approval, 'at'>): boolean =>
  a.taskId === b.taskId && a.gate === b.gate && a.docVersion === b.docVersion && a.decision === b.decision && a.comment === b.comment;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with object keys sorted, so equal values compare equal whatever their key order. undefined is 'undefined'. */
export const canonicalJson = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isPlainObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x) ?? 'undefined';

/** The stored value of one settings scope changed since the caller read it. */
export const settingsConflict = (scope: string): VersionConflictError =>
  new VersionConflictError(`settings ${scope}`, Number.NaN, Number.NaN, `settings ${scope} changed since they were read; reload and save again`);

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
  /** Every version of a task's doc, ascending; the highest is 'current', the rest 'superseded'. */
  listDocs(taskId: string, kind: DocKind): Promise<Doc[]>;
  /** A caller-supplied `approvalId` makes a retry safe: the same id returns the approval already stored. */
  addApproval(a: NewApproval): Promise<Approval>;
  listApprovals(taskId: string): Promise<Approval[]>;
  getSettings(): Promise<StoredSettings>;
  /** Dev use only (writes every scope, no conflict check). The Board uses updateSettingsScope. */
  setSettings(s: StoredSettings): Promise<void>;
  /**
   * Writes one scope only, if its stored value (as getSettings gives it: global merged over the defaults, a missing
   * repo scope undefined) still equals `before` as canonical JSON; otherwise throws VersionConflictError.
   * `after` null removes a repo scope.
   */
  updateSettingsScope(scope: 'global' | RepoId, before: unknown, after: Settings | RepoSettings | null): Promise<void>;
  startRun(r: { taskId: string; step: Step; mode: Mode; agent: string }): Promise<Run>;
  openRun(taskId: string, step: Step): Promise<Run | undefined>;
  finishRun(runId: string, p: { result: string; turns: number | null; costUsd: number | null }): Promise<void>;
  /** A task's runs, finished or not, by start time ascending. */
  listRuns(taskId: string): Promise<Run[]>;
  addEvents(e: FactoryEvent[]): Promise<void>;
  listEvents(taskId?: string): Promise<FactoryEvent[]>;
}

/**
 * updateTask for a caller that holds the task at `task.version`. A write that landed but could not be read back
 * (RereadAfterUpdateError) is exactly the held task plus the patch at version + 1: the version check proved the row
 * was the held task. So the caller still gets the task, and can write its events.
 */
export async function updateHeld(store: BoardStore, task: Task, patch: Partial<Task>): Promise<Task> {
  try {
    return await store.updateTask(task.taskId, task.version, patch);
  } catch (e) {
    if (e instanceof RereadAfterUpdateError) return { ...task, ...structuredClone(patch), version: task.version + 1 };
    throw e;
  }
}
