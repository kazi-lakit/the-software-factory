import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Exec } from '../src/checks.js';
import { run, type WireOptions } from '../src/cli.js';
import { Engine } from '../src/engine.js';
import type { GitRepos } from '../src/git.js';
import { FakeGitHub } from '../src/github.js';
import type { RepoConfig } from '../src/repoConfig.js';
import { MemoryStore } from '../src/store.js';
import type { RepoId, Task } from '../src/types.js';

const ROOT = join(tmpdir(), 'factory-cli-test');
const cfg: RepoConfig = {
  repo: 'data',
  remote: 'git@github.com:SELISEdigitalplatforms/blocks-data.git',
  baseBranch: 'dev',
  checks: {
    server: { cwd: 'server', build: 'b', test: 't' },
    client: { cwd: 'client', install: 'i', typecheck: 'tc', lint: 'l', test: 't' },
    e2e: 'off',
  },
};

const git: GitRepos = {
  ensureClone: async (c) => join(ROOT, '.clones', c.repo),
  worktree: async (_c, taskId) => join(ROOT, '.clones', 'worktrees', taskId),
  push: async () => {},
  isClean: async () => true,
};

function setup() {
  const store = new MemoryStore();
  const exec: Exec = async () => ({ code: 0, output: '' });
  const engine = new Engine({
    store, git, github: new FakeGitHub(), repos: { data: cfg } as Record<RepoId, RepoConfig>,
    exec, now: () => new Date(), mode: 'session', claimant: 'me',
  });
  const makeEngine = async (_o: WireOptions) => ({ engine, store });
  const out: string[] = [];
  const err: string[] = [];
  const go = (...argv: string[]) => run(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, makeEngine);
  return { store, out, err, go };
}

const put = async (store: MemoryStore, patch: Partial<Task>) => {
  const t = await store.createTask({ title: 'Add widget', description: 'd', repo: 'data' });
  return store.updateTask(t.taskId, t.version, patch);
};

describe('factory cli', () => {
  test('next --json prints a ticket at the spec step', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('next', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n')).step).toBe('spec');
  });

  test('next prints a short line, and nothing to do when idle', async () => {
    const { store, out, go } = setup();
    expect(await go('next')).toBe(0);
    expect(out).toEqual(['nothing to do']);
    await put(store, { status: 'ready' });
    await go('next');
    expect(out[1]).toMatch(/^T-1 spec \(worktree .*T-1\)$/);
  });

  test('complete with a missing result file blocks the task', async () => {
    const { store, go } = setup();
    await put(store, { status: 'ready' });
    await go('next');
    expect(await go('complete', 'T-1', 'spec', '--result', 'missing.json')).toBe(0);
    const t = await store.getTask('T-1');
    expect(t.status).toBe('blocked');
    expect(t.blockedReason).toMatch(/^invalid agent result/);
  });

  test('dev approve for a missing doc exits 1', async () => {
    const { store, err, go } = setup();
    await put(store, { status: 'spec_review', stage: 'spec' });
    expect(await go('dev', 'approve', 'T-1', 'plan')).toBe(1);
    expect(err.join('\n')).toMatch(/no current plan doc/);
  });

  test('--store blocks exits 2', async () => {
    const { err, go } = setup();
    expect(await go('--store', 'blocks', 'status')).toBe(2);
    expect(err).toEqual(['Blocks store is not built yet (plan 2)']);
  });

  test('ship against a branch dev exits 1 with one line', async () => {
    const { store, err, go } = setup();
    await put(store, {
      status: 'review', stage: 'ship', branch: 'dev', claimBy: 'me',
      claimUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await go('ship', 'T-1')).toBe(1);
    expect(err).toEqual(['error: push to dev refused (protected branch)']);
  });

  test('dev add, ready, approve, answer, cancel write events as you', async () => {
    const { store, out, err, go } = setup();
    expect(await go('dev', 'add', '--repo', 'data', '--title', 'X', '--description', 'd')).toBe(0);
    expect(await go('dev', 'ready', 'T-1')).toBe(0);
    expect((await store.getTask('T-1')).status).toBe('ready');

    await put(store, { status: 'spec_review', stage: 'spec' });
    await store.addDoc('T-2', 'spec', 'S', 'a');
    expect(await go('dev', 'approve', 'T-2', 'spec')).toBe(0);
    expect(await store.listApprovals('T-2')).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
    const ev = (await store.listEvents('T-2')).find((e) => e.field === 'approval');
    expect(ev).toMatchObject({ actor: 'you', action: 'set', to: 'spec:approve@v1' });

    expect(await go('dev', 'answer', 'T-2', 'hi')).toBe(1);
    expect(err.at(-1)).toBe('error: T-2 is not blocked');
    await store.updateTask('T-2', (await store.getTask('T-2')).version, { status: 'blocked' });
    expect(await go('dev', 'answer', 'T-2', 'hi')).toBe(0);
    expect((await store.getTask('T-2')).answer).toBe('hi');

    expect(await go('dev', 'cancel', 'T-2')).toBe(0);
    expect((await store.getTask('T-2')).status).toBe('cancelled');
    expect(await go('dev', 'ready', 'T-2')).toBe(1);
    expect(out.length).toBeGreaterThan(0);
  });

  test('status --json and plain', async () => {
    const { store, out, go } = setup();
    await put(store, { status: 'ready' });
    expect(await go('status', '--json')).toBe(0);
    expect(JSON.parse(out[0]!).counts).toEqual({ ready: 1 });
    await go('status');
    expect(out.slice(1).join('\n')).toMatch(/ready: 1/);
  });
});
