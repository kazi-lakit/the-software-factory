import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { ClaimError, Engine, StageError, withRetry, type EngineDeps } from '../src/engine.js';
import type { Exec } from '../src/checks.js';
import type { GitRepos } from '../src/git.js';
import { FakeGitHub } from '../src/github.js';
import { IllegalInputError } from '../src/machine.js';
import type { RepoConfig } from '../src/repoConfig.js';
import { MemoryStore, VersionConflictError } from '../src/store.js';
import type { RepoId, Task } from '../src/types.js';

const ROOT = join(tmpdir(), 'factory-engine-test');
const REMOTE = 'git@github.com:SELISEdigitalplatforms/blocks-data.git';

const cfg: RepoConfig = {
  repo: 'data',
  remote: REMOTE,
  baseBranch: 'dev',
  checks: {
    server: { cwd: 'server', build: 'dotnet build', test: 'dotnet test' },
    client: { cwd: 'client', install: 'npm ci', typecheck: 'npm run tc', lint: 'npm run lint', test: 'npm test' },
    e2e: 'off',
  },
};

const iamCfg: RepoConfig = { ...cfg, repo: 'iam', remote: 'git@github.com:SELISEdigitalplatforms/blocks-iam.git' };

class FakeGit implements GitRepos {
  readonly calls: string[] = [];
  readonly bases: string[] = [];
  readonly pushes: { path: string; branch: string }[] = [];
  async ensureClone(c: RepoConfig) {
    this.calls.push(`clone ${c.repo}`);
    return join(ROOT, '.clones', c.repo);
  }
  async worktree(c: RepoConfig, taskId: string, branch: string) {
    this.calls.push(`worktree ${taskId} ${branch}`);
    this.bases.push(c.baseBranch);
    return join(ROOT, '.clones', 'worktrees', taskId);
  }
  async push(path: string, branch: string) {
    this.pushes.push({ path, branch });
  }
  async isClean() {
    return true;
  }
}

function setup(opts: { failing?: string[]; git?: FakeGit } = {}) {
  const store = new MemoryStore();
  const git = opts.git ?? new FakeGit();
  const github = new FakeGitHub();
  const clock = { t: new Date('2026-11-09T10:00:00Z') };
  const exec: Exec = async (cmd) => ({ code: opts.failing?.includes(cmd) ? 1 : 0, output: 'out' });
  const deps: EngineDeps = {
    store,
    git,
    github,
    repos: { data: cfg, iam: iamCfg } as Record<RepoId, RepoConfig>,
    exec,
    now: () => clock.t,
    mode: 'session',
    claimant: 'me',
  };
  return { store, git, github, clock, engine: new Engine(deps) };
}

/** Creates a task and puts it straight into the given state. */
async function put(store: MemoryStore, patch: Partial<Task>, base = 'dev', repo: RepoId = 'data'): Promise<Task> {
  const t = await store.createTask({ title: 'Add widget', description: 'd', repo, baseBranch: base });
  return Object.keys(patch).length ? store.updateTask(t.taskId, t.version, patch) : t;
}

const claimedBy = (who: string, clock: { t: Date }) => ({
  claimBy: who,
  claimUntil: new Date(clock.t.getTime() + 60_000).toISOString(),
});

const result = (r: object) => JSON.stringify(r);

afterEach(() => {
  vi.useRealTimers();
});

