import { describe, expect, test } from 'vitest';
import { MemoryStore } from '../src/store.js';
import { FakeGitHubBoard, type GitHubBoard } from '../src/githubBoard.js';
import { FakeGitHub } from '../src/github.js';
import { GitHubPuller, type PullLock } from '../src/githubPuller.js';
import { GitHubPusher } from '../src/githubPusher.js';
import { defFixture, repoFixture } from './factoryFixtures.js';

const map = { inbox: 'Backlog', ready: 'Todo', spec: 'In progress', spec_review: 'In progress', plan: 'In progress',
  plan_review: 'In progress', build: 'In progress', verify: 'In progress', review: 'In progress',
  pr_open: 'In review', done: 'Merged', blocked: 'In progress', cancelled: 'Backlog' } as const;
const OPTIONS = ['Backlog', 'Todo', 'In progress', 'In review', 'Merged'];
const hub = (number = 3) => ({ mode: 'github-only' as const, project: { owner: 'o', number }, label: 'factory', approvers: ['kazi-lakit'], statusMap: map as never });
const NOW = new Date('2026-06-01T00:00:00Z');
const REPO = { owner: 'o', repo: 'app' };
const PROJECT = { owner: 'o', number: 3 };

function setup(opts: { github?: boolean; lock?: PullLock; board?: (b: FakeGitHubBoard) => GitHubBoard } = {}) {
  const store = new MemoryStore({
    factories: {
      defs: [defFixture('f', opts.github === false ? {} : { github: hub() })],
      repos: [repoFixture('f', 'app', { remote: 'git@github.com:o/app.git' })],
    },
  });
  const board = new FakeGitHubBoard();
  board.addProject(PROJECT, OPTIONS);
  const gh = new FakeGitHub();
  const seen = opts.board ? opts.board(board) : board;
  const pusher = new GitHubPusher({ store, boardFor: () => board, now: () => NOW, claimant: 'x' });
  const puller = new GitHubPuller({ store, boardFor: () => seen, githubFor: () => gh, now: () => NOW, ...(opts.lock ? { lock: opts.lock } : {}) });
  return { store, board, gh, pusher, puller };
}
type S = ReturnType<typeof setup>;
const add = (s: S) => s.store.createTask({ factoryId: 'f', title: 'Do it', description: 'desc', repo: 'app' });
const project = async (s: S) => (await s.board.project(PROJECT))!;

