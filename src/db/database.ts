import { isElectronSql, SqlClient } from './sqlClient';
import type { CascadeDeleteChallanResult } from './sqlClient';
import { makeShim, TableShim, type Row } from './sqlShim';

export interface Challan {
  id?: number;
  challanNumber: string;
  firmName: string;
  entryDate: string;
  loadingDate: string;
  loadingStation: string;
  truckNumber: string;
  truckHire: number;
  deliveryCharges: number;
  deliveryChargesType: 'fixed' | 'percent';
  status: 'open' | 'saved' | 'cancelled';
  totalToPay: number;
  totalPaid: number;
  totalEntries: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  createdSeat: string;   // seat that created this memo
  savedSeat?: string;    // seat that clicked Save Memo (unset until saved)
}

export interface LREntry {
  id?: number;
  challanId: number;
  challanNumber: string;
  srNo: number;
  consignor: string;
  consignee: string;
  fromStation: string;
  lrNumber: string;
  pmNumber: string;
  bookingDate: string;
  particulars: string;
  quantity: number;
  toPay: number;
  paid: number;
  // 'topay': consignee owes freight (+ charges) at delivery. 'paid': freight was
  // settled already — but charges (hamali/g.bhada/GDN/delivery) can still be owed
  // separately, and those still get collected. 'charges': no freight recorded at
  // all, only charges are due. 'none': nothing owed on this entry at all.
  paymentMode: 'topay' | 'paid' | 'charges' | 'none';
  crossing: number;
  doorDelivery: number;
  pf: number;
  refund: number;
  cartage: number;
  cartageOption: 'option1' | 'option2' | 'blank';
  godownBhada: number;
  deliveryCharges: number;
  otherCharges: number;
  hamali: number;
  total: number;
  status: 'active' | 'cancelled';
  createdAt: string;
  deletedAt?: string;
  seat: string;          // seat that added this entry
}

export interface DR {
  id?: number;
  lrEntryId: number;
  challanId: number;
  challanNumber: string;
  drNumber: string;
  firmName: string;
  consignor: string;
  consignee: string;
  fromStation: string;
  truckNumber?: string;
  lrNumber: string;
  particulars: string;
  quantity: number;
  bookingDate: string;
  deliveryDate: string;
  freight: number;
  cartage: number;
  hamali: number;
  godownBhada: number;
  godownInsurance: number;
  deliveryCharges: number;
  pf: number;   // collected from the consignee, same as freight — not a charges-rule field
  otherCharges: number;
  total: number;
  status: 'pending' | 'printed' | 'delivered' | 'cancelled';
  printedAt?: string;
  deletedAt?: string;
}

export interface Wasuli {
  id?: number;
  lrEntryId: number;
  challanId: number;
  drId: number;
  operatorId: number;
  consigneeName: string;
  amountToCollect: number;
  assignedDate: string;
  status: 'pending' | 'collected' | 'cancelled';
  collectedDate?: string;
  collectedAmount?: number;
  notes: string;
  deletedAt?: string;
}

export interface FirmLedger {
  id?: number;
  firmName: string;
  challanId: number;
  challanNumber: string;
  entryDate: string;
  type: 'debit' | 'credit';
  category: 'freight' | 'delivery_charges' | 'truck_hire' | 'pf' | 'adjustment' | 'settlement';
  amount: number;
  description: string;
  runningBalance: number;
  createdAt: string;
}

export interface Operator {
  id?: number;
  name: string;
  phone: string;
  active: boolean;
  code?: number;   // sequential operator code
}

export interface MasterData {
  id?: number;
  field: string;
  value: string;
  useCount: number;
  code?: number;        // sequential per-type code (firm/station/operator). Undefined = not code-eligible.
  details?: string;     // optional JSON of extra fields (phone, address, etc.) added via Master Data page
}

export interface Setting {
  key: string;
  value: string;
}

