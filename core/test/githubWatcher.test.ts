import { describe, expect, test } from 'vitest';
import { FakeBlocksData, newFakeStorage } from '../src/blocks/fakeData.js';
import { GITHUB_SCHEMA } from '../src/blocks/schema.js';
import { BlocksStore } from '../src/blocks/store.js';
import type { BoardStore } from '../src/boardStore.js';
import { FakeGitHub } from '../src/github.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { DEFAULT_STATUS_MAP, type GitHubSettings } from '../src/githubConfig.js';
import type { PullLock } from '../src/githubPuller.js';
import { applySyncRequest, type SyncRequest } from '../src/githubSync.js';
import { GitHubWatcher, optionProblems, WATCHER_HEALTH_MS, type WatcherDeps } from '../src/githubWatcher.js';
import { createTask } from '../src/owner.js';
import type { Status } from '../src/types.js';
import { defFixture, repoFixture, seedBlocksFactories } from './factoryFixtures.js';

const OPTIONS = ['Backlog', 'Todo', 'In progress', 'In review', 'Merged'];
const REPO = { owner: 'o', repo: 'app' };
const PROJECT = { owner: 'o', number: 3 };
const hub = (statusMap: Record<Status, string> = DEFAULT_STATUS_MAP, project = PROJECT): GitHubSettings => ({
  mode: 'connected', project, label: 'factory', approvers: ['me'], statusMap,
});

function setup(opts: { statusMap?: Record<Status, string>; project?: { owner: string; number: number }; missing?: boolean; lock?: PullLock; board?: (b: FakeGitHubBoard) => GitHubBoard; wrap?: (core: BoardStore, owner: BlocksStore) => BoardStore } = {}) {
  let t = new Date('2026-11-15T10:00:00Z');
  const now = () => t;
  const storage = newFakeStorage();
  const missing = opts.missing ? { missing: GITHUB_SCHEMA } : {};
  const coreData = new FakeBlocksData('factory-core', { storage, now, ...missing });
  const ownerData = new FakeBlocksData('factory-owner', { storage, now, ...missing });
  seedBlocksFactories(coreData, {
    defs: [defFixture('f', { ghUser: 'me', github: hub(opts.statusMap, opts.project) }), defFixture('g', { ghUser: 'me' })],
    repos: [repoFixture('f', 'app', { remote: 'git@github.com:o/app.git' }), repoFixture('g', 'web', { remote: 'git@github.com:o/web.git' })],
  });
  const core = new BlocksStore(coreData, 'core', { now });
  const owner = new BlocksStore(ownerData, 'owner', { now });
  const board = new FakeGitHubBoard();
  board.addProject(PROJECT, OPTIONS);
  const seen = opts.board ? opts.board(board) : board;
  let boardCalls = 0;
  const deps: WatcherDeps = {
    store: opts.wrap ? opts.wrap(core, owner) : core, boardFor: () => { boardCalls++; return seen; }, githubFor: () => new FakeGitHub(), now, claimant: 'watcher',
    loggedIn: async () => new Set(['me']), ...(opts.lock ? { lock: opts.lock } : {}),
  };
  const watcher = new GitHubWatcher(deps);
  return {
    core, owner, board, watcher, now,
    boardCalls: () => boardCalls,
    advance: (ms: number) => { t = new Date(t.getTime() + ms); },
  };
}
type S = ReturnType<typeof setup>;

const own = (s: S, factoryId = 'f', repo = 'app') => createTask(s.owner, s.now, { factoryId, title: 'Do it', description: 'desc', repo });
const project = async (s: S) => (await s.board.project(PROJECT))!;
/** A labelled issue on the Project with the given Status. */
async function issueOnProject(s: S, status: string, title = 'From GitHub'): Promise<number> {
  const made = await s.board.createIssue(REPO, { title, body: 'please', labels: ['factory'] });
  await s.board.setStatus(await project(s), await s.board.addToProject(await project(s), made.nodeId), status);
  return made.number;
}
const row = async (s: S, requestId: string): Promise<SyncRequest> => (await s.owner.listSyncRequests('f')).find((r) => r.requestId === requestId)!;
/** The store, with `method` replaced by `fn` (which gets the real method). */
const intercept = <K extends keyof BoardStore>(store: BoardStore, method: K, fn: (real: BoardStore[K], ...a: Parameters<BoardStore[K]>) => ReturnType<BoardStore[K]>): BoardStore =>
  new Proxy(store, { get(target, p, r) {
    const v = Reflect.get(target, p, r);
    if (typeof v !== 'function') return v;
    const real = v.bind(target);
    return p === method ? (...a: Parameters<BoardStore[K]>) => fn(real, ...a) : real;
  } });