describe('next', () => {
  test('paused: returns null and claims nothing', async () => {
    const { store, engine } = setup();
    await store.setSettings({ global: { ...DEFAULT_SETTINGS, paused: true }, repos: {} });
    await put(store, { status: 'ready' });
    expect(await engine.next()).toBeNull();
    expect((await store.getTask('T-1')).claimBy).toBeNull();
  });

  test('skips tasks in a paused repo but still claims in other repos', async () => {
    const { store, engine } = setup();
    await store.setSettings({ global: DEFAULT_SETTINGS, repos: { data: { paused: true } } });
    await put(store, { status: 'ready' });
    await put(store, { status: 'ready' }, 'dev', 'iam');
    expect(await engine.next()).toMatchObject({ taskId: 'T-2', step: 'spec' });
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null });
    expect(await engine.next('T-1')).toBeNull();
  });

  test('the worktree branches from the task base, not the repo default', async () => {
    const { store, engine, git } = setup();
    await put(store, { status: 'ready' }, 'feature/x');
    await engine.next();
    expect(git.bases).toEqual(['feature/x']);
  });

  test('returns null when maxParallel tasks are already claimed', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'spec', stage: 'spec', branch: 'factory/T-1-a', ...claimedBy('other', clock) });
    await put(store, { status: 'plan', stage: 'plan', branch: 'factory/T-2-a', ...claimedBy('other', clock) });
    await put(store, { status: 'ready' });
    expect(await engine.next()).toBeNull();
    expect((await store.getTask('T-3')).status).toBe('ready');
  });

  test('a ready task is claimed, gets a branch and worktree, and moves to spec', async () => {
    const { store, engine, git } = setup();
    await put(store, { status: 'ready' });
    const ticket = await engine.next();
    expect(ticket).toMatchObject({
      taskId: 'T-1',
      step: 'spec',
      worktree: join(ROOT, '.clones', 'worktrees', 'T-1'),
      runId: 'R-1',
    });
    expect(git.calls).toEqual(['clone data', 'worktree T-1 factory/T-1-add-widget']);
    const t = await store.getTask('T-1');
    expect(t).toMatchObject({ status: 'spec', stage: 'spec', branch: 'factory/T-1-add-widget', claimBy: 'me' });
    expect(ticket!.context.task).toEqual(t);
    const events = await store.listEvents('T-1');
    expect(events).toContainEqual(
      expect.objectContaining({ field: 'status', from: 'ready', to: 'spec', actor: 'core · session' }),
    );
    expect(await store.openRun('T-1', 'spec')).toMatchObject({ agent: 'spec-writer', mode: 'session' });
  });

  test('picks the lowest T-<n> that is ready or at a working stage, skipping claimed and waiting tasks', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'spec_review', stage: null, branch: 'b1' });
    await put(store, { status: 'build', stage: 'build', branch: 'b2', ...claimedBy('other', clock) });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b3' });
    await put(store, { status: 'plan', stage: 'plan', branch: 'b4' });
    await put(store, { status: 'ready' });
    const ticket = await engine.next();
    expect(ticket).toMatchObject({ taskId: 'T-4', step: 'plan' });
  });

  test('picks an explicit task', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await put(store, { status: 'build', stage: 'build', branch: 'factory/T-2-x' });
    expect(await engine.next('T-2')).toMatchObject({ taskId: 'T-2', step: 'build' });
  });

  test('context carries the current spec and plan, the answer as feedback and the latest verify doc', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'factory/T-1-x', answer: 'fix the test' });
    await store.addDoc('T-1', 'spec', 'spec v1', 'a');
    await store.addDoc('T-1', 'spec', 'spec v2', 'a');
    await store.addDoc('T-1', 'plan', 'the plan', 'a');
    await store.addDoc('T-1', 'verify', 'checks report', 'core · checks');
    const ticket = await engine.next();
    expect(ticket!.context).toEqual({
      task: await store.getTask('T-1'),
      spec: 'spec v2',
      plan: 'the plan',
      feedback: 'fix the test',
      checks: 'checks report',
    });
  });

  test('context omits keys that have no value', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    const ticket = await engine.next();
    expect(Object.keys(ticket!.context)).toEqual(['task']);
  });

  test('core steps get a ticket without a run', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    const ticket = await engine.next();
    expect(ticket).toMatchObject({ step: 'check', runId: null });
    expect(await store.openRun('T-1', 'check')).toBeUndefined();
  });

  test('releases the claim and rethrows when work after the claim fails', async () => {
    class BrokenGit extends FakeGit {
      override async worktree(): Promise<string> {
        throw new Error('worktree add failed');
      }
    }
    const { store, engine } = setup({ git: new BrokenGit() });
    await put(store, { status: 'ready' });
    await expect(engine.next()).rejects.toThrow('worktree add failed');
    expect(await store.getTask('T-1')).toMatchObject({ status: 'ready', claimBy: null, claimUntil: null });
  });

  test('reuses the open run for the step instead of starting a new one', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'ready' });
    expect((await engine.next())!.runId).toBe('R-1');
    clock.t = new Date(clock.t.getTime() + 3_600_000); // claim lapses, the run is still open
    const startRun = vi.spyOn(store, 'startRun');
    expect(await engine.next()).toMatchObject({ taskId: 'T-1', step: 'spec', runId: 'R-1' });
    expect(startRun).not.toHaveBeenCalled();
  });

  test('returns null when nothing is workable', async () => {
    const { store, engine } = setup();
    await put(store, {});
    expect(await engine.next()).toBeNull();
  });
});

