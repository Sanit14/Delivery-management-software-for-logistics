/**
 * sqlShim — a Dexie-compatible facade over SqlEngine.
 *
 * Goal: existing call sites like
 *    db.challans.where('status').equals('open').toArray()
 *    db.masterData.where({ field, value }).first()
 *    db.drs.where('challanId').anyOf(ids).filter(fn).toArray()
 *    db.operators.orderBy('id').reverse().toArray()
 *    db.challans.add(obj) / .put(obj) / .update(id, changes) / .delete(id) / .get(id) / .count()
 * keep working unchanged, but route to SqlEngine instead of Dexie.
 *
 * All query methods return Promises (like Dexie) so `await` keeps working.
 *
 * The engine is injected (so the same shim works whether the engine runs in-process
 * for dev/web or behind IPC in Electron — see sqlClient for the IPC variant).
 *
 * TableShim/Collection/WhereClause are generic (defaulting to the loose `Row`)
 * so a caller — see src/db/database.ts's `db` export — can view each table's
 * shim as `TableShim<Challan>`, `TableShim<LREntry>`, etc. via a type-only cast,
 * the same way the old `db as DeliveryDB` cast gave every call site real
 * per-table types from Dexie. The runtime object is identical either way; only
 * the compile-time view changes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Row = Record<string, any> & { id?: number };

// The minimal engine surface the shim needs. Both the in-process SqlEngine and the
// IPC-backed client implement this (the IPC one returns Promises; we normalize below).
export interface EngineLike {
  all(table: string): Row[] | Promise<Row[]>;
  get(table: string, key: any): Row | undefined | Promise<Row | undefined>;
  add(table: string, obj: Row): any | Promise<any>;
  put(table: string, obj: Row): any | Promise<any>;
  update(table: string, key: any, changes: Row): number | Promise<number>;
  delete(table: string, key: any): void | Promise<void>;
  bulkAdd(table: string, objs: Row[]): void | Promise<void>;
  bulkPut(table: string, objs: Row[]): void | Promise<void>;
  clear(table: string): void | Promise<void>;
  vacuum(): void | Promise<void>;
  query(table: string, opts: any): Row[] | Promise<Row[]>;
}

type Predicate = (r: Row) => boolean;

// A chainable collection — accumulates query options, executes on a terminal call.
class Collection<T extends Row = Row> {
  private engine: EngineLike;
  private table: string;
  private opts: any = {};
  constructor(engine: EngineLike, table: string, init: any = {}) {
    this.engine = engine;
    this.table = table;
    this.opts = { ...init };
  }
  // .where('col') then .equals/.anyOf  — or .where({obj})
  equals(val: any) { this.opts.equals = val; return this; }
  anyOf(vals: any[]) { this.opts.anyOf = vals; return this; }
  filter(fn: (r: T) => boolean) {
    const next = fn as unknown as Predicate;
    const prev = this.opts.predicate as Predicate | undefined;
    this.opts.predicate = prev ? (r: Row) => prev(r) && next(r) : next;
    return this;
  }
  reverse() { this.opts.reverse = !this.opts.reverse; return this; }
  limit(n: number) { this.opts.limit = n; return this; }
  async sortBy(key: string): Promise<T[]> {
    const rows = await Promise.resolve(this.engine.query(this.table, { ...this.opts })) as T[];
    rows.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
    if (this.opts.reverse) rows.reverse();
    return rows;
  }
  async toArray(): Promise<T[]> { return Promise.resolve(this.engine.query(this.table, { ...this.opts })) as Promise<T[]>; }
  async first(): Promise<T | undefined> {
    const rows = await Promise.resolve(this.engine.query(this.table, { ...this.opts, limit: 1 })) as T[];
    return rows[0];
  }
  async count(): Promise<number> {
    const rows = await Promise.resolve(this.engine.query(this.table, { ...this.opts }));
    return rows.length;
  }
  async modify(changer: (r: T) => void) {
    const rows = await Promise.resolve(this.engine.query(this.table, { ...this.opts })) as T[];
    for (const r of rows) {
      const key = r.id != null ? r.id : (r as any).key;
      const copy = { ...r };
      changer(copy);
      await Promise.resolve(this.engine.update(this.table, key, copy));
    }
  }
  async delete(): Promise<number> {
    const rows = await Promise.resolve(this.engine.query(this.table, { ...this.opts }));
    // Fire all deletes concurrently rather than awaiting one IPC round trip at a
    // time — a 90-day purge over 1000+ rows was otherwise 1000 sequential trips.
    await Promise.all(rows.map(r => Promise.resolve(this.engine.delete(this.table, r.id != null ? r.id : (r as any).key))));
    return rows.length;
  }
}

// A WhereClause — what .where('col') returns before .equals/.anyOf/.below
class WhereClause<T extends Row = Row> {
  private engine: EngineLike;
  private table: string;
  private col: string;
  constructor(engine: EngineLike, table: string, col: string) {
    this.engine = engine;
    this.table = table;
    this.col = col;
  }
  equals(val: any): Collection<T> { return new Collection<T>(this.engine, this.table, { whereCol: this.col, equals: val }); }
  anyOf(vals: any[]): Collection<T> { return new Collection<T>(this.engine, this.table, { whereCol: this.col, anyOf: vals }); }
  // No server-side "below" support in the engine's query() — filter client-side,
  // same as any other .filter() predicate (see sqlClient.ts query()).
  below(val: any): Collection<T> { return new Collection<T>(this.engine, this.table, {}).filter(r => (r as any)[this.col] < val); }
}

class TableShim<T extends Row = Row> {
  private engine: EngineLike;
  private table: string;
  constructor(engine: EngineLike, table: string) {
    this.engine = engine;
    this.table = table;
  }

  where(col: string): WhereClause<T>;
  where(obj: Record<string, any>): Collection<T>;
  where(arg: string | Record<string, any>): WhereClause<T> | Collection<T> {
    if (typeof arg === 'string') return new WhereClause<T>(this.engine, this.table, arg);
    return new Collection<T>(this.engine, this.table, { whereObj: arg });
  }
  orderBy(col: string): Collection<T> { return new Collection<T>(this.engine, this.table, { orderBy: col }); }
  toCollection(): Collection<T> { return new Collection<T>(this.engine, this.table, {}); }
  filter(fn: (r: T) => boolean): Collection<T> { return new Collection<T>(this.engine, this.table, { predicate: fn as unknown as Predicate }); }

  async toArray(): Promise<T[]> { return Promise.resolve(this.engine.query(this.table, {})) as Promise<T[]>; }
  async get(key: any): Promise<T | undefined> { return Promise.resolve(this.engine.get(this.table, key)) as Promise<T | undefined>; }
  async add(obj: T): Promise<number> { return Promise.resolve(this.engine.add(this.table, obj)); }
  async put(obj: T): Promise<number> { return Promise.resolve(this.engine.put(this.table, obj)); }
  async update(key: any, changes: Partial<T>): Promise<number> { return Promise.resolve(this.engine.update(this.table, key, changes as Row)); }
  async delete(key: any): Promise<void> { return Promise.resolve(this.engine.delete(this.table, key)); }
  async bulkAdd(objs: T[]): Promise<void> { return Promise.resolve(this.engine.bulkAdd(this.table, objs)); }
  async bulkPut(objs: T[]): Promise<void> { return Promise.resolve(this.engine.bulkPut(this.table, objs)); }
  async clear(): Promise<void> { return Promise.resolve(this.engine.clear(this.table)); }
  async count(): Promise<number> { const rows = await Promise.resolve(this.engine.query(this.table, {})); return rows.length; }
}

// The db facade — one TableShim per table, matching the Dexie `db` shape.
export interface ShimDB {
  challans: TableShim;
  lrEntries: TableShim;
  drs: TableShim;
  wasuli: TableShim;
  firmLedger: TableShim;
  operators: TableShim;
  masterData: TableShim;
  settings: TableShim;
  drafts: TableShim;
  auditLog: TableShim;
}

export function makeShim(engine: EngineLike): ShimDB {
  return {
    challans: new TableShim(engine, 'challans'),
    lrEntries: new TableShim(engine, 'lrEntries'),
    drs: new TableShim(engine, 'drs'),
    wasuli: new TableShim(engine, 'wasuli'),
    firmLedger: new TableShim(engine, 'firmLedger'),
    operators: new TableShim(engine, 'operators'),
    masterData: new TableShim(engine, 'masterData'),
    settings: new TableShim(engine, 'settings'),
    drafts: new TableShim(engine, 'drafts'),
    auditLog: new TableShim(engine, 'auditLog'),
  };
}

export { Collection, WhereClause, TableShim };
