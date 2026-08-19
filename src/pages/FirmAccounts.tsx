import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Trash2 } from 'lucide-react';
import { db } from '../db/database';
import { formatINR, todayISO, daysDiff } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import AutoCompleteInput from '../components/AutoCompleteInput';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { learnValues } from '../utils/masterData';

interface FirmSummary {
  firmName: string;
  balance: number;
  entryCount: number;
  lastEntryDate: string;
}

type StatusFilter = 'all' | 'pay' | 'collect' | 'settled';

// balance > 0 → we owe the firm ("Pay firm"); balance < 0 → the firm owes us
// ("Collect from firm"); 0 → Settled. Matches the ledger convention documented
// in database.ts and FirmLedgerPage.tsx.
const statusOf = (balance: number): Exclude<StatusFilter, 'all'> => balance > 0 ? 'pay' : balance < 0 ? 'collect' : 'settled';
const STATUS_LABEL: Record<Exclude<StatusFilter, 'all'>, string> = { pay: 'Pay firm', collect: 'Collect from firm', settled: 'Settled' };
const STATUS_COLOR: Record<Exclude<StatusFilter, 'all'>, string> = { pay: 'var(--warning)', collect: 'var(--success)', settled: 'var(--text-muted)' };

export default function FirmAccounts() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [firms, setFirms] = useState<FirmSummary[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [openingAmt, setOpeningAmt] = useState('');
  const [openingType, setOpeningType] = useState<'debit' | 'credit'>('debit');
  const [removeTarget, setRemoveTarget] = useState<FirmSummary | null>(null);

  const load = async () => {
    const all = await db.firmLedger.toArray();
    const firmsMap = new Map<string, { firmName: string; balance: number; entryCount: number; lastEntryDate: string; lastId: number }>();
    for (const e of all) {
      const f = firmsMap.get(e.firmName) || { firmName: e.firmName, balance: 0, entryCount: 0, lastEntryDate: '', lastId: 0 };
      f.entryCount++;
      const isLatest = !f.lastEntryDate ||
        e.entryDate.localeCompare(f.lastEntryDate) > 0 ||
        (e.entryDate === f.lastEntryDate && (e.id || 0) > f.lastId);
      if (isLatest) {
        f.balance = e.runningBalance || 0;
        f.lastEntryDate = e.entryDate;
        f.lastId = e.id || 0;
      }
      firmsMap.set(e.firmName, f);
    }
    const list = Array.from(firmsMap.values()).map(f => ({
      firmName: f.firmName,
      balance: f.balance,
      entryCount: f.entryCount,
      lastEntryDate: f.lastEntryDate,
    }));
    list.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    setFirms(list);
  };
  useEffect(() => { load(); }, []);

  const addFirm = async () => {
    const name = newName.trim();
    if (!name) { showToast('Firm name is required', 'error'); return; }
    if (firms.some(f => f.firmName.toLowerCase() === name.toLowerCase())) {
      showToast('This firm already exists', 'error');
      return;
    }
    const amt = Number(openingAmt) || 0;
    await db.firmLedger.add({
      firmName: name,
      challanId: 0,
      challanNumber: '—',
      entryDate: todayISO(),
      type: openingType,
      category: 'adjustment',
      amount: amt,
      description: amt > 0 ? 'Opening balance' : 'Firm account opened',
      runningBalance: openingType === 'debit' ? amt : -amt,
      createdAt: new Date().toISOString(),
    });
    await learnValues([{ field: 'firmName', value: name }]);
    showToast(`${name} added`, 'success');
    setShowAdd(false);
    setNewName(''); setOpeningAmt(''); setOpeningType('debit');
    load();
  };

  const removeFirm = async () => {
    if (!removeTarget) return;
    await db.firmLedger.where('firmName').equals(removeTarget.firmName).delete();
    showToast(`${removeTarget.firmName}'s account deleted`, 'info');
    setRemoveTarget(null);
    load();
  };

  const filtered = firms
    .filter(f => f.firmName.toLowerCase().includes(search.toLowerCase()))
    .filter(f => filter === 'all' || statusOf(f.balance) === filter);

  const lastActivityLabel = (dateStr: string) => {
    if (!dateStr) return '—';
    const d = daysDiff(dateStr);
    return d <= 0 ? 'Today' : `${d}d ago`;
  };

  const FILTERS: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All firms' },
    { id: 'pay', label: 'Pay firm' },
    { id: 'collect', label: 'Collect from firm' },
    { id: 'settled', label: 'Settled' },
  ];

  return (
    <div>
      <PageHeader
        showBack onRefresh={load}
        title="Firm Accounts"
        subtitle="Each firm's account — balance and settlement status"
        right={<button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add Firm</button>}
      />

      <div style={{ position: 'relative', maxWidth: 360, marginBottom: 14 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Search firms..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <span key={f.id} onClick={() => setFilter(f.id)} style={{
            fontSize: 12, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
            border: '0.5px solid ' + (filter === f.id ? 'var(--orange)' : 'var(--border)'),
            background: filter === f.id ? 'var(--orange)' : 'var(--card)',
            color: filter === f.id ? '#fff' : 'var(--text-secondary)', fontWeight: filter === f.id ? 600 : 500,
          }}>
            {f.label}
          </span>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>🏦</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{firms.length === 0 ? 'No firm accounts yet' : 'No firms match'}</div>
          {firms.length === 0 ? (
            <>
              <div style={{ fontSize: 13, marginBottom: 16 }}>The firm ledger is created when a memo is saved — or add one manually above</div>
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add Firm</button>
            </>
          ) : (
            <div style={{ fontSize: 13 }}>Try a different search or filter</div>
          )}
        </div>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Firm</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Last activity</th>
                <th style={{ width: 44 }}></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(f => {
                const status = statusOf(f.balance);
                return (
                  <tr key={f.firmName} style={{ cursor: 'pointer' }} onClick={() => navigate(`/firm-accounts/${encodeURIComponent(f.firmName)}`)}>
                    <td className="td-bold">{f.firmName}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: STATUS_COLOR[status] }}>
                      {status === 'settled' ? '—' : formatINR(Math.abs(f.balance))}
                    </td>
                    <td style={{ color: STATUS_COLOR[status] }}>{STATUS_LABEL[status]}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{lastActivityLabel(f.lastEntryDate)}</td>
                    <td>
                      <button
                        title="Delete firm"
                        className="btn-icon btn-icon-delete"
                        onClick={e => { e.stopPropagation(); setRemoveTarget(f); }}
                      >
                        <Trash2 />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add firm modal */}
      {showAdd && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowAdd(false); }}>
          <div className="confirm-modal" style={{ width: 400 }}>
            <div className="confirm-title">Add new firm</div>
            <div className="confirm-body">
              <div className="form-group">
                <label className="form-label req">Firm Name</label>
                <AutoCompleteInput field="firmName" value={newName} onChange={setNewName} placeholder="e.g. Shree Gajanan Transport" />
              </div>
              <div className="form-group">
                <label className="form-label">Opening Balance (₹) — optional</label>
                <input className="form-input" type="number" inputMode="numeric" value={openingAmt} onChange={e => setOpeningAmt(e.target.value)} placeholder="0" />
              </div>
              {Number(openingAmt) > 0 && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <div className="radio-group">
                    <label className={`radio-opt ${openingType === 'debit' ? 'selected' : ''}`}>
                      <input type="radio" checked={openingType === 'debit'} onChange={() => setOpeningType('debit')} />
                      Pay firm (debit)
                    </label>
                    <label className={`radio-opt ${openingType === 'credit' ? 'selected' : ''}`}>
                      <input type="radio" checked={openingType === 'credit'} onChange={() => setOpeningType('credit')} />
                      Collect from firm (credit)
                    </label>
                  </div>
                </div>
              )}
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)}>Back</button>
              <button className="btn btn-primary btn-sm" onClick={addFirm}>Add ✓</button>
            </div>
          </div>
        </div>
      )}

      {/* Remove firm confirm */}
      {removeTarget && (
        <ConfirmModal
          title="Delete this firm account?"
          body={<>The entire ledger for <b>{removeTarget.firmName}</b> ({removeTarget.entryCount} entries, balance {formatINR(Math.abs(removeTarget.balance))}) will be permanently deleted. This cannot be undone.</>}
          confirmLabel="Yes, delete"
          onConfirm={removeFirm}
          onCancel={() => setRemoveTarget(null)}
          danger
        />
      )}
    </div>
  );
}
