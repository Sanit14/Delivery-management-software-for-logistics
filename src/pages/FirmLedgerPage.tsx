import { useCallback, useEffect, useState, useMemo, Fragment } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Scale, FileText, History, Search, X } from 'lucide-react';
import { db, recordFirmSettlement, recomputeFirmLedger, getRecentChallansForFirm, searchChallansForFirm, logAudit } from '../db/database';
import type { FirmLedger, Challan } from '../db/database';
import { formatINR, todayISO, formatDate } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import LedgerTable from '../components/LedgerTable';
import PinModal from '../components/PinModal';
import { useToast } from '../context/ToastContext';
import { useAdmin } from '../context/AdminContext';

const CATEGORIES = [
  ['adjustment', 'Adjustment'],
  ['settlement', 'Settlement'],
  ['freight', 'Freight (ToPay)'],
  ['delivery_charges', 'Delivery Charges'],
  ['truck_hire', 'Truck Hire'],
  ['pf', 'PF'],
  ['crossing', 'Crossing'],
  ['door_delivery', 'Door Delivery'],
  ['refund', 'Refund'],
] as const;

// Per-memo settlement breakdown derived from the ledger — matches the Firm
// Report waterfall: Freight − DC − Truck Hire − Crossing − Door Delivery − Refund + PF.
interface MemoRow {
  challanNumber: string;
  entryDate: string;
  freight: number;
  deliveryCharges: number;
  truckHire: number;
  pf: number;
  crossing: number;
  doorDelivery: number;
  refund: number;
  net: number;
  adjustments: { amount: number; type: 'debit' | 'credit'; reason: string }[];
}

const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
};

// White pill so these read clearly against the header's solid teal — the
// shared .btn-outline (transparent bg, orange text/border) washes out there.
const headerBtnStyle: React.CSSProperties = { background: '#fff', color: 'var(--orange)', border: 'none', fontWeight: 700 };