// One audit-log entry: a tracked action (wasuli movement or a deletion), with the
// seat that did it and when. Powers the History page and the worker-facing trail.
export interface AuditEntry {
  id?: number;
  action: 'assign' | 'reassign' | 'remove' | 'undo' | 'collect' | 'delete' | 'edit' | 'add' | 'create' | 'save';
  at: string;            // ISO timestamp
  seat: string;          // seat name, e.g. "PC-01" ('' if unknown)
  drNumber?: string;     // BS number, when relevant
  party?: string;        // consignee/firm, for readability
  amount?: number;       // amount involved (for 'edit', the NEW total/final)
  fromAgent?: string;    // for reassign/remove: agent it left
  toAgent?: string;      // for assign/reassign: agent it went to
  detail?: string;       // freeform extra: for 'edit', a "field ₹old→₹new" summary
}

const isElectron = isElectronSql();
export const sqlClient = isElectron ? new SqlClient() : null;

// sqlShim.ts exists specifically to replace Dexie, and Electron (with its
// preload-exposed window.sqlAPI) is now the only way this app runs — the old
// Dexie-backed browser/dev fallback was unreachable in the shipped app.
//
// TableShim is generic (see sqlShim.ts) so this cast gives every call site the
// same real per-table typing Dexie's `Table<Challan>` etc. used to — just
// without depending on Dexie. The runtime object is identical either way.
interface TypedDB {
  challans: TableShim<Challan>;
  lrEntries: TableShim<LREntry>;
  drs: TableShim<DR>;
  wasuli: TableShim<Wasuli>;
  firmLedger: TableShim<FirmLedger>;
  operators: TableShim<Operator>;
  masterData: TableShim<MasterData>;
  settings: TableShim<Setting>;
  drafts: TableShim<Row>;
  auditLog: TableShim<AuditEntry>;
}
export const db = makeShim(sqlClient!) as unknown as TypedDB;

export const CLEAR = null as unknown as undefined; // null survives IPC; engine treats it as "clear field"

// ── Audit log ─────────────────────────────────────────────────────────────────
// Records a tracked action (wasuli movement or deletion) with this seat's name and
// a timestamp. Seat name is fetched once and cached. Never throws — a logging
// failure must not block the real action. 90-day retention is trimmed lazily.
let _seatName: string | null = null;
export async function seatName(): Promise<string> {
  if (_seatName !== null) return _seatName;
  try { _seatName = (await window.sqlAPI?.getSeatName?.()) || ''; }
  catch { _seatName = ''; }
  return _seatName;
}

export async function logAudit(entry: Omit<AuditEntry, 'id' | 'at' | 'seat'>): Promise<void> {
  try {
    const seat = await seatName();
    await db.auditLog.add({ ...entry, at: new Date().toISOString(), seat });
  } catch (e) {
    // Logging must never break the action — but a silent failure here is
    // exactly how the audit log went empty without anyone noticing.
    console.error('[audit] write failed:', e, entry);
  }
}

// Returns audit entries (newest first), optionally filtered. Trims entries older
// than 90 days as a side effect so the log stays lean.
// Builds a per-DR reassign trail from the audit log: for each DR that has been
// reassigned, the ordered chain of agents it passed through, e.g. ["Suresh","Navaz"].
// Returns a map keyed by drNumber. Only includes DRs with at least one reassign.
export async function getReassignTrails(): Promise<Record<string, string[]>> {
  const rows = (await db.auditLog.toArray())
    .filter(e => e.action === 'reassign' && e.drNumber)
    .sort((a, b) => (a.at < b.at ? -1 : 1)); // oldest first
  const trails: Record<string, string[]> = {};
  for (const e of rows) {
    const dr = e.drNumber!;
    if (!trails[dr]) trails[dr] = e.fromAgent ? [e.fromAgent] : [];
    if (e.toAgent) trails[dr].push(e.toAgent);
  }
  return trails;
}

