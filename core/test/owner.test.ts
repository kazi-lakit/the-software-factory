import { describe, expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlocksStore } from '../src/blocks/store.js';
import { FakeBlocksData, newFakeStorage } from '../src/blocks/fakeData.js';
import { DEFAULT_SETTINGS } from '../src/defaults.js';
import { ClaimError, Engine } from '../src/engine.js';
import { FakeGitHub } from '../src/github.js';
import {
  answerTask, cancelTask, createTask, createTaskAsCore, decideGate, editTask, markReady, OwnerActionError, saveFactory, saveRepo, saveSettings,
  StaleDocError,
} from '../src/owner.js';
import { defFixture, repoFixture, seed, seedBlocksFactories } from './factoryFixtures.js';
import { FactoryConfig } from '../src/factories.js';
import { IllegalMoveError } from '../src/status.js';
import { FileStore, MemoryStore, VersionConflictError, type BoardStore } from '../src/store.js';
import type { FactoryEvent, RepoId, Task } from '../src/types.js';

const NOW = '2026-11-10T09:00:00.000Z';
const now = () => new Date(NOW);

/** The owner acts on the Board; the core moves tasks and writes docs. On MemoryStore both are one store. */
const fixtures: [string, () => { owner: BoardStore; core: BoardStore }][] = [
  ['MemoryStore', () => {
    const s = new MemoryStore({ factories: seed() });
    return { owner: s, core: s };
  }],
  ['BlocksStore', () => {
    const storage = newFakeStorage();
    const ownerData = new FakeBlocksData('factory-owner', { storage });
    seedBlocksFactories(ownerData, seed());
    return { owner: new BlocksStore(ownerData, 'owner'), core: new BlocksStore(new FakeBlocksData('factory-core', { storage }), 'core') };
  }],
];

const factories = async () => new FactoryConfig([defFixture('blocks')], [repoFixture('blocks', 'data')]);

const you = (e: Partial<FactoryEvent>): FactoryEvent => ({
  taskId: 'T-1', factoryId: 'blocks', actor: 'you', action: 'set', field: null, from: null, to: null, reason: '', at: NOW, ...e,
});

