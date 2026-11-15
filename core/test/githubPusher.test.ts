import { describe, expect, test } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { GitHubPusher, LEASE_MS, backoffMs } from '../src/githubPusher.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { defFixture, repoFixture } from './factoryFixtures.js';

const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as const;
const OPTIONS = ['Backlog', 'Todo', 'In progress', 'In review', 'Merged'];
const hub = (mode: 'github-only' | 'connected' = 'github-only', statusMap: Record<string, string> = map) => ({
  mode, project: { owner: 'o', number: 3 }, label: 'factory', approvers: ['me'], statusMap: statusMap as never,
});
const NOW = new Date('2026-06-01T00:00:00Z');
const REPO = { owner: 'o', repo: 'app' };

function setup(github: ReturnType<typeof hub> | null = hub()) {
  const store = new MemoryStore({
    factories: { defs: [defFixture('f', { ...(github ? { github } : {}) })], repos: [repoFixture('f', 'app', { remote: 'git@github.com:o/app.git' })] },
  });
  const board = new FakeGitHubBoard();
  board.addProject({ owner: 'o', number: 3 }, OPTIONS);
  let t = NOW;
  const make = (claimant = 'x', b: GitHubBoard = board) => new GitHubPusher({ store, boardFor: () => b, now: () => t, claimant });
  return { store, board, make, pusher: make(), advance: (ms: number) => { t = new Date(t.getTime() + ms); } };
}
const add = (s: ReturnType<typeof setup>, title = 'Do it') => s.store.createTask({ factoryId: 'f', title, description: 'desc', repo: 'app' });
/** The board, but `method` throws on its first `times` calls. */
const throwing = (board: FakeGitHubBoard, method: keyof GitHubBoard, times: number, err: Error | string = 'boom'): GitHubBoard => {
  let n = times;
  return new Proxy(board, { get(t, p, r) {
    const v = Reflect.get(t, p, r);
    if (p !== method || typeof v !== 'function') return typeof v === 'function' ? v.bind(t) : v;
    return (...a: unknown[]) => { if (n-- > 0) throw typeof err === 'string' ? new Error(err) : err; return v.apply(t, a); };
  } });
};
const items = async (s: ReturnType<typeof setup>) => s.board.listItems((await s.board.project({ owner: 'o', number: 3 }))!);

