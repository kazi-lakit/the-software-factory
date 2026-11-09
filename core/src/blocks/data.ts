import { BlocksApiError, createBlocksClient } from '@seliseblocks/client';
import { FIELDS, collectionOf, type SchemaName } from './schema.js';
import type { TokenSource } from './token.js';
import { classifyUpdate, type WriteOutcome } from './update.js';

// Blocks Data over the official SDK. Ported from ACR packages/claude-connector/src/blocks-data-sdk.ts.
// Errors carry the operation name and HTTP status only: never row values, tokens or GraphQL message text.

export type Row = Record<string, string | number | null>;
export type Filter = Record<string, string | number>;

export interface BlocksData {
  /** Pages of 100 until `totalCount`; at most 100 pages, then throws. Throws BlocksForbiddenError on HTTP 403. */
  list(schema: SchemaName, filter: Filter, fields?: string[]): Promise<Row[]>;
  insert(schema: SchemaName, row: Record<string, string | number | null>): Promise<{ kind: 'inserted'; itemId: string } | { kind: 'duplicate' } | { kind: 'forbidden' }>;
  /** Never rejects: a transport error is `unknown`. */
  update(schema: SchemaName, filter: Filter, input: Record<string, string | number | null>): Promise<WriteOutcome | { kind: 'forbidden' }>;
  /** Used only for FactorySpike. */
  hardDelete(schema: SchemaName, itemId: string): Promise<void>;
}

export class BlocksForbiddenError extends Error {
  constructor(operation: string) {
    super(`blocks: ${operation} forbidden`);
    this.name = 'BlocksForbiddenError';
  }
}

/** HTTP 401 again after the token was refreshed once. */
export class BlocksUnauthorizedError extends Error {
  constructor() {
    super('blocks: unauthorized after token refresh');
    this.name = 'BlocksUnauthorizedError';
  }
}

const MAX_PAGES = 100;
const PAGE_SIZE = 100;
const DUPLICATE = /A record with the same value for '[^']+' already exists/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type Answer = { kind: 'answer'; payload: Record<string, unknown> } | { kind: 'duplicate' } | { kind: 'forbidden' } | { kind: 'column-refused' };

/** A column write rule refusal: GraphQL error code VALIDATION_ERROR with a validationErrors entry of type ColumnAccess. Matched on structure only, never message text. */
function isColumnRefusal(e: unknown): boolean {
  if (!isObject(e) || !isObject(e.extensions) || e.extensions.code !== 'VALIDATION_ERROR') return false;
  const list = e.extensions.validationErrors;
  return Array.isArray(list) && list.some(v => isObject(v) && v.validationType === 'ColumnAccess');
}

