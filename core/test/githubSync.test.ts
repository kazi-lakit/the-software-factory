import { describe, expect, test } from 'vitest';
import {
  applySyncRequest, failStaleSync, canSyncMove, fitSyncPlan, latestSync, syncSummary, watcherState, SYNC_MOVES, type SyncPlan, type SyncRequest, type SyncState,
} from '../src/githubSync.js';
import type { PullAction } from '../src/githubPull.js';
import { createTask } from '../src/owner.js';
import type { BoardStore } from '../src/boardStore.js';
import { MemoryStore, VersionConflictError } from '../src/store.js';
import { defFixture, repoFixture } from './factoryFixtures.js';


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
    const owner = [['planned', 'applying'], ['applying', 'applying'], ['applying', 'applied'], ['applying', 'failed']];
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

describe('applySyncRequest', () => {
  const NOW = '2026-11-15T10:00:00.000Z';
  const now = () => new Date(NOW);
  const issue = { repo: 'o/app', number: 7 };
  const mk = (n: number, status: 'inbox' | 'ready' = 'inbox'): PullAction => ({
    kind: 'create', issue: { repo: 'o/app', number: n }, nodeId: 'N', itemId: 'I', option: null, labelled: true, repoId: 'app', baseBranch: 'dev', title: `New ${n}`, description: 'd', status,
  });
  const setup = async (plan: Partial<SyncPlan>, withTask = false) => {
    const factories = { defs: [defFixture('f')], repos: [repoFixture('f', 'app')] };
    const core = new MemoryStore({ identity: 'core', factories });
    const store = new MemoryStore({ identity: 'owner', factories });
    // Both identities share one state.
    (core as unknown as { state: unknown }).state = (store as unknown as { state: unknown }).state;
    const task = withTask ? await createTask(store, now, { factoryId: 'f', title: 'T', description: 'D', repo: 'app' }) : undefined;
    const queued = await store.requestSync('f', 'o');
    const full: SyncPlan = { actions: [], notApplied: [], done: [], errors: [], ...plan };
    const planned = await core.saveSyncRequest(queued, { ...queued, state: 'planned', plan: full, plannedAt: NOW });
    return { store, core, task, planned };
  };

  test('a planned row with create and ready is applied and stored as applied with a summary', async () => {
    const { store, task, planned } = await setup({ actions: [mk(9), { kind: 'ready', taskId: 'T-1', version: 0, issue, onApplied: {} }] }, true);
    planned.plan!.actions[1] = { kind: 'ready', taskId: 'T-1', version: task!.version, issue, onApplied: {} };
    const r = await applySyncRequest(store, now, planned);
    expect(r).toMatchObject({ state: 'applied', appliedAt: NOW });
    expect(syncSummary(r!.result!)).toBe('created 1, applied 1, not applied 0, failed 0');
    expect((await store.listEvents('T-2'))[0]).toMatchObject({ actor: 'github', action: 'create' });
    expect((await store.listSyncRequests('f'))[0]!.state).toBe('applied');
    expect(JSON.stringify(r!.result)).not.toContain('onApplied');
  });
  test('done and errors from the factory machine lead the result', async () => {
    const done = { taskId: 'T-1', issue: 'o/app#7', change: 'moved' };
    const err = { taskId: null, issue: null, message: 'core failed' };
    const { store, planned } = await setup({ actions: [mk(9)], done: [done], errors: [err] });
    const r = await applySyncRequest(store, now, planned);
    expect(r!.result!.applied[0]).toEqual(done);
    expect(r!.result!.applied).toHaveLength(1);
    expect(r!.result!.errors).toEqual([err]);
    expect(r!.result!.created).toHaveLength(1);
  });
  test('a block action is not applied by the Board', async () => {
    const { store, planned } = await setup({ actions: [{ kind: 'block', taskId: 'T-1', version: 1, issue, reason: 'label removed' }] }, true);
    const r = await applySyncRequest(store, now, planned);
    expect(r!.result!.notApplied).toEqual([{ taskId: 'T-1', issue: 'o/app#7', change: 'block', reason: 'the factory machine applies this' }]);
    expect(r!.result!.applied).toEqual([]);
    expect((await store.getTask('T-1')).status).toBe('inbox');
  });
  test('a stale version is listed as not applied, not as an error', async () => {
    const { store, planned } = await setup({ actions: [{ kind: 'ready', taskId: 'T-1', version: 99, issue, onApplied: {} }] }, true);
    const r = await applySyncRequest(store, now, planned);
    expect(r!.result!.notApplied).toMatchObject([{ taskId: 'T-1', change: 'ready', reason: 'task changed meanwhile' }]);
    expect(r!.result!.errors).toEqual([]);
  });
  test('a second applier loses the claim and applies nothing', async () => {
    const { store, planned } = await setup({ actions: [mk(9)] });
    const [a, b] = await Promise.all([applySyncRequest(store, now, planned), applySyncRequest(store, now, planned)]);
    expect([a, b].filter((x) => x === null)).toHaveLength(1);
    expect(await store.listTasks()).toHaveLength(1);
  });
  test('a non-planned row is ignored', async () => {
    const { store, planned } = await setup({ actions: [mk(9)] });
    expect(await applySyncRequest(store, now, { ...planned, state: 'applied' })).toBeNull();
    expect(await store.listTasks()).toHaveLength(0);
  });
  test('a long apply refreshes applyingSince every 10 applied actions', async () => {
    const { store, planned } = await setup({ actions: Array.from({ length: 25 }, (_, i) => mk(100 + i)) });
    const moves: string[] = [];
    let created = 0;
    const spy = new Proxy(store, { get(target, p, r) {
      const v = Reflect.get(target, p, r);
      if (typeof v !== 'function') return v;
      if (p === 'createTask') return async (...a: unknown[]) => { created++; return v.apply(target, a); };
      if (p === 'saveSyncRequest') return async (b: SyncRequest, a: SyncRequest) => { moves.push(`${b.state}>${a.state}@${created}`); return v.call(target, b, a); };
      return v.bind(target);
    } }) as BoardStore;
    const r = await applySyncRequest(spy, now, planned);
    expect(moves).toEqual(['planned>applying@0', 'applying>applying@10', 'applying>applying@20', 'applying>applied@25']);
    expect(r).toMatchObject({ state: 'applied', version: 6 });
    expect(r!.result!.created).toHaveLength(25);
  });
  test('a heartbeat that conflicts stops the apply at once and leaves the row as the other party wrote it', async () => {
    const { store, core, planned } = await setup({ actions: Array.from({ length: 25 }, (_, i) => mk(100 + i)) });
    const spy = new Proxy(store, { get(target, p, r) {
      const v = Reflect.get(target, p, r);
      if (typeof v !== 'function') return v;
      if (p === 'saveSyncRequest') {
        return async (b: SyncRequest, a: SyncRequest) => {
          // The watcher fails the row just before the first heartbeat.
          if (b.state === 'applying' && a.state === 'applying') await core.saveSyncRequest(b, { ...b, state: 'failed', error: 'interrupted while applying; click Sync again' });
          return v.call(target, b, a);
        };
      }
      return v.bind(target);
    } }) as BoardStore;
    await expect(applySyncRequest(spy, now, planned)).rejects.toBeInstanceOf(VersionConflictError);
    expect(await store.listTasks()).toHaveLength(10);
    expect((await store.listSyncRequests('f'))[0]).toMatchObject({ state: 'failed', error: 'interrupted while applying; click Sync again' });
  });
  test('the store keeps everything but applyingSince on a heartbeat', async () => {
    const { store, planned } = await setup({});
    const applying = await store.saveSyncRequest(planned, { ...planned, state: 'applying', applyingSince: 'a' });
    const beat = await store.saveSyncRequest(applying, { ...applying, state: 'applying', applyingSince: 'b', error: 'x', plan: null });
    expect(beat).toMatchObject({ state: 'applying', applyingSince: 'b', error: null, version: applying.version + 1 });
    expect(beat.plan).toEqual(planned.plan);
  });
  test('failStaleSync with the caller\'s own since time ignores applyingSince', async () => {
    const { store, planned } = await setup({});
    // applyingSince from a browser clock ten minutes behind.
    const applying = await store.saveSyncRequest(planned, { ...planned, state: 'applying', applyingSince: '2026-11-15T09:50:00.000Z' });
    const seen = Date.parse('2026-11-15T09:59:00.000Z');
    expect(await failStaleSync(store, now, applying, seen)).toBeNull();
    expect(await failStaleSync(store, () => new Date('2026-11-15T10:01:00.000Z'), applying, seen)).toMatchObject({ state: 'failed' });
  });
  test('failStaleSync fails an applying row after 120 s and leaves a fresh one', async () => {
    const { store, planned } = await setup({});
    const applying = await store.saveSyncRequest(planned, { ...planned, state: 'applying', applyingSince: '2026-11-15T09:58:00.000Z' });
    expect(await failStaleSync(store, () => new Date('2026-11-15T09:59:59.000Z'), applying)).toBeNull();
    const failed = await failStaleSync(store, now, applying);
    expect(failed).toMatchObject({ state: 'failed', error: 'interrupted while applying; click Sync again' });
    expect(await failStaleSync(store, now, planned)).toBeNull();
  });
});
