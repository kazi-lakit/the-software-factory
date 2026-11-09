import { describe, expect, it, vi } from 'vitest';
import { BlocksForbiddenError, BlocksUnauthorizedError, SdkBlocksData } from '../../src/blocks/data.js';
import { FIELDS } from '../../src/blocks/schema.js';

const projectKey = 'PK-test';
const apiUrl = 'https://api.example.test';
type Seen = { url: string; key: string | null; auth: string | null; body: { operationName: string; query: string; variables: Record<string, any> } };
type Answer = { status?: number; body?: unknown };

function platform(answers: (Answer | Error)[]) {
  const seen: Seen[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), key: headers.get('x-blocks-key'), auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) });
    const next = answers.shift() ?? { body: { data: {} } };
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetcher, seen };
}
const tokens = (...values: string[]) => {
  const queue = [...values];
  let current = queue.shift()!;
  return { get: vi.fn(async () => current), invalidate: vi.fn(() => { current = queue.shift() ?? current; }) };
};
const adapt = (answers: (Answer | Error)[], o: { token?: ReturnType<typeof tokens>; timeoutMs?: number; fetcher?: typeof fetch } = {}) => {
  const p = platform(answers);
  const token = o.token ?? tokens('token-1');
  return { ...p, token, data: new SdkBlocksData({ apiUrl, projectKey, token, fetch: o.fetcher ?? p.fetcher, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) }) };
};
const tasks = (...ids: string[]) => ids.map(ItemId => ({ ItemId, taskId: `t-${ItemId}`, version: 1 }));
const page = (items: unknown[], totalCount: number): Answer => ({ body: { data: { getFactoryTasks: { items, totalCount } } } });