describe('feedback', () => {
  test('a spec-change comment does not leak into the planner or implementer feedback', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await engine.next();
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'v1' }));
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'changes', comment: 'drop the cache idea' });
    const respec = await engine.next();
    expect(respec).toMatchObject({ step: 'spec', context: { feedback: 'drop the cache idea' } });
    await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'v2' }));
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 2, decision: 'approve', comment: '' });
    const plan = await engine.next();
    expect(plan!.step).toBe('plan');
    expect(plan!.context.feedback).toBeUndefined();
    await engine.complete('T-1', 'plan', result({ status: 'done', summary: 's', doc: 'p' }));
    const build = await engine.next();
    expect(build!.step).toBe('build');
    expect(build!.context.feedback).toBeUndefined();
  });

  test('the answer to a verifier question reaches the resumed verifier', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'verify', stage: 'verify', branch: 'factory/T-1-x' });
    await engine.next();
    await engine.complete('T-1', 'verify', result({ status: 'blocked', summary: 's', question: 'AC3: which API?' }));
    const b = await store.getTask('T-1');
    await store.updateTask('T-1', b.version, { answer: 'use v2' });
    const resumed = await engine.next();
    expect(resumed).toMatchObject({ step: 'verify', context: { feedback: 'use v2' } });
    expect(resumed!.context.task).toMatchObject({ question: null, blockedReason: null, attempt: 0 });
  });
});

describe('complete', () => {
  test('rejects another claimant and a step that is not the stage', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'spec', stage: 'spec', branch: 'b', ...claimedBy('other', clock) });
    await expect(engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'x' }))).rejects.toBeInstanceOf(
      ClaimError,
    );
    await put(store, { status: 'spec', stage: 'spec', branch: 'b', ...claimedBy('me', clock) });
    await expect(engine.complete('T-2', 'plan', result({ status: 'done', summary: 's', doc: 'x' }))).rejects.toBeInstanceOf(
      StageError,
    );
  });

  test('done with a doc writes the doc, finishes the run and moves on', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await engine.next();
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: '# Spec', costUsd: 1.5, turns: 4 }));
    expect(t).toMatchObject({ status: 'spec_review', stage: null, costUsd: 1.5, claimBy: null, claimUntil: null });
    expect(await store.currentDoc('T-1', 'spec')).toMatchObject({
      version: 1,
      body: '# Spec',
      author: 'spec-writer · session · run R-1',
    });
    expect(await store.openRun('T-1', 'spec')).toBeUndefined();
    const events = await store.listEvents('T-1');
    expect(events).toContainEqual(
      expect.objectContaining({ field: 'status', from: 'spec', to: 'spec_review', actor: 'spec-writer · session · run R-1' }),
    );
  });

  test('accepts a lapsed claim nobody re-claimed', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'ready' });
    await engine.next();
    clock.t = new Date(clock.t.getTime() + 3_600_000);
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'x' }));
    expect(t.status).toBe('spec_review');
  });

  test('a missing result blocks the task as failed', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await engine.next();
    const t = await engine.complete('T-1', 'spec', undefined);
    expect(t.status).toBe('blocked');
    expect(t.blockedReason).toMatch(/^invalid agent result/);
  });

  test('a cost of 5.01 at the default limit blocks the task', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'ready' });
    await engine.next();
    const t = await engine.complete('T-1', 'spec', result({ status: 'done', summary: 's', doc: 'x', costUsd: 5.01 }));
    expect(t).toMatchObject({ status: 'blocked', stage: 'spec', costUsd: 5.01 });
    expect(t.blockedReason).toMatch(/cost/);
  });
});