describe('GitHubPuller', () => {
  test('a labelled Todo issue becomes a ready task with a link and no marker yet', async () => {
    const s = setup();
    const made = await s.board.createIssue(REPO, { title: 'From GitHub', body: 'please', labels: ['factory'] });
    const item = await s.board.addToProject(await project(s), made.nodeId);
    await s.board.setStatus(await project(s), item, 'Todo');
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(r!.created).toHaveLength(1);
    const task = await s.store.getTask(r!.created[0]!.taskId);
    expect(task).toMatchObject({ status: 'ready', title: 'From GitHub' });
    const link = (await s.store.getGitHubLink(task.taskId))!;
    expect(link).toMatchObject({ repo: 'o/app', issueNumber: 1, project: 'o/3', itemId: item });
    expect(link.pushed).toMatchObject({ status: 'ready', option: 'Todo', title: 'From GitHub', bodyHash: null, label: 'factory' });
    await s.pusher.pushTask(task.taskId);
    expect(s.board.issue(REPO, 1).body).toContain(`tsf:task=${task.taskId}`);
  });

  test('/approve after the pushed spec comment records the approval and reacts', async () => {
    const s = setup();
    const t = await add(s);
    await s.store.addDoc(t.taskId, 'spec', 'the spec', 'agent');
    await s.store.updateTask(t.taskId, 1, { status: 'spec_review' });
    await s.pusher.pushTask(t.taskId);
    const c = await s.board.addComment(REPO, 1, '/approve', 'kazi-lakit');
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    const approvals = await s.store.listApprovals(t.taskId);
    expect(approvals).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
    expect(s.board.reactions).toEqual([{ commentId: c.id, content: '+1' }]);
  });

  test('a Status move not applied is put back by the next push', async () => {
    const s = setup();
    const t = await add(s);
    await s.store.updateTask(t.taskId, 1, { status: 'ready' });
    await s.pusher.pushTask(t.taskId);
    const item = (await s.board.listItems(await project(s)))[0]!;
    await s.board.setStatus(await project(s), item.itemId, 'In review');
    const [r] = await s.puller.pull();
    expect(r!.notApplied).toHaveLength(1);
    expect((await s.store.getGitHubLink(t.taskId))!.pushed.option).toBe('In review');
    await s.pusher.pushTask(t.taskId);
    expect((await s.board.listItems(await project(s)))[0]!.status).toBe('Todo');
  });

  test('PR approve review on pr_open records the pr approval', async () => {
    const s = setup();
    const t = await add(s);
    const pr = await s.gh.openPr({ remote: 'git@github.com:o/app.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await s.store.addDoc(t.taskId, 'review', 'the review', 'agent');
    await s.store.updateTask(t.taskId, 1, { status: 'pr_open', prUrl: pr.url });
    await s.pusher.pushTask(t.taskId);
    s.gh.addReview(pr.url, { author: 'kazi-lakit', state: 'approved' });
    const [r] = await s.puller.pull();
    expect(r!.errors).toEqual([]);
    expect(await s.store.listApprovals(t.taskId)).toMatchObject([{ gate: 'pr', docVersion: 1, decision: 'approve' }]);
    expect(s.board.reactions).toEqual([]);
  });

  test('a closed issue with a merged PR does not cancel', async () => {
    const s = setup();
    const t = await add(s);
    const pr = await s.gh.openPr({ remote: 'git@github.com:o/app.git', head: 'h', base: 'dev', title: 't', body: 'b' });
    await s.store.updateTask(t.taskId, 1, { status: 'pr_open', prUrl: pr.url });
    await s.pusher.pushTask(t.taskId);
    await s.board.closeIssue(REPO, 1, 'completed');
    s.gh.setState(pr.url, 'merged');
    const [r] = await s.puller.pull();
    expect(r!.applied).toEqual([]);
    expect((await s.store.getTask(t.taskId)).status).toBe('pr_open');
  });

  test('a missing project is one factory error, other factories still pull', async () => {
    const store = new MemoryStore({
      factories: {
        defs: [defFixture('f', { github: hub(3) }), defFixture('g', { github: hub(9) })],
        repos: [repoFixture('f', 'app', { remote: 'git@github.com:o/app.git' }), repoFixture('g', 'other', { remote: 'git@github.com:o/other.git' })],
      },
    });
    const board = new FakeGitHubBoard();
    board.addProject(PROJECT, OPTIONS);
    const p = await board.project(PROJECT);
    const made = await board.createIssue(REPO, { title: 'New', body: '', labels: ['factory'] });
    await board.addToProject(p!, made.nodeId);
    const puller = new GitHubPuller({ store, boardFor: () => board, githubFor: () => new FakeGitHub(), now: () => NOW });
    const out = await puller.pull();
    expect(out.map((r) => r.factoryId)).toEqual(['f', 'g']);
    expect(out[0]!.created).toHaveLength(1);
    expect(out[1]!.errors).toHaveLength(1);
    expect(out[1]!.errors[0]).toMatchObject({ taskId: null, message: expect.stringContaining('not found') });
  });

  test('a held pull lock skips the factory', async () => {
    let calls = 0;
    const s = setup({ lock: async () => null, board: (b) => new Proxy(b, { get(t, p, r) { calls++; const v = Reflect.get(t, p, r); return typeof v === 'function' ? v.bind(t) : v; } }) });
    const out = await s.puller.pull();
    expect(out).toMatchObject([{ factoryId: 'f', skipped: 'busy', created: [], errors: [] }]);
    expect(calls).toBe(0);
  });

  test('releases the lock even when the pull fails', async () => {
    let released = 0;
    const s = setup({ lock: async () => () => { released++; }, board: (b) => Object.assign(Object.create(b), { project: async () => { throw new Error('down'); } }) });
    const [r] = await s.puller.pull();
    expect(r!.errors).toMatchObject([{ taskId: null, message: 'down' }]);
    expect(released).toBe(1);
  });

  test('factory without github is not pulled', async () => {
    const s = setup({ github: false });
    expect(await s.puller.pull()).toEqual([]);
  });
});
