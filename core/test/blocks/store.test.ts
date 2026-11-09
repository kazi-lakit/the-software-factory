import { describe, expect, it } from 'vitest';
import { BlocksForbiddenError, BlocksUnauthorizedError, type BlocksData } from '../../src/blocks/data.js';
import { FakeBlocksData } from '../../src/blocks/fakeData.js';
import {
  BlocksStore, CORE_TASK_FIELDS, DocTooLargeError, MAX_DOC_BYTES, OwnerOnlyError,
} from '../../src/blocks/store.js';
import { DEFAULT_SETTINGS } from '../../src/defaults.js';
import { NotFoundError, VersionConflictError } from '../../src/store.js';
import { runStoreContract } from '../storeContract.js';

// R1: the contract suite runs on role 'any' (owner identity, no access checks).
runStoreContract('BlocksStore', () => new BlocksStore(new FakeBlocksData('any'), 'owner'));

/** Counts every BlocksData call. */
function counting(inner: BlocksData): BlocksData & { calls: number } {
  const c = {
    calls: 0,
    list: (...a: Parameters<BlocksData['list']>) => (c.calls++, inner.list(...a)),
    insert: (...a: Parameters<BlocksData['insert']>) => (c.calls++, inner.insert(...a)),
    update: (...a: Parameters<BlocksData['update']>) => (c.calls++, inner.update(...a)),
    hardDelete: (...a: Parameters<BlocksData['hardDelete']>) => (c.calls++, inner.hardDelete(...a)),
  };
  return c;
}

const event = { taskId: 'T-1', actor: 'core', action: 'move' as const, field: 'status', from: 'inbox', to: 'ready', reason: 'r', at: '2026-11-09T00:00:00.000Z' };

