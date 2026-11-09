import { describe, expect, it } from 'vitest';
import { FakeBlocksData } from '../../src/blocks/fakeData.js';
import { BlocksForbiddenError } from '../../src/blocks/data.js';

describe('FakeBlocksData', () => {
  it('assigns ItemId and CreatedDate, and CreatedBy by role', async () => {
    const f = new FakeBlocksData('factory-owner');
    expect(await f.insert('FactoryTask', { taskId: 'a' })).toEqual({ kind: 'inserted', itemId: 'I-1' });
    const [row] = await f.list('FactoryTask', {});
    expect(row).toMatchObject({ ItemId: 'I-1', CreatedBy: 'owner-user', taskId: 'a', title: null });
    expect(Number.isNaN(Date.parse(String(row!.CreatedDate)))).toBe(false);
    const c = new FakeBlocksData('factory-core');
    await c.insert('FactoryDoc', { docKey: 'k' });
    expect((await c.list('FactoryDoc', {}))[0]!.CreatedBy).toBe('');
  });
  it('stamps CreatedDate from an injected clock', async () => {
    const f = new FakeBlocksData('any', { now: () => new Date('2026-01-02T03:04:05.000Z') });
    await f.insert('FactoryTask', { taskId: 'a' });
    expect(f.rows('FactoryTask')[0]!.CreatedDate).toBe('2026-01-02T03:04:05.000Z');
  });
  it('seed stores a row as given, without access checks, filling missing fields with null', async () => {
    const f = new FakeBlocksData('factory-core');
    f.seed('FactoryTask', { taskId: 'T-1', CreatedDate: '2026-11-09T10:00:00' });
    expect(f.rows('FactoryTask')[0]).toMatchObject({ taskId: 'T-1', title: null, CreatedDate: '2026-11-09T10:00:00', ItemId: 'I-1' });
    expect(await f.list('FactoryTask', {})).toHaveLength(1);
  });
  it('duplicate unique value returns duplicate and stores nothing', async () => {
    const f = new FakeBlocksData('factory-owner');
    await f.insert('FactoryTask', { taskId: 'a' });
    expect(await f.insert('FactoryTask', { taskId: 'a' })).toEqual({ kind: 'duplicate' });
    expect(f.rows('FactoryTask')).toHaveLength(1);
  });
  it('factory-core inserting into FactoryApproval is forbidden; any role skips checks', async () => {
    expect(await new FakeBlocksData('factory-core').insert('FactoryApproval', { approvalId: 'x' })).toEqual({ kind: 'forbidden' });
    const any = new FakeBlocksData('any');
    expect(await any.insert('FactoryApproval', { approvalId: 'x' })).toMatchObject({ kind: 'inserted' });
    expect(any.rows('FactoryApproval')[0]!.CreatedBy).toBe('any');
  });
  it('list needs read permission and filters by strict equality', async () => {
    const owner = new FakeBlocksData('factory-owner');
    await owner.insert('FactoryTask', { taskId: 'a', version: 1 });
    await owner.insert('FactoryTask', { taskId: 'b', version: 2 });
    expect(await owner.list('FactoryTask', { version: 2 })).toHaveLength(1);
    expect(await owner.list('FactoryTask', { version: '2' })).toHaveLength(0);
    await expect(new FakeBlocksData('factory-owner').list('FactorySpike', {})).rejects.toBeInstanceOf(BlocksForbiddenError);
  });
  it('list honours fields', async () => {
    const f = new FakeBlocksData('any');
    await f.insert('FactoryTask', { taskId: 'a', title: 't' });
    expect(Object.keys((await f.list('FactoryTask', {}, ['taskId']))[0]!).sort()).toEqual(['CreatedBy', 'CreatedDate', 'ItemId', 'taskId']);
  });
  it('update applies to the single matching row, not-applied for zero, throws for many, forbidden without edit', async () => {
    const f = new FakeBlocksData('factory-owner');
    await f.insert('FactoryTask', { taskId: 'a', version: 1, status: 'x' });
    expect(await f.update('FactoryTask', { taskId: 'a', version: 1 }, { status: 'y' })).toEqual({ kind: 'applied' });
    expect(f.rows('FactoryTask')[0]!.status).toBe('y');
    expect(await f.update('FactoryTask', { taskId: 'a', version: 9 }, { status: 'z' })).toEqual({ kind: 'not-applied' });
    await f.insert('FactoryTask', { taskId: 'b', version: 1 });
    await expect(f.update('FactoryTask', { version: 1 }, { status: 'z' })).rejects.toThrow();
    expect(await new FakeBlocksData('factory-core').update('FactoryDoc', {}, { body: 'x' })).toEqual({ kind: 'forbidden' });
  });
  it('failNextReply(insert) stores the row and then throws, once', async () => {
    const f = new FakeBlocksData('factory-owner');
    f.failNextReply('insert');
    await expect(f.insert('FactoryTask', { taskId: 'a' })).rejects.toThrow();
    expect(f.rows('FactoryTask')).toHaveLength(1);
    expect(await f.insert('FactoryTask', { taskId: 'b' })).toMatchObject({ kind: 'inserted' });
  });
  it('failNextReply(update) applies the write and returns unknown', async () => {
    const f = new FakeBlocksData('factory-owner');
    await f.insert('FactoryTask', { taskId: 'a', status: 'x' });
    f.failNextReply('update');
    expect(await f.update('FactoryTask', { taskId: 'a' }, { status: 'y' })).toEqual({ kind: 'unknown' });
    expect(f.rows('FactoryTask')[0]!.status).toBe('y');
  });
  it('rows returns copies; unknown insert keys throw', async () => {
    const f = new FakeBlocksData('any');
    await f.insert('FactoryTask', { taskId: 'a' });
    f.rows('FactoryTask')[0]!.taskId = 'mutated';
    expect(f.rows('FactoryTask')[0]!.taskId).toBe('a');
    await expect(f.insert('FactoryTask', { nope: 1 })).rejects.toThrow(/unknown/i);
  });
  it('hardDelete needs the delete permission', async () => {
    const core = new FakeBlocksData('factory-core');
    await core.insert('FactorySpike', { spikeKey: 's' });
    await core.hardDelete('FactorySpike', 'I-1');
    expect(core.rows('FactorySpike')).toHaveLength(0);
    const owner = new FakeBlocksData('factory-owner');
    await expect(owner.hardDelete('FactorySpike', 'I-1')).rejects.toBeInstanceOf(BlocksForbiddenError);
  });
  it('list rejects unknown field names; hardDelete of a missing id throws; write paths reject system keys', async () => {
    const f = new FakeBlocksData('any');
    await expect(f.list('FactoryTask', {}, ['bogus'])).rejects.toThrow(/unknown/i);
    await expect(f.hardDelete('FactorySpike', 'I-404')).rejects.toThrow('fake: delete on FactorySpike deleted nothing');
    for (const k of ['ItemId', 'CreatedBy', 'CreatedDate']) await expect(f.insert('FactoryTask', { [k]: 'x' })).rejects.toThrow(/unknown/i);
    await f.insert('FactoryTask', { taskId: 'a' });
    await expect(f.update('FactoryTask', { taskId: 'a' }, { ItemId: 'x' })).rejects.toThrow(/unknown/i);
  });
});