describe.each(fixtures)('owner actions on %s', (_name, make) => {
  const setup = () => {
    const { owner, core } = make();
    /** A task created by the owner, then moved by the core (its events are dropped from the checks below). */
    const put = async (patch: Partial<Task> = {}, input: Partial<Parameters<typeof createTask>[2]> = {}) => {
      const t = await createTask(owner, now, { factoryId: 'blocks', title: 'Add widget', description: 'd', repo: 'data', ...input });
      return Object.keys(patch).length ? core.updateTask(t.taskId, t.version, patch) : t;
    };
    const ownerEvents = async (taskId = 'T-1') => (await owner.listEvents(taskId)).filter((e) => e.action !== 'create');
    return { owner, core, put, ownerEvents };
  };

  describe('createTask', () => {
    test('creates an inbox task and writes a create event as you', async () => {
      const { owner } = setup();
      const t = await createTask(owner, now, { factoryId: 'blocks', title: 'Add widget', description: 'why', repo: 'iam', baseBranch: 'feature/x' });
      expect(t).toMatchObject({ taskId: 'T-1', title: 'Add widget', description: 'why', repo: 'iam', baseBranch: 'feature/x', status: 'inbox', version: 1 });
      expect(await owner.getTask('T-1')).toEqual(t);
      expect(await owner.listEvents('T-1')).toEqual([you({ action: 'create', to: 'inbox', reason: 'created' })]);
    });

    test('stores the title trimmed', async () => {
      const { owner } = setup();
      expect((await createTask(owner, now, { factoryId: 'blocks', title: '  Add widget \n', description: '', repo: 'data' })).title).toBe('Add widget');
    });

    test('the base branch defaults to dev', async () => {
      const { owner } = setup();
      expect((await createTask(owner, now, { factoryId: 'blocks', title: 'X', description: '', repo: 'data' })).baseBranch).toBe('dev');
    });

    test.each([
      ['a blank title', { title: '  ' }],
      ['an unknown repo', { repo: 'Nope!' as RepoId }],
      ['an empty base branch', { baseBranch: ' ' }],
      ['a description that is not text', { description: 7 as unknown as string }],
    ])('refuses %s', async (_what, bad) => {
      const { owner } = setup();
      const err = await createTask(owner, now, { factoryId: 'blocks', title: 'X', description: '', repo: 'data', ...bad }).catch((e: unknown) => e);
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
    test('cancels a claimed task and frees the claim; the old claimant then gets a ClaimError', async () => {
      const { owner, core, put, ownerEvents } = setup();
      await put({ status: 'build', stage: 'build', branch: 'b', claimBy: 'w', claimUntil: '2026-11-10T09:10:00.000Z' });
      await core.startRun({ taskId: 'T-1', step: 'build', mode: 'session', agent: 'implementer' });
      const t = await cancelTask(owner, now, 'T-1');
      expect(t).toMatchObject({ status: 'cancelled', stage: 'build', claimBy: null, claimUntil: null });
      expect(await owner.getTask('T-1')).toMatchObject({ status: 'cancelled', claimBy: null, claimUntil: null });
      expect(await ownerEvents()).toEqual([
        you({ action: 'move', field: 'status', from: 'build', to: 'cancelled', reason: 'cancelled' }),
        you({ field: 'claimBy', from: 'w', to: null, reason: 'cancelled' }),
      ]);
      const engine = new Engine({
        store: core, git: {} as never, github: new FakeGitHub(), factories,
        exec: async () => ({ code: 0, output: '' }), now, mode: 'session', claimant: 'w',
      });
      await expect(engine.complete('T-1', 'build', JSON.stringify({ status: 'done', summary: 's' }))).rejects.toBeInstanceOf(ClaimError);
      expect((await owner.getTask('T-1')).status).toBe('cancelled');
    });

    test('cancels an unclaimed inbox task', async () => {
      const { owner, put } = setup();
      await put();
      expect(await cancelTask(owner, now, 'T-1')).toMatchObject({ status: 'cancelled', claimBy: null });
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
      const t = await answerTask(owner, now, 'T-1', 'the v2 one', (await owner.getTask('T-1')).version);
      expect(t).toMatchObject({ status: 'blocked', answer: 'the v2 one' });
      expect(await ownerEvents()).toEqual([you({ field: 'answer', to: 'the v2 one', reason: 'answered' })]);
    });

    test('refuses a task that is not blocked', async () => {
      const { owner, put } = setup();
      await put({ status: 'build', stage: 'build' });
      const err = await answerTask(owner, now, 'T-1', 'x', (await owner.getTask('T-1')).version).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OwnerActionError);
      expect(err).toMatchObject({ code: 'not-blocked', message: 'T-1 is not blocked' });
    });

    test('refuses an answer to a question the owner did not see', async () => {
      const { owner, put } = setup();
      const t = await put({ status: 'blocked', stage: 'build', question: 'which API?' });
      await expect(answerTask(owner, now, 'T-1', 'x', t.version - 1)).rejects.toBeInstanceOf(VersionConflictError);
      expect((await owner.getTask('T-1')).answer).toBeNull();
    });

    test('refuses a blank answer', async () => {
      const { owner, put } = setup();
      await put({ status: 'blocked', stage: 'build' });
      await expect(answerTask(owner, now, 'T-1', ' \n', 1)).rejects.toMatchObject({ code: 'invalid' });
      expect((await owner.getTask('T-1')).answer).toBeNull();
    });

    test("then the engine's sync resumes the task", async () => {
      const { owner, core, put } = setup();
      await put({ status: 'blocked', stage: 'build', question: 'which API?', blockedReason: 'needs input' });
      await answerTask(owner, now, 'T-1', 'the v2 one', (await owner.getTask('T-1')).version);
      const engine = new Engine({
        store: core, git: {} as never, github: new FakeGitHub(), factories,
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

    test.each([
      ['seen version 0', 'spec', 'approve', 0], ['seen version 1.5', 'spec', 'approve', 1.5], ['seen version NaN', 'spec', 'approve', Number.NaN],
      ['an unknown gate', 'deploy', 'approve', 1], ['an unknown decision', 'spec', 'maybe', 1],
    ])('refuses %s', async (_what, gate, decision, seen) => {
      const { owner, core, put } = setup();
      await put({ status: 'spec_review', stage: 'spec' });
      await core.addDoc('T-1', 'spec', 'S', 'a');
      await expect(decideGate(owner, now, 'T-1', gate as never, decision as never, seen, '')).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.listApprovals('T-1')).toEqual([]);
    });

    test('a caller approval id makes a retried click record one approval', async () => {
      const { owner, core, put } = setup();
      await put({ status: 'spec_review', stage: 'spec' });
      await core.addDoc('T-1', 'spec', 'S', 'a');
      const first = await decideGate(owner, now, 'T-1', 'spec', 'approve', 1, 'ok', 'click-1');
      expect(await decideGate(owner, now, 'T-1', 'spec', 'approve', 1, 'ok', 'click-1')).toEqual(first);
      expect(await owner.listApprovals('T-1')).toHaveLength(1);
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

    test('stores the title trimmed and writes gate overrides as canonical JSON', async () => {
      const { owner, put, ownerEvents } = setup();
      const t = await put();
      const u = await editTask(owner, now, 'T-1', t.version, { title: ' Renamed ', gateOverrides: { spec: false, plan: true } });
      expect(u.title).toBe('Renamed');
      expect((await ownerEvents()).map((e) => [e.field, e.to])).toEqual([['title', 'Renamed'], ['gateOverrides', '{"plan":true,"spec":false}']]);
      // A trimmed title equal to the stored one is no change.
      expect(await editTask(owner, now, 'T-1', u.version, { title: 'Renamed  ' })).toEqual(u);
    });

    test('refuses a task the core is working on', async () => {
      const { owner, put } = setup();
      const t = await put({ status: 'spec', stage: 'spec' });
      await expect(editTask(owner, now, 'T-1', t.version, { title: 'x' })).rejects.toMatchObject({ code: 'not-editable' });
    });

    test.each([
      ['a blank title', { title: '' }],
      ['a description that is not text', { description: 7 }],
      ['an unknown repo', { repo: 'Nope!' }],
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
      const s = await saveSettings(owner, now, 'blocks', { maxParallel: 3, maxTurnsPerStage: DEFAULT_SETTINGS.maxTurnsPerStage, gates: { plan: true } });
      const global = { ...DEFAULT_SETTINGS, maxParallel: 3, gates: { ...DEFAULT_SETTINGS.gates, plan: true } };
      expect(s).toEqual({ factories: { blocks: { factory: global, repos: {} } } });
      expect(await owner.getSettings()).toEqual({ factories: { blocks: { factory: global, repos: {} } } });
      expect(await owner.listEvents('-')).toEqual([
        setting('settings.blocks.maxParallel', '2', '3'),
        setting('settings.blocks.gates', '{"spec":true,"plan":false,"pr":true}', '{"spec":true,"plan":true,"pr":true}'),
      ]);
    });

    test('merges a repo patch over that repo and keeps the others', async () => {
      const { owner } = setup();
      await saveSettings(owner, now, 'blocks/os', { paused: true });
      await saveSettings(owner, now, 'blocks/data', { maxCostPerTaskUsd: 10, gates: { pr: false } });
      await saveSettings(owner, now, 'blocks/data', { maxParallel: 1 });
      expect(await owner.getSettings()).toEqual({
        factories: { blocks: { factory: DEFAULT_SETTINGS, repos: { os: { paused: true }, data: { maxCostPerTaskUsd: 10, gates: { pr: false }, maxParallel: 1 } } } },
      });
      expect((await owner.listEvents('-')).map((e) => [e.field, e.from, e.to])).toEqual([
        ['settings.blocks/os.paused', null, 'true'],
        ['settings.blocks/data.maxCostPerTaskUsd', null, '10'],
        ['settings.blocks/data.gates', null, '{"pr":false}'],
        ['settings.blocks/data.maxParallel', null, '1'],
      ]);
    });

    test('null in a repo scope inherits the global value: the key or gate is removed and the event says inherit', async () => {
      const { owner } = setup();
      await saveSettings(owner, now, 'blocks/data', { maxParallel: 3, paused: true, gates: { pr: false, spec: true } });
      await saveSettings(owner, now, 'blocks/os', { maxParallel: 4 });
      const at = (await owner.listEvents('-')).length;
      await saveSettings(owner, now, 'blocks/data', { maxParallel: null, maxTurnsPerStage: null, gates: { pr: null } });
      expect((await owner.getSettings()).factories.blocks!.repos).toEqual({ data: { paused: true, gates: { spec: true } }, os: { maxParallel: 4 } });
      await saveSettings(owner, now, 'blocks/data', { gates: { spec: null } });
      expect((await owner.getSettings()).factories.blocks!.repos).toEqual({ data: { paused: true }, os: { maxParallel: 4 } });
      await saveSettings(owner, now, 'blocks/data', { paused: null });
      expect((await owner.getSettings()).factories.blocks!.repos).toEqual({ data: {}, os: { maxParallel: 4 } });
      expect((await owner.listEvents('-')).slice(at).map((e) => [e.field, e.from, e.to])).toEqual([
        ['settings.blocks/data.maxParallel', '3', 'inherit'],
        ['settings.blocks/data.gates', '{"pr":false,"spec":true}', '{"spec":true}'],
        ['settings.blocks/data.gates', '{"spec":true}', 'inherit'],
        ['settings.blocks/data.paused', 'true', 'inherit'],
      ]);
    });

    test('gates: null in a repo scope drops all its gate overrides', async () => {
      const { owner } = setup();
      await saveSettings(owner, now, 'blocks/data', { gates: { plan: true } });
      await saveSettings(owner, now, 'blocks/data', { gates: null });
      expect((await owner.getSettings()).factories.blocks!.repos).toEqual({ data: {} });
      expect((await owner.listEvents('-')).at(-1)).toMatchObject({ field: 'settings.blocks/data.gates', from: '{"plan":true}', to: 'inherit' });
    });

    test('a save from a stale read is a VersionConflictError and writes no event', async () => {
      const { owner } = setup();
      const getSettings = owner.getSettings.bind(owner);
      // Another owner saves the same scope between this save's read and its write.
      owner.getSettings = async () => {
        const seen = await getSettings();
        owner.getSettings = getSettings;
        await saveSettings(owner, now, 'blocks/data', { maxParallel: 5 });
        return seen;
      };
      await expect(saveSettings(owner, now, 'blocks/data', { maxParallel: 3 })).rejects.toBeInstanceOf(VersionConflictError);
      expect((await owner.getSettings()).factories.blocks!.repos.data).toEqual({ maxParallel: 5 });
      expect((await owner.listEvents('-')).map((e) => e.to)).toEqual(['5']);
    });

    test('saves only its scope: a scope changed by someone else meanwhile is kept', async () => {
      const { owner } = setup();
      const getSettings = owner.getSettings.bind(owner);
      owner.getSettings = async () => {
        const seen = await getSettings();
        owner.getSettings = getSettings;
        await saveSettings(owner, now, 'blocks/os', { paused: true });
        return seen;
      };
      await saveSettings(owner, now, 'blocks/data', { maxParallel: 3 });
      expect((await owner.getSettings()).factories.blocks!.repos).toEqual({ os: { paused: true }, data: { maxParallel: 3 } });
    });

    test('a patch that changes nothing writes no event', async () => {
      const { owner } = setup();
      await saveSettings(owner, now, 'blocks', { maxParallel: DEFAULT_SETTINGS.maxParallel, gates: { spec: true } });
      expect(await owner.listEvents('-')).toEqual([]);
    });

    test.each([
      { maxParallel: 1 }, { maxParallel: 10 }, { maxTurnsPerStage: 1 }, { maxTurnsPerStage: 500 },
      { maxCostPerTaskUsd: 0 }, { maxCostPerTaskUsd: 1000 }, { maxCostPerTaskUsd: 2.5 },
    ])('accepts the bound %o', async (patch) => {
      const { owner } = setup();
      await saveSettings(owner, now, 'blocks', patch);
      expect((await owner.getSettings()).factories.blocks!.factory).toMatchObject(patch);
    });

    test.each([
      ['blocks', { maxParallel: 0 }], ['blocks', { maxParallel: 11 }], ['blocks/data', { maxParallel: 1.5 }],
      ['blocks', { maxTurnsPerStage: 0 }], ['blocks/data', { maxTurnsPerStage: 501 }],
      ['blocks', { maxCostPerTaskUsd: -1 }], ['blocks', { maxCostPerTaskUsd: 1000.01 }], ['blocks/data', { maxCostPerTaskUsd: Number.NaN }],
      ['blocks', { maxParallel: '3' }], ['blocks', { paused: 'yes' }], ['blocks/data', { gates: { spec: 1 } }], ['blocks', { gates: { deploy: true } }],
      ['blocks', { colour: 'red' }], ['Nope!', { maxParallel: 2 }],
      ['blocks', { maxParallel: null }], ['blocks', { gates: null }], ['blocks', { gates: { pr: null } }], ['blocks/data', { gates: { pr: 'off' } }],
    ])('refuses scope %s with %o', async (scope, patch) => {
      const { owner } = setup();
      await expect(saveSettings(owner, now, scope, patch as never)).rejects.toMatchObject({ code: 'invalid' });
      expect(await owner.getSettings()).toEqual({ factories: {} });
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

describe.each(fixtures)('createTaskAsCore (%s)', (_name, make) => {
  const setup = () => make();
  const input = { factoryId: 'blocks', title: ' Fix typo ', description: 'd', repo: 'data' as RepoId };

  test('inserts in inbox by default with a create event from core · new', async () => {
    const { core } = setup();
    const t = await createTaskAsCore(core, now, input);
    expect(t).toMatchObject({ taskId: 'T-1', title: 'Fix typo', description: 'd', repo: 'data', baseBranch: 'dev', status: 'inbox', version: 1 });
    expect(await core.listEvents('T-1')).toEqual([
      { taskId: 'T-1', factoryId: 'blocks', actor: 'core · new', action: 'create', field: null, from: null, to: 'inbox', reason: 'created by factory new', at: NOW },
    ]);
  });

  test('inserts in ready when asked', async () => {
    const { core } = setup();
    const t = await createTaskAsCore(core, now, { ...input, ready: true, baseBranch: 'stg' });
    expect(t).toMatchObject({ status: 'ready', baseBranch: 'stg' });
    expect(await core.getTask('T-1')).toEqual(t);
    expect((await core.listEvents('T-1'))[0]).toMatchObject({ to: 'ready', actor: 'core · new' });
  });

  test('refuses base main', async () => {
    const { core } = setup();
    await expect(createTaskAsCore(core, now, { ...input, baseBranch: 'main' })).rejects.toThrow('the factory never targets main');
    expect(await core.listTasks()).toEqual([]);
  });

  test.each(['Main', ' main ', 'origin/main', 'refs/heads/main', 'ORIGIN/MAIN'])('refuses base %s', async (baseBranch) => {
    const { core } = setup();
    await expect(createTaskAsCore(core, now, { ...input, baseBranch })).rejects.toThrow('the factory never targets main');
    expect(await core.listTasks()).toEqual([]);
  });

  test('the owner createTask may still name any base', async () => {
    const { owner } = setup();
    expect((await createTask(owner, now, { ...input, baseBranch: 'main' })).baseBranch).toBe('main');
  });

  test.each([
    ['a blank title', { title: '  ' }, 'title must not be blank'],
    ['an unknown repo', { repo: 'Nope!' as RepoId }, 'repo must be a repo id'],
    ['a blank base', { baseBranch: ' ' }, 'base branch must not be blank'],
  ])('refuses %s', async (_n, patch, message) => {
    const { core } = setup();
    await expect(createTaskAsCore(core, now, { ...input, ...patch })).rejects.toThrow(message);
    expect(await core.listTasks()).toEqual([]);
  });

  test('the owner createTask still writes the event as you', async () => {
    const { owner } = setup();
    await createTask(owner, now, input);
    expect((await owner.listEvents('T-1'))[0]).toMatchObject({ actor: 'you', reason: 'created' });
  });
});

describe.each(fixtures)('creating a task checks the factory and its repos (%s)', (_name, make) => {
  const input = { title: 't', description: '', repo: 'data' };

  test.each([
    ['createTask', (st: BoardStore) => createTask(st, now, { factoryId: 'blocks', ...input, repo: 'api' })],
    ['createTaskAsCore', (st: BoardStore) => createTaskAsCore(st, now, { factoryId: 'blocks', ...input, repo: 'api' })],
  ])('%s refuses a repo that is not in the factory', async (_n, create) => {
    const { owner, core } = make();
    const store = _n === 'createTask' ? owner : core;
    await expect(create(store)).rejects.toThrow('repo api is not in factory blocks');
    expect(await store.listTasks()).toEqual([]);
  });

  test.each([
    ['createTask', (st: BoardStore) => createTask(st, now, { factoryId: 'delta', ...input })],
    ['createTaskAsCore', (st: BoardStore) => createTaskAsCore(st, now, { factoryId: 'delta', ...input })],
  ])('%s refuses an unknown factory', async (_n, create) => {
    const { owner, core } = make();
    const store = _n === 'createTask' ? owner : core;
    await expect(create(store)).rejects.toMatchObject({ code: 'invalid', message: 'factory delta does not exist' });
    expect(await store.listTasks()).toEqual([]);
  });

  test('the same repo id in a second factory is its own repo', async () => {
    const factories = {
      defs: [defFixture('blocks'), defFixture('delta')],
      repos: [repoFixture('blocks', 'data'), repoFixture('delta', 'api')],
    };
    const owner: BoardStore = _name === 'MemoryStore' ? new MemoryStore({ factories }) : (() => {
      const data = new FakeBlocksData('any');
      seedBlocksFactories(data, factories);
      return new BlocksStore(data, 'owner');
    })();
    await expect(createTask(owner, now, { factoryId: 'delta', ...input, repo: 'api' })).resolves.toMatchObject({ factoryId: 'delta', repo: 'api' });
    await expect(createTask(owner, now, { factoryId: 'delta', ...input })).rejects.toThrow('repo data is not in factory delta');
    await expect(createTask(owner, now, { factoryId: 'blocks', ...input })).resolves.toMatchObject({ factoryId: 'blocks', repo: 'data' });
    await expect(createTask(owner, now, { factoryId: 'blocks', ...input, repo: 'api' })).rejects.toThrow('repo api is not in factory blocks');
  });

  test('editTask refuses a repo that is not in the task\'s factory, and allows one that is', async () => {
    const { owner } = make();
    const t = await createTask(owner, now, { factoryId: 'blocks', ...input });
    await expect(editTask(owner, now, t.taskId, t.version, { repo: 'api' })).rejects.toThrow('repo api is not in factory blocks');
    expect((await owner.getTask(t.taskId)).repo).toBe('data');
    await expect(editTask(owner, now, t.taskId, t.version, { repo: 'iam' })).resolves.toMatchObject({ repo: 'iam' });
    // An edit that leaves the repo alone does not look it up.
    await expect(editTask(owner, now, t.taskId, t.version + 1, { title: 'x' })).resolves.toMatchObject({ title: 'x' });
  });

  test('saveSettings refuses a factory or repo that does not exist', async () => {
    const { owner } = make();
    await expect(saveSettings(owner, now, 'delta', { paused: true })).rejects.toThrow('factory delta does not exist');
    await expect(saveSettings(owner, now, 'blocks/api', { paused: true })).rejects.toThrow('repo api is not in factory blocks');
    await expect(saveSettings(owner, now, 'delta/api', { paused: true })).rejects.toThrow('factory delta does not exist');
    expect(await owner.getSettings()).toEqual({ factories: {} });
    expect(await owner.listEvents('-')).toEqual([]);
  });
});

describe.each([
  ['MemoryStore', () => new MemoryStore()],
  ['FileStore', () => new FileStore(join(mkdtempSync(join(tmpdir(), 'owner-fac-')), 'board.json'))],
])('saveFactory and saveRepo on %s', (_name, make) => {
  const factoryEvents = async (s: BoardStore) => (await s.listEvents('-')).map((e) => [e.factoryId, e.actor, e.field, e.from, e.to]);

  test('saveFactory inserts a validated factory with main and writes an event per field', async () => {
    const s = make();
    const stored = await saveFactory(s, now, null, defFixture('delta', { protectedBranches: ['dev'] }));
    expect(stored).toMatchObject({ factoryId: 'delta', protectedBranches: ['dev', 'main'], version: 1 });
    expect(await s.listFactoryDefs()).toEqual([stored]);
    expect((await factoryEvents(s)).map((e) => e[2])).toEqual([
      'def.name', 'def.protectedBranches', 'def.gitName', 'def.gitEmail', 'def.docsPath', 'def.patAccount', 'def.active',
    ]);
    expect((await s.listEvents('-'))[0]).toMatchObject({ factoryId: 'delta', actor: 'you', action: 'set', from: null, to: 'delta', at: NOW });
  });

  test('saveFactory that removes main keeps main and writes an event for each changed field only', async () => {
    const s = make();
    const first = await saveFactory(s, now, null, defFixture('delta'));
    const before = (await s.listEvents('-')).length;
    const next = await saveFactory(s, now, first, { ...first, name: 'Delta 2', protectedBranches: ['dev', 'stg'], active: false });
    expect(next).toMatchObject({ name: 'Delta 2', protectedBranches: ['dev', 'stg', 'main'], active: false, version: 2 });
    expect((await factoryEvents(s)).slice(before)).toEqual([
      ['delta', 'you', 'def.name', 'delta', 'Delta 2'],
      ['delta', 'you', 'def.active', 'true', 'false'],
    ]);
  });

  test('saveFactory refuses an invalid definition and a stale version, and writes nothing', async () => {
    const s = make();
    await expect(saveFactory(s, now, null, defFixture('Bad Id'))).rejects.toMatchObject({ code: 'invalid' });
    const first = await saveFactory(s, now, null, defFixture('delta'));
    await saveFactory(s, now, first, { ...first, name: 'x' });
    const count = (await s.listEvents('-')).length;
    await expect(saveFactory(s, now, first, { ...first, name: 'y' })).rejects.toBeInstanceOf(VersionConflictError);
    expect((await s.listEvents('-')).length).toBe(count);
  });

  test('saveRepo changing checks writes one repo.<id>.checks event with canonical old and new JSON', async () => {
    const s = make();
    await saveFactory(s, now, null, defFixture('delta'));
    const api = await saveRepo(s, now, null, repoFixture('delta', 'api'));
    const before = (await s.listEvents('-')).length;
    const checks = { ...api.checks, e2e: 'off' as const, server: { build: 'b2', cwd: 'server', test: 't' } };
    await saveRepo(s, now, api, { ...api, checks });
    expect((await factoryEvents(s)).slice(before)).toEqual([[
      'delta', 'you', 'repo.api.checks',
      '{"client":{"cwd":"client","install":"i","lint":"l","test":"t","typecheck":"tc"},"e2e":"off","server":{"build":"b","cwd":"server","test":"t"}}',
      '{"client":{"cwd":"client","install":"i","lint":"l","test":"t","typecheck":"tc"},"e2e":"off","server":{"build":"b2","cwd":"server","test":"t"}}',
    ]]);
  });

  test('saveRepo refuses a repo of an unknown factory, a main base, and a stale version', async () => {
    const s = make();
    await expect(saveRepo(s, now, null, repoFixture('delta', 'api'))).rejects.toThrow('factory delta does not exist');
    await saveFactory(s, now, null, defFixture('delta'));
    await expect(saveRepo(s, now, null, repoFixture('delta', 'api', { baseBranch: 'main' }))).rejects.toMatchObject({ code: 'invalid' });
    const api = await saveRepo(s, now, null, repoFixture('delta', 'api'));
    await saveRepo(s, now, api, { ...api, remote: 'git@github.com:o/other.git' });
    await expect(saveRepo(s, now, api, { ...api, baseBranch: 'stg' })).rejects.toBeInstanceOf(VersionConflictError);
    expect(await s.listFactoryRepos('delta')).toHaveLength(1);
  });

  test('events record the stored row as the old value, not the caller\'s stale copy', async () => {
    const s = make();
    const first = await saveFactory(s, now, null, defFixture('delta'));
    // Same version as stored, but other content.
    const lying = { ...first, name: 'Not what is stored' };
    const before = (await s.listEvents('-')).length;
    await saveFactory(s, now, lying, { ...first, name: 'Delta 2' });
    expect((await factoryEvents(s)).slice(before)).toEqual([['delta', 'you', 'def.name', 'delta', 'Delta 2']]);
    const api = await saveRepo(s, now, null, repoFixture('delta', 'api'));
    const mark = (await s.listEvents('-')).length;
    await saveRepo(s, now, { ...api, baseBranch: 'lie' }, { ...api, baseBranch: 'stg' });
    expect((await factoryEvents(s)).slice(mark)).toEqual([['delta', 'you', 'repo.api.baseBranch', 'dev', 'stg']]);
  });

  test('createTask then works against a saved factory and repo', async () => {
    const s = make();
    await saveFactory(s, now, null, defFixture('delta'));
    await saveRepo(s, now, null, repoFixture('delta', 'api'));
    await expect(createTask(s, now, { factoryId: 'delta', title: 't', description: '', repo: 'api' })).resolves.toMatchObject({ factoryId: 'delta' });
    await expect(createTask(s, now, { factoryId: 'delta', title: 't', description: '', repo: 'data' })).rejects.toThrow('repo data is not in factory delta');
  });
});