describe('SdkBlocksData', () => {
  it('list pages of 100 until totalCount, with key, bearer, path and filter as JSON string', async () => {
    const first = Array.from({ length: 100 }, (_, n) => ({ ItemId: `a${n}`, taskId: `t${n}` }));
    const t = adapt([page(first, 101), page(tasks('z'), 101)]);
    const rows = await t.data.list('FactoryTask', { status: 'ready' });
    expect(rows).toHaveLength(101);
    expect(t.seen).toHaveLength(2);
    expect(t.seen[0]!.url).toBe(`${apiUrl}/data/v4/gateway`);
    expect(t.seen.map(s => s.key)).toEqual([projectKey, projectKey]);
    expect(t.seen.map(s => s.auth)).toEqual(['Bearer token-1', 'Bearer token-1']);
    const q = t.seen[0]!.body;
    expect(q.operationName).toBe('getFactoryTasks');
    expect(q.query).toContain('query getFactoryTasks($input: DynamicQueryInput)');
    for (const name of ['ItemId', 'CreatedBy', 'CreatedDate', ...FIELDS.FactoryTask.map(f => f.name)]) expect(q.query).toContain(name);
    expect(q.variables.input).toEqual({ filter: JSON.stringify({ status: 'ready' }), pageNo: 1, pageSize: 100 });
    expect(typeof q.variables.input.filter).toBe('string');
    expect(t.seen[1]!.body.variables.input.pageNo).toBe(2);
  });
  it('list normalizes missing keys to null and honours a fields override', async () => {
    const t = adapt([page([{ ItemId: 'a', taskId: 'x' }], 1)]);
    const rows = await t.data.list('FactoryTask', {}, ['taskId', 'version']);
    expect(rows).toEqual([{ ItemId: 'a', CreatedBy: null, CreatedDate: null, taskId: 'x', version: null }]);
    expect(t.seen[0]!.body.query).not.toContain('claimBy');
    expect(t.seen[0]!.body.query).toContain('version');
  });
  it('list stops on an empty page and gives up after 100 pages by throwing', async () => {
    expect(await adapt([page(tasks('a'), 5), page([], 5)]).data.list('FactoryTask', {})).toHaveLength(1);
    const t = adapt(Array.from({ length: 150 }, () => page(tasks('x'), 100000)));
    await expect(t.data.list('FactoryTask', {})).rejects.toThrow(/too many/i);
    expect(t.seen).toHaveLength(100);
  });
  it('401 invalidates the token and retries once with the new token', async () => {
    const token = tokens('old', 'new');
    const t = adapt([{ status: 401, body: {} }, page(tasks('a'), 1)], { token });
    expect(await t.data.list('FactoryTask', {})).toHaveLength(1);
    expect(token.invalidate).toHaveBeenCalledTimes(1);
    expect(t.seen.map(s => s.auth)).toEqual(['Bearer old', 'Bearer new']);
  });
  it('401 awaits an async invalidate() before the retry sends', async () => {
    const order: string[] = [];
    let current = 'token-1';
    const token = {
      get: vi.fn(async () => current),
      invalidate: vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); current = 'token-2'; order.push('invalidated'); }),
    };
    const p = platform([{ status: 401, body: {} }, page(tasks('a'), 1)]);
    const inner = p.fetcher;
    const fetcher: typeof fetch = async (u, i) => { order.push(`send:${new Headers(i?.headers).get('authorization')}`); return inner(u, i); };
    const data = new SdkBlocksData({ apiUrl, projectKey, token, fetch: fetcher });
    await data.list('FactoryTask', {});
    expect(order).toEqual(['send:Bearer token-1', 'invalidated', 'send:Bearer token-2']);
  });

  it('a second 401 throws', async () => {
    const t = adapt([{ status: 401, body: {} }, { status: 401, body: {} }]);
    await expect(t.data.list('FactoryTask', {})).rejects.toThrow('blocks: unauthorized after token refresh');
    await expect(adapt([{ status: 401, body: {} }, { status: 401, body: {} }]).data.list('FactoryTask', {})).rejects.toBeInstanceOf(BlocksUnauthorizedError);
    expect(t.seen).toHaveLength(2);
  });
  it('403 is forbidden for insert and update, and BlocksForbiddenError for list', async () => {
    expect(await adapt([{ status: 403, body: {} }]).data.insert('FactoryTask', { taskId: 'a' })).toEqual({ kind: 'forbidden' });
    expect(await adapt([{ status: 403, body: {} }]).data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'forbidden' });
    await expect(adapt([{ status: 403, body: {} }]).data.list('FactoryTask', {})).rejects.toBeInstanceOf(BlocksForbiddenError);
  });
  describe('column write rule refusal', () => {
    const refusal = (code: string, validationType: string): Answer => ({ body: { errors: [{ message: "You don't have permission to change title on this record.", extensions: { code, validationErrors: [{ field: 'title', message: 'x', validationType }] } }], data: null } });
    it('VALIDATION_ERROR with a ColumnAccess entry is a final refusal on update', async () => {
      const t = adapt([refusal('VALIDATION_ERROR', 'ColumnAccess')]);
      expect(await t.data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'forbidden' });
      expect(t.seen).toHaveLength(1);
    });
    it('the same refusal answered with HTTP 400 is also final (SDK error body)', async () => {
      const r = refusal('VALIDATION_ERROR', 'ColumnAccess');
      expect(await adapt([{ status: 400, body: r.body }]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'forbidden' });
      const other = refusal('VALIDATION_ERROR', 'Required');
      expect(await adapt([{ status: 400, body: other.body }]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
      expect(await adapt([{ status: 400, body: {} }]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
    });
    const LIVE_ENTRY = "{ field = title, message = You don't have permission to change title on this record., validationType = ColumnAccess }";
    const live = (entry = LIVE_ENTRY) => ({ errors: [{ message: "You don't have permission to change title on this record.", locations: [{ line: 1, column: 80 }], path: ['updateFactoryTask'], extensions: { code: 'VALIDATION_ERROR', validationErrors: [entry] } }], data: { updateFactoryTask: null } });
    it('live 2026-11-10 body (string validationErrors entry) is a final refusal, HTTP 200', async () => {
      const t = adapt([{ body: live() }]);
      expect(await t.data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'forbidden' });
      expect(t.seen).toHaveLength(1);
    });
    it('the live body in a non-2xx BlocksApiError body is a final refusal', async () => {
      expect(await adapt([{ status: 400, body: live() }]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'forbidden' });
    });
    it('a string entry with another validationType stays unknown', async () => {
      const other = live("{ field = title, message = ColumnAccess is required, validationType = Required }");
      expect(await adapt([{ body: other }]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
      expect(await adapt([{ status: 400, body: other }]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
    });
    it('other validation errors, other codes and a bare message stay unknown', async () => {
      expect(await adapt([refusal('VALIDATION_ERROR', 'Required')]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
      expect(await adapt([refusal('OTHER', 'ColumnAccess')]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
      const textOnly: Answer = { body: { errors: [{ message: "You don't have permission to change title on this record. ColumnAccess VALIDATION_ERROR" }] } };
      expect(await adapt([textOnly]).data.update('FactoryTask', { taskId: 'a' }, { title: 'x' })).toEqual({ kind: 'unknown' });
    });
    it('is not forbidden for list and insert (they throw as any GraphQL error)', async () => {
      await expect(adapt([refusal('VALIDATION_ERROR', 'ColumnAccess')]).data.list('FactoryTask', {})).rejects.toThrow(/GraphQL error/);
      await expect(adapt([refusal('VALIDATION_ERROR', 'ColumnAccess')]).data.insert('FactoryTask', { taskId: 'a' })).rejects.toThrow(/GraphQL error/);
    });
  });
  it('insert sends only present keys and returns the item id', async () => {
    const t = adapt([{ body: { data: { insertFactoryTask: { acknowledged: true, itemId: 'row-1', totalImpactedData: 1 } } } }]);
    expect(await t.data.insert('FactoryTask', { taskId: 'a', title: 'T', question: null })).toEqual({ kind: 'inserted', itemId: 'row-1' });
    expect(t.seen[0]!.body.operationName).toBe('insertFactoryTask');
    expect(t.seen[0]!.body.query).toContain('mutation insertFactoryTask($input: FactoryTaskInsertInput!)');
    expect(JSON.parse(JSON.stringify(t.seen[0]!.body.variables))).toEqual({ input: { taskId: 'a', title: 'T', question: null } });
  });
  it('insert drops undefined keys and rejects unknown keys before sending', async () => {
    const t = adapt([{ body: { data: { insertFactoryTask: { acknowledged: true, itemId: 'r', totalImpactedData: 1 } } } }]);
    await t.data.insert('FactoryTask', { taskId: 'a', title: undefined as unknown as string });
    expect(Object.keys(t.seen[0]!.body.variables.input)).toEqual(['taskId']);
    await expect(t.data.insert('FactoryTask', { nope: 'x' })).rejects.toThrow(/unknown/i);
    expect(t.seen).toHaveLength(1);
  });
  it('the duplicate text maps to duplicate on insert, and is an error on list', async () => {
    const dup = { body: { errors: [{ message: "A record with the same value for 'taskId' already exists." }] } };
    expect(await adapt([dup]).data.insert('FactoryTask', { taskId: 'a' })).toEqual({ kind: 'duplicate' });
    await expect(adapt([dup]).data.list('FactoryTask', {})).rejects.toThrow(/getFactoryTasks/);
  });
  it('other GraphQL and HTTP errors throw with operation name and status, without row values or tokens', async () => {
    const e1 = await adapt([{ status: 500, body: {} }]).data.insert('FactoryTask', { taskId: 'secret-value' }).catch(e => e as Error);
    expect(e1).toBeInstanceOf(Error);
    expect((e1 as Error).message).toContain('insertFactoryTask');
    expect((e1 as Error).message).toContain('500');
    expect((e1 as Error).message).not.toContain('secret-value');
    expect((e1 as Error).message).not.toContain('token-1');
    await expect(adapt([{ body: { errors: [{ message: 'boom secret-value' }] } }]).data.insert('FactoryTask', { taskId: 'a' })).rejects.toThrow(/insertFactoryTask/);
  });
  it('update sends filter as a JSON string and classifies the outcome', async () => {
    const ans = (acknowledged: boolean, n: number): Answer => ({ body: { data: { updateFactoryTask: { acknowledged, itemId: 'r', totalImpactedData: n } } } });
    const t = adapt([ans(true, 1), ans(false, 0), ans(true, 2)]);
    expect(await t.data.update('FactoryTask', { taskId: 'a', version: 1 }, { status: 'done' })).toEqual({ kind: 'applied' });
    expect(await t.data.update('FactoryTask', { taskId: 'a', version: 1 }, { status: 'done' })).toEqual({ kind: 'not-applied' });
    expect(await t.data.update('FactoryTask', { taskId: 'a', version: 1 }, { status: 'done' })).toEqual({ kind: 'unknown' });
    const b = t.seen[0]!.body;
    expect(b.operationName).toBe('updateFactoryTask');
    expect(b.query).toContain('mutation updateFactoryTask($filter: String, $input: FactoryTaskUpdateInput!)');
    expect(b.variables).toEqual({ filter: JSON.stringify({ taskId: 'a', version: 1 }), input: { status: 'done' } });
  });
  it('update never rejects: transport errors, 500 and GraphQL errors become unknown', async () => {
    expect(await adapt([new Error('socket')]).data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'unknown' });
    expect(await adapt([{ status: 500, body: {} }]).data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'unknown' });
    expect(await adapt([{ body: { errors: [{ message: 'x' }] } }]).data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'unknown' });
  });
  it('hardDelete sends a hard delete by ItemId', async () => {
    const t = adapt([{ body: { data: { deleteFactorySpike: { acknowledged: true, itemId: 'r', totalImpactedData: 1 } } } }]);
    await t.data.hardDelete('FactorySpike', 'row-9');
    const b = t.seen[0]!.body;
    expect(b.operationName).toBe('deleteFactorySpike');
    expect(b.variables).toEqual({ filter: JSON.stringify({ ItemId: 'row-9' }), input: { isHardDelete: true } });
    await expect(adapt([{ status: 403, body: {} }]).data.hardDelete('FactorySpike', 'x')).rejects.toBeInstanceOf(BlocksForbiddenError);
    await expect(adapt([]).data.hardDelete('FactorySpike', '')).rejects.toThrow();
  });
  it('times out a stalled request', async () => {
    const stalled: typeof fetch = (_url, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    const t = adapt([], { fetcher: stalled, timeoutMs: 30 });
    await expect(t.data.list('FactoryTask', {})).rejects.toThrow(/getFactoryTasks/);
    expect(await t.data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'unknown' });
  });
  it('list rejects an unknown requested field before sending', async () => {
    const t = adapt([]);
    await expect(t.data.list('FactoryTask', {}, ['taskId', 'bogus'])).rejects.toThrow(/unknown/i);
    expect(t.seen).toHaveLength(0);
    await adapt([page([], 0)]).data.list('FactoryTask', {}, ['ItemId', 'taskId']);
  });
  it('insert and update reject ItemId, CreatedBy and CreatedDate keys', async () => {
    const t = adapt([]);
    for (const k of ['ItemId', 'CreatedBy', 'CreatedDate']) {
      await expect(t.data.insert('FactoryTask', { [k]: 'x' })).rejects.toThrow(/unknown/i);
    }
    expect(await t.data.update('FactoryTask', { taskId: 'a' }, { ItemId: 'x' })).toEqual({ kind: 'unknown' });
    expect(t.seen).toHaveLength(0);
  });
  it('a token source failure never leaks its message', async () => {
    const token = { get: vi.fn(async () => { throw new Error('keychain says hunter2'); }), invalidate: vi.fn() };
    const t = adapt([], { token });
    for (const op of [t.data.list('FactoryTask', {}), t.data.insert('FactoryTask', { taskId: 'a' }), t.data.hardDelete('FactorySpike', 'x')]) {
      const e = await op.catch(e => e as Error);
      expect((e as Error).message).toMatch(/^blocks: \w+ token unavailable$/);
      expect((e as Error).message).not.toContain('hunter2');
    }
    expect(await t.data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'unknown' });
  });
  it('duplicate text on update is unknown', async () => {
    const dup = { body: { errors: [{ message: "A record with the same value for 'taskId' already exists." }] } };
    expect(await adapt([dup]).data.update('FactoryTask', { taskId: 'a' }, { status: 'x' })).toEqual({ kind: 'unknown' });
  });
  it('hardDelete with totalImpactedData 0 throws', async () => {
    await expect(adapt([{ body: { data: { deleteFactorySpike: { acknowledged: true, itemId: 'r', totalImpactedData: 0 } } } }]).data.hardDelete('FactorySpike', 'x')).rejects.toThrow(/deleteFactorySpike/);
  });
});
