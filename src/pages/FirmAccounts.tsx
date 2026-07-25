import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, ChevronRight, Search, Plus, Trash2 } from 'lucide-react';
import { db } from '../db/database';
import { formatINR, todayISO } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import AutoCompleteInput from '../components/AutoCompleteInput';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../context/ToastContext';
import { learnValues } from '../utils/masterData';

interface FirmSummary {
  firmName: string;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  entryCount: number;
}

export default function FirmAccounts() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [firms, setFirms] = useState<FirmSummary[]>([]);
  const [search, setSearch] = useState('');
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
      totalDebit: 0,
      totalCredit: 0,
      balance: f.balance,
      entryCount: f.entryCount
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

  const filtered = firms.filter(f => f.firmName.toLowerCase().includes(search.toLowerCase()));

  const badge = (balance: number) => {
    if (balance > 0) return <span style={{ color: 'var(--success)', fontWeight: 700, fontSize: 13 }}>{formatINR(balance)} <span style={{ fontSize: 10, fontWeight: 600 }}>THEY OWE</span></span>;
    if (balance < 0) return <span style={{ color: 'var(--warning)', fontWeight: 700, fontSize: 13 }}>{formatINR(Math.abs(balance))} <span style={{ fontSize: 10, fontWeight: 600 }}>WE OWE</span></span>;
    return <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }}>SETTLED</span>;
  };

  return (
    <div>
      <PageHeader
        showBack onRefresh={load}
        title="Firm Accounts"
        subtitle="Each firm's account — debit, credit, balance"
        right={<button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add Firm</button>}
      />

      <div style={{ position: 'relative', maxWidth: 360, marginBottom: 18 }}>
        <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Search firms..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>🏦</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No firm accounts yet</div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>The firm ledger is created when a memo is saved — or add one manually above</div>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Plus size={16} /> Add Firm</button>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
          {filtered.map(f => (
            <div
              key={f.firmName}
              className="card"
              style={{ padding: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
              onClick={() => navigate(`/firm-accounts/${encodeURIComponent(f.firmName)}`)}
            >
              <div className="icon-box icon-box-orange" style={{ flexShrink: 0 }}><Building2 /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.firmName}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{f.entryCount} entries</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                {badge(f.balance)}
              </div>
              <button
                title="Delete firm"
                className="btn-icon btn-icon-delete"
                style={{ flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); setRemoveTarget(f); }}
              >
                <Trash2 />
              </button>
              <ChevronRight size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
            </div>
          ))}
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
                      They owe us (debit)
                    </label>
                    <label className={`radio-opt ${openingType === 'credit' ? 'selected' : ''}`}>
                      <input type="radio" checked={openingType === 'credit'} onChange={() => setOpeningType('credit')} />
                      We owe them (credit)
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