describe('check', () => {
  test('passing checks write a verify doc and move to the verify agent', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    await engine.next();
    const t = await engine.check('T-1');
    expect(t).toMatchObject({ status: 'verify', stage: 'verify' });
    const doc = await store.currentDoc('T-1', 'verify');
    expect(doc).toMatchObject({ author: 'core · checks' });
    expect(doc!.body).toContain('## Checks: passed');
  });

  test('failing checks return to build with the failing and skipped step names', async () => {
    const { store, engine } = setup({ failing: ['dotnet build'] });
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    await engine.next();
    const t = await engine.check('T-1');
    expect(t).toMatchObject({ status: 'build', stage: 'build', attempt: 1, answer: 'server.build, server.test' });
  });

  test('requires the claim and stage check', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'verify', stage: 'check', branch: 'b' });
    await expect(engine.check('T-1')).rejects.toBeInstanceOf(ClaimError);
    await put(store, { status: 'verify', stage: 'verify', branch: 'b', ...claimedBy('me', clock) });
    await expect(engine.check('T-2')).rejects.toBeInstanceOf(StageError);
  });
});

describe('ship', () => {
  async function atShip(base: string, prGate: boolean) {
    const s = setup();
    await s.store.setSettings({ global: { ...DEFAULT_SETTINGS, gates: { ...DEFAULT_SETTINGS.gates, pr: prGate } }, repos: {} });
    await put(s.store, { status: 'review', stage: 'ship', branch: 'factory/T-1-add-widget' }, base);
    await s.store.addDoc('T-1', 'spec', 'S'.repeat(5000), 'a');
    await s.engine.next();
    return s;
  }

  test('base dev with the PR gate off stops at pr_open without a merge', async () => {
    const { engine, github, git } = await atShip('dev', false);
    const t = await engine.ship('T-1');
    expect(t).toMatchObject({ status: 'pr_open', stage: null, prUrl: 'https://github.com/SELISEdigitalplatforms/blocks-data/pull/1' });
    expect(git.pushes).toEqual([{ path: join(ROOT, '.clones', 'worktrees', 'T-1'), branch: 'factory/T-1-add-widget' }]);
    expect([...github.prs.values()]).toEqual([{ base: 'dev', head: 'factory/T-1-add-widget', state: 'open' }]);
  });

  test('base feature/x with the PR gate off merges and is done', async () => {
    const { engine, github } = await atShip('feature/x', false);
    const t = await engine.ship('T-1');
    expect(t.status).toBe('done');
    expect([...github.prs.values()][0]!.state).toBe('merged');
  });

  test('base feature/x with the PR gate on waits at pr_open', async () => {
    const { engine, github } = await atShip('feature/x', true);
    expect((await engine.ship('T-1')).status).toBe('pr_open');
    expect([...github.prs.values()][0]!.state).toBe('open');
  });

  test('PR title and body', async () => {
    const { engine, github } = await atShip('dev', true);
    const openPr = vi.spyOn(github, 'openPr');
    await engine.ship('T-1');
    expect(openPr).toHaveBeenCalledWith({
      remote: REMOTE,
      head: 'factory/T-1-add-widget',
      base: 'dev',
      title: '[T-1] Add widget',
      body: `Factory task T-1\n\n${'S'.repeat(3000)}`,
    });
  });

  test('ships from the task base', async () => {
    const { engine, git } = await atShip('feature/x', true);
    await engine.ship('T-1');
    expect(git.bases.at(-1)).toBe('feature/x');
  });

  test('shipping again after PR changes reuses the open PR', async () => {
    const { store, engine, github, git } = await atShip('dev', true);
    const first = await engine.ship('T-1');
    await store.addDoc('T-1', 'review', 'approve', 'reviewer');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'changes', comment: 'rename it' });
    await engine.sync();
    const back = await store.getTask('T-1');
    expect(back.status).toBe('build');
    // build → verify → review happen; the reviewer approves a new review doc.
    await store.updateTask('T-1', back.version, { status: 'review', stage: 'ship' });
    await store.addDoc('T-1', 'review', 'approve again', 'reviewer');
    await engine.next();
    const again = await engine.ship('T-1');
    expect(again).toMatchObject({ status: 'pr_open', prUrl: first.prUrl });
    expect(github.prs.size).toBe(1);
    expect(git.pushes).toHaveLength(2);
  });

  test('shipping a task whose PR was already merged completes it without a push', async () => {
    const { store, engine, github, git } = await atShip('dev', true);
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-add-widget', base: 'dev', title: 't', body: 'b' });
    github.setState(pr.url, 'merged');
    const t = await store.getTask('T-1');
    await store.updateTask('T-1', t.version, { prUrl: pr.url });
    const done = await engine.ship('T-1');
    expect(done).toMatchObject({ status: 'done', prUrl: pr.url });
    expect(git.pushes).toHaveLength(0);
  });

  test('shipping a task whose PR was closed opens a new PR', async () => {
    const { store, engine, github } = await atShip('dev', true);
    const pr = await github.openPr({ remote: REMOTE, head: 'factory/T-1-add-widget', base: 'dev', title: 't', body: 'b' });
    github.setState(pr.url, 'closed');
    const t = await store.getTask('T-1');
    await store.updateTask('T-1', t.version, { prUrl: pr.url });
    const shipped = await engine.ship('T-1');
    expect(shipped.status).toBe('pr_open');
    expect(shipped.prUrl).not.toBe(pr.url);
    expect(github.prs.size).toBe(2);
  });

  test('requires the claim and stage ship', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'review', stage: 'ship', branch: 'b' });
    await expect(engine.ship('T-1')).rejects.toBeInstanceOf(ClaimError);
    await put(store, { status: 'review', stage: 'review', branch: 'b', ...claimedBy('me', clock) });
    await expect(engine.ship('T-2')).rejects.toBeInstanceOf(StageError);
  });
});