/** The board, but `method` throws on its next `fails.n` calls (set `fails.n` to arm it). */
const failing = (b: FakeGitHubBoard, method: keyof GitHubBoard, fails: { n: number }): GitHubBoard =>
  new Proxy(b, { get(target, p, r) {
    const v = Reflect.get(target, p, r);
    if (typeof v !== 'function') return v;
    return (...a: unknown[]) => { if (p === method && fails.n-- > 0) throw new Error('boom'); return v.apply(target, a); };
  } });

describe('GitHubWatcher', () => {
  test('a Board-created task gets an issue on the next tick', async () => {
    const s = setup();
    const t = await own(s);
    const tick = await s.watcher.tick();
    expect(tick.schemaMissing).toBe(false);
    expect(tick.pushed).toMatchObject([{ taskId: t.taskId, issue: 'o/app#1', error: null }]);
    expect((await s.core.getGitHubLink(t.taskId))?.issueNumber).toBe(1);
  });

  test('a queued request becomes a planned change set; the owner applies it', async () => {
    const s = setup();
    const n = await issueOnProject(s, 'Todo');
    const q = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.synced).toEqual([{ factoryId: 'f', requestId: q.requestId, state: 'planned', actions: 1, notApplied: 0, error: null }]);
    const planned = await row(s, q.requestId);
    expect(planned.state).toBe('planned');
    expect(planned.plannedAt).toBe(s.now().toISOString());
    expect(planned.plan!.actions).toMatchObject([{ kind: 'create', issue: { repo: 'o/app', number: n } }]);
    expect(await s.owner.listTasks()).toEqual([]);

    const applied = (await applySyncRequest(s.owner, s.now, planned))!;
    expect(applied.result!.created).toMatchObject([{ status: 'ready' }]);
    const taskId = applied.result!.created[0]!.taskId;
    expect(await s.owner.getTask(taskId)).toMatchObject({ status: 'ready', title: 'From GitHub' });

    await s.watcher.tick();
    expect((await s.core.getGitHubLink(taskId))?.issueNumber).toBe(n);
    expect(s.board.issue(REPO, n).body).toContain(`tsf:task=${taskId}`);
  });

  test('label removed on a build task is blocked by the factory machine and listed as done', async () => {
    const s = setup();
    const t = await own(s);
    await s.watcher.tick();
    const cur = await s.core.getTask(t.taskId);
    await s.core.updateTask(t.taskId, cur.version, { status: 'build', stage: 'build' });
    await s.watcher.tick();
    expect((await s.core.getGitHubLink(t.taskId))?.pushed.label).toBe('factory');
    s.board.issue(REPO, 1).labels = [];
    const q = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.synced).toMatchObject([{ requestId: q.requestId, state: 'planned', actions: 0, error: null }]);
    expect(await s.core.getTask(t.taskId)).toMatchObject({ status: 'blocked', blockedReason: 'label removed' });
    const planned = await row(s, q.requestId);
    expect(planned.plan!.actions).toEqual([]);
    expect(planned.plan!.done[0]).toEqual({ taskId: t.taskId, issue: 'o/app#1', change: 'blocked (label removed)' });
  });

  test('a Status move not applied saves the option, so the push puts it back', async () => {
    const s = setup();
    const t = await own(s);
    await s.watcher.tick();
    const p = await project(s);
    await s.board.setStatus(p, (await s.core.getGitHubLink(t.taskId))!.itemId!, 'In review');
    const q = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    const planned = await row(s, q.requestId);
    expect(planned.plan!.notApplied).toMatchObject([{ taskId: t.taskId, change: 'Status In review' }]);
    expect((await s.core.getGitHubLink(t.taskId))!.pushed.option).toBe('In review');
    const next = await s.watcher.tick();
    expect(next.pushed[0]!.done).toContain('status Backlog');
    expect(s.board.issue(REPO, 1).itemStatus).toBe('Backlog');
  });

  test('a second request while the first is unapplied supersedes it', async () => {
    const s = setup();
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    expect((await row(s, a.requestId)).state).toBe('planned');
    s.advance(1000);
    const b = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.superseded).toEqual([a.requestId]);
    expect(await row(s, a.requestId)).toMatchObject({ state: 'failed', error: 'superseded by a newer Sync' });
    const planned = await row(s, b.requestId);
    expect(planned.state).toBe('planned');
    expect(await applySyncRequest(s.owner, s.now, planned)).not.toBeNull();
    expect(await s.owner.listTasks()).toHaveLength(1);
  });

  test('of two queued requests only the newest is planned', async () => {
    const s = setup();
    const a = await s.owner.requestSync('f', 'me');
    s.advance(1000);
    const b = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.superseded).toEqual([a.requestId]);
    expect(tick.synced).toMatchObject([{ requestId: b.requestId, state: 'planned' }]);
    expect((await row(s, a.requestId)).error).toBe('superseded by a newer Sync');
  });

  test('a fresh applying row stops planning; an applying row older than 120 s fails and the next request is planned', async () => {
    const s = setup();
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    const planned = await row(s, a.requestId);
    await s.owner.saveSyncRequest(planned, { ...planned, state: 'applying', applyingSince: s.now().toISOString() });
    s.advance(1000);
    const b = await s.owner.requestSync('f', 'me');
    const blocked = await s.watcher.tick();
    expect(blocked.synced).toEqual([]);
    expect((await row(s, b.requestId)).state).toBe('queued');
    // The watcher first saw the row applying 1 s after the claim: 120 s by its own clock is 121 s after the claim.
    s.advance(119_000);
    expect((await s.watcher.tick()).synced).toEqual([]);
    expect((await row(s, a.requestId)).state).toBe('applying');
    s.advance(1000);
    const tick = await s.watcher.tick();
    expect(await row(s, a.requestId)).toMatchObject({ state: 'failed', error: 'interrupted while applying; click Sync again' });
    // a's create stays pending for 10 minutes (its applier may not have stopped), so b does not plan it again.
    expect(tick.synced).toMatchObject([{ requestId: b.requestId, state: 'planned', actions: 0 }]);
  });

  test('a long apply that keeps its heartbeat is never failed; a Board failure after it still holds its issues for 10 minutes', async () => {
    const s = setup();
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    let cur = await row(s, a.requestId);
    cur = await s.owner.saveSyncRequest(cur, { ...cur, state: 'applying', applyingSince: s.now().toISOString() });
    for (let i = 0; i < 12; i++) {
      s.advance(60_000);
      cur = await s.owner.saveSyncRequest(cur, { ...cur, applyingSince: s.now().toISOString() });
      await s.watcher.tick();
      expect((await row(s, a.requestId)).state).toBe('applying');
    }
    await s.owner.saveSyncRequest(cur, { ...cur, state: 'failed', error: 'boom' });
    s.advance(1000);
    const b = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.synced).toMatchObject([{ requestId: b.requestId, state: 'planned', actions: 0 }]);
  });

  test('a claim stamped by a browser clock far behind is not failed before 120 s by the watcher clock', async () => {
    const s = setup();
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    const planned = await row(s, a.requestId);
    await s.owner.saveSyncRequest(planned, { ...planned, state: 'applying', applyingSince: '2026-11-15T09:00:00.000Z' });
    await s.watcher.tick();
    s.advance(119_000);
    await s.watcher.tick();
    expect((await row(s, a.requestId)).state).toBe('applying');
    s.advance(1000);
    await s.watcher.tick();
    expect((await row(s, a.requestId)).state).toBe('failed');
  });

  test('the creates of a row failed as stale are not planned again for 10 minutes, whatever the browser clock says', async () => {
    const s = setup();
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    const planned = await row(s, a.requestId);
    // The Board claims with a clock an hour behind and then stops (the page closed mid-apply).
    await s.owner.saveSyncRequest(planned, { ...planned, state: 'applying', applyingSince: '2026-11-15T09:00:00.000Z' });
    await s.watcher.tick();
    s.advance(120_000);
    await s.watcher.tick();
    expect((await row(s, a.requestId)).state).toBe('failed');
    const b = await s.owner.requestSync('f', 'me');
    expect((await s.watcher.tick()).synced).toMatchObject([{ requestId: b.requestId, state: 'planned', actions: 0 }]);
    s.advance(9 * 60_000);
    const c = await s.owner.requestSync('f', 'me');
    expect((await s.watcher.tick()).synced).toMatchObject([{ requestId: c.requestId, state: 'planned', actions: 0 }]);
    s.advance(60_000);
    const d = await s.owner.requestSync('f', 'me');
    expect((await s.watcher.tick()).synced).toMatchObject([{ requestId: d.requestId, state: 'planned', actions: 1 }]);
  });

  test('a planned save lost to another party reports nothing', async () => {
    let core: BoardStore | undefined;
    const s = setup({
      wrap: (c) => {
        core = c;
        return intercept(c, 'saveSyncRequest', async (real, before, after) => {
          // Another watcher fails the row first.
          if (after.state === 'planned') await core!.saveSyncRequest(before, { ...before, state: 'failed', error: 'other' });
          return real(before, after);
        });
      },
    });
    const a = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.synced).toEqual([]);
    expect(await row(s, a.requestId)).toMatchObject({ state: 'failed', error: 'other' });
  });

  test('issues of create actions in planned rows are not planned again', async () => {
    const s = setup();
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    s.advance(1000);
    const b = await s.owner.requestSync('f', 'me');
    // b was planned elsewhere (another watcher) before a is looked at: a is the newest queued row, older than b.
    const bq = await row(s, b.requestId);
    const create = { kind: 'create' as const, issue: { repo: 'o/app', number: 1 }, nodeId: 'N', itemId: 'I', option: 'Todo', labelled: true, repoId: 'app', baseBranch: 'dev', title: 'From GitHub', description: 'please', status: 'ready' as const };
    await s.core.saveSyncRequest(bq, { ...bq, state: 'planned', plan: { actions: [create], notApplied: [], done: [], errors: [] }, plannedAt: s.now().toISOString() });
    const tick = await s.watcher.tick();
    expect(tick.synced).toMatchObject([{ requestId: a.requestId, state: 'planned', actions: 0 }]);
  });

  test('a GitHub-created task not adopted yet keeps its issue from being planned again', async () => {
    const fails = { n: 0 };
    const s = setup({ board: (b) => failing(b, 'listItems', fails) });
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    await applySyncRequest(s.owner, s.now, await row(s, a.requestId));
    fails.n = 1;
    const b = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick(); // the push's adopt fails on listItems; the planner then reads the items
    expect(tick.pushed[0]!.error).toBe('boom');
    expect(tick.synced).toMatchObject([{ requestId: b.requestId, state: 'planned', actions: 0 }]);
  });

  test('a held lock leaves the request queued and pushes wait for it', async () => {
    const lock = Object.assign(async () => null, { held: () => true });
    const s = setup({ lock });
    const t = await own(s);
    const q = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.pushed).toMatchObject([{ taskId: t.taskId, skipped: 'busy' }]);
    expect(tick.synced).toEqual([]);
    expect((await row(s, q.requestId)).state).toBe('queued');
  });

  test('a missing Project fails the request with its message', async () => {
    const s = setup({ project: { owner: 'o', number: 9 } });
    const q = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.synced).toEqual([{ factoryId: 'f', requestId: q.requestId, state: 'failed', actions: 0, notApplied: 0, error: 'Project o/9 not found' }]);
    expect(await row(s, q.requestId)).toMatchObject({ state: 'failed', error: 'Project o/9 not found' });
  });

  test('health: watcherSeenAt, ghLoggedIn and a missing option are written; not again within 30 s', async () => {
    const s = setup({ statusMap: { ...DEFAULT_STATUS_MAP, verify: 'Testing' } });
    const first = s.now().toISOString();
    await s.watcher.tick();
    const health = async () => (await s.owner.listFactoryHealth()).find((h) => h.factoryId === 'f');
    expect(await health()).toMatchObject({ ghLoggedIn: true, checkedAt: first, watcherSeenAt: first, githubProblems: ['missing option "Testing" (used by verify)'] });
    s.advance(WATCHER_HEALTH_MS - 1);
    await s.watcher.tick();
    expect((await health())!.watcherSeenAt).toBe(first);
    s.advance(1);
    await s.watcher.tick();
    expect((await health())!.watcherSeenAt).toBe(s.now().toISOString());
  });

  test('health: a Project read error becomes a problem with its first line', async () => {
    const s = setup({ board: (b) => failing(b, 'project', { n: 1 }) });
    await s.watcher.tick();
    const h = (await s.owner.listFactoryHealth()).find((x) => x.factoryId === 'f');
    expect(h!.githubProblems).toEqual(['boom']);
  });

  test('without the schema the tick does nothing and reports schemaMissing', async () => {
    const s = setup({ missing: true });
    await own(s);
    expect(await s.watcher.tick()).toEqual({ schemaMissing: true, pushed: [], synced: [], superseded: [] });
    expect(s.boardCalls()).toBe(0);
    expect(await s.owner.listFactoryHealth()).toEqual([]);
  });

  test('a factory without github is untouched', async () => {
    const s = setup();
    const t = await own(s, 'g', 'web');
    const q = await s.owner.requestSync('g', 'me');
    const u = await own(s);
    const tick = await s.watcher.tick();
    expect(tick.pushed.map((p) => p.taskId)).toEqual([u.taskId]);
    expect((await s.owner.listSyncRequests('g'))[0]).toMatchObject({ requestId: q.requestId, state: 'queued' });
    expect(await s.core.getGitHubLink(t.taskId)).toBeUndefined();
    expect((await s.owner.listFactoryHealth()).map((h) => h.factoryId)).toEqual(['f']);
  });

  test('a Board claim racing the supersede stops planning for this tick', async () => {
    let owner: BlocksStore | undefined;
    const s = setup({
      wrap: (core, o) => {
        owner = o;
        return intercept(core, 'saveSyncRequest', async (real, before, after) => {
          if (before.state === 'planned' && after.error === 'superseded by a newer Sync') {
            await owner!.saveSyncRequest(before, { ...before, state: 'applying', applyingSince: new Date().toISOString() });
          }
          return real(before, after);
        });
      },
    });
    await issueOnProject(s, 'Todo');
    const a = await s.owner.requestSync('f', 'me');
    await s.watcher.tick();
    s.advance(1000);
    const b = await s.owner.requestSync('f', 'me');
    const tick = await s.watcher.tick();
    expect(tick.synced).toEqual([]);
    expect(tick.superseded).toEqual([]);
    expect((await row(s, a.requestId)).state).toBe('applying');
    expect((await row(s, b.requestId)).state).toBe('queued');
  });

  test('a store error for one factory is reported and health is still written', async () => {
    const s = setup({
      wrap: (core) => intercept(core, 'listSyncRequests', async (real, factoryId) => {
        if (factoryId === 'f') throw new Error('blocks down\nmore');
        return real(factoryId);
      }),
    });
    const tick = await s.watcher.tick();
    expect(tick.synced).toEqual([{ factoryId: 'f', requestId: '', state: 'failed', actions: 0, notApplied: 0, error: 'blocks down' }]);
    expect((await s.owner.listFactoryHealth()).map((h) => h.factoryId)).toEqual(['f']);
  });
});

describe('optionProblems', () => {
  const info = (names: string[]) => ({ projectId: 'P', statusFieldId: 'F', options: names.map((name, i) => ({ id: `o${i}`, name })) });
  test('a missing Project is one problem', () => {
    expect(optionProblems(hub(), null, 'me')).toEqual(['Project o/3 not found or not visible to me']);
  });
  test('one problem per missing option, naming every status that uses it', () => {
    expect(optionProblems(hub(), info(OPTIONS), 'me')).toEqual([]);
    expect(optionProblems(hub(), info(['Backlog', 'Todo', 'In review']), 'me')).toEqual([
      'missing option "In progress" (used by spec, spec_review, plan, plan_review, build, verify, review, blocked)',
      'missing option "Merged" (used by done)',
    ]);
  });
});
