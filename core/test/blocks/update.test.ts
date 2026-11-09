import { describe, expect, it, vi } from 'vitest';
import { classifyUpdate, reconcileUpdate, settleConditionalUpdate, type RereadResult, type WriteOutcome } from '../../src/blocks/update.js';

type UpdateResponse = Parameters<typeof classifyUpdate>[0];

describe('Blocks conditional-update response', () => {
  it.each<[string, UpdateResponse, WriteOutcome['kind']]>([
    ['acknowledged one', { acknowledged: true, totalImpactedData: 1 }, 'applied'],
    ['observed non-match (acknowledged:false, 0)', { acknowledged: false, totalImpactedData: 0 }, 'not-applied'],
    ['acknowledged zero', { acknowledged: true, totalImpactedData: 0 }, 'not-applied'],
    ['missing fields', { acknowledged: undefined, totalImpactedData: undefined }, 'unknown'],
    ['acknowledged:false with impact', { acknowledged: false, totalImpactedData: 1 }, 'unknown'],
    ['more than one impacted', { acknowledged: true, totalImpactedData: 2 }, 'unknown'],
    ['impact as a string', { acknowledged: true, totalImpactedData: '1' as unknown as number }, 'unknown'],
    ['GraphQL error (call failed, passed as Error)', new Error('GraphQL error'), 'unknown'],
    ['HTTP 403 (call failed, passed as Error)', new Error('HTTP 403'), 'unknown'],
    ['timeout or network (passed as Error)', new Error('timeout'), 'unknown']
  ])('classifies %s', (_label, response, expected) => {
    expect(classifyUpdate(response).kind).toBe(expected);
  });
});

describe('Blocks re-read reconciliation', () => {
  const attempt = { expectedVersion: 3, writeIds: ['write-ours'], isRetry: false };
  const row = (version: unknown, writeId: unknown) => ({ rows: [{ version, writeId }] }) as RereadResult;
  it.each<[string, RereadResult, typeof attempt, ReturnType<typeof reconcileUpdate>]>([
    ['our writeId landed', row(4, 'write-ours'), attempt, { outcome: 'applied' }],
    ['another writer moved the version', row(4, 'write-theirs'), attempt, { outcome: 'failed', code: 'CONFLICT' }],
    ['version unchanged, first attempt', row(3, 'write-earlier'), attempt, { outcome: 'retry' }],
    ['version unchanged after the retry', row(3, 'write-earlier'), { ...attempt, isRetry: true }, { outcome: 'failed', code: 'RECONCILE_REQUIRED' }],
    ['version went backwards', row(2, 'write-theirs'), attempt, { outcome: 'failed', code: 'RECONCILE_REQUIRED' }],
    ['version not a number', row('4', 'write-theirs'), attempt, { outcome: 'failed', code: 'RECONCILE_REQUIRED' }],
    ['no row: not found or not yours', { rows: [] }, attempt, { outcome: 'failed', code: 'UNAUTHORIZED' }],
    ['several rows for one ItemId', { rows: [{ version: 4, writeId: 'write-ours' }, { version: 4, writeId: 'write-theirs' }] }, attempt, { outcome: 'failed', code: 'RECONCILE_REQUIRED' }],
    // ACR had three distinct denial inputs (GraphQL error, HTTP 401, HTTP 403); the caller now folds them into { error: 'denied' }.
    ['read denied by GraphQL error (folded to denied by the caller)', { error: 'denied' }, attempt, { outcome: 'failed', code: 'UNAUTHORIZED' }],
    ['read denied with 401 (folded to denied by the caller)', { error: 'denied' }, attempt, { outcome: 'failed', code: 'UNAUTHORIZED' }],
    ['read denied with 403 (folded to denied by the caller)', { error: 'denied' }, attempt, { outcome: 'failed', code: 'UNAUTHORIZED' }],
    // ACR's HTTP 503 and transport timeout both fold into { error: 'failed' }.
    ['read failed with 503 (folded to failed by the caller)', { error: 'failed' }, attempt, { outcome: 'failed', code: 'RECONCILE_REQUIRED' }],
    ['read timed out (folded to failed by the caller)', { error: 'failed' }, attempt, { outcome: 'failed', code: 'RECONCILE_REQUIRED' }]
  ])('%s', (_label, reread, input, expected) => {
    expect(reconcileUpdate(reread, input)).toEqual(expected);
  });
});