describe('sync', () => {
  test('a spec approval at v1 after spec v2 exists does not open the gate', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'spec_review', branch: 'b' });
    await store.addDoc('T-1', 'spec', 'v1', 'a');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    await store.addDoc('T-1', 'spec', 'v2', 'a');
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('spec_review');
  });

  test('an approval of the current spec moves to plan; changes go back to spec with the comment', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'spec_review', branch: 'b' });
    await store.addDoc('T-1', 'spec', 'v1', 'a');
    await store.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    await put(store, { status: 'plan_review', branch: 'b' });
    await store.addDoc('T-2', 'plan', 'v1', 'a');
    await store.addApproval({ taskId: 'T-2', gate: 'plan', docVersion: 1, decision: 'changes', comment: 'smaller' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'plan', stage: 'plan' });
    expect(await store.getTask('T-2')).toMatchObject({ status: 'plan', stage: 'plan', answer: 'smaller' });
  });

  async function prOpen(base = 'dev') {
    const s = setup();
    const pr = await s.github.openPr({ remote: REMOTE, head: 'factory/T-1-x', base, title: 't', body: 'b' });
    await put(s.store, { status: 'pr_open', branch: 'factory/T-1-x', prUrl: pr.url }, base);
    await s.store.addDoc('T-1', 'review', 'approve', 'reviewer');
    return { ...s, url: pr.url };
  }

  test('a PR closed on GitHub blocks the task', async () => {
    const { store, engine, github, url } = await prOpen();
    github.setState(url, 'closed');
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', blockedReason: 'PR closed without merge' });
  });

  test('a PR merged on GitHub completes the task', async () => {
    const { store, engine, github, url } = await prOpen();
    github.setState(url, 'merged');
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('done');
  });

  test('PR changes requested on the Board return to build', async () => {
    const { store, engine } = await prOpen();
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'changes', comment: 'rename it' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', answer: 'rename it', attempt: 1 });
  });

  test('PR approve on an unprotected base merges', async () => {
    const { store, engine, github, url } = await prOpen('feature/x');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'approve', comment: '' });
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('done');
    expect(github.prs.get(url)!.state).toBe('merged');
  });

  test('PR approve on a protected base is ignored', async () => {
    const { store, engine, github, url } = await prOpen('dev');
    await store.addApproval({ taskId: 'T-1', gate: 'pr', docVersion: 1, decision: 'approve', comment: '' });
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('pr_open');
    expect(github.prs.get(url)!.state).toBe('open');
  });

  test('a blocked task with an answer resumes at its stage', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', question: 'q?', answer: 'do x' });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', question: 'q?', answer: '' });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', question: 'q?', answer: '  \n\t ' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', question: null, answer: 'do x' });
    expect((await store.getTask('T-2')).status).toBe('blocked');
    expect((await store.getTask('T-3')).status).toBe('blocked');
  });

  test('a working task over the cost limit is blocked; waiting-without-stage and blocked tasks are left alone', async () => {
    const { store, engine } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', costUsd: 6 });
    await put(store, { status: 'spec_review', stage: null, branch: 'b', costUsd: 6 });
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', costUsd: 6 });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', stage: 'build' });
    expect((await store.getTask('T-2')).status).toBe('spec_review');
    expect((await store.getTask('T-3')).blockedReason).toBeNull();
  });

  test('a third failed check blocks the task and a stale answer does not resume it', async () => {
    const { store, engine } = setup({ failing: ['dotnet build'] });
    await put(store, { status: 'verify', stage: 'check', branch: 'factory/T-1-x' });
    for (let i = 0; i < 3; i++) {
      const t = await store.getTask('T-1');
      if (t.status === 'build') await store.updateTask('T-1', t.version, { status: 'verify', stage: 'check' });
      await engine.next();
      await engine.check('T-1');
    }
    expect(await store.getTask('T-1')).toMatchObject({ status: 'blocked', stage: 'build', attempt: 3, answer: null });
    await engine.sync();
    const blocked = await store.getTask('T-1');
    expect(blocked.status).toBe('blocked');
    await store.updateTask('T-1', blocked.version, { answer: 'try a clean build' });
    await engine.sync();
    expect(await store.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', attempt: 0, answer: 'try a clean build' });
  });

  test('an illegal input or move is a bug and surfaces from sync', async () => {
    vi.useFakeTimers();
    const { engine, github } = await prOpen();
    const task = { status: 'pr_open', stage: null } as const;
    vi.spyOn(github, 'prState').mockRejectedValue(new IllegalInputError(task, 'bug'));
    const p = engine.sync();
    const settled = expect(p).rejects.toBeInstanceOf(IllegalInputError);
    await vi.runAllTimersAsync();
    await settled;
  });

  test('a GitHub outage: 3 failed tries skip the task without moving it', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await prOpen();
    const prState = vi.spyOn(github, 'prState').mockRejectedValue(new Error('GitHub down'));
    const p = engine.sync();
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBeUndefined();
    expect(prState).toHaveBeenCalledTimes(3);
    expect((await store.getTask('T-1')).status).toBe('pr_open');
  });

  test('a GitHub blip: one failure then merged gives done', async () => {
    vi.useFakeTimers();
    const { store, engine, github } = await prOpen();
    vi.spyOn(github, 'prState').mockRejectedValueOnce(new Error('blip')).mockResolvedValue('merged');
    const p = engine.sync();
    await vi.runAllTimersAsync();
    await p;
    expect((await store.getTask('T-1')).status).toBe('done');
  });

  test('a version conflict skips that task and carries on', async () => {
    const { store, engine, github, url } = await prOpen();
    github.setState(url, 'merged');
    await put(store, { status: 'blocked', stage: 'build', branch: 'b', answer: 'go' });
    const update = vi.spyOn(store, 'updateTask');
    update.mockRejectedValueOnce(new VersionConflictError('T-1', 1, 2));
    await engine.sync();
    expect((await store.getTask('T-1')).status).toBe('pr_open');
    expect((await store.getTask('T-2')).status).toBe('build');
  });
});

describe('status', () => {
  test('lists active claims and counts per status', async () => {
    const { store, engine, clock } = setup();
    await put(store, { status: 'build', stage: 'build', branch: 'b', ...claimedBy('other', clock) });
    await put(store, { status: 'build', stage: 'build', branch: 'b', claimBy: 'old', claimUntil: '2026-01-01T00:00:00Z' });
    await put(store, { status: 'ready' });
    const s = await engine.status();
    expect(s).toEqual({
      paused: false,
      active: [{ taskId: 'T-1', step: 'build', claimBy: 'other', claimUntil: claimedBy('other', clock).claimUntil }],
      counts: { build: 2, ready: 1 },
    });
  });
});

describe('withRetry', () => {
  test('waits 500 then 1000 ms between three tries, then throws', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValue(new Error('down'));
    const p = withRetry(fn, { tries: 3, baseMs: 500 });
    const settled = expect(p).rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);
    await settled;
  });

  test('never retries a VersionConflictError', async () => {
    const fn = vi.fn().mockRejectedValue(new VersionConflictError('T-1', 1, 2));
    await expect(withRetry(fn, { tries: 3, baseMs: 500 })).rejects.toBeInstanceOf(VersionConflictError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
