import { describe, expect, test } from 'vitest';
import { BlocksStore } from '../src/blocks/store.js';
import { FakeBlocksData, newFakeStorage } from '../src/blocks/fakeData.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { Engine } from '../src/engine.js';
import { FakeGitHub } from '../src/github.js';
import {
  answerTask, cancelTask, createTask, decideGate, editTask, markReady, OwnerActionError, saveSettings, StaleDocError,
} from '../src/owner.js';
import type { RepoConfig } from '../src/repoConfig.js';
import { IllegalMoveError } from '../src/status.js';
import { MemoryStore, VersionConflictError, type BoardStore } from '../src/store.js';
import type { FactoryEvent, RepoId, Task } from '../src/types.js';

const NOW = '2026-11-10T09:00:00.000Z';
const now = () => new Date(NOW);

/** The owner acts on the Board; the core moves tasks and writes docs. On MemoryStore both are one store. */
const fixtures: [string, () => { owner: BoardStore; core: BoardStore }][] = [
  ['MemoryStore', () => {
    const s = new MemoryStore();
    return { owner: s, core: s };
  }],
  ['BlocksStore', () => {
    const storage = newFakeStorage();
    return {
      owner: new BlocksStore(new FakeBlocksData('factory-owner', { storage }), 'owner'),
      core: new BlocksStore(new FakeBlocksData('factory-core', { storage }), 'core'),
    };
  }],
];

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

const you = (e: Partial<FactoryEvent>): FactoryEvent => ({
  taskId: 'T-1', actor: 'you', action: 'set', field: null, from: null, to: null, reason: '', at: NOW, ...e,
});

