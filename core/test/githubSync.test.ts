import { describe, expect, test } from 'vitest';
import {
  canSyncMove, fitSyncPlan, latestSync, syncSummary, watcherState, SYNC_MOVES, type SyncPlan, type SyncRequest, type SyncState,
} from '../src/githubSync.js';
import type { PullAction } from '../src/githubPull.js';

const STATES: SyncState[] = ['queued', 'planned', 'applying', 'applied', 'failed'];
const row = (requestId: string, requestedAt: string, state: SyncState = 'queued'): SyncRequest => ({
  requestId, factoryId: 'f', requestedAt, requestedBy: 'o', state, plan: null, plannedAt: null, applyingSince: null,
  result: null, appliedAt: null, error: null, version: 1,
});
const create = (n: number, description: string): PullAction => ({
  kind: 'create', issue: { repo: 'o/r', number: n }, nodeId: `N${n}`, itemId: `I${n}`, option: null, labelled: true,
  repoId: 'r', baseBranch: 'main', title: `t${n}`, description, status: 'inbox',
});

describe('githubSync', () => {
  test('core may plan or fail a queued row; only the owner claims and finishes', () => {
    const core = [['queued', 'planned'], ['queued', 'failed'], ['planned', 'failed'], ['applying', 'failed']];
    const owner = [['planned', 'applying'], ['applying', 'applied'], ['applying', 'failed']];
    for (const from of STATES) for (const to of STATES) {
      expect(canSyncMove(from, to, 'core')).toBe(core.some(([a, b]) => a === from && b === to));
      expect(canSyncMove(from, to, 'owner')).toBe(owner.some(([a, b]) => a === from && b === to));
    }
    expect(SYNC_MOVES.core).toHaveLength(4);
  });
  test('fitSyncPlan keeps a small plan as is and drops the last creates of a large one', () => {
    const small: SyncPlan = { actions: [create(1, 'x')], notApplied: [], done: [], errors: [] };
    expect(fitSyncPlan(small)).toEqual(small);
    const big: SyncPlan = { actions: [1, 2, 3].map((n) => create(n, 'x'.repeat(2 * 1024 * 1024))), notApplied: [], done: [], errors: [] };
    const fit = fitSyncPlan(big);
    expect(fit.actions).toHaveLength(1);
    expect(fit.notApplied).toHaveLength(2);
    expect(fit.notApplied[0]).toMatchObject({ change: 'new issue', reason: 'too many changes for one Sync; click Sync again' });
  });
  test('latestSync picks the newest, optionally by state', () => {
    const rows = [row('a', '2026-01-01', 'planned'), row('c', '2026-01-02', 'queued'), row('b', '2026-01-02', 'queued')];
    expect(latestSync(rows)?.requestId).toBe('c');
    expect(latestSync(rows, 'planned')?.requestId).toBe('a');
    expect(latestSync(rows, 'applied')).toBeUndefined();
  });
  test('watcherState is never without a time, stale after 120 s, else seen', () => {
    const now = new Date('2026-01-01T00:10:00Z');
    expect(watcherState(undefined, now)).toBe('never');
    expect(watcherState({ factoryId: 'f', ghLoggedIn: true, checkedAt: 't' }, now)).toBe('never');
    expect(watcherState({ factoryId: 'f', ghLoggedIn: true, checkedAt: 't', watcherSeenAt: '2026-01-01T00:08:01Z' }, now)).toBe('seen');
    expect(watcherState({ factoryId: 'f', ghLoggedIn: true, checkedAt: 't', watcherSeenAt: '2026-01-01T00:07:59Z' }, now)).toBe('stale');
  });
  test('syncSummary counts each list', () => {
    expect(syncSummary({ created: [{ taskId: 'T-1', issue: 'o/r#1', status: 'inbox' }], applied: [], notApplied: [], errors: [] }))
      .toBe('created 1, applied 0, not applied 0, failed 0');
  });
});