describe('GitHubPusher', () => {
  test('pushes a new task: issue, label created, item with Status', async () => {
    const s = setup();
    const t = await add(s);
    const r = await s.pusher.pushTask(t.taskId);
    expect(r).toMatchObject({ issue: 'o/app#1', error: null, skipped: null });
    expect(r.done).toEqual(['created', 'status Backlog']);
    const issue = s.board.issue(REPO, 1);
    expect(issue.labels).toEqual(['factory']);
    expect(issue.body).toContain('<!-- tsf:task=');
    expect(await s.board.labelExists(REPO, 'factory')).toBe(true);
    expect((await items(s))[0]!.status).toBe('Backlog');
    const link = (await s.store.getGitHubLink(t.taskId))!;
    expect(link.pushed.option).toBe('Backlog');
    expect(link).toMatchObject({ repo: 'o/app', error: null, lease: null });
  });

  test('second push with no change writes nothing', async () => {
    const s = setup();
    const t = await add(s);
    await s.pusher.pushTask(t.taskId);
    const v = (await s.store.getGitHubLink(t.taskId))!.version;
    const r = await s.pusher.pushTask(t.taskId);
    expect(r.done).toEqual([]);
    expect((await s.store.getGitHubLink(t.taskId))!.version).toBe(v);
  });

  test('does not create a second issue after a later action fails', async () => {
    const s = setup();
    const t = await add(s);
    const flaky = s.make('x', throwing(s.board, 'addToProject', 1));
    const first = await flaky.pushTask(t.taskId);
    expect(first.error).toBe('boom');
    const link = (await s.store.getGitHubLink(t.taskId))!;
    expect(link.issueNumber).toBe(1);
    expect(link.error!.attempts).toBe(1);
    const second = await flaky.pushTask(t.taskId, { ignoreBackoff: true });
    expect(second.error).toBeNull();
    expect(second.issue).toBe('o/app#1');
    expect(await items(s)).toHaveLength(1);
    expect((await items(s))[0]!.status).toBe('Backlog');
  });

  test('an unknown Status option fails only that task', async () => {
    const s = setup(hub('github-only', { ...map, inbox: 'Nope' }));
    const a = await add(s, 'A');
    const b = await s.store.createTask({ factoryId: 'f', title: 'B', description: 'd', repo: 'app', status: 'ready' });
    const out = await s.pusher.pushAll();
    expect(out.map((r) => r.taskId)).toEqual([a.taskId, b.taskId]);
    expect(out[0]!.error).toContain('Nope');
    expect(out[1]!.error).toBeNull();
    const link = (await s.store.getGitHubLink(a.taskId))!;
    expect(link.error!.nextAttemptAt).toBe(new Date(NOW.getTime() + 5000).toISOString());
  });

  test('pushAll orders by numeric task id and honours factoryIds', async () => {
    const s = setup();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await add(s, `t${i}`)).taskId);
    const out = await s.pusher.pushAll(['f']);
    expect(out.map((r) => r.taskId)).toEqual(ids);
    expect(await s.pusher.pushAll(['other'])).toEqual([]);
  });

  test('backoff skips until nextAttemptAt', async () => {
    const s = setup();
    const t = await add(s);
    await s.make('x', throwing(s.board, 'createIssue', 1)).pushTask(t.taskId);
    const calls: string[] = [];
    const spy = new Proxy(s.board, { get: (o, p, r) => { calls.push(String(p)); const v = Reflect.get(o, p, r); return typeof v === 'function' ? v.bind(o) : v; } });
    const p = s.make('x', spy);
    expect(await p.pushTask(t.taskId)).toMatchObject({ skipped: 'backoff' });
    expect(calls).toEqual([]);
    s.advance(5001);
    expect((await p.pushTask(t.taskId)).error).toBeNull();
  });

  test('a held lease makes another pusher skip', async () => {
    const s = setup();
    const t = await add(s);
    await s.pusher.pushTask(t.taskId);
    const link = (await s.store.getGitHubLink(t.taskId))!;
    await s.store.updateTask(t.taskId, 1, { status: 'ready' });
    await s.store.saveGitHubLink(link, { ...link, lease: { by: 'x', until: new Date(NOW.getTime() + LEASE_MS).toISOString() } });
    const y = s.make('y');
    expect(await y.pushTask(t.taskId)).toMatchObject({ skipped: 'leased' });
    s.advance(LEASE_MS + 1);
    const r = await y.pushTask(t.taskId);
    expect(r).toMatchObject({ skipped: null, error: null });
    expect(r.done).toEqual(['status Todo']);
  });

  test('an unexpired lease held by the same claimant is still leased', async () => {
    const s = setup();
    const t = await add(s);
    await s.pusher.pushTask(t.taskId);
    const link = (await s.store.getGitHubLink(t.taskId))!;
    await s.store.updateTask(t.taskId, 1, { status: 'ready' });
    await s.store.saveGitHubLink(link, { ...link, lease: { by: 'x', until: new Date(NOW.getTime() + LEASE_MS).toISOString() } });
    const calls: string[] = [];
    const spy = new Proxy(s.board, { get: (o, p, r) => { calls.push(String(p)); const v = Reflect.get(o, p, r); return typeof v === 'function' ? v.bind(o) : v; } });
    expect(await s.make('x', spy).pushTask(t.taskId)).toMatchObject({ skipped: 'leased' });
    expect(calls).toEqual([]);
  });

  test('a failure does not wipe the lease of a pusher that took over mid-run', async () => {
    const s = setup();
    const t = await add(s);
    let saves = 0;
    const rival = { by: 'z', until: new Date(NOW.getTime() + LEASE_MS).toISOString() };
    const store = new Proxy(s.store, { get(o, p, r) {
      const v = Reflect.get(o, p, r);
      if (p !== 'saveGitHubLink') return typeof v === 'function' ? v.bind(o) : v;
      return async (before: never, after: never) => {
        if (++saves === 3) { const l = (await o.getGitHubLink(t.taskId))!; await o.saveGitHubLink(l, { ...l, lease: rival }); }
        return o.saveGitHubLink(before, after);
      };
    } });
    const p = new GitHubPusher({ store, boardFor: () => s.board, now: () => NOW, claimant: 'x' });
    const r = await p.pushTask(t.taskId);
    expect(r.error).not.toBeNull();
    expect((await s.store.getGitHubLink(t.taskId))!.lease).toEqual(rival);
  });

  test('factory without github: not-github, no link written', async () => {
    for (const github of [null, hub('connected')]) {
      const s = setup(github);
      const t = await add(s);
      expect(await s.pusher.pushTask(t.taskId)).toMatchObject({ skipped: 'not-github' });
      expect(await s.store.listGitHubLinks()).toEqual([]);
      expect(await s.pusher.pushAll()).toEqual([]);
    }
  });

  test('cancelled task: Status Backlog and issue closed not_planned', async () => {
    const s = setup();
    const t = await add(s);
    await s.pusher.pushTask(t.taskId);
    await s.store.updateTask(t.taskId, 1, { status: 'cancelled' });
    const r = await s.pusher.pushTask(t.taskId);
    expect(r.done).toEqual(['closed']);
    expect(s.board.issue(REPO, 1)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    expect((await s.store.getGitHubLink(t.taskId))!.pushed).toMatchObject({ closed: true, status: 'cancelled', option: 'Backlog' });
  });

  test('spec comment carries the reply line when the spec gate is on', async () => {
    const s = setup();
    await s.store.setSettings({ factories: { f: { factory: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, spec: true } }, repos: {} } } });
    const t = await add(s);
    await s.pusher.pushTask(t.taskId);
    await s.store.addDoc(t.taskId, 'spec', 'the spec', 'agent');
    await s.store.updateTask(t.taskId, 1, { status: 'spec_review' });
    const r = await s.pusher.pushTask(t.taskId);
    expect(r.done).toEqual(['status In progress', 'spec v1 comment']);
    const c = (await s.board.listComments(REPO, 1)).at(-1)!;
    expect(c.body.startsWith('## Spec v1')).toBe(true);
    expect(c.body).toContain('/approve');
  });

  test('a lifted block is cleared so the same block comments again', async () => {
    const s = setup();
    const t = await add(s);
    await s.pusher.pushTask(t.taskId);
    let v = 1;
    const patch = async (p: object) => { v = (await s.store.updateTask(t.taskId, v, p)).version; };
    await patch({ status: 'blocked', blockedReason: 'why' });
    expect((await s.pusher.pushTask(t.taskId)).done).toContain('blocked comment');
    await patch({ status: 'inbox', blockedReason: null });
    await s.pusher.pushTask(t.taskId);
    expect((await s.store.getGitHubLink(t.taskId))!.pushed.blocked).toBeNull();
    await patch({ status: 'blocked', blockedReason: 'why' });
    expect((await s.pusher.pushTask(t.taskId)).done).toContain('blocked comment');
  });

  test('error text is redacted', async () => {
    const s = setup();
    const t = await add(s);
    const r = await s.make('x', throwing(s.board, 'createIssue', 1, new Error('bad ghp_' + 'a'.repeat(36)))).pushTask(t.taskId);
    expect(r.error).toContain('[redacted]');
    expect((await s.store.getGitHubLink(t.taskId))!.error!.message).toContain('[redacted]');
    expect(backoffMs(1)).toBe(5000);
    expect(backoffMs(30)).toBe(600_000);
  });

  test('M1: every progress save renews the lease', async () => {
    const s = setup();
    const t = await add(s);
    let seen: string | undefined;
    const spy = new Proxy(s.board, { get(tg, p, r) {
      const v = Reflect.get(tg, p, r);
      if (typeof v !== 'function') return v;
      return async (...a: unknown[]) => {
        if (p === 'addToProject') s.advance(30_000);
        if (p === 'setStatus') seen = (await s.store.getGitHubLink(t.taskId))!.lease!.until;
        return v.apply(tg, a);
      };
    } }) as GitHubBoard;
    await s.make('x', spy).pushTask(t.taskId);
    expect(Date.parse(seen!)).toBe(NOW.getTime() + 30_000 + LEASE_MS);
  });

  test('M2: a missing repo is recorded with backoff, then skipped', async () => {
    const s = setup();
    const t = await s.store.createTask({ factoryId: 'f', title: 'x', description: 'd', repo: 'gone' });
    const first = await s.pusher.pushTask(t.taskId);
    expect(first.error).toContain('gone');
    expect((await s.store.getGitHubLink(t.taskId))!.error!.attempts).toBe(1);
    expect(await s.pusher.pushTask(t.taskId)).toMatchObject({ skipped: 'backoff' });
  });

  test('F4: pushAll can ignore backoff', async () => {
    const s = setup();
    const t = await add(s);
    const flaky = s.make('x', throwing(s.board, 'addToProject', 1));
    await flaky.pushTask(t.taskId);
    expect((await s.pusher.pushAll())[0]).toMatchObject({ skipped: 'backoff' });
    const r = (await s.pusher.pushAll(undefined, { ignoreBackoff: true }))[0]!;
    expect(r.error).toBeNull();
    expect((await s.store.getGitHubLink(t.taskId))!.error).toBeNull();
  });

  test('F5: two factories on one GitHub repo push nothing and report an error each', async () => {
    const store = new MemoryStore({ factories: {
      defs: [defFixture('a', { github: hub() }), defFixture('b', { github: hub() })],
      repos: [repoFixture('a', 'app', { remote: 'git@github.com:o/app.git' }), repoFixture('b', 'app', { remote: 'git@github.com:o/app.git' })],
    } });
    const board = new FakeGitHubBoard();
    board.addProject({ owner: 'o', number: 3 }, OPTIONS);
    const pusher = new GitHubPusher({ store, boardFor: () => board, now: () => NOW, claimant: 'x' });
    await store.createTask({ factoryId: 'a', title: 'x', description: 'd', repo: 'app' });
    await store.createTask({ factoryId: 'b', title: 'y', description: 'd', repo: 'app' });
    const rs = await pusher.pushAll();
    expect(rs).toHaveLength(2);
    for (const r of rs) expect(r.error).toContain('only one factory repo');
    expect(() => board.issue(REPO, 1)).toThrow();
    expect((await store.listGitHubLinks()).every((l) => l.error !== null && l.issueNumber === null)).toBe(true);
  });
});
