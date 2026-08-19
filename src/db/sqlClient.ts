/**
 * sqlClient — implements the EngineLike interface (same as SqlEngine) but routes every
 * operation to the Electron main process over IPC (window.sqlAPI from preload).
 *
 * Key detail (Approach B1): a .filter() predicate is a JS function and can't cross IPC.
 * So query() sends only the serializable parts (whereCol/equals/anyOf/whereObj/orderBy/
 * reverse/limit) to main, gets candidate rows back, then applies the predicate HERE in
 * the renderer. At our data volume this is fast and keeps all 200+ call sites working.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { EngineLike, Row } from './sqlShim';
export type { Row };

/** Confirm-before-replace summary shown before a restore/import proceeds: what
 *  the incoming backup contains vs. what's currently live, so the operator can
 *  tell at a glance whether it's the right file. `total` covers ALL business
 *  tables (drives the "this backup is EMPTY" warning), not just the four shown. */
export interface RestoreSummary {
  challans: number;
  memos: number;
  drs: number;
  firms: number;
  newestDate: string;
  total: number;
}
/** Result of a restore/import call. Without `force`, a structurally-valid file
 *  resolves to `needsConfirm:true` with both summaries instead of restoring —
 *  the caller re-invokes with force:true after the operator confirms. */
export type RestoreOutcome =
  | { ok: true; error?: string }
  | { ok: false; error: string; needsConfirm?: false }
  | { ok: false; needsConfirm: true; incoming: RestoreSummary; live: RestoreSummary };

/** `true` confirms a normal restore. An incoming backup with ZERO business rows
 *  needs the distinct `'CONFIRM_EMPTY'` signal instead — plain `true` is refused
 *  by the keeper in that case (see engine.cjs restoreFromBytes), so blanking the
 *  live database can never happen from the same click/muscle-memory as a normal
 *  restore. */
export type RestoreForce = boolean | 'CONFIRM_EMPTY';

/** Result of a cascadeDeleteChallan call. Without a matching `confirm` token, a
 *  challan with locked wasuli resolves to `needsConfirm` instead of deleting
 *  anything — the caller shows that tier's dialog and re-invokes with the token
 *  once the operator confirms (see electron/keeper/engine.cjs
 *  cascadeDeleteChallanSync for the authoritative gate). */
export type CascadeDeleteChallanResult =
  | { ok: true; error?: string }
  | { ok: false; error: string; needsConfirm?: undefined }
  | { ok: false; needsConfirm: 'assigned'; counts: { assigned: number } }
  | { ok: false; needsConfirm: 'collected'; counts: { collected: number; collectedAmount: number } };

