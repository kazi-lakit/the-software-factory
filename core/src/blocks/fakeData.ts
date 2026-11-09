import { BlocksForbiddenError, cleanRow, listNames, type BlocksData, type Filter, type Row } from './data.js';
import { ACCESS, FIELDS, UNIQUE, type Operation, type SchemaName } from './schema.js';
import type { WriteOutcome } from './update.js';

type Role = 'factory-owner' | 'factory-core' | 'any';

/** In-memory BlocksData for tests. Role 'any' skips access checks (used by the shared store contract suite). */
export class FakeBlocksData implements BlocksData {
  private readonly tables = new Map<SchemaName, Row[]>();
  private counter = 0;
  private failNext: { insert: boolean; update: boolean } = { insert: false, update: false };

  private readonly now: () => Date;

  /** `now` stamps CreatedDate (default: real time). */
  constructor(private readonly role: Role, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  failNextReply(op: 'insert' | 'update'): void { this.failNext[op] = true; }

  /** Test setup: stores a row as given (system keys allowed), with no access or unique checks. */
  seed(schema: SchemaName, row: Row): void {
    const stored: Row = Object.fromEntries(FIELDS[schema].map(f => [f.name, null]));
    Object.assign(stored, { ItemId: `I-${++this.counter}`, CreatedDate: this.now().toISOString(), CreatedBy: 'seed' }, row);
    this.table(schema).push(stored);
  }

  rows(schema: SchemaName): Row[] { return (this.tables.get(schema) ?? []).map(r => ({ ...r })); }

  private allowed(schema: SchemaName, op: Operation): boolean {
    return this.role === 'any' || (ACCESS[schema][op] ?? []).includes(this.role);
  }
  private table(schema: SchemaName): Row[] {
    let t = this.tables.get(schema);
    if (!t) this.tables.set(schema, (t = []));
    return t;
  }
  private static matches(row: Row, filter: Filter): boolean {
    return Object.entries(filter).every(([k, v]) => row[k] === v);
  }

  async list(schema: SchemaName, filter: Filter, fields?: string[]): Promise<Row[]> {
    if (!this.allowed(schema, 'read')) throw new BlocksForbiddenError(`get${schema}s`);
    const names = listNames(schema, fields);
    return this.table(schema).filter(r => FakeBlocksData.matches(r, filter)).map(r => Object.fromEntries(names.map(n => [n, r[n] ?? null])));
  }

  async insert(schema: SchemaName, row: Record<string, string | number | null>) {
    if (!this.allowed(schema, 'insert')) return { kind: 'forbidden' as const };
    const input = cleanRow(schema, row);
    const table = this.table(schema);
    for (const field of UNIQUE[schema]) {
      if (field in input && table.some(r => r[field] === input[field])) return { kind: 'duplicate' as const };
    }
    const stored: Row = Object.fromEntries(FIELDS[schema].map(f => [f.name, null]));
    Object.assign(stored, input, {
      ItemId: `I-${++this.counter}`,
      CreatedDate: this.now().toISOString(),
      CreatedBy: this.role === 'factory-core' ? '' : this.role === 'factory-owner' ? 'owner-user' : 'any',
    });
    table.push(stored);
    if (this.failNext.insert) {
      this.failNext.insert = false;
      throw new Error('fake: insert reply lost');
    }
    return { kind: 'inserted' as const, itemId: stored.ItemId as string };
  }

  async update(schema: SchemaName, filter: Filter, input: Record<string, string | number | null>): Promise<WriteOutcome | { kind: 'forbidden' }> {
    if (!this.allowed(schema, 'edit')) return { kind: 'forbidden' };
    const clean = cleanRow(schema, input);
    const hits = this.table(schema).filter(r => FakeBlocksData.matches(r, filter));
    if (hits.length > 1) throw new Error(`fake: update on ${schema} matched ${hits.length} rows`);
    if (hits.length === 0) return { kind: 'not-applied' };
    Object.assign(hits[0]!, clean);
    if (this.failNext.update) {
      this.failNext.update = false;
      return { kind: 'unknown' };
    }
    return { kind: 'applied' };
  }

  async hardDelete(schema: SchemaName, itemId: string): Promise<void> {
    if (!this.allowed(schema, 'delete')) throw new BlocksForbiddenError(`delete${schema}`);
    const table = this.table(schema);
    const at = table.findIndex(r => r.ItemId === itemId);
    if (at < 0) throw new Error(`fake: delete on ${schema} deleted nothing`);
    table.splice(at, 1);
  }
}