/** The SDK client has no timeout of its own, so a stalled connection would hang the caller. */
export function withTimeout(ms: number, fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    return fetchImpl(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

export class SdkBlocksData implements BlocksData {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly p: { apiUrl: string; projectKey: string; token: TokenSource; timeoutMs?: number; fetch?: typeof fetch }) {
    this.fetchImpl = withTimeout(p.timeoutMs ?? 30_000, p.fetch);
  }

  private async send(operationName: string, query: string, variables: Record<string, unknown>): Promise<Answer> {
    for (const retry of [false, true]) {
      // A client per attempt: a retry after invalidate() must send the new token.
      let token: string;
      try { token = await this.p.token.get(); } catch { throw new Error(`blocks: ${operationName} token unavailable`); }
      const client = createBlocksClient({ apiUrl: this.p.apiUrl, xBlocksKey: this.p.projectKey, accessToken: () => token, fetch: this.fetchImpl });
      try {
        const answer = await client.data.graphql({ operationName, query, variables });
        if (!isObject(answer)) throw new Error(`blocks: ${operationName} malformed answer`);
        const errors = answer.errors;
        if (Array.isArray(errors) ? errors.length : errors) {
          const list = Array.isArray(errors) ? errors : [];
          if (list.some(e => isObject(e) && typeof e.message === 'string' && DUPLICATE.test(e.message))) return { kind: 'duplicate' };
          if (list.some(isColumnRefusal)) return { kind: 'column-refused' };
          throw new Error(`blocks: ${operationName} GraphQL error`);
        }
        const payload = isObject(answer.data) ? answer.data[operationName] : undefined;
        if (!isObject(payload)) throw new Error(`blocks: ${operationName} malformed answer`);
        return { kind: 'answer', payload };
      } catch (error) {
        if (!(error instanceof BlocksApiError)) {
          if (error instanceof Error && error.message.startsWith(`blocks: ${operationName}`)) throw error;
          throw new Error(`blocks: ${operationName} transport error`);
        }
        if (error.status === 401) {
          if (retry) throw new BlocksUnauthorizedError();
          this.p.token.invalidate();
          continue;
        }
        if (error.status === 403) return { kind: 'forbidden' };
        // The gateway may answer a column refusal with a non-2xx status; BlocksApiError carries the parsed body.
        const body = error.body;
        if (isObject(body) && Array.isArray(body.errors) && body.errors.some(isColumnRefusal)) return { kind: 'column-refused' };
        throw new Error(`blocks: ${operationName} failed (HTTP ${error.status})`);
      }
    }
    throw new BlocksUnauthorizedError();
  }

  async list(schema: SchemaName, filter: Filter, fields?: string[]): Promise<Row[]> {
    const operationName = `get${collectionOf(schema)}`;
    const names = listNames(schema, fields);
    const query = `query ${operationName}($input: DynamicQueryInput) { ${operationName}(input: $input) { items { ${names.join(' ')} } totalCount } }`;
    const rows: Row[] = [];
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
      const answer = await this.send(operationName, query, { input: { filter: JSON.stringify(filter), pageNo, pageSize: PAGE_SIZE } });
      if (answer.kind === 'forbidden') throw new BlocksForbiddenError(operationName);
      if (answer.kind === 'duplicate' || answer.kind === 'column-refused') throw new Error(`blocks: ${operationName} GraphQL error`);
      const { items, totalCount } = answer.payload;
      if (!Array.isArray(items) || typeof totalCount !== 'number' || !items.every(isObject)) throw new Error(`blocks: ${operationName} malformed answer`);
      for (const item of items) {
        const row: Row = {};
        for (const name of names) row[name] = (item[name] ?? null) as string | number | null;
        rows.push(row);
      }
      if (items.length === 0 || rows.length >= totalCount) return rows;
    }
    throw new Error(`blocks: ${operationName} returned too many pages`);
  }

  async insert(schema: SchemaName, row: Record<string, string | number | null>) {
    const input = cleanRow(schema, row);
    const operationName = `insert${schema}`;
    const answer = await this.send(operationName, `mutation ${operationName}($input: ${schema}InsertInput!) { ${operationName}(input: $input) { acknowledged itemId totalImpactedData } }`, { input });
    if (answer.kind === 'forbidden') return { kind: 'forbidden' as const };
    if (answer.kind === 'column-refused') throw new Error(`blocks: ${operationName} GraphQL error`);
    if (answer.kind === 'duplicate') return { kind: 'duplicate' as const };
    const { acknowledged, itemId } = answer.payload;
    if (acknowledged === true && typeof itemId === 'string' && itemId !== '') return { kind: 'inserted' as const, itemId };
    throw new Error(`blocks: ${operationName} not acknowledged`);
  }

  async update(schema: SchemaName, filter: Filter, input: Record<string, string | number | null>): Promise<WriteOutcome | { kind: 'forbidden' }> {
    const operationName = `update${schema}`;
    try {
      const answer = await this.send(operationName, `mutation ${operationName}($filter: String, $input: ${schema}UpdateInput!) { ${operationName}(filter: $filter, input: $input) { acknowledged itemId totalImpactedData message } }`, { filter: JSON.stringify(filter), input: cleanRow(schema, input) });
      // A column refusal is final: nothing was written, so settle must not retry.
      if (answer.kind === 'forbidden' || answer.kind === 'column-refused') return { kind: 'forbidden' };
      if (answer.kind === 'duplicate') return { kind: 'unknown' };
      const { acknowledged, totalImpactedData } = answer.payload;
      return classifyUpdate({
        ...(typeof acknowledged === 'boolean' ? { acknowledged } : {}),
        ...(typeof totalImpactedData === 'number' ? { totalImpactedData } : {}),
      });
    } catch {
      // The settle logic relies on update never rejecting; the caller re-reads to find out what happened.
      return { kind: 'unknown' };
    }
  }

  async hardDelete(schema: SchemaName, itemId: string): Promise<void> {
    const operationName = `delete${schema}`;
    // An empty id would be a filter on nothing.
    if (typeof itemId !== 'string' || itemId === '') throw new Error(`blocks: ${operationName} needs an item id`);
    const answer = await this.send(operationName, `mutation ${operationName}($filter: String, $input: ${schema}DeleteInput!) { ${operationName}(filter: $filter, input: $input) { acknowledged itemId totalImpactedData message } }`, { filter: JSON.stringify({ ItemId: itemId }), input: { isHardDelete: true } });
    if (answer.kind === 'forbidden') throw new BlocksForbiddenError(operationName);
    if (answer.kind === 'duplicate' || answer.kind === 'column-refused') throw new Error(`blocks: ${operationName} GraphQL error`);
    if (answer.payload.acknowledged === true && answer.payload.totalImpactedData === 1) return;
    throw new Error(`blocks: ${operationName} deleted nothing`);
  }
}

/** Keeps only keys that are present; an unknown or system-assigned key (ItemId, CreatedBy, CreatedDate) is a programming error. */
export function cleanRow(schema: SchemaName, row: Record<string, string | number | null | undefined>): Record<string, string | number | null> {
  const known = new Set(FIELDS[schema].map(f => f.name));
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!known.has(key)) throw new Error(`blocks: unknown field '${key}' for ${schema}`);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** ItemId, CreatedBy and CreatedDate are always selected; any requested name must be one of them or a schema field. */
export function listNames(schema: SchemaName, fields?: string[]): string[] {
  const base = ['ItemId', 'CreatedBy', 'CreatedDate'];
  const known = new Set([...base, ...FIELDS[schema].map(f => f.name)]);
  const names = fields ?? FIELDS[schema].map(f => f.name);
  for (const n of names) if (!known.has(n)) throw new Error(`blocks: unknown field '${n}' for ${schema}`);
  return [...new Set([...base, ...names])];
}