describe('settleConditionalUpdate', () => {
  const ids = (...values: string[]) => { const queue = [...values]; return () => { const next = queue.shift(); if (!next) throw new Error('newWriteId called more often than expected'); return next; }; };
  const notApplied: WriteOutcome = { kind: 'not-applied' };
  const unknown: WriteOutcome = { kind: 'unknown' };
  const sequence = <T>(...values: T[]) => async () => { const next = values.shift(); if (next === undefined) throw new Error('called more often than expected'); return next; };
  it('returns applied when the update applies, without re-reading', async () => {
    const reread = vi.fn();
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: async () => ({ kind: 'applied' }), reread });
    expect(result).toEqual({ kind: 'applied' });
    expect(reread).not.toHaveBeenCalled();
  });
  it('treats an unknown answer whose write actually landed as applied', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: async () => unknown, reread: async () => ({ rows: [{ version: 4, writeId: 'w1' }] }) });
    expect(result).toEqual({ kind: 'applied' });
  });
  it('reports a lost race as conflict and never retries it', async () => {
    const send = vi.fn(async (_writeId: string): Promise<WriteOutcome> => notApplied);
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2'), send, reread: async () => ({ rows: [{ version: 4, writeId: 'someone-else' }] }) });
    expect(result).toEqual({ kind: 'conflict' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries exactly once with a fresh writeId when the version did not move', async () => {
    const send = vi.fn(async (_writeId: string): Promise<WriteOutcome> => notApplied);
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2', 'w3'), send, reread: async () => ({ rows: [{ version: 3, writeId: 'older' }] }) });
    expect(result).toEqual({ kind: 'reconcile', pendingWriteIds: [] });
    expect(send.mock.calls.map(call => call[0])).toEqual(['w1', 'w2']);
  });
  it('a retry that lands succeeds', async () => {
    const rereads = [{ rows: [{ version: 3, writeId: 'older' }] }] as RereadResult[];
    const answers = [notApplied, { kind: 'applied' }] as WriteOutcome[];
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2'), send: async () => answers.shift()!, reread: async () => rereads.shift()! });
    expect(result).toEqual({ kind: 'applied' });
  });
  it('maps a hidden row to unauthorized', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: async () => notApplied, reread: async () => ({ rows: [] }) });
    expect(result).toEqual({ kind: 'unauthorized' });
  });
  it('recognises our first write landing late after the retry was sent', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2'), send: sequence<WriteOutcome>(unknown, notApplied),
      reread: sequence<RereadResult>({ rows: [{ version: 3, writeId: 'older' }] }, { rows: [{ version: 4, writeId: 'w1' }] }) });
    expect(result).toEqual({ kind: 'applied' });
  });
  it('keeps every write whose answer was unknown, including one on the retry', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2'), send: sequence<WriteOutcome>(unknown, unknown),
      reread: sequence<RereadResult>({ rows: [{ version: 3, writeId: 'older' }] }, { rows: [{ version: 3, writeId: 'older' }] }) });
    expect(result).toEqual({ kind: 'reconcile', pendingWriteIds: ['w1', 'w2'] });
  });
  it('keeps only the unknown write when the other answer was a definite non-match', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2'), send: sequence<WriteOutcome>(notApplied, unknown),
      reread: sequence<RereadResult>({ rows: [{ version: 3, writeId: 'older' }] }, { rows: [{ version: 3, writeId: 'older' }] }) });
    expect(result).toEqual({ kind: 'reconcile', pendingWriteIds: ['w2'] });
  });
  it('a denied re-read after an unknown write is a reconcile case, not unauthorized', async () => {
    // ACR ran this for HTTP 401 and for a GraphQL error; both are { error: 'denied' } now.
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: sequence<WriteOutcome>(unknown), reread: sequence<RereadResult>({ error: 'denied' }) });
    expect(result).toEqual({ kind: 'reconcile', pendingWriteIds: ['w1'] });
  });
  it('a denied re-read after a definite non-match stays unauthorized with nothing pending', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: sequence<WriteOutcome>(notApplied), reread: sequence<RereadResult>({ error: 'denied' }) });
    expect(result).toEqual({ kind: 'unauthorized' });
  });
  it('nothing is pending once the version has moved past the expected one', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: sequence<WriteOutcome>(unknown), reread: sequence<RereadResult>({ rows: [{ version: 4, writeId: 'someone-else' }] }) });
    expect(result).toEqual({ kind: 'conflict' });
  });
  it('stops at a forbidden answer: no re-read, no second send', async () => {
    const send = vi.fn(async (_writeId: string) => ({ kind: 'forbidden' as const }));
    const reread = vi.fn();
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1', 'w2'), send, reread });
    expect(result).toEqual({ kind: 'forbidden' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(reread).not.toHaveBeenCalled();
  });
  it('keeps the pending writeId when the outcome cannot be reconciled now', async () => {
    const result = await settleConditionalUpdate({ expectedVersion: 3, newWriteId: ids('w1'), send: async () => unknown, reread: async () => ({ error: 'failed' }) });
    expect(result).toEqual({ kind: 'reconcile', pendingWriteIds: ['w1'] });
  });
});
