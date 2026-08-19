import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Eye, XCircle, Trash2 } from 'lucide-react';
import { db, cascadeCancelChallan } from '../db/database';
import type { Challan } from '../db/database';
import { formatINR, formatDate } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import DeleteChallanDialog from '../components/DeleteChallanDialog';
import { useToast } from '../context/ToastContext';

// Above this many in-progress challans, a flat inline list stops being useful —
// search and date range take over instead of a growing scroll.
const SEARCH_THRESHOLD = 6;

export default function ChallanList() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [challans, setChallans] = useState<Challan[]>([]);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Challan | null>(null);

  const load = async () => {
    const all = await db.challans.orderBy('id').reverse().toArray();
    // Challan Entry page shows ONLY in-progress (open) challans — saved ones live in Saved Memos
    setChallans(all.filter(c => !c.deletedAt && c.status === 'open'));
  };

  useEffect(() => { load(); }, []);

  const isSearchMode = challans.length > SEARCH_THRESHOLD;

  const filtered = challans.filter(c => {
    if (!isSearchMode) return true; // small enough to just show — no filtering needed
    if (search && !c.firmName.toLowerCase().includes(search.toLowerCase()) && !c.challanNumber.includes(search)) return false;
    if (dateFrom && c.entryDate < dateFrom) return false;
    if (dateTo && c.entryDate > dateTo) return false;
    return true;
  });

  const handleCancel = async (c: Challan) => {
    if (!c.id) return;
    try {
      await cascadeCancelChallan(c.id);
      showToast('Challan cancelled', 'info');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Cancel failed', 'error');
    }
  };

  return (
    <div>
      <PageHeader
        showBack onRefresh={load}
        title="Challan Entry"
        subtitle={`${challans.length} challan in progress`}
      />

      <div style={{ textAlign: 'center', margin: '8px 0 24px' }}>
        <button className="btn btn-primary" style={{ padding: '11px 22px', fontSize: 14 }} onClick={() => navigate('/challan/new/header')}>
          <Plus size={16} /> New challan entry
        </button>
      </div>

      {challans.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '24px 24px 48px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>🚚</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Nothing in progress right now</div>
          <div style={{ fontSize: 13 }}>All memos are saved. New paperwork in? Start a new entry above.</div>
        </div>
      ) : (
        <>
          {isSearchMode && (
            <div style={{ display: 'flex', gap: 12, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: '1 1 200px' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Search by firm or challan no." value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <input type="date" className="form-input" style={{ flex: '0 0 140px' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              <input type="date" className="form-input" style={{ flex: '0 0 140px' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
              {(dateFrom || dateTo) && <button className="btn btn-ghost btn-sm" onClick={() => { setDateFrom(''); setDateTo(''); }}>Reset dates</button>}
            </div>
          )}
          {isSearchMode && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 12 }}>
              {challans.length} in progress — search above to find one instead of scrolling
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(c => (
              <div key={c.id} className="card" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    <span className="td-navy">{c.firmName}</span> <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· #{c.challanNumber}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {formatDate(c.entryDate)} · {c.truckNumber || 'no truck yet'} · {c.totalEntries > 0 ? `${c.totalEntries} entries so far` : 'header only, no entries yet'}
                  </div>
                </div>
                {c.totalToPay + c.totalPaid > 0 && (
                  <div style={{ fontSize: 13, fontWeight: 700 }} className="td-orange">{formatINR(c.totalToPay + c.totalPaid)}</div>
                )}
                <StatusBadge status={c.status} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button title="Continue Entry" className="btn-icon btn-icon-view" onClick={() => navigate(`/challan/${c.id}/detail`)}><Eye /></button>
                  {c.status !== 'cancelled' && <button title="Cancel" className="btn-icon btn-icon-cancel" onClick={() => handleCancel(c)}><XCircle /></button>}
                  <button title="Delete" className="btn-icon btn-icon-delete" onClick={() => setDeleteTarget(c)}><Trash2 /></button>
                </div>
              </div>
            ))}
            {isSearchMode && filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--text-muted)', fontSize: 13 }}>No match for that search.</div>
            )}
          </div>
        </>
      )}

      {deleteTarget && (
        <DeleteChallanDialog
          challan={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={load}
        />
      )}
    </div>
  );
}
