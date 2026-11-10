import { describe, expect, it } from 'vitest';
import { BlocksForbiddenError, BlocksUnauthorizedError, type BlocksData } from '../../src/blocks/data.js';
import { FakeBlocksData, newFakeStorage } from '../../src/blocks/fakeData.js';
import {
  BlocksStore, CORE_TASK_FIELDS, DocTooLargeError, MAX_DOC_BYTES, OwnerOnlyError,
} from '../../src/blocks/store.js';
import { DEFAULT_SETTINGS } from '../../src/defaults.js';
import { CoreFieldError, ForbiddenError, MissingVersionError, NotFoundError, RereadAfterUpdateError, VersionConflictError } from '../../src/store.js';
import { PROTECTED_TASK_FIELDS } from '../../src/blocks/schema.js';
import { defFixture, repoFixture, seedBlocksFactories } from '../factoryFixtures.js';
import { FactoryConfig } from '../../src/factories.js';
import { runStoreContract } from '../storeContract.js';

// R1: the contract suite runs on role 'any' (owner identity, no access checks).
runStoreContract('BlocksStore', (identity) => new BlocksStore(new FakeBlocksData('any'), identity ?? 'owner'));

/** Counts every BlocksData call, and updates on their own. */
function counting(inner: BlocksData): BlocksData & { calls: number; updates: number } {
  const c = {
    calls: 0,
    updates: 0,
    list: (...a: Parameters<BlocksData['list']>) => (c.calls++, inner.list(...a)),
    insert: (...a: Parameters<BlocksData['insert']>) => (c.calls++, inner.insert(...a)),
    update: (...a: Parameters<BlocksData['update']>) => (c.calls++, c.updates++, inner.update(...a)),
    hardDelete: (...a: Parameters<BlocksData['hardDelete']>) => (c.calls++, inner.hardDelete(...a)),
  };
  return c;
}

const event = { taskId: 'T-1', factoryId: 'blocks', actor: 'core', action: 'move' as const, field: 'status', from: 'inbox', to: 'ready', reason: 'r', at: '2026-11-09T00:00:00.000Z' };

describe('BlocksStore hashes (golden values from the node:crypto implementation)', () => {
  it('bodySha256 of an ASCII and multi-byte body', async () => {
    const inserted: Record<string, any>[] = [];
    const data = new FakeBlocksData('any');
    const insert = data.insert.bind(data);
    data.insert = (async (schema: any, values: any, ...rest: any[]) => { inserted.push({ schema, ...values }); return (insert as any)(schema, values, ...rest); }) as any;
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    await s.addDoc(t.taskId, 'spec', 'Héllo wörld — 日本語 😀 ascii', 'you');
    expect(inserted.find((r) => r.schema === 'FactoryDoc')!.bodySha256).toBe('9d07485b03cc138c5db8ac35a827fc4f8103fe28f51d669d96d98468b5764d9b');
  });

  it('eventId of a fixed event', async () => {
    const inserted: Record<string, any>[] = [];
    const data = new FakeBlocksData('any');
    const insert = data.insert.bind(data);
    data.insert = (async (schema: any, values: any, ...rest: any[]) => { inserted.push({ schema, ...values }); return (insert as any)(schema, values, ...rest); }) as any;
    await new BlocksStore(data, 'owner').addEvents([event]);
    expect(inserted.find((r) => r.schema === 'FactoryEvent')!.eventId).toBe('2e1b4ba5b86e791a6487ecfb04898fe34196032ebccdbba9d54bc3ade93b370e');
  });
});