interface SqlAPI {
  all(table: string): Promise<Row[]>;
  get(table: string, key: any): Promise<Row | undefined>;
  query(table: string, opts: any): Promise<Row[]>;
  add(table: string, obj: Row): Promise<any>;
  put(table: string, obj: Row): Promise<any>;
  update(table: string, key: any, changes: Row): Promise<number>;
  delete(table: string, key: any): Promise<void>;
  bulkAdd(table: string, objs: Row[]): Promise<void>;
  bulkPut(table: string, objs: Row[]): Promise<void>;
  clear(table: string): Promise<void>;
  vacuum(): Promise<void>;
  getDbFileSize?(): Promise<number>;
  // Data-folder tools (the Settings "change data folder" card + migration flow,
  // wired in preload/main from the NComputing folder fix). Declared here so the
  // SqlAPI type matches what preload exposes; optional because the browser/dev
  // build has no sqlAPI at all.
  getDataRoot?(): Promise<string>;
  // Result shape is defined by the migration tool (root-change flow); typed loose
  // on purpose so this declaration never fights the calling code.
  changeDataRoot?(): Promise<any>;
  nextNumber(table: string, field: string, prefix?: string): Promise<number>;
  addWithNumber(table: string, obj: Row, field: string, prefix?: string, scope?: { field: string; value: unknown }): Promise<{ id: number;[key: string]: unknown }>;
  getGeneration?(): Promise<number>;
  exportDb(): Promise<number[]>;
  importDb(bytes: number[], force?: RestoreForce): Promise<RestoreOutcome>;
  /** Atomic find-or-create-with-code for master-data values (firm/station/plain
   *  fields), executed in one keeper turn so two seats learning the same new
   *  value at once can't create duplicate rows or duplicate codes — same
   *  primitive class as addWithNumber for BS/DR numbers. */
  learnMasterData?(pairs: { field: string; value: string }[]): Promise<boolean>;
  /** Atomic find-or-REFUSE for a manually-added coded entity (firm/station) —
   *  the Master Data admin "Add" form's counterpart to learnMasterData. Same
   *  field-scoped code sequence, but returns null instead of bumping useCount
   *  when the name already exists, and forwards optional `details`. */
  addCodedMasterData?(field: string, value: string, details?: string): Promise<{ id: number; code: number } | null>;
  /** Every write below runs keeper-side in ONE atomic turn (add the row, then
   *  recompute the firm's whole runningBalance chain) — see
   *  electron/keeper/firmLedger.cjs. This is what closes the read-then-write
   *  race a second seat's write could otherwise land inside of. */
  /** The ONE place freight + delivery charge are computed and turned into firm
   *  ledger rows (see electron/keeper/firmLedger.cjs createLedgerEntriesSync) —
   *  the memo-save path calls it internally; this is for the other two
   *  callers (challan restore, DR-charges edit) that only have a challanId. */
  createLedgerEntriesForChallan?(challanId: number): Promise<void>;
  recordFirmSettlement?(firmName: string, amount: number, note: string): Promise<void>;
  saveChallanAdjustments?(
    challanNumber: string, firmName: string,
    adjustments: { label: string; amount: number; sign: 1 | -1 }[],
  ): Promise<{ challanId: number; oldTotal: number; newTotal: number }>;
  addManualLedgerEntry?(
    firmName: string, type: 'debit' | 'credit', category: string,
    amount: number, description: string, entryDate: string,
  ): Promise<{ id: number; runningBalance: number }>;
  recomputeFirmLedger?(firmName: string): Promise<void>;
  /** Challan-lifecycle cascades — each one atomic keeper turn, gated server-side
   *  by a wasuli-lock check (see electron/keeper/engine.cjs). {ok:false,error}
   *  means the gate blocked it (or, for updateDRCharges/deleteEntryCascade,
   *  lockedByAgent/staleConflict) and NO changes were made. */
  /** confirm is required to proceed past the assigned/collected wasuli gate —
   *  see CascadeDeleteChallanResult below and electron/keeper/engine.cjs
   *  cascadeDeleteChallanSync. Omitted (or wrong tier) on a locked challan
   *  returns needsConfirm instead of deleting anything. */
  cascadeDeleteChallan?(challanId: number, confirm?: 'CONFIRM_ASSIGNED' | 'CONFIRM_COLLECTED'): Promise<CascadeDeleteChallanResult>;
  cascadeCancelChallan?(challanId: number): Promise<{ ok: boolean; error?: string }>;
  cascadeReopenChallan?(challanId: number): Promise<{ ok: boolean; error?: string }>;
  restoreChallanCascade?(challanId: number): Promise<{ ok: boolean; error?: string }>;
  deleteEntryCascade?(entryId: number): Promise<{ ok: boolean; lockedByAgent: boolean; error?: string }>;
  updateDRCharges?(
    drId: number,
    charges: { freight: number; cartage: number; hamali: number; godownBhada: number; godownInsurance: number; deliveryCharges: number; pf: number },
    seenTotal?: number,
  ): Promise<{ ok: boolean; lockedByAgent: boolean; staleConflict: boolean; drNumber?: string; consignee?: string; total?: number; changesSummary?: string }>;
  getBackupFolder(): Promise<string>;
  getBackupInterval(): Promise<number>;
  setBackupInterval(days: number): Promise<boolean>;
  getExportFolder?(kind: 'pdf' | 'csv'): Promise<string>;
  saveExport?(kind: 'pdf' | 'csv', fileName: string, content: string): Promise<string | null>;
  backupNow(): Promise<{ ok: boolean; path: string; written?: string[]; failed?: string[] }>;
  listBackups(): Promise<{ file: string; path: string; kind: string; size: number; mtime: number; locations?: string[] }[]>;
  /** Optional extra backup folders (pendrive, second drive). Empty by default —
   *  no drive letter is assumed; the customer chooses paths at their site. */
  getExtraTargets?(): Promise<string[]>;
  setExtraTargets?(list: string[]): Promise<boolean>;
  pickExtraTarget?(): Promise<{ canceled: boolean; folder: string }>;
  /** Backup freshness for the dashboard badge: last-backup time + per-target status. */
  backupHealth?(): Promise<{
    lastBackupMs: number;
    intervalDays: number;
    targets: { dir: string; exists: boolean; newestMs: number }[];
  }>;
  /** Blank-DB guard state. active=true means the db opened empty but previously
   *  had data — the app should show the safe-mode restore screen. */
  safeMode?(): Promise<{
    active: boolean;
    reason?: string;
    opened?: { total: number; counts: Record<string, number> };
    lastGood?: { total: number; counts: Record<string, number>; at: string; root: string } | null;
  }>;
  recordCounts?(): Promise<{ total: number; counts: Record<string, number> }>;
  markDataCleared?(): Promise<boolean>;
  saveMemo?(challanId: number, seat: string): Promise<{ ok: boolean; reason?: string; totalToPay?: number; totalPaid?: number; totalEntries?: number }>;
  auditEvent?(event: string, detail?: unknown): Promise<boolean>;
  getSecondAuditDir?(): Promise<string>;
  pickSecondAuditDir?(): Promise<{ canceled: boolean; folder: string }>;
  pickRestoreFile(): Promise<{ canceled: boolean; path: string }>;
  restoreBackup(filePath: string, force?: RestoreForce): Promise<RestoreOutcome>;
  /** Master-data merge. mergeImpact is read-only (per-table row counts for the
   *  confirm popup). mergeMaster rewrites references + folds the master row, then
   *  all seats reload via onDbChanged. field 'operator' uses ids; others use strings. */
  mergeImpact?(field: string, from: string | number): Promise<Record<string, number>>;
  mergeMaster?(field: string, from: string | number, to: string | number): Promise<Record<string, number>>;
  /** Challan duplicate merge. challanMergeCheck is read-only (confirm popup data).
   *  mergeChallansDup re-parents lrEntries, renumbers srNo, and removes the loser
   *  challan row inside one atomic keeper turn. Both seats reload via onDbChanged. */
  challanMergeCheck?(keepId: number, removeId: number): Promise<{
    ok: boolean;
    reason?: string;
    primaryCount?: number;
    primarySrMin?: number | null;
    primarySrMax?: number;
    secondaryCount?: number;
    secondaryDrCount?: number;
    secondaryPendingWasuli?: number;
    secondaryAssignedWasuli?: number;
    total?: number;
    resultSrMin?: number | null;
    resultSrMax?: number | null;
    isContiguous?: boolean;
    keepCount?: number;
    keepSrMin?: number | null;
    keepSrMax?: number;
    removeCount?: number;
  }>;
  mergeChallansDup?(keepId: number, removeId: number, seat: string): Promise<{ ok: boolean; reason?: string; moved?: number; backupPath?: string }>;
  /** Subscribe to "database changed for everyone" events (fired after a restore/import
   *  on any seat). Returns an unsubscribe function. Present only in Electron. */
  onDbChanged?(cb: () => void): () => void;
  /** This seat's name (per-seat, e.g. "PC-01"), used to stamp the audit log. */
  getSeatName?(): Promise<string>;
  setSeatName?(name: string): Promise<{ ok: boolean; error: string }>;
}