export async function getAuditLog(opts: { action?: AuditEntry['action']; fromISO?: string; toISO?: string } = {}): Promise<AuditEntry[]> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const all = await db.auditLog.toArray();
  // lazy 90-day trim (non-blocking bulk delete)
  db.auditLog.where('at').below(cutoff).delete().catch(() => {});
  let rows = all.filter(e => e.at >= cutoff);
  if (opts.action) rows = rows.filter(e => e.action === opts.action);
  if (opts.fromISO) rows = rows.filter(e => e.at.slice(0, 10) >= opts.fromISO!);
  if (opts.toISO) rows = rows.filter(e => e.at.slice(0, 10) <= opts.toISO!);
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// CartageRule type — exported so Settings and ChallanDetail can share it
export interface CartageRule {
  godownBhada: number;
  godownInsurance: number;
  deliveryCharges: number;
  hamaliPerDag: number;   // ₹ per dag (quantity unit) — multiplied by entry quantity
  hamaliFlat: number;     // flat ₹ added regardless of quantity (0 if not used)
  hamaliMode: 'perDag' | 'flat' | 'none';
}

const DEFAULT_CARTAGE_RULES: Record<'option1' | 'option2' | 'blank', CartageRule> = {
  option1: { godownBhada: 5, godownInsurance: 5, deliveryCharges: 2, hamaliPerDag: 10, hamaliFlat: 0, hamaliMode: 'perDag' },
  option2: { godownBhada: 2, godownInsurance: 3, deliveryCharges: 3, hamaliPerDag: 0, hamaliFlat: 0, hamaliMode: 'none' },
  blank: { godownBhada: 0, godownInsurance: 0, deliveryCharges: 0, hamaliPerDag: 0, hamaliFlat: 0, hamaliMode: 'none' },
};

export async function getCartageRules(): Promise<Record<'option1' | 'option2' | 'blank', CartageRule>> {
  const keys = ['cartageRule_option1', 'cartageRule_option2', 'cartageRule_blank'];
  const rows = await Promise.all(keys.map(k => db.settings.get(k)));
  const parse = (row: Setting | undefined, def: CartageRule): CartageRule => {
    if (!row?.value) return def;
    try { return { ...def, ...JSON.parse(row.value) }; } catch { return def; }
  };
  return {
    option1: parse(rows[0], DEFAULT_CARTAGE_RULES.option1),
    option2: parse(rows[1], DEFAULT_CARTAGE_RULES.option2),
    blank: parse(rows[2], DEFAULT_CARTAGE_RULES.blank),
  };
}

export async function saveCartageRule(option: 'option1' | 'option2' | 'blank', rule: CartageRule) {
  await db.settings.put({ key: `cartageRule_${option}`, value: JSON.stringify(rule) });
}

// One-time backfill: existing DRs created before truckNumber was added have no
// truck number. Fill it in from each DR's parent challan. Runs once (guarded by a
// settings flag), only sets the field where it's missing, touches nothing else.
export async function backfillDRTruckNumbers() {
  const done = await db.settings.get('drTruckBackfillDone');
  if (done?.value === 'true') return;
  try {
    const challans = await db.challans.toArray();
    const byId = new Map(challans.map(c => [c.id!, c.truckNumber]));
    const drs = await db.drs.toArray();
    for (const d of drs) {
      if (!d.truckNumber && d.id != null) {
        const truck = byId.get(d.challanId);
        if (truck) await db.drs.update(d.id, { truckNumber: truck });
      }
    }
    await db.settings.put({ key: 'drTruckBackfillDone', value: 'true' });
  } catch (e) {
    console.error('[backfill] DR truck numbers failed:', e);
  }
}