describe('BlocksStore factories', () => {
  const stored = async (data: FakeBlocksData) => {
    const s = new BlocksStore(data, 'owner');
    return { s, def: await s.saveFactoryDef(null, defFixture('delta')), repo: await s.saveFactoryRepo(null, repoFixture('delta', 'api')) };
  };

  it('stores a def and a repo in their tables: lists and checks as JSON text, active as 1/0, the repo under its key', async () => {
    const data = new FakeBlocksData('any');
    const { s, def, repo } = await stored(data);
    expect(data.rows('FactoryDef')[0]).toMatchObject({
      factoryId: 'delta', protectedBranches: '["dev","stg","main"]', active: 1, version: 1, patAccount: 'github-pat:delta',
    });
    expect(data.rows('FactoryRepo')[0]).toMatchObject({ repoKey: 'delta/api', factoryId: 'delta', repoId: 'api', version: 1 });
    expect(JSON.parse(String(data.rows('FactoryRepo')[0]!.checks))).toEqual(repo.checks);
    await s.saveFactoryDef(def, { ...def, active: false, gitName: '' });
    expect(data.rows('FactoryDef')[0]).toMatchObject({ active: 0, gitName: '', version: 2 });
    expect(await s.listFactoryDefs()).toEqual([{ ...def, active: false, gitName: '', version: 2 }]);
  });

  it.each([['not json', '[dev'], ['not a list', '"dev"'], ['a list with a non-name', '["dev",7]'], ['missing', undefined]])(
    'a def whose protectedBranches is %s is skipped with a reason, never read as main only (M1)',
    async (_what, raw) => {
      const data = new FakeBlocksData('any');
      const row = { ...defFixture('delta'), protectedBranches: raw, active: 1, writeId: '' } as Record<string, unknown>;
      if (raw === undefined) delete row.protectedBranches;
      data.seed('FactoryDef', row as never);
      const cfg = new FactoryConfig(await new BlocksStore(data, 'owner').listFactoryDefs(), []);
      expect(cfg.factory('delta')).toBeUndefined();
      expect(cfg.skipped()).toEqual([{ id: 'delta', reason: 'protectedBranches must be a list of branch names' }]);
    },
  );

  it('a repo id may exist in two factories: they are two rows', async () => {
    const s = new BlocksStore(new FakeBlocksData('any'), 'owner');
    await s.saveFactoryRepo(null, repoFixture('delta', 'api'));
    await s.saveFactoryRepo(null, repoFixture('mods', 'api'));
    expect((await s.listFactoryRepos()).map((r) => `${r.factoryId}/${r.repoId}`)).toEqual(['delta/api', 'mods/api']);
  });

  it('a stale or missing before is a VersionConflictError, and the row is unchanged', async () => {
    const data = new FakeBlocksData('any');
    const { s, def, repo } = await stored(data);
    await s.saveFactoryDef(def, { ...def, name: 'first' });
    await s.saveFactoryRepo(repo, { ...repo, remote: 'first' });
    await expect(s.saveFactoryDef(def, { ...def, name: 'x' })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(s.saveFactoryRepo(repo, { ...repo, remote: 'x' })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(s.saveFactoryDef(null, def)).rejects.toBeInstanceOf(VersionConflictError);
    expect(data.rows('FactoryDef')[0]).toMatchObject({ name: 'first', version: 2 });
    expect(data.rows('FactoryRepo')[0]).toMatchObject({ remote: 'first', version: 2 });
  });

  it('a lost insert reply still returns the saved def', async () => {
    const data = new FakeBlocksData('any');
    data.failNextReply('insert', 'FactoryDef');
    const s = new BlocksStore(data, 'owner');
    await expect(s.saveFactoryDef(null, defFixture('delta'))).resolves.toMatchObject({ factoryId: 'delta', version: 1 });
    expect(data.rows('FactoryDef')).toHaveLength(1);
  });

  it('a def row without a version cannot be saved', async () => {
    const data = new FakeBlocksData('any');
    data.seed('FactoryDef', { factoryId: 'old', name: 'Old', protectedBranches: '["main"]', active: 1 });
    await expect(new BlocksStore(data, 'owner').saveFactoryDef({ ...defFixture('old'), version: 0 }, defFixture('old'))).rejects.toBeInstanceOf(MissingVersionError);
  });

  it('the core may not save defs or repos (before any data call); the owner may not set health', async () => {
    const data = counting(new FakeBlocksData('factory-core'));
    const core = new BlocksStore(data, 'core');
    await expect(core.saveFactoryDef(null, defFixture('delta'))).rejects.toBeInstanceOf(OwnerOnlyError);
    await expect(core.saveFactoryRepo(null, repoFixture('delta', 'api'))).rejects.toBeInstanceOf(OwnerOnlyError);
    expect(data.calls).toBe(0);
    const owner = new BlocksStore(counting(new FakeBlocksData('factory-owner')), 'owner');
    await expect(owner.setFactoryHealth({ factoryId: 'delta', patPresent: true, checkedAt: 't' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('under the access rules the core reads defs and writes health, the owner writes defs and reads health', async () => {
    const storage = newFakeStorage();
    const owner = new BlocksStore(new FakeBlocksData('factory-owner', { storage }), 'owner');
    const core = new BlocksStore(new FakeBlocksData('factory-core', { storage }), 'core');
    await owner.saveFactoryDef(null, defFixture('delta'));
    expect((await core.listFactoryDefs()).map((d) => d.factoryId)).toEqual(['delta']);
    await core.setFactoryHealth({ factoryId: 'delta', patPresent: false, checkedAt: 'a' });
    await core.setFactoryHealth({ factoryId: 'delta', patPresent: true, checkedAt: 'b' });
    expect(await owner.listFactoryHealth()).toEqual([{ factoryId: 'delta', patPresent: true, checkedAt: 'b' }]);
    expect(storage.tables.get('FactoryHealth')).toHaveLength(1);
  });

  it('tasks and events store their factoryId; rows without one read as factory blocks', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    await s.createTask({ factoryId: 'delta', title: 't', description: '', repo: 'api' });
    expect(data.rows('FactoryTask')[0]).toMatchObject({ factoryId: 'delta' });
    await s.addEvents([{ ...event, factoryId: 'delta' }]);
    expect(data.rows('FactoryEvent')[0]).toMatchObject({ factoryId: 'delta' });
    data.seed('FactoryTask', { taskId: 'T-9', title: 'old', description: '', repo: 'data', baseBranch: 'dev', status: 'inbox', version: 1 });
    data.seed('FactoryEvent', { eventId: 'old', taskId: 'T-9', actor: 'x', action: 'move', reason: '', at: '2026-01-01T00:00:00.000Z' });
    expect((await s.getTask('T-9')).factoryId).toBe('blocks');
    expect((await s.listEvents('T-9'))[0]!.factoryId).toBe('blocks');
  });

  it('identical events in two factories do not collide; a retried one is still one row', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    await s.addEvents([{ ...event, taskId: '-', factoryId: 'delta' }, { ...event, taskId: '-', factoryId: 'mods' }, { ...event, taskId: '-', factoryId: 'delta' }]);
    expect(data.rows('FactoryEvent').map((r) => r.factoryId)).toEqual(['delta', 'mods']);
  });

  it('a core patch of factoryId is refused; the owner may', async () => {
    const data = new FakeBlocksData('any');
    const owner = new BlocksStore(data, 'owner');
    const t = await owner.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    await expect(new BlocksStore(data, 'core').updateTask(t.taskId, 1, { factoryId: 'x' })).rejects.toBeInstanceOf(CoreFieldError);
    await expect(owner.updateTask(t.taskId, 1, { factoryId: 'x' })).resolves.toMatchObject({ factoryId: 'x' });
  });

  describe('legacy settings rows (until `migrate` runs)', () => {
    const legacy = () => {
      const data = new FakeBlocksData('any');
      data.seed('FactorySettings', { scope: 'global', json: JSON.stringify({ paused: true }), version: 1 });
      data.seed('FactorySettings', { scope: 'data', json: JSON.stringify({ maxParallel: 1 }), version: 3 });
      data.seed('FactorySettings', { scope: 'os', json: 'null', version: 2 });
      return { data, s: new BlocksStore(data, 'owner') };
    };

    it('global is factory blocks, any other scope a repo of blocks', async () => {
      const { s } = legacy();
      expect(await s.getSettings()).toEqual({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } } });
    });

    it('a new-scope row wins over the legacy one; a write uses the new scope and leaves the legacy rows alone', async () => {
      const { s, data } = legacy();
      await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 2 });
      await s.updateSettingsScope('blocks', { ...DEFAULT_SETTINGS, paused: true }, { ...DEFAULT_SETTINGS, maxParallel: 4 });
      expect((await s.getSettings()).factories.blocks).toEqual({ factory: { ...DEFAULT_SETTINGS, maxParallel: 4 }, repos: { data: { maxParallel: 2 } } });
      expect(data.rows('FactorySettings').map((r) => [r.scope, r.json])).toEqual([
        ['global', '{"paused":true}'], ['data', '{"maxParallel":1}'], ['os', 'null'],
        ['blocks/data', '{"maxParallel":2}'], ['blocks', JSON.stringify({ ...DEFAULT_SETTINGS, maxParallel: 4 })],
      ]);
    });

    it('removing a legacy repo scope shadows it with a null row', async () => {
      const { s } = legacy();
      await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, null);
      expect((await s.getSettings()).factories.blocks!.repos).toEqual({});
    });

    it('a factory named like a legacy repo never gets that repo\'s settings', async () => {
      const { s, data } = legacy();
      seedBlocksFactories(data, { defs: [defFixture('data')], repos: [] });
      const got = (await s.getSettings()).factories;
      expect(got.blocks!.repos).toEqual({ data: { maxParallel: 1 } });
      expect(got.data).toBeUndefined();
    });

    it('creating a factory whose id is a live legacy repo scope is refused until the legacy rows are retired', async () => {
      const { s, data } = legacy();
      await expect(s.saveFactoryDef(null, defFixture('data'))).rejects.toThrow('factory id data collides with legacy settings; run factory migrate first');
      expect(data.rows('FactoryDef')).toEqual([]);
      // `os` has a null legacy row (removed): no collision. Ids that were never repos are free.
      await s.saveFactoryDef(null, defFixture('os'));
      await s.saveFactoryDef(null, defFixture('delta'));
      await s.updateSettingsScope('blocks', { ...DEFAULT_SETTINGS, paused: true }, { ...DEFAULT_SETTINGS, paused: true });
      await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 1 });
      await s.retireLegacySettings();
      await expect(s.saveFactoryDef(null, defFixture('data'))).resolves.toMatchObject({ factoryId: 'data' });
    });

    it('retireLegacySettings nulls the raw rows whose value is now under the new scopes, and is idempotent', async () => {
      const { s, data } = legacy();
      expect(await s.retireLegacySettings()).toEqual({ retired: [], remaining: ['data', 'global'] });
      await s.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 1 });
      // The legacy repo row `data` has moved, but `global` has not: global stays (and so the reader's legacy mode).
      expect(await s.retireLegacySettings()).toEqual({ retired: ['data'], remaining: ['global'] });
      expect(data.rows('FactorySettings').find((r) => r.scope === 'global')!.json).toBe('{"paused":true}');
      await s.updateSettingsScope('blocks', { ...DEFAULT_SETTINGS, paused: true }, { ...DEFAULT_SETTINGS, paused: true });
      expect(await s.retireLegacySettings()).toEqual({ retired: ['global'], remaining: [] });
      expect(await s.retireLegacySettings()).toEqual({ retired: [], remaining: [] });
      expect(data.rows('FactorySettings').map((r) => [r.scope, r.json])).toEqual([
        ['global', 'null'], ['data', 'null'], ['os', 'null'], ['blocks/data', '{"maxParallel":1}'], ['blocks', JSON.stringify({ ...DEFAULT_SETTINGS, paused: true })],
      ]);
      // The nulled rows are ignored: no phantom factory `data`, and the new values still read.
      expect(await s.getSettings()).toEqual({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: { data: { maxParallel: 1 } } } } });
    });

    it('retireLegacySettings keeps legacy mode while a repo row has not moved, and is the owner\'s', async () => {
      const { s } = legacy();
      await s.updateSettingsScope('blocks', { ...DEFAULT_SETTINGS, paused: true }, { ...DEFAULT_SETTINGS, paused: true });
      expect(await s.retireLegacySettings()).toEqual({ retired: [], remaining: ['data', 'global'] });
      expect((await s.getSettings()).factories.blocks!.repos).toEqual({ data: { maxParallel: 1 } });
      await expect(new BlocksStore(new FakeBlocksData('any'), 'core').retireLegacySettings()).rejects.toBeInstanceOf(OwnerOnlyError);
    });

    it('retireLegacySettings keeps `global` while the `blocks` row is null or malformed, and reports it as remaining', async () => {
      for (const json of ['null', '{not json']) {
        const data = new FakeBlocksData('any');
        data.seed('FactorySettings', { scope: 'global', json: JSON.stringify({ paused: true }), version: 1 });
        data.seed('FactorySettings', { scope: 'blocks', json, version: 1 });
        const s = new BlocksStore(data, 'owner');
        expect(await s.retireLegacySettings()).toEqual({ retired: [], remaining: ['global'] });
        expect(data.rows('FactorySettings').find((r) => r.scope === 'global')!.json).toBe('{"paused":true}');
      }
    });

    it('a stored empty factoryId stays empty; only an absent one means blocks', async () => {
      const { s, data } = legacy();
      data.seed('FactoryEvent', { eventId: 'e1', taskId: '-', factoryId: '', actor: 'x', action: 'move', reason: '', at: '2026-01-01T00:00:00.000Z' });
      expect((await s.listEvents('-'))[0]!.factoryId).toBe('');
    });

    it('setSettings writes new scopes and hides legacy repo scopes that are left out', async () => {
      const { s } = legacy();
      await s.setSettings({ factories: { blocks: { factory: DEFAULT_SETTINGS, repos: {} } } });
      expect(await s.getSettings()).toEqual({ factories: { blocks: { factory: DEFAULT_SETTINGS, repos: {} } } });
    });
  });
});

