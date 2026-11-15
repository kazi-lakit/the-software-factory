import { VersionConflictError, type BoardStore } from './boardStore.js';
import type { FactoryHealth } from './factories.js';
import type { PullAction, NotApplied } from './githubPull.js';
import { applyPull, firstLine, type ApplyResult, type PullError } from './githubPullApply.js';
import { MAX_DOC_BYTES } from './limits.js';

// Pure (no Node API, no credential): the sync request the Board queues, the factory machine plans and the Board applies.

export type SyncState = 'queued' | 'planned' | 'applying' | 'applied' | 'failed';
export interface SyncDone { taskId: string; issue: string; change: string }
export interface SyncPlan { actions: PullAction[]; notApplied: NotApplied[]; done: SyncDone[]; errors: PullError[] }
export interface SyncResult {
  created: { taskId: string; issue: string; status: 'inbox' | 'ready' }[]; applied: SyncDone[]; notApplied: NotApplied[]; errors: PullError[];
}
export interface SyncRequest {
  requestId: string; factoryId: string; requestedAt: string; requestedBy: string; state: SyncState;
  plan: SyncPlan | null; plannedAt: string | null; applyingSince: string | null;
  result: SyncResult | null; appliedAt: string | null; error: string | null; version: number;
}

/** The state moves each identity may make (builder's call 4). */
export const SYNC_MOVES: Readonly<Record<'core' | 'owner', readonly (readonly [SyncState, SyncState])[]>> = {
  core: [['queued', 'planned'], ['queued', 'failed'], ['planned', 'failed'], ['applying', 'failed']],
  owner: [['planned', 'applying'], ['applying', 'applied'], ['applying', 'failed']],
};

export const canSyncMove = (from: SyncState, to: SyncState, who: 'core' | 'owner'): boolean =>
  SYNC_MOVES[who].some(([a, b]) => a === from && b === to);

/** An `applying` row younger than this still blocks planning. */
export const SYNC_APPLY_MS = 120_000;
/** The watcher counts as not seen after this long. */
export const WATCHER_STALE_MS = 120_000;
export const MAX_SYNC_JSON_BYTES = MAX_DOC_BYTES;
export const GITHUB_SCHEMA_MISSING = 'GitHub tables are missing in Blocks Data; apply the schema change in docs/setup/blocks-project-setup.md';

const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

/** Drops `create` actions from the end until the plan JSON fits; each becomes not applied (builder's call 15). */
export function fitSyncPlan(p: SyncPlan): SyncPlan {
  if (jsonBytes(p) <= MAX_SYNC_JSON_BYTES) return p;
  const actions = [...p.actions];
  const notApplied = [...p.notApplied];
  const dropped: NotApplied[] = [];
  while (jsonBytes({ ...p, actions, notApplied: [...notApplied, ...dropped] }) > MAX_SYNC_JSON_BYTES) {
    let i = actions.length - 1;
    while (i >= 0 && actions[i]!.kind !== 'create') i--;
    const a = actions[i];
    if (!a || a.kind !== 'create') break;
    actions.splice(i, 1);
    dropped.unshift({ taskId: null, issue: `${a.issue.repo}#${a.issue.number}`, change: 'new issue', reason: 'too many changes for one Sync; click Sync again' });
  }
  return { ...p, actions, notApplied: [...notApplied, ...dropped] };
}

/** The newest request (by requestedAt, then requestId), optionally only in one state. */
export function latestSync(rows: SyncRequest[], state?: SyncState): SyncRequest | undefined {
  let best: SyncRequest | undefined;
  for (const r of rows) {
    if (state !== undefined && r.state !== state) continue;
    if (!best || r.requestedAt > best.requestedAt || (r.requestedAt === best.requestedAt && r.requestId > best.requestId)) best = r;
  }
  return best;
}

export function watcherState(h: FactoryHealth | undefined, now: Date): 'seen' | 'stale' | 'never' {
  const t = h?.watcherSeenAt ? Date.parse(h.watcherSeenAt) : NaN;
  if (Number.isNaN(t)) return 'never';
  return now.getTime() - t > WATCHER_STALE_MS ? 'stale' : 'seen';
}

export const syncSummary = (r: SyncResult): string =>
  `created ${r.created.length}, applied ${r.applied.length}, not applied ${r.notApplied.length}, failed ${r.errors.length}`;

/** The plan's own `done`/`errors` lead; `action`, `onApplied` and not-applied `link` patches (core-only) are dropped. */
export function toSyncResult(plan: SyncPlan, r: ApplyResult): SyncResult {
  return {
    created: r.created.map(({ taskId, issue, status }) => ({ taskId, issue, status })),
    applied: [...plan.done, ...r.applied.map(({ taskId, issue, change }) => ({ taskId, issue, change }))],
    notApplied: r.notApplied.map(({ link: _link, ...n }) => n),
    errors: [...plan.errors, ...r.errors],
  };
}

const conflictOrThrow = (e: unknown): null => {
  if (e instanceof VersionConflictError) return null;
  throw e;
};

/** Claims the planned row (planned→applying), applies its actions as the caller (the owner), stores the result (applied). Null when another applier holds it. */
export async function applySyncRequest(store: BoardStore, now: () => Date, row: SyncRequest): Promise<SyncRequest | null> {
  if (row.state !== 'planned' || !row.plan) return null;
  let claimed: SyncRequest;
  try {
    claimed = await store.saveSyncRequest(row, { ...row, state: 'applying', applyingSince: now().toISOString() });
  } catch (e) {
    return conflictOrThrow(e);
  }
  const plan = row.plan;
  const blocks = plan.actions.filter((a) => a.kind === 'block');
  const refused: NotApplied[] = blocks.map((a) => ({
    taskId: 'taskId' in a ? a.taskId : null, issue: `${a.issue.repo}#${a.issue.number}`, change: 'block', reason: 'the factory machine applies this',
  }));
  try {
    const r = await applyPull(store, now, { factoryId: claimed.factoryId, actions: plan.actions.filter((a) => a.kind !== 'block'), notApplied: plan.notApplied });
    r.notApplied.push(...refused);
    return await store.saveSyncRequest(claimed, { ...claimed, state: 'applied', result: toSyncResult(plan, r), appliedAt: now().toISOString() });
  } catch (e) {
    try { await store.saveSyncRequest(claimed, { ...claimed, state: 'failed', error: firstLine(e) }); } catch { /* the first error is the one to report */ }
    throw e;
  }
}

/** An applying row whose claim is older than SYNC_APPLY_MS: applying→failed with `interrupted while applying; click Sync again`. Null when it is not stale or the save conflicts. */
export async function failStaleSync(store: BoardStore, now: () => Date, row: SyncRequest): Promise<SyncRequest | null> {
  const since = row.applyingSince ? Date.parse(row.applyingSince) : NaN;
  if (row.state !== 'applying' || now().getTime() - since < SYNC_APPLY_MS) return null;
  try {
    return await store.saveSyncRequest(row, { ...row, state: 'failed', error: 'interrupted while applying; click Sync again' });
  } catch (e) {
    return conflictOrThrow(e);
  }
}
