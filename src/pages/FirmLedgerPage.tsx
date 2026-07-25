import { useCallback, useEffect, useState, useMemo, Fragment } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Plus, Scale, TrendingUp, TrendingDown, CheckCircle2, FileText, History, Search, X } from 'lucide-react';
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
  ['freight', 'Freight (ToPay+Paid)'],
  ['delivery_charges', 'Delivery Charges'],
  ['truck_hire', 'Truck Hire'],
] as const;

// Per-memo settlement breakdown derived from the ledger
interface MemoRow {
  challanNumber: string;
  entryDate: string;
  freight: number;
  deliveryCharges: number;
  truckHire: number;
  net: number;
  adjustments: { amount: number; type: 'debit' | 'credit'; reason: string }[];
}

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

  // Balance: positive = WE OWE firm · negative = FIRM OWES us
  const balance = entries.reduce((b, e) => b + (e.type === 'debit' ? e.amount : -e.amount), 0);

  // Build per-memo settlement breakdown from ledger rows
  const memoRows = useMemo(() => {
    const map = new Map<string, MemoRow>();
    for (const e of entries) {
      if (e.challanId === 0) continue; // skip manual/settlement rows
      const key = e.challanNumber;
      const row = map.get(key) || { challanNumber: key, entryDate: e.entryDate, freight: 0, deliveryCharges: 0, truckHire: 0, net: 0, adjustments: [] as { amount: number; type: 'debit' | 'credit'; reason: string }[] };
      if (e.category === 'freight') row.freight += e.amount;
      if (e.category === 'delivery_charges') row.deliveryCharges += e.amount;
      if (e.category === 'truck_hire') row.truckHire += e.amount;
      if (e.category === 'adjustment') row.adjustments.push({ amount: e.amount, type: e.type, reason: e.description });
      map.set(key, row);
    }
    const rows = Array.from(map.values()).map(r => {
      // Adjustments: a debit raises what the firm gets, a credit lowers it.
      const adj = r.adjustments.reduce((s, a) => s + (a.type === 'debit' ? a.amount : -a.amount), 0);
      return { ...r, net: r.freight - r.deliveryCharges - r.truckHire + adj };
    });
    rows.sort((a, b) => Number(b.challanNumber) - Number(a.challanNumber));
    return rows;
  }, [entries]);

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

  const doSettle = async () => {
    const amt = settleAmount ? Number(settleAmount) : Math.abs(balance);
    if (!amt || amt <= 0) { showToast('Settlement amount is invalid', 'error'); return; }
    await recordFirmSettlement(firmName, amt, balance > 0 ? `Paid to firm ₹${amt}` : `Received from firm ₹${amt}`);
    showToast('Settlement recorded ✓', 'success');
    setShowSettle(false);
    setSettleAmount('');
    load();
  };

  // Big settlement summary card
  // Rendered inline (not a nested component) to avoid remount-on-render
  const renderSettlementCard = () => {
    const owe = balance > 0;
    const settled = balance === 0;
    return (
      <div style={{
        background: settled ? 'var(--border-light)' : owe ? 'linear-gradient(135deg, #FAEEDA, #fff)' : 'linear-gradient(135deg, #EAF3DE, #fff)',
        border: `1px solid ${settled ? 'var(--border)' : owe ? '#BA751740' : '#3B6D1140'}`,
        borderRadius: 'var(--r-xl)', padding: '20px 24px', marginBottom: 18,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: settled ? 'var(--text-muted)' : owe ? '#BA7517' : '#639922', color: '#fff', flexShrink: 0,
          }}>
            {settled ? <CheckCircle2 size={24} /> : owe ? <TrendingUp size={24} /> : <TrendingDown size={24} />}
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {settled ? 'Account Status' : owe ? 'You owe the firm' : 'The firm owes you'}
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: settled ? 'var(--text-muted)' : owe ? '#854F0B' : '#3B6D11', lineHeight: 1.1 }}>
              {settled ? 'Settled ✓' : formatINR(Math.abs(balance))}
            </div>
            {!settled && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                {owe ? `You owe ${firmName}` : `${firmName} owes you`}
              </div>
            )}
          </div>
        </div>
        {!settled && (
          <button className="btn btn-primary" onClick={() => requireAdmin(() => { setSettleAmount(String(Math.abs(balance))); setShowSettle(true); })}>
            <Scale size={16} /> Record Settlement
          </button>
        )}
      </div>
    );
  };

  return (
    <div>
      <Link to="/firm-accounts" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', textDecoration: 'none', marginBottom: 12 }}>
        <ArrowLeft size={14} /> All Firms
      </Link>
      <PageHeader
        showBack onRefresh={load}
        title={firmName}
        subtitle="Firm settlement — (ToPay+Paid) − Delivery Charges − Truck Hire"
        right={
          <button className="btn btn-outline btn-sm" onClick={() => requireAdmin(() => setShowManual(true))}>
            <Plus size={14} /> Manual Entry
          </button>
        }
      />

      {renderSettlementCard()}

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
                <th style={{ textAlign: 'right' }}>Freight (ToPay+Paid)</th>
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
        <button className="btn btn-outline" onClick={() => setShowChallanSearch(true)}>
          <FileText size={15} /> Challan-wise Report
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
                    We pay the firm (+)
                  </label>
                  <label className={`radio-opt ${mType === 'credit' ? 'selected' : ''}`}>
                    <input type="radio" checked={mType === 'credit'} onChange={() => setMType('credit')} />
                    Firm pays us (−)
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

      {/* Settlement modal */}
      {showSettle && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSettle(false); }}>
          <div className="confirm-modal" style={{ width: 400 }}>
            <div className="confirm-title">Record Settlement — {firmName}</div>
            <div className="confirm-body">
              <div style={{ background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '12px 14px', marginBottom: 14, fontSize: 13 }}>
                Current balance: <b>{formatINR(Math.abs(balance))}</b> {balance > 0 ? '(you owe the firm)' : '(the firm owes you)'}
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label req">Settlement Amount (₹)</label>
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
          <div className="confirm-title" style={{ marginBottom: 0 }}>Challan-wise Report</div>
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