export default function FirmLedgerPage() {
  const { firmName: rawName } = useParams();
  const firmName = decodeURIComponent(rawName || '');
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { isAdmin, unlock } = useAdmin();
  const PREVIEW_COUNT = 10;

  const [entries, setEntries] = useState<FirmLedger[]>([]);
  const [showManual, setShowManual] = useState(false);
  const [showSettle, setShowSettle] = useState(false);
  const [settleAmount, setSettleAmount] = useState('');
  const [adminAction, setAdminAction] = useState<(() => void) | null>(null);
  const [showChallanSearch, setShowChallanSearch] = useState(false);

  // manual entry form
  const [mDate, setMDate] = useState(todayISO());
  const [mCategory, setMCategory] = useState<FirmLedger['category']>('adjustment');
  const [mType, setMType] = useState<'debit' | 'credit'>('debit');
  const [mAmount, setMAmount] = useState('');
  const [mDesc, setMDesc] = useState('');

  const requireAdmin = (action: () => void) => {
    if (isAdmin) action();
    else setAdminAction(() => action);
  };

  const load = useCallback(async () => {
    const all = (await db.firmLedger.where('firmName').equals(firmName).toArray())
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || (a.id! - b.id!));
    setEntries(all);
  }, [firmName]);
  useEffect(() => { load(); }, [firmName, load]);

  // Balance: positive = we owe firm ("Pay firm") · negative = firm owes us ("Collect from firm")
  const balance = entries.reduce((b, e) => b + (e.type === 'debit' ? e.amount : -e.amount), 0);
  const status: 'pay' | 'collect' | 'settled' = balance > 0 ? 'pay' : balance < 0 ? 'collect' : 'settled';
  const STATUS_LABEL = { pay: 'Pay firm', collect: 'Collect from firm', settled: 'Settled' } as const;
  const STATUS_COLOR = { pay: '#BA7517', collect: '#3B6D11', settled: 'var(--text-muted)' } as const;

  // Build per-memo settlement breakdown from ledger rows
  const memoRows = useMemo(() => {
    const map = new Map<string, MemoRow>();
    for (const e of entries) {
      if (e.challanId === 0) continue; // skip manual/settlement rows
      const key = e.challanNumber;
      const row = map.get(key) || {
        challanNumber: key, entryDate: e.entryDate, freight: 0, deliveryCharges: 0, truckHire: 0,
        pf: 0, crossing: 0, doorDelivery: 0, refund: 0, net: 0,
        adjustments: [] as { amount: number; type: 'debit' | 'credit'; reason: string }[],
      };
      if (e.category === 'freight') row.freight += e.amount;
      if (e.category === 'delivery_charges') row.deliveryCharges += e.amount;
      if (e.category === 'truck_hire') row.truckHire += e.amount;
      if (e.category === 'pf') row.pf += e.type === 'debit' ? e.amount : -e.amount;
      if (e.category === 'crossing') row.crossing += e.amount;
      if (e.category === 'door_delivery') row.doorDelivery += e.amount;
      if (e.category === 'refund') row.refund += e.amount;
      if (e.category === 'adjustment') row.adjustments.push({ amount: e.amount, type: e.type, reason: e.description });
      map.set(key, row);
    }
    const rows = Array.from(map.values()).map(r => {
      // Adjustments: a debit raises what the firm gets, a credit lowers it.
      const adj = r.adjustments.reduce((s, a) => s + (a.type === 'debit' ? a.amount : -a.amount), 0);
      // Same waterfall as computeFirmSettlement: Freight − DC − Truck Hire − Door Delivery − Crossing + PF − Refund.
      return { ...r, net: r.freight - r.deliveryCharges - r.truckHire - r.doorDelivery - r.crossing + r.pf - r.refund + adj };
    });
    rows.sort((a, b) => Number(b.challanNumber) - Number(a.challanNumber));
    return rows;
  }, [entries]);

  // Trade volume — how much business actually moved through this firm, not
  // just what's currently outstanding. Freight is ToPay-only, same figure the
  // ledger's own freight debit uses.
  const tradeStats = useMemo(() => {
    const totalFreight = entries.filter(e => e.category === 'freight').reduce((s, e) => s + e.amount, 0);
    const trips = memoRows.length;
    return { totalFreight, trips, avgPerTrip: trips > 0 ? totalFreight / trips : 0 };
  }, [entries, memoRows]);

  // Total freight (ToPay) moved per month, for the last 6 months that had any.
  // Entries are already sorted oldest→newest, so accumulating in Map insertion
  // order keeps months chronological with no extra sort.
  const monthlyFreight = useMemo(() => {
    const byMonth = new Map<string, number>();
    for (const e of entries) {
      if (e.category !== 'freight') continue;
      const key = e.entryDate.slice(0, 7);
      byMonth.set(key, (byMonth.get(key) || 0) + e.amount);
    }
    return Array.from(byMonth.entries()).slice(-6);
  }, [entries]);
  const avgFreight = monthlyFreight.length ? monthlyFreight.reduce((s, [, a]) => s + a, 0) / monthlyFreight.length : 0;

  // Full-ledger preview — most recent entries first, capped; the complete,
  // filterable history lives on the Settled Records page.
  const filtered = useMemo(() => [...entries].reverse(), [entries]);


  // Adds the row, then recomputes the firm's whole runningBalance chain, in ONE
  // atomic keeper turn when Electron is present (see electron/keeper/
  // firmLedger.cjs addManualEntrySync). THE FIX: the old code anchored off
  // `entries[entries.length-1]` — react state from a PREVIOUS load, not even
  // sorted by entryDate — and never recomputed, so a race OR a simple backdated
  // entry both produced a wrong running balance. The browser/dev fallback below
  // does the same add-then-recompute (Dexie is single-process, no cross-seat
  // race there, but the backdating fix still matters with a single seat too).
  const addManualEntry = async (type: 'debit' | 'credit', category: FirmLedger['category'], amount: number, description: string, entryDate: string) => {
    let newBalance: number;
    if (typeof window !== 'undefined' && window.sqlAPI?.addManualLedgerEntry) {
      const res = await window.sqlAPI.addManualLedgerEntry(firmName, type, category, amount, description, entryDate);
      newBalance = res.runningBalance;
    } else {
      const id = await db.firmLedger.add({
        firmName, challanId: 0, challanNumber: '—', entryDate, type, category, amount, description,
        runningBalance: 0, createdAt: new Date().toISOString(),
      });
      await recomputeFirmLedger(firmName);
      const row = await db.firmLedger.get(id as number);
      newBalance = row?.runningBalance ?? 0;
    }
    // Track every manual ledger change in History, attributed to this PC.
    logAudit({ action: 'edit', party: firmName, amount: newBalance, detail: `${type === 'debit' ? '+' : '−'}₹${amount} ${category}${description ? ` (${description})` : ''}` });
  };

  const saveManual = async () => {
    const amt = Number(mAmount);
    if (!amt || amt <= 0) { showToast('Amount is required', 'error'); return; }
    await addManualEntry(mType, mCategory, amt, mDesc || CATEGORIES.find(c => c[0] === mCategory)?.[1] || '', mDate);
    showToast('Entry saved', 'success');
    setShowManual(false);
    setMAmount(''); setMDesc('');
    load();
  };

  // Same math as recordFirmSettlementSync (electron/keeper/firmLedger.cjs):
  // balance>=0 → settling is a credit, balance shrinks toward 0; balance<0 →
  // settling is a debit, balance grows toward 0. Mirrored here purely for the
  // live before/after preview — the actual write still goes through that
  // function as the authoritative source.
  const settleAmt = Number(settleAmount) || 0;
  const afterSettleBalance = balance >= 0 ? balance - settleAmt : balance + settleAmt;

  const doSettle = async () => {
    const amt = settleAmount ? Number(settleAmount) : Math.abs(balance);
    if (!amt || amt <= 0) { showToast('Settlement amount is invalid', 'error'); return; }
    await recordFirmSettlement(firmName, amt, balance > 0 ? `Paid to firm ₹${amt}` : `Received from firm ₹${amt}`);
    showToast('Settlement recorded ✓', 'success');
    setShowSettle(false);
    setSettleAmount('');
    load();
  };

  return (
    <div>
      <Link to="/firm-accounts" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', textDecoration: 'none', marginBottom: 12 }}>
        <ArrowLeft size={14} /> All Firms
      </Link>
      <PageHeader
        showBack onRefresh={load}
        title={firmName}
        subtitle={status === 'settled' ? 'Settled ✓' : `${STATUS_LABEL[status]} ${formatINR(Math.abs(balance))}`}
        right={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-sm" style={headerBtnStyle} onClick={() => setShowChallanSearch(true)}>
              <FileText size={14} /> Challan Report
            </button>
            <button className="btn btn-sm" style={headerBtnStyle} onClick={() => requireAdmin(() => setShowManual(true))}>
              <Plus size={14} /> Manual Entry
            </button>
            {status !== 'settled' && (
              <button className="btn btn-primary btn-sm" onClick={() => requireAdmin(() => { setSettleAmount(String(Math.abs(balance))); setShowSettle(true); })}>
                <Scale size={14} /> Record Settlement
              </button>
            )}
          </div>
        }
      />

      {/* Trade volume — how much business, not just what's owed right now */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <div className="stat-card" style={{ padding: '10px 16px', flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--navy)' }}>{formatINR(tradeStats.totalFreight)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Total freight moved</div>
        </div>
        <div className="stat-card" style={{ padding: '10px 16px', flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--navy)' }}>{tradeStats.trips}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Trips (all-time)</div>
        </div>
        <div className="stat-card" style={{ padding: '10px 16px', flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--navy)' }}>{formatINR(Math.round(tradeStats.avgPerTrip))}</div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Avg per trip</div>
        </div>
      </div>

      {/* Total freight moved per month — hand-rolled bars, no charting library
          in this app; dashed line marks the average across the shown months. */}
      {monthlyFreight.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)' }}>Total freight moved / month</div>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ width: 12, height: 0, borderTop: '1.5px dashed var(--text-muted)', display: 'inline-block' }} /> Average {formatINR(Math.round(avgFreight))}
            </span>
          </div>
          <div className="card" style={{ padding: '14px 14px 12px' }}>
            {(() => {
              const maxAmt = Math.max(...monthlyFreight.map(([, a]) => a), 1);
              const avgPct = Math.min(1, avgFreight / maxAmt);
              return (
                <>
                  <div style={{ position: 'relative', height: 84, display: 'flex', alignItems: 'flex-end', gap: 10 }}>
                    <div title={`Average: ${formatINR(Math.round(avgFreight))}`}
                      style={{ position: 'absolute', left: 0, right: 0, bottom: avgPct * 56, borderTop: '1.5px dashed var(--text-muted)' }} />
                    {monthlyFreight.map(([month, amt]) => (
                      <div key={month} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', zIndex: 1 }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--navy)', marginBottom: 4, whiteSpace: 'nowrap' }}>{formatINR(amt)}</div>
                        <div title={`${monthLabel(month)}: ${formatINR(amt)}`}
                          style={{ width: '100%', maxWidth: 34, height: Math.max(4, (amt / maxAmt) * 56), borderRadius: '4px 4px 0 0', background: 'var(--navy)' }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                    {monthlyFreight.map(([month]) => (
                      <div key={month} style={{ flex: 1, textAlign: 'center', fontSize: 10.5, color: 'var(--text-muted)' }}>{monthLabel(month)}</div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Memo-wise settlement — preview only, full history lives on its own page */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)' }}>Memo-wise settlement — last {PREVIEW_COUNT}</div>
      </div>
      {memoRows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 8, opacity: 0.3 }}>📒</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No memo settlements yet</div>
        </div>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto', marginBottom: 20 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Challan</th><th>Date</th>
                <th style={{ textAlign: 'right' }}>Freight (ToPay)</th>
                <th style={{ textAlign: 'right' }}>− Delivery Charges</th>
                <th style={{ textAlign: 'right' }}>− Truck Hire</th>
                <th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {memoRows.slice(0, PREVIEW_COUNT).map(r => (
                <Fragment key={r.challanNumber}>
                  <tr style={{ cursor: 'pointer' }} title="View this challan's ledger report"
                    onClick={() => navigate(`/reports?challanLedger=${encodeURIComponent(r.challanNumber)}`)}>
                    <td className="td-bold">#{r.challanNumber}</td>
                    <td>{formatDate(r.entryDate)}</td>
                    <td style={{ textAlign: 'right' }}>{formatINR(r.freight)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>− {formatINR(r.deliveryCharges)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>− {formatINR(r.truckHire)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.net > 0 ? '#854F0B' : r.net < 0 ? '#3B6D11' : 'var(--text-muted)' }}>
                      {r.net >= 0 ? '' : '−'}{formatINR(Math.abs(r.net))}
                    </td>
                  </tr>
                  {r.adjustments.map((a, i) => (
                    <tr key={`${r.challanNumber}-adj-${i}`} style={{ background: 'var(--border-light)' }}>
                      <td></td>
                      <td colSpan={4} style={{ fontSize: 12, color: 'var(--text-secondary)', paddingLeft: 8 }}>
                        ↳ Adjustment{a.reason ? `: ${a.reason}` : ''}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: a.type === 'debit' ? '#854F0B' : '#3B6D11' }}>
                        {a.type === 'debit' ? '+' : '−'}{formatINR(a.amount)}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Full ledger — preview only */}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)', marginBottom: 8 }}>Full ledger — last {PREVIEW_COUNT}</div>
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 8, opacity: 0.3 }}>📒</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No ledger entries yet</div>
        </div>
      ) : (
        <LedgerTable entries={filtered.slice(0, PREVIEW_COUNT)} />
      )}

      {/* Where the rest of the history lives */}
      <div style={{ display: 'flex', gap: 10, marginTop: 20, marginBottom: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-outline" onClick={() => navigate(`/firm-accounts/${encodeURIComponent(firmName)}/settled`)}>
          <History size={15} /> Settled Records
        </button>
      </div>

      {showChallanSearch && (
        <ChallanSearchPopup firmName={firmName} onClose={() => setShowChallanSearch(false)}
          onPick={(num) => { setShowChallanSearch(false); navigate(`/firm-accounts/${encodeURIComponent(firmName)}/challan/${encodeURIComponent(num)}`); }} />
      )}

      {/* Manual entry modal */}
      {showManual && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowManual(false); }}>
          <div className="confirm-modal" style={{ width: 400 }}>
            <div className="confirm-title">Manual Entry — {firmName}</div>
            <div className="confirm-body">
              <div className="form-group">
                <label className="form-label req">Date</label>
                <input className="form-input" type="date" value={mDate} onChange={e => setMDate(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label req">Category</label>
                <select className="form-select" value={mCategory} onChange={e => setMCategory(e.target.value as FirmLedger['category'])}>
                  {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label req">Type</label>
                <div className="radio-group">
                  <label className={`radio-opt ${mType === 'debit' ? 'selected' : ''}`}>
                    <input type="radio" checked={mType === 'debit'} onChange={() => setMType('debit')} />
                    Pay firm (+)
                  </label>
                  <label className={`radio-opt ${mType === 'credit' ? 'selected' : ''}`}>
                    <input type="radio" checked={mType === 'credit'} onChange={() => setMType('credit')} />
                    Collect from firm (−)
                  </label>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label req">Amount (₹)</label>
                <input className="form-input" type="number" inputMode="numeric" value={mAmount} onChange={e => setMAmount(e.target.value)} placeholder="0" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Description</label>
                <input className="form-input" value={mDesc} onChange={e => setMDesc(e.target.value)} placeholder="Description / note" />
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowManual(false)}>Back</button>
              <button className="btn btn-primary btn-sm" onClick={saveManual}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Settlement modal — before/after preview, not just a bare amount box */}
      {showSettle && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSettle(false); }}>
          <div className="confirm-modal" style={{ width: 400 }}>
            <div className="confirm-title">Record Settlement — {firmName}</div>
            <div className="confirm-body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                <div style={{ flex: 1, textAlign: 'center', background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '10px 8px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Current</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: STATUS_COLOR[status] }}>{formatINR(Math.abs(balance))}</div>
                </div>
                <ArrowLeft size={16} style={{ transform: 'rotate(180deg)', color: 'var(--text-muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, textAlign: 'center', background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '10px 8px' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>After this</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: afterSettleBalance === 0 ? 'var(--text-muted)' : (afterSettleBalance > 0 ? '#BA7517' : '#3B6D11') }}>
                    {afterSettleBalance === 0 ? 'Settled ✓' : formatINR(Math.abs(afterSettleBalance))}
                  </div>
                </div>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label req">{balance >= 0 ? 'Amount paid to firm (₹)' : 'Amount received from firm (₹)'}</label>
                <input className="form-input" type="number" inputMode="numeric" value={settleAmount} onChange={e => setSettleAmount(e.target.value)} />
                <div className="form-hint" style={{ marginTop: 4 }}>Full or partial — enter the cash given/received</div>
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowSettle(false)}>Back</button>
              <button className="btn btn-primary btn-sm" onClick={doSettle}>Record ✓</button>
            </div>
          </div>
        </div>
      )}

      {/* Admin PIN gate */}
      {adminAction && (
        <PinModal title="Admin PIN Required" checkPin={unlock} onSuccess={() => { const a = adminAction; setAdminAction(null); a(); }} onCancel={() => setAdminAction(null)} />
      )}
    </div>
  );
}

/**
 * The Challan-wise Report search popup — this is the ONE search surface for
 * finding a specific challan, whether by number (with live matches as you
 * type) or by picking a recent one directly, or narrowing by date first. Every
 * path here leads to the same destination: FirmChallanReport, that challan's
 * own single-row version of the Firm Report plus its full ledger.
 */
function ChallanSearchPopup({ firmName, onClose, onPick }: { firmName: string; onClose: () => void; onPick: (challanNumber: string) => void }) {
  const [query, setQuery] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [matches, setMatches] = useState<Challan[]>([]);
  const [recent, setRecent] = useState<Challan[]>([]);

  useEffect(() => { getRecentChallansForFirm(firmName, 5).then(setRecent); }, [firmName]);

  useEffect(() => {
    if (!query.trim()) { setMatches([]); return; }
    searchChallansForFirm(firmName, query, 8).then(list => {
      const filtered = list.filter(c => (!dateFrom || c.entryDate >= dateFrom) && (!dateTo || c.entryDate <= dateTo));
      setMatches(filtered);
    });
  }, [firmName, query, dateFrom, dateTo]);

  const filteredRecent = recent.filter(c => (!dateFrom || c.entryDate >= dateFrom) && (!dateTo || c.entryDate <= dateTo));
  const list = query.trim() ? matches : filteredRecent;

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="confirm-modal" style={{ width: 440 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div className="confirm-title" style={{ marginBottom: 0 }}>Challan Report</div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="confirm-body">
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>{firmName} — search a challan number, or pick a recent one below</div>

          <div style={{ position: 'relative', marginBottom: 8 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input className="form-input" style={{ paddingLeft: 32 }} autoFocus
              placeholder="Type a challan number..." value={query} onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && list.length === 1) onPick(list[0].challanNumber); }} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="form-input" type="date" style={{ flex: 1 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
            <input className="form-input" type="date" style={{ flex: 1 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
            {(dateFrom || dateTo) && <button className="btn btn-ghost btn-sm" onClick={() => { setDateFrom(''); setDateTo(''); }}>Reset</button>}
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 6 }}>
            {query.trim() ? `Matches for "${query}"` : 'Last 5 challans'}
          </div>
          {list.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 12.5 }}>No challans found.</div>
          ) : (
            <div style={{ border: '0.5px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {list.map((c, i) => (
                <div key={c.id} onClick={() => onPick(c.challanNumber)}
                  style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, display: 'flex', justifyContent: 'space-between', borderTop: i === 0 ? undefined : '0.5px solid var(--border)' }}>
                  <span><b>#{c.challanNumber}</b> · {c.truckNumber || 'no truck'}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{formatDate(c.entryDate)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