export async function seedDefaults() {
  const existing = await db.settings.get('adminPin');
  if (!existing) {
    await db.settings.bulkPut([
      { key: 'adminPin', value: '1234' },
      { key: 'companyName', value: 'Sundeep Freight Movers' },
      { key: 'companyLocation', value: 'Yavatmal' },
      { key: 'drCounter', value: '1' },
      { key: 'walkthroughDone', value: 'false' },
      { key: 'cartageRule_option1', value: JSON.stringify(DEFAULT_CARTAGE_RULES.option1) },
      { key: 'cartageRule_option2', value: JSON.stringify(DEFAULT_CARTAGE_RULES.option2) },
      { key: 'cartageRule_blank', value: JSON.stringify(DEFAULT_CARTAGE_RULES.blank) },
    ]);
  } else {
    // Seed cartage rules if they don't exist yet (upgrade path for existing installs)
    for (const [key, rule] of Object.entries({
      cartageRule_option1: DEFAULT_CARTAGE_RULES.option1,
      cartageRule_option2: DEFAULT_CARTAGE_RULES.option2,
      cartageRule_blank: DEFAULT_CARTAGE_RULES.blank,
    })) {
      const exists = await db.settings.get(key);
      if (!exists) await db.settings.put({ key, value: JSON.stringify(rule) });
    }
  }
}

/**
 * The BS-number year prefix, e.g. "26-" during 2026. Switches automatically on
 * January 1 (it is simply derived from today's date, so no scheduled reset is
 * needed — the first DR generated in the new year naturally starts a fresh
 * "27-000001" series because nextNumber only counts rows within this prefix).
 * Workers never type this; it is stamped automatically and appears on prints.
 */
export const bsYearPrefix = () => `${String(new Date().getFullYear()).slice(2)}-`;

/**
 * Classifies an entry's payment mode from its own amounts — automatic, the
 * worker never picks this. 'topay' if ToPay is filled, else 'paid' if Paid is
 * filled, else 'charges' if there's a total from charges alone (no freight
 * typed at all), else 'none'. One memo can freely mix all four across entries.
 */
export function classifyPaymentMode(toPay: number, paid: number, total: number): 'topay' | 'paid' | 'charges' | 'none' {
  if (toPay > 0) return 'topay';
  if (paid > 0) return 'paid';
  if (total > 0) return 'charges';
  return 'none';
}

/**
 * The amount still owed by the consignee at delivery, for wasuli. The entry's
 * `total` is already the collectible amount: for ToPay it's freight + charges;
 * for Paid it's charges only (the paid freight was excluded at entry time, since
 * it was settled at origin and is never collected from the customer); for
 * charges-only it's the charges; for none it's 0. So collectible == total.
 */
export function collectibleAmount(entry: Pick<LREntry, 'total'>): number {
  return Math.max(0, entry.total);
}

/**
 * Freight shown ON THE DR (the customer's receipt). Freight is only owed by the
 * customer for a ToPay entry. For a Paid entry the freight was already paid at
 * origin, so it must NOT appear on the DR (only our charges-rules amounts do).
 * For charges-only / none there is no freight either. So: ToPay → toPay, else 0.
 */
export function drFreight(entry: Pick<LREntry, 'toPay'>): number {
  return entry.toPay > 0 ? entry.toPay : 0;
}

// Settlement model (per firm):
//   balance = Σ[ (ToPay + Paid)  −  Delivery Charges  −  Truck Hire ]
//   balance > 0  → WE OWE THE FIRM (firm's money sitting with us)
//   balance < 0  → FIRM OWES US   (their expenses + our commission exceeded freight)
// Ledger sign convention: type 'debit' adds to balance, 'credit' subtracts.
/**
 * Freight + DC are computed in exactly ONE place — electron/keeper/firmLedger.cjs
 * createLedgerEntriesSync — reached over one atomic keeper turn.
 */
export async function createLedgerEntries(challanId: number) {
  if (typeof window !== 'undefined' && window.sqlAPI?.createLedgerEntriesForChallan) {
    await window.sqlAPI.createLedgerEntriesForChallan(challanId);
    return;
  }
}