declare global {
  interface Window { sqlAPI?: SqlAPI; }
}

export function isElectronSql(): boolean {
  return typeof window !== 'undefined' && !!window.sqlAPI;
}

export class SqlClient implements EngineLike {
  private api: SqlAPI;
  constructor() {
    if (!window.sqlAPI) throw new Error('sqlAPI not available — not running in Electron');
    this.api = window.sqlAPI;
  }

  all(table: string) { return this.api.all(table); }
  get(table: string, key: any) { return this.api.get(table, key); }
  add(table: string, obj: Row) { return this.api.add(table, obj); }
  put(table: string, obj: Row) { return this.api.put(table, obj); }
  update(table: string, key: any, changes: Row) { return this.api.update(table, key, changes); }
  delete(table: string, key: any) { return this.api.delete(table, key); }
  bulkAdd(table: string, objs: Row[]) { return this.api.bulkAdd(table, objs); }
  bulkPut(table: string, objs: Row[]) { return this.api.bulkPut(table, objs); }
  clear(table: string) { return this.api.clear(table); }
  vacuum() { return this.api.vacuum(); }

  async query(table: string, opts: any): Promise<Row[]> {
    // split serializable opts from the JS predicate
    const { predicate, ...serializable } = opts || {};
    // ask main for candidate rows WITHOUT limit (so the predicate runs on the full set first)
    const serverOpts = { ...serializable };
    const wantLimit = serverOpts.limit;
    if (predicate) delete serverOpts.limit; // limit after filtering locally
    let rows = await this.api.query(table, serverOpts);
    if (predicate) {
      rows = rows.filter(predicate);
      if (wantLimit != null) rows = rows.slice(0, wantLimit);
    }
    return rows;
  }

  // helpers exposed for atomic counters and backup
  nextNumber(table: string, field: string, prefix?: string) { return this.api.nextNumber(table, field, prefix); }
  exportDb() { return this.api.exportDb(); }
  importDb(bytes: number[], force?: RestoreForce) { return this.api.importDb(bytes, force); }

  /**
   * Atomically assigns the next sequential number for `field` in `table`,
   * inserts the row with that number, and returns { id, [field]: numberValue }.
   *
   * This is ONE call to the keeper, which computes the number and inserts the row
   * as a single indivisible operation (inside the keeper's write queue). No other
   * write — including another addWithNumber, from any seat — can land in between,
   * so two seats can never be assigned the same number.
   */
  async addWithNumber(
    table: string,
    obj: Record<string, unknown>,
    field: string,
    prefix?: string,
    scope?: { field: string; value: unknown },
  ): Promise<{ id: number;[key: string]: unknown }> {
    return this.api.addWithNumber(table, obj as Row, field, prefix, scope) as Promise<{ id: number;[key: string]: unknown }>;
  }
}