describe('BlocksStore', () => {
  it('exports the core task fields and the proven doc size', () => {
    expect(CORE_TASK_FIELDS).toEqual(['status', 'stage', 'branch', 'prUrl', 'attempt', 'blockedReason', 'question', 'answer', 'claimBy', 'claimUntil', 'costUsd']);
    expect(MAX_DOC_BYTES).toBe(4 * 1024 * 1024);
  });

  it('core identity: owner-only methods throw OwnerOnlyError before any data call', async () => {
    const data = counting(new FakeBlocksData('factory-core'));
    const s = new BlocksStore(data, 'core');
    await expect(s.createTask({ title: 't', description: '', repo: 'data' })).rejects.toThrow(
      new OwnerOnlyError('createTask is done on the Board, not by the factory core'),
    );
    await expect(s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' })).rejects.toBeInstanceOf(OwnerOnlyError);
    await expect(s.setSettings({ global: DEFAULT_SETTINGS, repos: {} })).rejects.toThrow('setSettings is done on the Board, not by the factory core');
    expect(data.calls).toBe(0);
  });

  it('core identity: a patch outside CORE_TASK_FIELDS throws before any data call', async () => {
    const data = counting(new FakeBlocksData('factory-core'));
    const s = new BlocksStore(data, 'core');
    await expect(s.updateTask('T-1', 1, { title: 'x' })).rejects.toThrow('factory core may not change title');
    await expect(s.updateTask('T-1', 1, { status: 'ready', gateOverrides: {} })).rejects.toThrow('factory core may not change gateOverrides');
    expect(data.calls).toBe(0);
  });

  it('core identity can update core fields of an owner-created task', async () => {
    const owner = new FakeBlocksData('any');
    const t = await new BlocksStore(owner, 'owner').createTask({ title: 't', description: '', repo: 'data' });
    const core = new BlocksStore(owner, 'core');
    expect(await core.updateTask(t.taskId, 1, { status: 'ready', claimBy: 'w', costUsd: 1.25 })).toMatchObject({ status: 'ready', claimBy: 'w', costUsd: 1.25, version: 2 });
  });

  it('stores fields with the Blocks encodings', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ title: 't', description: 'd', repo: 'os', baseBranch: 'main' });
    await s.updateTask(t.taskId, 1, { gateOverrides: { pr: false }, costUsd: 0.5 });
    const [row] = data.rows('FactoryTask');
    expect(row).toMatchObject({ taskId: 'T-1', baseBranch: 'main', gateOverrides: '{"pr":false}', costUsd: '0.5', attempt: 0, version: 2, stage: null });
    expect(typeof row!.writeId).toBe('string');
    const run = await s.startRun({ taskId: 'T-1', step: 'build', mode: 'sdk', agent: 'implementer' });
    await s.finishRun(run.runId, { result: 'done', turns: 3, costUsd: 0.25 });
    expect(data.rows('FactoryRun')[0]).toMatchObject({ runId: run.runId, turns: 3, costUsd: '0.25', result: 'done', version: 2 });
    expect(data.rows('FactoryRun')[0]!.endedAt).toMatch(/^\d{4}-/);
    await s.addDoc('T-1', 'spec', 'body', 'me');
    expect(data.rows('FactoryDoc')[0]).toMatchObject({ docKey: 'T-1:spec:1', version: 1, bodySha256: '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5' });
    const a = await s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' });
    expect(data.rows('FactoryApproval')[0]!.approvalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toHaveProperty('approvalId');
  });

  it('getSettings merges a partial stored global over DEFAULT_SETTINGS', async () => {
    const data = new FakeBlocksData('any');
    await data.insert('FactorySettings', { scope: 'global', json: '{"paused":true,"gates":{"plan":true}}', version: 1 });
    await data.insert('FactorySettings', { scope: 'data', json: '{"maxParallel":1}', version: 1 });
    expect(await new BlocksStore(data, 'owner').getSettings()).toEqual({
      global: { ...DEFAULT_SETTINGS, paused: true, gates: { ...DEFAULT_SETTINGS.gates, plan: true } },
      repos: { data: { maxParallel: 1 } },
    });
  });

  it('setSettings updates an existing scope with compare-and-set', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    await s.setSettings({ global: DEFAULT_SETTINGS, repos: {} });
    await s.setSettings({ global: { ...DEFAULT_SETTINGS, paused: true }, repos: {} });
    expect(data.rows('FactorySettings')).toHaveLength(1);
    expect(data.rows('FactorySettings')[0]).toMatchObject({ scope: 'global', version: 2 });
  });

  it('lost reply: addEvents retried writes one row', async () => {
    const data = new FakeBlocksData('factory-core');
    const s = new BlocksStore(data, 'core');
    data.failNextReply('insert');
    await expect(s.addEvents([event])).rejects.toThrow();
    await s.addEvents([event]);
    expect(data.rows('FactoryEvent')).toHaveLength(1);
    expect(await s.listEvents('T-1')).toEqual([event]);
  });

  it('lost reply: addDoc retried makes one doc version', async () => {
    const data = new FakeBlocksData('factory-core');
    const s = new BlocksStore(data, 'core');
    data.failNextReply('insert');
    await expect(s.addDoc('T-1', 'spec', 'body', 'me')).rejects.toThrow();
    expect(await s.addDoc('T-1', 'spec', 'body', 'me')).toMatchObject({ version: 1, body: 'body', status: 'current' });
    expect(data.rows('FactoryDoc')).toHaveLength(1);
    // A different author is a new version.
    expect((await s.addDoc('T-1', 'spec', 'body', 'you')).version).toBe(2);
  });

  it('addDoc: a lost-reply retry within 120 s is one version; the same body after the window is v+1', async () => {
    const clock = { t: new Date('2026-11-09T10:00:00Z') };
    const now = () => clock.t;
    const data = new FakeBlocksData('factory-core', { now });
    const s = new BlocksStore(data, 'core', { now });
    data.failNextReply('insert');
    await expect(s.addDoc('T-1', 'spec', 'same', 'me')).rejects.toThrow();
    clock.t = new Date(clock.t.getTime() + 120_000);
    expect((await s.addDoc('T-1', 'spec', 'same', 'me')).version).toBe(1);
    expect(data.rows('FactoryDoc')).toHaveLength(1);
    clock.t = new Date(clock.t.getTime() + 1);
    expect(await s.addDoc('T-1', 'spec', 'same', 'me')).toMatchObject({ version: 2, body: 'same', status: 'current' });
    expect(data.rows('FactoryDoc')).toHaveLength(2);
    expect((await s.currentDoc('T-1', 'spec'))?.version).toBe(2);
  });

  describe('addDoc reads CreatedDate as UTC unless it names a zone', () => {
    // On a machine not on UTC, reading the zone-less form as local time moves it outside or inside the window.
    const at = (iso: string) => {
      const clock = { t: new Date(iso) };
      const data = new FakeBlocksData('any');
      return { clock, data, s: new BlocksStore(data, 'owner', { now: () => clock.t }) };
    };
    const seedDoc = (data: FakeBlocksData, CreatedDate: string) =>
      data.seed('FactoryDoc', { docKey: 'T-1:spec:1', taskId: 'T-1', kind: 'spec', version: 1, body: 'same', bodySha256: '0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5', author: 'me', CreatedDate });
    for (const created of ['2026-11-09T10:00:00', '2026-11-09T10:00:00.000', '2026-11-09T10:00:00Z', '2026-11-09T16:00:00+06:00', '2026-11-09T16:00:00+0600']) {
      it(`${created}: within 120 s is a retry, after is v+1`, async () => {
        const a = at('2026-11-09T10:01:59Z');
        seedDoc(a.data, created);
        expect((await a.s.addDoc('T-1', 'spec', 'same', 'me')).version).toBe(1);
        const b = at('2026-11-09T10:02:01Z');
        seedDoc(b.data, created);
        expect((await b.s.addDoc('T-1', 'spec', 'same', 'me')).version).toBe(2);
      });
    }
  });

  it('one malformed Board row does not stop listTasks or getSettings', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    await s.createTask({ title: 'a', description: '', repo: 'data' });
    await s.createTask({ title: 'b', description: '', repo: 'data' });
    await s.createTask({ title: 'c', description: '', repo: 'data' });
    for (const [taskId, gateOverrides] of [['T-1', '{not json'], ['T-2', '[1]'], ['T-3', '"x"']] as const) {
      expect(await data.update('FactoryTask', { taskId }, { gateOverrides })).toEqual({ kind: 'applied' });
    }
    expect((await s.listTasks()).map((t) => t.gateOverrides)).toEqual([{}, {}, {}]);
    data.seed('FactorySettings', { scope: 'global', json: '{bad', version: 1 });
    data.seed('FactorySettings', { scope: 'os', json: '7', version: 1 });
    data.seed('FactorySettings', { scope: 'data', json: '{"maxParallel":1}', version: 1 });
    expect(await s.getSettings()).toEqual({ global: DEFAULT_SETTINGS, repos: { data: { maxParallel: 1 } } });
  });

  it('timestamps come from the injected clock', async () => {
    const t = new Date('2026-01-02T03:04:05.000Z');
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner', { now: () => t });
    expect((await s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' })).at).toBe(t.toISOString());
    const run = await s.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'x' });
    expect(run.startedAt).toBe(t.toISOString());
    await s.finishRun(run.runId, { result: 'done', turns: null, costUsd: null });
    expect(data.rows('FactoryRun')[0]!.endedAt).toBe(t.toISOString());
  });

  it('lost reply on updateTask is settled by the re-read', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ title: 't', description: '', repo: 'data' });
    data.failNextReply('update');
    expect(await s.updateTask(t.taskId, 1, { status: 'ready' })).toMatchObject({ status: 'ready', version: 2 });
  });

  it('a compare-and-set race between two updateTask calls: one wins, one VersionConflictError', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ title: 't', description: '', repo: 'data' });
    const results = await Promise.allSettled([
      s.updateTask(t.taskId, 1, { status: 'ready' }),
      s.updateTask(t.taskId, 1, { status: 'cancelled' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(VersionConflictError);
    expect((await s.getTask(t.taskId)).version).toBe(2);
  });

  it(`a body over MAX_DOC_BYTES UTF-8 bytes throws DocTooLargeError before any call`, async () => {
    const data = counting(new FakeBlocksData('factory-core'));
    const s = new BlocksStore(data, 'core');
    await expect(s.addDoc('T-1', 'spec', 'x'.repeat(MAX_DOC_BYTES + 1), 'me')).rejects.toBeInstanceOf(DocTooLargeError);
    // Counted in bytes, not characters: (MAX_DOC_BYTES / 2 + 1) two-byte characters are MAX_DOC_BYTES + 2 bytes.
    await expect(s.addDoc('T-1', 'spec', 'é'.repeat(MAX_DOC_BYTES / 2 + 1), 'me')).rejects.toBeInstanceOf(DocTooLargeError);
    expect(data.calls).toBe(0);
    expect((await s.addDoc('T-1', 'spec', 'x'.repeat(MAX_DOC_BYTES), 'me')).version).toBe(1);
  });

  it('createTask retries a duplicate id after re-reading', async () => {
    const inner = new FakeBlocksData('any');
    let raced = false;
    const data: BlocksData = {
      ...counting(inner),
      async list(schema, filter, fields) {
        const rows = await inner.list(schema, filter, fields);
        // Another writer takes T-1 between our read and our insert.
        if (!raced && schema === 'FactoryTask') { raced = true; await inner.insert('FactoryTask', { taskId: 'T-1', title: 'other', version: 1 }); }
        return rows;
      },
    };
    expect((await new BlocksStore(data, 'owner').createTask({ title: 'mine', description: '', repo: 'data' })).taskId).toBe('T-2');
  });

  describe('update settle mapping', () => {
    const stub = (p: { update: Awaited<ReturnType<BlocksData['update']>>; list: () => Promise<never> }): BlocksData => ({
      list: p.list,
      insert: async () => { throw new Error('unused'); },
      update: async () => p.update,
      hardDelete: async () => { throw new Error('unused'); },
    });

    it('forbidden update + forbidden re-read → NotFoundError', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'forbidden' }, list: async () => { throw new BlocksForbiddenError('getFactoryTasks'); } }), 'core');
      await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toBeInstanceOf(NotFoundError);
    });
    it('not applied + unauthorized-after-refresh re-read → NotFoundError', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'not-applied' }, list: async () => { throw new BlocksUnauthorizedError(); } }), 'core');
      await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toBeInstanceOf(NotFoundError);
    });
    it('a plain Error with the unauthorized text is not denied (no message matching)', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'not-applied' }, list: async () => { throw new Error('blocks: unauthorized after token refresh'); } }), 'core');
      await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow('task T-1 update outcome unknown');
    });
    it('not applied + failed re-read → outcome unknown', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'not-applied' }, list: async () => { throw new Error('blocks: getFactoryTasks failed (HTTP 500)'); } }), 'core');
      await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow('task T-1 update outcome unknown; re-read before retrying');
    });
    it('unknown update + denied re-read → outcome unknown (the write may have landed)', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'unknown' }, list: async () => { throw new BlocksForbiddenError('getFactoryTasks'); } }), 'core');
      await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow('task T-1 update outcome unknown; re-read before retrying');
    });
    it('a rejecting update is treated as unknown, never as a thrown transport error', async () => {
      const data: BlocksData = {
        list: async () => { throw new Error('blocks: getFactoryTasks transport error'); },
        insert: async () => { throw new Error('unused'); },
        update: async () => { throw new Error('boom'); },
        hardDelete: async () => { throw new Error('unused'); },
      };
      await expect(new BlocksStore(data, 'core').updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow('task T-1 update outcome unknown');
    });
    it('finishRun outcome unknown names the run', async () => {
      let lists = 0;
      const data: BlocksData = {
        // The first list finds the run; the settle re-read then fails.
        list: async () => { if (lists++ === 0) return [{ runId: 'R-x', version: 1, writeId: null }]; throw new Error('blocks: getFactoryRuns transport error'); },
        insert: async () => { throw new Error('unused'); },
        update: async () => ({ kind: 'unknown' }),
        hardDelete: async () => { throw new Error('unused'); },
      };
      await expect(new BlocksStore(data, 'core').finishRun('R-x', { result: 'done', turns: null, costUsd: null })).rejects.toThrow('run R-x update outcome unknown; re-read before retrying');
    });
  });
});