// Record a settlement when cash actually changes hands — zeroes the balance toward 0.
// amount is the cash moved; direction inferred from current balance.
/**
 * Firm-report charge adjustments (Item 7), editable model.
 *
 * Adjustments for a challan are stored as `category: 'adjustment'` ledger rows,
 * ALWAYS keyed by the real challanId so the report (screen + print), Firm
 * Accounts, the ledger, and History all read the exact same rows.
 *
 * Editing is REPLACE-ALL, not append: saving deletes this challan's existing
 * adjustment rows and writes the current set. So changing a charge from ₹100
 * to ₹150 results in one ₹150 row, not ₹100 + ₹150. Removing a line removes
 * its row. After any change we recompute the firm's running balance so Firm
 * Accounts and the ledger stay correct.
 *
 * PF is NOT an adjustment — it's entry-level (Σ lrEntries.pf), and the only
 * writer of its derived `category: 'pf'` row is createLedgerEntries.
 */
export interface ChallanAdjustment { label: string; amount: number; sign: 1 | -1 }

export async function getChallanAdjustments(challanId: number): Promise<ChallanAdjustment[]> {
  const rows = await db.firmLedger.where('challanId').equals(challanId).filter(r => r.category === 'adjustment').toArray();
  return rows.map(r => ({ label: r.description, amount: r.amount, sign: (r.type === 'debit' ? 1 : -1) as 1 | -1 }));
}

/**
 * Replace-all + recompute, in ONE atomic keeper turn (see electron/keeper/
 * firmLedger.cjs saveChallanAdjustmentsSync) — closes the read-then-write race
 * a second seat's write could otherwise land inside of. logAudit stays here,
 * renderer-side, same as saveMemo/mergeMaster's convention.
 */
export async function saveChallanAdjustments(challanNumber: string, firmName: string, adjustments: ChallanAdjustment[]) {
  const logIfChanged = (oldTotal: number, newTotal: number) => {
    if (oldTotal === newTotal) return;
    const summary = adjustments.filter(a => a.amount).map(a => `${a.sign > 0 ? '+' : '−'}${a.label || 'adj'} ₹${a.amount}`).join(', ') || 'cleared';
    logAudit({ action: 'edit', drNumber: `#${challanNumber}`, party: firmName, amount: newTotal, detail: `Adjustments: ${summary}` });
  };

  if (typeof window !== 'undefined' && window.sqlAPI?.saveChallanAdjustments) {
    const { oldTotal, newTotal } = await window.sqlAPI.saveChallanAdjustments(challanNumber, firmName, adjustments);
    logIfChanged(oldTotal, newTotal);
    return;
  }
}

/**
 * Add the settlement row, then recompute — ONE atomic keeper turn (see
 * electron/keeper/firmLedger.cjs recordFirmSettlementSync).
 */
export async function recordFirmSettlement(firmName: string, amount: number, note: string) {
  if (typeof window !== 'undefined' && window.sqlAPI?.recordFirmSettlement) {
    await window.sqlAPI.recordFirmSettlement(firmName, amount, note);
    return;
  }
}

/**
 * Rebuilds a firm's whole runningBalance chain from its rows, chronologically
 * — the self-healing primitive every function above ends with. Routes through
 * ONE atomic keeper turn (see electron/keeper/firmLedger.cjs
 * recomputeFirmLedgerSync).
 */
export async function recomputeFirmLedger(firmName: string) {
  if (typeof window !== 'undefined' && window.sqlAPI?.recomputeFirmLedger) {
    await window.sqlAPI.recomputeFirmLedger(firmName);
    return;
  }
}

/**
 * Six challan-lifecycle cascades — delete/restore/cancel/reopen a challan, edit
 * a saved DR's charges, delete a single entry. Each used to be a renderer-
 * orchestrated sequence of N separate keeper round trips (one per row) with no
 * shared transaction and an inconsistently-applied wasuli lock. Now each is ONE
 * keeper turn (electron/keeper/engine.cjs) — gate check first (no changes made
 * if it trips), then everything else in a single db.transaction(). These
 * renderer functions are thin calls to those keeper routes; the sequential
 * loops that used to live here are gone.
 */
