import type { FactoryHealth } from './factories.js';
import type { PullAction, NotApplied } from './githubPull.js';
import type { PullError } from './githubPullApply.js';
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