describe.each(fixtures)('owner actions on %s', (_name, make) => {
  const setup = () => {
    const { owner, core } = make();
    /** A task created by the owner, then moved by the core (its events are dropped from the checks below). */
    const put = async (patch: Partial<Task> = {}, input: Partial<Parameters<typeof createTask>[2]> = {}) => {
      const t = await createTask(owner, now, { title: 'Add widget', description: 'd', repo: 'data', ...input });
      return Object.keys(patch).length ? core.updateTask(t.taskId, t.version, patch) : t;
    };
    const ownerEvents = async (taskId = 'T-1') => (await owner.listEvents(taskId)).filter((e) => e.action !== 'create');
    return { owner, core, put, ownerEvents };
  };

  describe('createTask', () => {
    test('creates an inbox task and writes a create event as you', async () => {
      const { owner } = setup();
      const t = await createTask(owner, now, { title: 'Add widget', description: 'why', repo: 'iam', baseBranch: 'feature/x' });
      expect(t).toMatchObject({ taskId: 'T-1', title: 'Add widget', description: 'why', repo: 'iam', baseBranch: 'feature/x', status: 'inbox', version: 1 });
      expect(await owner.getTask('T-1')).toEqual(t);
      expect(await owner.listEvents('T-1')).toEqual([you({ action: 'create', to: 'inbox', reason: 'created' })]);
    });

    test('the base branch defaults to dev', async () => {
      const { owner } = setup();
      expect((await createTask(owner, now, { title: 'X', description: '', repo: 'data' })).baseBranch).toBe('dev');
    });

    test.each([
      ['a blank title', { title: '  ' }],
      ['an unknown repo', { repo: 'nope' as RepoId }],
      ['an empty base branch', { baseBranch: ' ' }],
    ])('refuses %s', async (_what, bad) => {
      const { owner } = setup();
      const err = await createTask(owner, now, { title: 'X', description: '', repo: 'data', ...bad }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OwnerActionError);
      expect(err).toMatchObject({ code: 'invalid' });
      expect(await owner.listTasks()).toEqual([]);
      expect(await owner.listEvents()).toEqual([]);
    });
  });

  describe('markReady', () => {
    test('moves an inbox task to ready', async () => {
      const { owner, put, ownerEvents } = setup();
      await put();
      const t = await markReady(owner, now, 'T-1');
      expect(t).toMatchObject({ status: 'ready', version: 2 });
      expect(await ownerEvents()).toEqual([you({ action: 'move', field: 'status', from: 'inbox', to: 'ready', reason: 'marked ready' })]);
    });

    test('refuses a task that is not in the inbox', async () => {
      const { owner, put, ownerEvents } = setup();
      await put({ status: 'ready' });
      await expect(markReady(owner, now, 'T-1')).rejects.toBeInstanceOf(IllegalMoveError);
      expect(await ownerEvents()).toEqual([]);
    });
  });

  describe('cancelTask', () => {
    test('cancels a working task and leaves its claim to the engine', async () => {
      const { owner, put, ownerEvents } = setup();
      await put({ status: 'build', stage: 'build', claimBy: 'w', claimUntil: '2026-11-10T09:10:00.000Z' });
      const t = await cancelTask(owner, now, 'T-1');
      expect(t).toMatchObject({ status: 'cancelled', stage: 'build', claimBy: 'w' });
      expect(await ownerEvents()).toEqual([you({ action: 'move', field: 'status', from: 'build', to: 'cancelled', reason: 'cancelled' })]);
    });

    test.each(['cancelled', 'done'] as const)('refuses a %s task', async (status) => {
      const { owner, put } = setup();
      await put({ status });
      await expect(cancelTask(owner, now, 'T-1')).rejects.toBeInstanceOf(IllegalMoveError);
    });
  });

  describe('answerTask', () => {
    test('sets the answer of a blocked task', async () => {
      const { owner, put, ownerEvents } = setup();
      await put({ status: 'blocked', stage: 'build', question: 'which API?' });
      const t = await answerTask(owner, now, 'T-1', 'the v2 one');
      expect(t).toMatchObject({ status: 'blocked', answer: 'the v2 one' });
      expect(await ownerEvents()).toEqual([you({ field: 'answer', to: 'the v2 one', reason: 'answered' })]);
    });

    test('refuses a task that is not blocked', async () => {
      const { owner, put } = setup();
      await put({ status: 'build', stage: 'build' });
      const err = await answerTask(owner, now, 'T-1', 'x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OwnerActionError);
      expect(err).toMatchObject({ code: 'not-blocked', message: 'T-1 is not blocked' });
    });

    test('refuses a blank answer', async () => {
      const { owner, put } = setup();
      await put({ status: 'blocked', stage: 'build' });
      await expect(answerTask(owner, now, 'T-1', ' \n')).rejects.toMatchObject({ code: 'invalid' });
      expect((await owner.getTask('T-1')).answer).toBeNull();
    });

    test("then the engine's sync resumes the task", async () => {
      const { owner, core, put } = setup();
      await put({ status: 'blocked', stage: 'build', question: 'which API?', blockedReason: 'needs input' });
      await answerTask(owner, now, 'T-1', 'the v2 one');
      const engine = new Engine({
        store: core, git: {} as never, github: new FakeGitHub(), repos: { data: cfg } as Record<RepoId, RepoConfig>,
        exec: async () => ({ code: 0, output: '' }), now, mode: 'session', claimant: 'me',
      });
      await engine.sync();
      expect(await owner.getTask('T-1')).toMatchObject({ status: 'build', stage: 'build', question: null, blockedReason: null });
    });
  });

  describe('decideGate', () => {
    test('approves the current spec: records the approval and one event, and leaves the move to the engine', async () => {
      const { owner, core, put, ownerEvents } = setup();
      const before = await put({ status: 'spec_review', stage: 'spec' });
      await core.addDoc('T-1', 'spec', 'S', 'spec-writer');
      const a = await decideGate(owner, now, 'T-1', 'spec', 'approve', 1, '');
      expect(a).toMatchObject({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
      expect(await owner.listApprovals('T-1')).toMatchObject([{ gate: 'spec', docVersion: 1, decision: 'approve' }]);
      expect(await ownerEvents()).toEqual([you({ field: 'approval', to: 'spec:approve@v1', reason: 'approved' })]);
      expect(await owner.getTask('T-1')).toEqual(before);
    });

    test('asks for changes on the current plan with a comment', async () => {
      const { owner, core, put, ownerEvents } = setup();
      await put({ status: 'plan_review', stage: 'plan' });
      await core.addDoc('T-1', 'plan', 'P1', 'planner');
      await core.addDoc('T-1', 'plan', 'P2', 'planner');
      await decideGate(owner, now, 'T-1', 'plan', 'changes', 2, 'split step 3');
      expect(await owner.listApprovals('T-1')).toMatchObject([{ gate: 'plan', docVersion: 2, decision: 'changes', comment: 'split step 3' }]);
      expect(await ownerEvents()).toEqual([you({ field: 'approval', to: 'plan:changes@v2', reason: 'split step 3' })]);
      expect((await owner.getTask('T-1')).status).toBe('plan_review');
    });

    test('approves an open PR against the current review doc and does not move the task', async () => {
      const { owner, core, put } = setup();
      await put({ status: 'pr_open', stage: 'ship', prUrl: 'https://github.com/o/r/pull/1' });
      await core.addDoc('T-1', 'review', 'R', 'reviewer');
      await decideGate(owner, now, 'T-1', 'pr', 'approve', 1, 'lgtm');
      expect(await owner.listApprovals('T-1')).toMatchObject([{ gate: 'pr', docVersion: 1, decision: 'approve', comment: 'lgtm' }]);
      expect((await owner.getTask('T-1')).status).toBe('pr_open');
    });

    test.each([
      ['spec', 'plan_review'], ['plan', 'spec_review'], ['pr', 'review'], ['spec', 'spec'],
    ] as const)('refuses gate %s while the task is %s', async (gate, status) => {
      const { owner, core, put, ownerEvents } = setup();
      await put({ status, stage: 'spec' });
      await core.addDoc('T-1', 'spec', 'S', 'a');
      await core.addDoc('T-1', 'plan', 'P', 'a');
      await core.addDoc('T-1', 'review', 'R', 'a');
      await expect(decideGate(owner, now, 'T-1', gate, 'approve', 1, '')).rejects.toMatchObject({ code: 'not-waiting' });
      expect(await owner.listApprovals('T-1')).toEqual([]);
      expect(await ownerEvents()).toEqual([]);
    });

    test('refuses a decision on a doc version that is no longer current', async () => {
      const { owner, core, put } = setup();
      await put({ status: 'spec_review', stage: 'spec' });
      await core.addDoc('T-1', 'spec', 'S1', 'a');
      await core.addDoc('T-1', 'spec', 'S2', 'a');
      const err = await decideGate(owner, now, 'T-1', 'spec', 'approve', 1, '').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StaleDocError);
      expect(err).toMatchObject({ seenVersion: 1, currentVersion: 2 });
      expect(await owner.listApprovals('T-1')).toEqual([]);
    });

    test('refuses a gate with no doc', async () => {
      const { owner, put } = setup();
      await put({ status: 'spec_review', stage: 'spec' });
      await expect(decideGate(owner, now, 'T-1', 'spec', 'approve', 1, '')).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  describe('editTask', () => {
    test.each(['inbox', 'ready'] as const)('edits a %s task and writes one event per changed field', async (status) => {
      const { owner, put, ownerEvents } = setup();
      const t = await put(status === 'inbox' ? {} : { status });
      const before = (await ownerEvents()).length;
      const u = await editTask(owner, now, 'T-1', t.version, {
        title: 'New title', description: 'd', repo: 'iam', baseBranch: 'feature/y', gateOverrides: { pr: false },
      });
      expect(u).toMatchObject({ title: 'New title', description: 'd', repo: 'iam', baseBranch: 'feature/y', gateOverrides: { pr: false }, version: t.version + 1 });
      expect(await owner.getTask('T-1')).toEqual(u);
      expect((await ownerEvents()).slice(before)).toEqual([
        you({ field: 'title', from: 'Add widget', to: 'New title', reason: 'edited' }),
        you({ field: 'repo', from: 'data', to: 'iam', reason: 'edited' }),
        you({ field: 'baseBranch', from: 'dev', to: 'feature/y', reason: 'edited' }),
        you({ field: 'gateOverrides', from: '{}', to: '{"pr":false}', reason: 'edited' }),
      ]);
    });

    test('refuses a task the core is working on', async () => {
      const { owner, put } = setup();
      const t = await put({ status: 'spec', stage: 'spec' });
      await expect(editTask(owner, now, 'T-1', t.version, { title: 'x' })).rejects.toMatchObject({ code: 'not-editable' });
    });

    test.each([
      ['a blank title', { title: '' }],
      ['an unknown repo', { repo: 'nope' }],
      ['an empty base branch', { baseBranch: '' }],
      ['a non-boolean gate override', { gateOverrides: { spec: 'yes' } }],
      ['an unknown gate', { gateOverrides: { deploy: true } }],
      ['a field that is not the owner\'s', { status: 'ready' }],
    ])('refuses %s', async (_what, patch) => {
      const { owner, put } = setup();
      const t = await put();
      await expect(editTask(owner, now, 'T-1', t.version, patch as never)).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.getTask('T-1')).toEqual(t);
    });

    test('a stale expected version is a VersionConflictError', async () => {
      const { owner, put } = setup();
      await put();
      await markReady(owner, now, 'T-1');
      await expect(editTask(owner, now, 'T-1', 1, { title: 'x' })).rejects.toBeInstanceOf(VersionConflictError);
    });

    test('losing a race to a core updateTask is a VersionConflictError and writes nothing', async () => {
      const { owner, core, put, ownerEvents } = setup();
      const t = await put();
      const read = owner.getTask.bind(owner);
      // The core writes between the owner's read and its update.
      owner.getTask = async (id) => {
        const seen = await read(id);
        await core.updateTask(id, seen.version, { question: 'raced' });
        return seen;
      };
      await expect(editTask(owner, now, 'T-1', t.version, { title: 'x' })).rejects.toBeInstanceOf(VersionConflictError);
      expect(await read('T-1')).toMatchObject({ title: 'Add widget', question: 'raced', version: 2 });
      expect(await ownerEvents()).toEqual([]);
    });
  });

  describe('saveSettings', () => {
    const setting = (field: string, from: string | null, to: string) =>
      you({ taskId: '-', field, from, to, reason: 'settings saved' });

    test('merges a global patch and writes one event per changed key', async () => {
      const { owner } = setup();
      const s = await saveSettings(owner, now, 'global', { maxParallel: 3, maxTurnsPerStage: DEFAULT_SETTINGS.maxTurnsPerStage, gates: { plan: true } });
      const global = { ...DEFAULT_SETTINGS, maxParallel: 3, gates: { ...DEFAULT_SETTINGS.gates, plan: true } };
      expect(s).toEqual({ global, repos: {} });
      expect(await owner.getSettings()).toEqual({ global, repos: {} });
      expect(await owner.listEvents('-')).toEqual([
        setting('settings.global.maxParallel', '2', '3'),
        setting('settings.global.gates', '{"spec":true,"plan":false,"pr":true}', '{"spec":true,"plan":true,"pr":true}'),
      ]);
    });

    test('merges a repo patch over that repo and keeps the others', async () => {
      const { owner } = setup();
      await saveSettings(owner, now, 'os', { paused: true });
      await saveSettings(owner, now, 'data', { maxCostPerTaskUsd: 10, gates: { pr: false } });
      await saveSettings(owner, now, 'data', { maxParallel: 1 });
      expect(await owner.getSettings()).toEqual({
        global: DEFAULT_SETTINGS,
        repos: { os: { paused: true }, data: { maxCostPerTaskUsd: 10, gates: { pr: false }, maxParallel: 1 } },
      });
      expect((await owner.listEvents('-')).map((e) => [e.field, e.from, e.to])).toEqual([
        ['settings.os.paused', null, 'true'],
        ['settings.data.maxCostPerTaskUsd', null, '10'],
        ['settings.data.gates', null, '{"pr":false}'],
        ['settings.data.maxParallel', null, '1'],
      ]);
    });

    test('a patch that changes nothing writes no event', async () => {
      const { owner } = setup();
      await saveSettings(owner, now, 'global', { maxParallel: DEFAULT_SETTINGS.maxParallel, gates: { spec: true } });
      expect(await owner.listEvents('-')).toEqual([]);
    });

    test.each([
      { maxParallel: 1 }, { maxParallel: 10 }, { maxTurnsPerStage: 1 }, { maxTurnsPerStage: 500 },
      { maxCostPerTaskUsd: 0 }, { maxCostPerTaskUsd: 1000 }, { maxCostPerTaskUsd: 2.5 },
    ])('accepts the bound %o', async (patch) => {
      const { owner } = setup();
      await saveSettings(owner, now, 'global', patch);
      expect((await owner.getSettings()).global).toMatchObject(patch);
    });

    test.each([
      ['global', { maxParallel: 0 }], ['global', { maxParallel: 11 }], ['data', { maxParallel: 1.5 }],
      ['global', { maxTurnsPerStage: 0 }], ['data', { maxTurnsPerStage: 501 }],
      ['global', { maxCostPerTaskUsd: -1 }], ['global', { maxCostPerTaskUsd: 1000.01 }], ['data', { maxCostPerTaskUsd: Number.NaN }],
      ['global', { maxParallel: '3' }], ['global', { paused: 'yes' }], ['data', { gates: { spec: 1 } }], ['global', { gates: { deploy: true } }],
      ['global', { colour: 'red' }], ['nope', { maxParallel: 2 }],
    ])('refuses scope %s with %o', async (scope, patch) => {
      const { owner } = setup();
      await expect(saveSettings(owner, now, scope as RepoId, patch as never)).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.getSettings()).toEqual({ global: DEFAULT_SETTINGS, repos: {} });
      expect(await owner.listEvents('-')).toEqual([]);
    });
  });
});

test('OwnerActionError and StaleDocError carry their details', () => {
  const e = new OwnerActionError('not-waiting', 'T-1 is not waiting at the spec gate');
  expect(e).toBeInstanceOf(Error);
  expect(e).toMatchObject({ name: 'OwnerActionError', code: 'not-waiting', message: 'T-1 is not waiting at the spec gate' });
  const s = new StaleDocError('T-1', 'spec', 1, 2);
  expect(s).toMatchObject({ name: 'StaleDocError', taskId: 'T-1', kind: 'spec', seenVersion: 1, currentVersion: 2 });
  expect(s.message).toBe('T-1 spec is now v2, not v1');
});
