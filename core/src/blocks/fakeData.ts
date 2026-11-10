import { BlocksForbiddenError, cleanRow, listNames, type BlocksData, type Filter, type Row } from './data.js';
import { ACCESS, FIELDS, UNIQUE, type Operation, type SchemaName } from './schema.js';
import type { WriteOutcome } from './update.js';

type Role = 'factory-owner' | 'factory-core' | 'any';

/** Tables and id counter that several fakes (one per role) can share, as one Blocks project is shared. Test-only. */
export interface FakeStorage { tables: Map<SchemaName, Row[]>; counter: number }
export const newFakeStorage = (): FakeStorage => ({ tables: new Map(), counter: 0 });

/** In-memory BlocksData for tests. Role 'any' skips access checks (used by the shared store contract suite). */
export class FakeBlocksData implements BlocksData {
  private readonly storage: FakeStorage;
  private readonly extra = new Set<string>();
  private readonly revoked = new Set<string>();
  /** Pending lost replies: true for any table, or the one table named. */
  private failNext: Record<'insert' | 'update', SchemaName | boolean> = { insert: false, update: false };

  private readonly now: () => Date;

  private readonly columnRules: Partial<Record<SchemaName, string[]>>;

  private readonly storeNullUpdates: boolean;

  /**
   * `now` stamps CreatedDate (default: real time). `columnRules` is test-only: fields of a table that this fake's role
   * may not change; an update that changes one is refused as a whole (answer `forbidden`, nothing written), as a Blocks
   * column write rule does. A value sent back unchanged does not count.
   * As the live gateway does (seen 2026-11-10), an update that sets a field to null is acknowledged but leaves the
   * stored value unchanged; `storeNullUpdates: true` stores the null instead (a gateway that would clear).
   */
  constructor(
    private readonly role: Role,
    opts: { now?: () => Date; storage?: FakeStorage; columnRules?: Partial<Record<SchemaName, string[]>>; storeNullUpdates?: boolean } = {},
  ) {
    this.columnRules = opts.columnRules ?? {};
    this.storeNullUpdates = opts.storeNullUpdates ?? false;
    this.storage = opts.storage ?? newFakeStorage();
    this.now = opts.now ?? (() => new Date());
  }

  /** Test setup: lets this role do `op` on `schema` although the access matrix says no (proves a gate can fail). */
  grant(schema: SchemaName, op: Operation): void { this.extra.add(`${schema}:${op}`); }

  /** Test setup: takes `op` on `schema` away from this role although the access matrix gives it (proves a gate can fail). */
  revoke(schema: SchemaName, op: Operation): void { this.revoked.add(`${schema}:${op}`); }

  /** The next `op` (on `schema`, if given) is done, but its reply is lost: insert throws, update answers unknown. */
  failNextReply(op: 'insert' | 'update', schema?: SchemaName): void { this.failNext[op] = schema ?? true; }

  private takeFail(op: 'insert' | 'update', schema: SchemaName): boolean {
    const f = this.failNext[op];
    if (f !== true && f !== schema) return false;
    this.failNext[op] = false;
    return true;
  }

  /** Test setup: stores a row as given (system keys allowed), with no access or unique checks. */
  seed(schema: SchemaName, row: Row): void {
    const stored: Row = Object.fromEntries(FIELDS[schema].map(f => [f.name, null]));
    Object.assign(stored, { ItemId: `I-${++this.storage.counter}`, CreatedDate: this.now().toISOString(), CreatedBy: 'seed' }, row);
    this.table(schema).push(stored);
  }

  rows(schema: SchemaName): Row[] { return (this.storage.tables.get(schema) ?? []).map(r => ({ ...r })); }

  private allowed(schema: SchemaName, op: Operation): boolean {
    if (this.revoked.has(`${schema}:${op}`)) return false;
    return this.role === 'any' || this.extra.has(`${schema}:${op}`) || (ACCESS[schema][op] ?? []).includes(this.role);
  }
  private table(schema: SchemaName): Row[] {
    let t = this.storage.tables.get(schema);
    if (!t) this.storage.tables.set(schema, (t = []));
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
      ItemId: `I-${++this.storage.counter}`,
      CreatedDate: this.now().toISOString(),
      CreatedBy: this.role === 'factory-core' ? '' : this.role === 'factory-owner' ? 'owner-user' : 'any',
    });
    table.push(stored);
    if (this.takeFail('insert', schema)) {
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
    const refused = this.columnRules[schema] ?? [];
    if (Object.entries(clean).some(([k, v]) => refused.includes(k) && hits[0]![k] !== v)) return { kind: 'forbidden' };
    Object.assign(hits[0]!, this.storeNullUpdates ? clean : Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null)));
    if (this.takeFail('update', schema)) {
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