// Unlike the other five cascades, delete does NOT collapse {ok:false} into a
// thrown error — a locked challan resolves to {ok:false, needsConfirm, counts}
// so the caller (see src/utils/deleteChallanFlow.ts) can show the matching
// tier's dialog and re-invoke with the confirm token. A transport/IPC failure
// still throws, same as the other cascades.
export async function cascadeDeleteChallan(challanId: number, confirm?: 'CONFIRM_ASSIGNED' | 'CONFIRM_COLLECTED'): Promise<CascadeDeleteChallanResult> {
  if (typeof window !== 'undefined' && window.sqlAPI?.cascadeDeleteChallan) {
    return window.sqlAPI.cascadeDeleteChallan(challanId, confirm);
  }
  return { ok: false, error: 'Delete not available outside the app' };
}

export async function restoreChallanCascade(challanId: number): Promise<void> {
  if (typeof window !== 'undefined' && window.sqlAPI?.restoreChallanCascade) {
    const res = await window.sqlAPI.restoreChallanCascade(challanId);
    if (!res.ok) throw new Error(res.error || 'Restore failed');
  }
}

export async function cascadeCancelChallan(challanId: number): Promise<void> {
  if (typeof window !== 'undefined' && window.sqlAPI?.cascadeCancelChallan) {
    const res = await window.sqlAPI.cascadeCancelChallan(challanId);
    if (!res.ok) throw new Error(res.error || 'Cancel failed');
  }
}

export async function cascadeReopenChallan(challanId: number): Promise<void> {
  if (typeof window !== 'undefined' && window.sqlAPI?.cascadeReopenChallan) {
    const res = await window.sqlAPI.cascadeReopenChallan(challanId);
    if (!res.ok) throw new Error(res.error || 'Reopen failed');
  }
}

/**
 * Whether a DR's charges are locked against editing, and the wasuli row that
 * decides it (or null if there isn't one). Locked once the linked wasuli is
 * assigned to an agent or collected — per the business rule, amounts are
 * frozen the moment collection starts. updateDRCharges enforces this same
 * condition server-side; this export is for UI that needs to know ahead of
 * time (DREditModal) without re-deriving it.
 */
export async function getDRWasuliLock(drId: number): Promise<{ locked: boolean; wasuli: Wasuli | null }> {
  const w = (await db.wasuli.filter(x => x.drId === drId && !x.deletedAt).toArray())[0] || null;
  return { locked: !!w && (w.status !== 'pending' || w.operatorId !== 0), wasuli: w };
}

export async function syncChallanTotals(challanId: number): Promise<void> {
  const snapEnts = await db.lrEntries
    .where('challanId').equals(challanId)
    .filter(e => e.status === 'active' && !e.deletedAt)
    .toArray();
  const newTP = snapEnts.filter(e => e.paymentMode === 'topay').reduce((s, e) => s + e.toPay, 0);
  const newP  = snapEnts.filter(e => e.paymentMode === 'paid').reduce((s, e) => s + e.paid, 0);
  await db.challans.update(challanId, { totalToPay: newTP, totalPaid: newP });
}

/**
 * Edit a saved DR's charges AFTER the memo is saved — updates the DR, the
 * underlying entry, the linked wasuli, and rebuilds the firm ledger, all in
 * ONE keeper transaction (electron/keeper/engine.cjs updateDRChargesSync),
 * gated server-side by the same wasuli-lock rule as getDRWasuliLock and by a
 * stale-conflict check (seenTotal: the DR total this seat saw when it opened
 * the record — refused if another seat has since changed it).
 * logAudit stays here (renderer-attributed action, same convention as
 * saveChallanAdjustments/mergeMaster) using the summary the keeper returns.
 */
export async function updateDRCharges(
  drId: number,
  charges: { freight: number; cartage: number; hamali: number; godownBhada: number; godownInsurance: number; deliveryCharges: number; pf: number; },
  seenTotal?: number
): Promise<{ ok: boolean; lockedByAgent: boolean; staleConflict: boolean }> {
  if (typeof window !== 'undefined' && window.sqlAPI?.updateDRCharges) {
    const res = await window.sqlAPI.updateDRCharges(drId, charges, seenTotal);
    if (res.ok && res.changesSummary) {
      logAudit({ action: 'edit', drNumber: res.drNumber, party: res.consignee, amount: res.total, detail: res.changesSummary });
    }
    return { ok: res.ok, lockedByAgent: res.lockedByAgent, staleConflict: res.staleConflict };
  }
  return { ok: false, lockedByAgent: false, staleConflict: false };
}