describe('BlocksStore', () => {
  it('exports the core task fields and the proven doc size', () => {
    expect(CORE_TASK_FIELDS).toEqual(['status', 'stage', 'branch', 'prUrl', 'attempt', 'blockedReason', 'question', 'answer', 'claimBy', 'claimUntil', 'costUsd']);
    expect(MAX_DOC_BYTES).toBe(4 * 1024 * 1024);
  });

  it('core identity: owner-only methods (not createTask) throw OwnerOnlyError before any data call', async () => {
    const data = counting(new FakeBlocksData('factory-core'));
    const s = new BlocksStore(data, 'core');
    await expect(s.addApproval({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '' })).rejects.toBeInstanceOf(OwnerOnlyError);
    await expect(s.setSettings({ factories: { blocks: { factory: DEFAULT_SETTINGS, repos: {} } } })).rejects.toThrow('setSettings is done on the Board, not by the factory core');
    expect(data.calls).toBe(0);
  });

  it('core identity: createTask inserts (the rules allow a core insert) as inbox or ready', async () => {
    const storage = newFakeStorage();
    const s = new BlocksStore(new FakeBlocksData('factory-core', { storage }), 'core');
    expect(await s.createTask({ factoryId: 'blocks', title: 'a', description: 'd', repo: 'data' })).toMatchObject({ taskId: 'T-1', status: 'inbox' });
    expect(await s.createTask({ factoryId: 'blocks', title: 'b', description: '', repo: 'iam', status: 'ready' })).toMatchObject({ taskId: 'T-2', status: 'ready' });
    expect((await s.getTask('T-2')).status).toBe('ready');
  });

  it('core identity: a patch outside CORE_TASK_FIELDS throws before any data call', async () => {
    const data = counting(new FakeBlocksData('factory-core'));
    const s = new BlocksStore(data, 'core');
    await expect(s.updateTask('T-1', 1, { title: 'x' })).rejects.toThrow(new CoreFieldError('title'));
    await expect(s.updateTask('T-1', 1, { title: 'x' })).rejects.toThrow('factory core may not change title');
    await expect(s.updateTask('T-1', 1, { status: 'ready', gateOverrides: {} })).rejects.toThrow('factory core may not change gateOverrides');
    expect(data.calls).toBe(0);
  });

  it('core identity can update core fields of an owner-created task', async () => {
    const owner = new FakeBlocksData('any');
    const t = await new BlocksStore(owner, 'owner').createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    const core = new BlocksStore(owner, 'core');
    expect(await core.updateTask(t.taskId, 1, { status: 'ready', claimBy: 'w', costUsd: 1.25 })).toMatchObject({ status: 'ready', claimBy: 'w', costUsd: 1.25, version: 2 });
  });

  it('stores fields with the Blocks encodings', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ factoryId: 'blocks', title: 't', description: 'd', repo: 'os', baseBranch: 'main' });
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

  it('a clear is sent as empty text and read back as null; a null Int is refused before any update', async () => {
    const fake = new FakeBlocksData('any');
    const data = counting(fake);
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    const u = await s.updateTask(t.taskId, 1, { question: 'q', claimBy: 'w' });
    expect(await s.updateTask(t.taskId, u.version, { question: null, claimBy: null })).toMatchObject({ question: null, claimBy: null });
    expect(fake.rows('FactoryTask')[0]).toMatchObject({ question: '', claimBy: '', title: 't' });
    const updates = data.updates;
    await expect(s.updateTask(t.taskId, 3, { attempt: null as unknown as number })).rejects.toThrow(
      'FactoryTask.attempt (Int) cannot be cleared: Blocks ignores null in an update',
    );
    expect(data.updates).toBe(updates);
    // finishRun with unknown turns leaves the Int out; unknown cost is a clear.
    const run = await s.startRun({ taskId: 'T-1', step: 'spec', mode: 'sdk', agent: 'x' });
    await s.finishRun(run.runId, { result: 'done', turns: null, costUsd: null });
    expect(fake.rows('FactoryRun')[0]).toMatchObject({ turns: null, costUsd: '', result: 'done' });
    expect(await s.openRun('T-1', 'spec')).toBeUndefined();
  });

  it('getSettings merges a partial stored global over DEFAULT_SETTINGS', async () => {
    const data = new FakeBlocksData('any');
    await data.insert('FactorySettings', { scope: 'global', json: '{"paused":true,"gates":{"plan":true}}', version: 1 });
    await data.insert('FactorySettings', { scope: 'data', json: '{"maxParallel":1}', version: 1 });
    expect(await new BlocksStore(data, 'owner').getSettings()).toEqual({
      factories: { blocks: {
        factory: { ...DEFAULT_SETTINGS, paused: true, gates: { ...DEFAULT_SETTINGS.gates, plan: true } },
        repos: { data: { maxParallel: 1 } },
      } },
    });
  });

  it('updateSettingsScope: an insert that loses the race for a new scope is a VersionConflictError', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    const insert = data.insert.bind(data);
    data.insert = async (schema, row) => {
      data.insert = insert;
      await insert('FactorySettings', { scope: 'blocks/data', json: '{"maxParallel":5}', version: 1 });
      return insert(schema, row);
    };
    await expect(s.updateSettingsScope('blocks/data', undefined, { maxParallel: 1 })).rejects.toBeInstanceOf(VersionConflictError);
    expect((await s.getSettings()).factories.blocks!.repos.data).toEqual({ maxParallel: 5 });
  });

  it('updateSettingsScope: a write between the read and the compare-and-set is a VersionConflictError', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    await s.updateSettingsScope('blocks/data', undefined, { maxParallel: 1 });
    const update = data.update.bind(data);
    data.update = async (schema, filter, input) => {
      data.update = update;
      await update('FactorySettings', { scope: 'blocks/data' }, { json: '{"maxParallel":7}', version: 2 });
      return update(schema, filter, input);
    };
    await expect(s.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 2 })).rejects.toBeInstanceOf(VersionConflictError);
    expect((await s.getSettings()).factories.blocks!.repos.data).toEqual({ maxParallel: 7 });
  });

  it('updateSettingsScope is the owner\'s; the core is refused', async () => {
    const s = new BlocksStore(new FakeBlocksData('any'), 'core');
    await expect(s.updateSettingsScope('blocks/data', undefined, { maxParallel: 1 })).rejects.toThrow('updateSettingsScope is done on the Board, not by the factory core');
  });

  it('setSettings updates an existing scope with compare-and-set', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    await s.setSettings({ factories: { blocks: { factory: DEFAULT_SETTINGS, repos: {} } } });
    await s.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } });
    expect(data.rows('FactorySettings')).toHaveLength(1);
    expect(data.rows('FactorySettings')[0]).toMatchObject({ scope: 'blocks', version: 2 });
  });

  it('a column refusal is final: ForbiddenError after exactly one send, row unchanged', async () => {
    const storage = newFakeStorage();
    await new BlocksStore(new FakeBlocksData('factory-owner', { storage }), 'owner').createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    // Owner identity over the core role: the store lets the title through, so the column rule must refuse it.
    const data = counting(new FakeBlocksData('factory-core', { storage, columnRules: { FactoryTask: [...PROTECTED_TASK_FIELDS] } }));
    await expect(new BlocksStore(data, 'owner').updateTask('T-1', 1, { title: 'x', status: 'ready' })).rejects.toBeInstanceOf(ForbiddenError);
    expect(data.updates).toBe(1);
    expect(storage.tables.get('FactoryTask')![0]).toMatchObject({ title: 't', status: 'inbox', version: 1 });
  });

  it('a row-level 403 on finishRun is ForbiddenError after one send', async () => {
    // FactoryRun edit is the core's alone: the owner's update is refused by the row rule.
    const fake = new FakeBlocksData('factory-owner');
    fake.seed('FactoryRun', { runId: 'R-1', taskId: 'T-1', step: 'spec', version: 1 });
    const data = counting(fake);
    await expect(new BlocksStore(data, 'owner').finishRun('R-1', { result: 'done', turns: null, costUsd: null })).rejects.toThrow(new ForbiddenError('run R-1 update forbidden'));
    expect(data.updates).toBe(1);
    expect(fake.rows('FactoryRun')[0]).toMatchObject({ endedAt: null, version: 1 });
  });

  it('a row with a null version is refused before any update is sent', async () => {
    const fake = new FakeBlocksData('any');
    fake.seed('FactoryTask', { taskId: 'T-1', title: 't', status: 'inbox' });
    fake.seed('FactorySettings', { scope: 'blocks', json: '{}' });
    fake.seed('FactoryRun', { runId: 'R-1', taskId: 'T-1', step: 'spec' });
    const data = counting(fake);
    const s = new BlocksStore(data, 'owner');
    const t = await s.getTask('T-1');
    await expect(s.updateTask('T-1', t.version, { status: 'ready' })).rejects.toThrow(
      new MissingVersionError('FactoryTask', 'T-1'),
    );
    await expect(s.updateTask('T-1', t.version, { status: 'ready' })).rejects.toThrow(
      'FactoryTask row T-1 has no version; rows made outside the factory must set version 1',
    );
    await expect(s.setSettings({ factories: { blocks: { factory: { ...DEFAULT_SETTINGS, paused: true }, repos: {} } } })).rejects.toThrow('FactorySettings row blocks has no version');
    await expect(s.finishRun('R-1', { result: 'done', turns: null, costUsd: null })).rejects.toThrow('FactoryRun row R-1 has no version');
    expect(data.updates).toBe(0);
  });

  it('an events refusal names the identity that was refused', async () => {
    const data: BlocksData = {
      list: async () => [],
      insert: async () => ({ kind: 'forbidden' }),
      update: async () => ({ kind: 'forbidden' }),
      hardDelete: async () => { throw new Error('unused'); },
    };
    await expect(new BlocksStore(data, 'owner').addEvents([event])).rejects.toThrow(new ForbiddenError('owner may not write events'));
    await expect(new BlocksStore(data, 'core').addEvents([event])).rejects.toThrow(new ForbiddenError('factory core may not write events'));
  });

  it('lost reply: createTask returns the row it stored instead of making another task', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    data.failNextReply('insert', 'FactoryTask');
    const t = await s.createTask({ factoryId: 'blocks', title: 't', description: 'd', repo: 'data' });
    expect(t).toMatchObject({ taskId: 'T-1', title: 't', status: 'inbox', version: 1 });
    expect(data.rows('FactoryTask')).toHaveLength(1);
    expect(data.rows('FactoryTask')[0]!.writeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await s.getTask('T-1')).toEqual(t);
  });

  it('lost reply: addApproval returns the stored approval; the same approvalId again is not a second row', async () => {
    const clock = { t: new Date('2026-11-09T10:00:00Z') };
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner', { now: () => clock.t });
    const a = { taskId: 'T-1', gate: 'spec' as const, docVersion: 1, decision: 'approve' as const, comment: '', approvalId: 'appr-1' };
    data.failNextReply('insert', 'FactoryApproval');
    const first = await s.addApproval(a);
    expect(first).toEqual({ taskId: 'T-1', gate: 'spec', docVersion: 1, decision: 'approve', comment: '', at: clock.t.toISOString() });
    clock.t = new Date(clock.t.getTime() + 5000);
    expect(await s.addApproval(a)).toEqual(first);
    expect(data.rows('FactoryApproval')).toHaveLength(1);
    // The same id for a different decision is not a retry.
    await expect(s.addApproval({ ...a, decision: 'changes' })).rejects.toThrow('addApproval: approval id already taken');
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
    await s.createTask({ factoryId: 'blocks', title: 'a', description: '', repo: 'data' });
    await s.createTask({ factoryId: 'blocks', title: 'b', description: '', repo: 'data' });
    await s.createTask({ factoryId: 'blocks', title: 'c', description: '', repo: 'data' });
    for (const [taskId, gateOverrides] of [['T-1', '{not json'], ['T-2', '[1]'], ['T-3', '"x"']] as const) {
      expect(await data.update('FactoryTask', { taskId }, { gateOverrides })).toEqual({ kind: 'applied' });
    }
    expect((await s.listTasks()).map((t) => t.gateOverrides)).toEqual([{}, {}, {}]);
    data.seed('FactorySettings', { scope: 'global', json: '{bad', version: 1 });
    data.seed('FactorySettings', { scope: 'os', json: '7', version: 1 });
    data.seed('FactorySettings', { scope: 'data', json: '{"maxParallel":1}', version: 1 });
    expect(await s.getSettings()).toEqual({ factories: { blocks: { factory: DEFAULT_SETTINGS, repos: { data: { maxParallel: 1 } } } } });
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
    const t = await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    data.failNextReply('update');
    expect(await s.updateTask(t.taskId, 1, { status: 'ready' })).toMatchObject({ status: 'ready', version: 2 });
  });

  /** A fake whose next `n` full task reads (getTask) or settle re-reads (version + writeId) fail. */
  function flakyReads(inner: FakeBlocksData) {
    const fail = { getTask: 0, reread: 0 };
    const data: BlocksData = {
      list: async (schema, filter, fields) => {
        if (schema === 'FactoryTask' && fields === undefined && fail.getTask > 0) { fail.getTask--; throw new Error('blocks: getFactoryTasks transport error'); }
        if (fields?.includes('writeId') && fail.reread > 0) { fail.reread--; throw new Error('blocks: getFactoryTasks transport error'); }
        return inner.list(schema, filter, fields);
      },
      insert: (...a) => inner.insert(...a),
      update: (...a) => inner.update(...a),
      hardDelete: (...a) => inner.hardDelete(...a),
    };
    return { data, fail };
  }

  it('a write that landed during a reconcile is recognised by the next updateTask for the same version', async () => {
    const inner = new FakeBlocksData('any');
    const { data, fail } = flakyReads(inner);
    const s = new BlocksStore(data, 'owner');
    await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    // The write lands, its reply is lost, and the re-read fails: outcome unknown.
    inner.failNextReply('update');
    fail.reread = 1;
    await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow('task T-1 update outcome unknown');
    expect(inner.rows('FactoryTask')[0]).toMatchObject({ status: 'ready', version: 2 });
    // The caller's retry sends the same version: our landed write counts as applied, not as a conflict.
    expect(await s.updateTask('T-1', 1, { status: 'ready' })).toMatchObject({ status: 'ready', version: 2 });
    // Once settled, the old write id is forgotten: someone else's later write is a conflict again.
    await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toBeInstanceOf(VersionConflictError);
  });

  it('a failed post-apply re-read is retried in the store', async () => {
    const inner = new FakeBlocksData('any');
    const { data, fail } = flakyReads(inner);
    const s = new BlocksStore(data, 'owner');
    await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    fail.getTask = 2;
    expect(await s.updateTask('T-1', 1, { status: 'ready' })).toMatchObject({ status: 'ready', version: 2 });
  });

  it('a post-apply re-read that keeps failing throws RereadAfterUpdateError (the update did land)', async () => {
    const inner = new FakeBlocksData('any');
    const { data, fail } = flakyReads(inner);
    const s = new BlocksStore(data, 'owner');
    await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
    fail.getTask = 3;
    await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow(new RereadAfterUpdateError('T-1'));
    expect(inner.rows('FactoryTask')[0]).toMatchObject({ status: 'ready', version: 2 });
  });

  it('a compare-and-set race between two updateTask calls: one wins, one VersionConflictError', async () => {
    const data = new FakeBlocksData('any');
    const s = new BlocksStore(data, 'owner');
    const t = await s.createTask({ factoryId: 'blocks', title: 't', description: '', repo: 'data' });
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
    expect((await new BlocksStore(data, 'owner').createTask({ factoryId: 'blocks', title: 'mine', description: '', repo: 'data' })).taskId).toBe('T-2');
  });

  describe('update settle mapping', () => {
    const stub = (p: { update: Awaited<ReturnType<BlocksData['update']>>; list: () => Promise<never> }): BlocksData => ({
      list: p.list,
      insert: async () => { throw new Error('unused'); },
      update: async () => p.update,
      hardDelete: async () => { throw new Error('unused'); },
    });

    it('forbidden update → ForbiddenError, without a re-read', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'forbidden' }, list: async () => { throw new Error('no re-read expected'); } }), 'core');
      await expect(s.updateTask('T-1', 1, { status: 'ready' })).rejects.toThrow(new ForbiddenError('task T-1 update forbidden'));
    });
    it('not applied + forbidden re-read → NotFoundError', async () => {
      const s = new BlocksStore(stub({ update: { kind: 'not-applied' }, list: async () => { throw new BlocksForbiddenError('getFactoryTasks'); } }), 'core');
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

describe('legacySettingsStatus', () => {
  it('separates unmoved from unretired legacy rows and is readable by the core', async () => {
    const data = new FakeBlocksData('any');
    data.seed('FactorySettings', { scope: 'global', json: JSON.stringify({ paused: true }), version: 1 });
    data.seed('FactorySettings', { scope: 'data', json: JSON.stringify({ maxParallel: 1 }), version: 1 });
    const core = new BlocksStore(data, 'core');
    expect(await core.legacySettingsStatus()).toEqual({ unmoved: ['global', 'data'], unretired: [] });
    const owner = new BlocksStore(data, 'owner');
    await owner.updateSettingsScope('blocks', { ...DEFAULT_SETTINGS, paused: true }, { ...DEFAULT_SETTINGS, paused: true });
    await owner.updateSettingsScope('blocks/data', { maxParallel: 1 }, { maxParallel: 1 });
    expect(await core.legacySettingsStatus()).toEqual({ unmoved: [], unretired: ['global', 'data'] });
    await owner.retireLegacySettings();
    expect(await core.legacySettingsStatus()).toEqual({ unmoved: [], unretired: [] });
  });
});