/**
 * Deletes an LR entry, and — if it already has a DR (only possible when
 * editing during a reopened memo, since normal entry is before any DR exists)
 * — cancels that DR and its wasuli too, so nothing is left orphaned. Refuses
 * server-side if collection on it has already started (assigned to an agent
 * or collected), same protection principle as editing a DR's charges: work
 * already in progress is never silently discarded.
 */
export async function deleteEntryCascade(entryId: number): Promise<{ ok: boolean; lockedByAgent: boolean }> {
  if (typeof window !== 'undefined' && window.sqlAPI?.deleteEntryCascade) {
    const res = await window.sqlAPI.deleteEntryCascade(entryId);
    return { ok: res.ok, lockedByAgent: res.lockedByAgent };
  }
  return { ok: false, lockedByAgent: false };
}

/**
 * One challan's row, built with the EXACT same math the multi-challan Firm
 * Report uses — this is what makes the single-challan "Challan-wise Report"
 * genuinely the same report, just scoped to one, rather than a different
 * calculation that could quietly drift out of sync with the real one over time.
 */
interface ChallanSummaryRow {
  date: string; challanNumber: string; truckNumber: string; loadingDate: string; loadingStation: string;
  toPay: number; paid: number; deliveryCharges: number; crossing: number; doorDelivery: number;
  truckHire: number; pf: number; refund: number;
  dcAmount: number; // this challan's OWN commission (₹), from its own rate/type — never a shared batch rate
}

export async function buildChallanSummaryRow(challan: Challan): Promise<ChallanSummaryRow> {
  const ents = await db.lrEntries.where('challanId').equals(challan.id!).filter(e => e.status === 'active' && !e.deletedAt).toArray();
  const sum = (f: (e: LREntry) => number) => ents.reduce((s, e) => s + f(e), 0);
  const toPay = sum(e => e.toPay), paid = sum(e => e.paid);
  // Kept to 2 decimal places (paisa) — same formula as createLedgerEntries so the
  // Firm Report screen and the Firm Accounts ledger always agree on the DC amount.
  const dcAmount = challan.deliveryChargesType === 'percent'
    ? Math.round(Math.round((toPay + paid) * 100) * (challan.deliveryCharges || 0) / 100) / 100
    : (challan.deliveryCharges || 0) * ents.length;
  return {
    date: challan.entryDate, challanNumber: challan.challanNumber, truckNumber: challan.truckNumber,
    loadingDate: challan.loadingDate, loadingStation: challan.loadingStation,
    toPay, paid, deliveryCharges: sum(e => e.deliveryCharges),
    crossing: sum(e => e.crossing), doorDelivery: sum(e => e.doorDelivery),
    truckHire: challan.truckHire || 0, pf: sum(e => e.pf), refund: sum(e => e.refund), dcAmount,
  };
}

/** Recent challans for one firm — for the "last 5" list in the challan-search popup. */
export async function getRecentChallansForFirm(firmName: string, limit = 5): Promise<Challan[]> {
  const all = await db.challans.filter(c => !c.deletedAt && c.status !== 'cancelled' && c.firmName === firmName).toArray();
  return all.sort((a, b) => b.entryDate.localeCompare(a.entryDate) || (b.id || 0) - (a.id || 0)).slice(0, limit);
}

/** Live typeahead matches for the same popup, as the user types a challan number. */
export async function searchChallansForFirm(firmName: string, query: string, limit = 8): Promise<Challan[]> {
  const q = query.trim();
  if (!q) return [];
  const all = await db.challans.filter(c => !c.deletedAt && c.status !== 'cancelled' && c.firmName === firmName && c.challanNumber.includes(q)).toArray();
  return all.sort((a, b) => b.entryDate.localeCompare(a.entryDate)).slice(0, limit);
}
