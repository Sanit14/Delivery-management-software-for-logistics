import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { MoreVertical, Building2, Search, Sparkles, GitMerge } from 'lucide-react';
import { db, cascadeReopenChallan } from '../db/database';
import type { Challan } from '../db/database';
import { formatINR, formatDate, todayISO } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import ConfirmModal from '../components/ConfirmModal';
import DeleteChallanDialog from '../components/DeleteChallanDialog';
import MasterDataCleanup from '../components/MasterDataCleanup';
import ChallanMergeTool from '../components/ChallanMergeTool';
import PinModal from '../components/PinModal';
import { useToast } from '../context/ToastContext';
import { useAdmin } from '../context/AdminContext';

// White pill so these read clearly against the header's solid teal — the
// shared .btn-outline (transparent bg, orange text/border) washes out there.
const headerBtnStyle: React.CSSProperties = { background: '#fff', color: 'var(--orange)', border: 'none', fontWeight: 700 };

const PAGE_SIZE = 20;

export default function SavedMemos() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { isAdmin, unlock } = useAdmin();
  const [searchParams] = useSearchParams();
  const [memos, setMemos] = useState<Challan[]>([]);
  const [search, setSearch] = useState(searchParams.get('challan') || '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [reopenTarget, setReopenTarget] = useState<Challan | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Challan | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [showCleanup, setShowCleanup] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [adminAction, setAdminAction] = useState<(() => void) | null>(null);

  const requireAdmin = (action: () => void) => {
    if (isAdmin) action();
    else setAdminAction(() => action);
  };

  const load = async () => {
    const all = await db.challans.orderBy('id').reverse().filter(c => !c.deletedAt).toArray();
    setMemos(all.filter(c => c.status !== 'open'));
  };
  useEffect(() => { load(); }, []);

  const isSearching = !!(search || dateFrom || dateTo);
  const today = todayISO();

  // Default view: today's work only — small and directly relevant, nothing to load or scroll through.
  // updatedAt is stored as a UTC ISO string; convert it to the LOCAL calendar date before
  // comparing, so a memo saved today (local time) isn't hidden by a UTC/local day boundary.
  const localDay = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const todaysMemos = useMemo(
    () => memos.filter(c => localDay(c.updatedAt) === today),
    [memos, today]
  );

  // Once searching, today's list steps aside entirely and this takes over.
  const searchResults = useMemo(() => {
    if (!isSearching) return [];
    return memos.filter(c => {
      if (search && !c.firmName.toLowerCase().includes(search.toLowerCase()) && !c.challanNumber.includes(search)) return false;
      if (dateFrom && c.loadingDate < dateFrom) return false;
      if (dateTo && c.loadingDate > dateTo) return false;
      return true;
    });
  }, [memos, isSearching, search, dateFrom, dateTo]);

  // Group search results by firm — one card per matching firm, capped list with load more.
  const firmGroups = useMemo(() => {
    const map = new Map<string, Challan[]>();
    for (const c of searchResults) {
      const g = map.get(c.firmName) || [];
      g.push(c);
      map.set(c.firmName, g);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [searchResults]);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [search, dateFrom, dateTo]);

  const handleReopen = async () => {
    if (!reopenTarget?.id) return;
    try {
      await cascadeReopenChallan(reopenTarget.id);
      showToast('Challan reopened for editing', 'info');
      load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Reopen failed', 'error');
    } finally {
      setReopenTarget(null);
      setOpenMenuId(null);
    }
  };

  const MemoRow = ({ c }: { c: Challan }) => (
    <div className="card" style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', position: 'relative' }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          <span className="td-navy">{c.firmName}</span> <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· #{c.challanNumber}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {formatDate(c.loadingDate)} · {c.truckNumber} · {c.totalEntries} entries
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700 }} className="td-orange">{formatINR(c.totalToPay + c.totalPaid)}</div>
      <StatusBadge status={c.status} />
      <button className="btn-icon" onClick={() => setOpenMenuId(openMenuId === c.id ? null : c.id!)} aria-label="Actions">
        <MoreVertical size={16} />
      </button>
      {openMenuId === c.id && (
        <div
          onMouseLeave={() => setOpenMenuId(null)}
          style={{ position: 'absolute', top: '100%', right: 12, zIndex: 20, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', overflow: 'hidden', minWidth: 170 }}>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => navigate(`/memo/${c.id}/view`)}>View</div>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => navigate(`/drs?q=${encodeURIComponent(c.challanNumber)}`)}>Print DR</div>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => navigate(`/memo/${c.id}/view?print=1`)}>Print Memo</div>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => navigate(`/firm-accounts/${encodeURIComponent(c.firmName)}`)}>Firm account</div>
          {c.status === 'saved' && <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => { setReopenTarget(c); setOpenMenuId(null); }}>Reopen</div>}
          {c.status === 'saved' && <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer', color: 'var(--red, #C0392B)' }} onClick={() => { setDeleteTarget(c); setOpenMenuId(null); }}>Delete</div>}
        </div>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader showBack onRefresh={load} title="Saved Memos" subtitle={isSearching ? `${searchResults.length} results` : `${todaysMemos.length} saved today`}
        right={
          <>
            <button className="btn btn-sm" style={headerBtnStyle} onClick={() => requireAdmin(() => setShowMerge(true))}>
              <GitMerge size={14} /> Merge
            </button>
            <button className="btn btn-sm" style={headerBtnStyle} onClick={() => requireAdmin(() => setShowCleanup(true))}>
              <Sparkles size={14} /> Clean up duplicates
            </button>
          </>
        }
      />

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 200px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Firm or challan no..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <input type="date" className="form-input" style={{ flex: '0 0 160px' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <input type="date" className="form-input" style={{ flex: '0 0 160px' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
        {(dateFrom || dateTo) && <button className="btn btn-ghost btn-sm" onClick={() => { setDateFrom(''); setDateTo(''); }}>Reset dates</button>}
      </div>

      {!isSearching ? (
        todaysMemos.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>📁</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Nothing saved yet today</div>
            <div style={{ fontSize: 13 }}>Search above to find any past memo by firm, challan number, or date</div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>Today — {todaysMemos.length} memo{todaysMemos.length !== 1 ? 's' : ''} saved</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {todaysMemos.map(c => <MemoRow key={c.id} c={c} />)}
            </div>
          </>
        )
      ) : firmGroups.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>🔍</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No match</div>
          <div style={{ fontSize: 13 }}>Try a different firm, challan number, or date range</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {firmGroups.map(([firm, items]) => (
            <div key={firm} className="card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'var(--teal-tint)', borderRadius: 'var(--r-lg) var(--r-lg) 0 0' }}>
                <Building2 size={16} color="var(--teal)" />
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--navy)' }}>{firm}</span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{items.length} memo{items.length !== 1 ? 's' : ''} total</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10 }}>
                {items.slice(0, visibleCount).map(c => <MemoRow key={c.id} c={c} />)}
              </div>
              {items.length > visibleCount && (
                <div style={{ textAlign: 'center', padding: '8px 0 12px' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
                    Showing {Math.min(visibleCount, items.length)} of {items.length} — Load more
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {reopenTarget && (
        <ConfirmModal
          title="Reopen this challan?"
          body={<>Challan <b>#{reopenTarget.challanNumber}</b> will become editable again. Its BS numbers stay exactly as they are — only entries you actually change get updated when you save again.</>}
          confirmLabel="Yes, reopen"
          onConfirm={handleReopen}
          onCancel={() => setReopenTarget(null)}
        />
      )}

      {deleteTarget && (
        <DeleteChallanDialog
          challan={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDone={load}
        />
      )}

      {showCleanup && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowCleanup(false); }}>
          <div className="confirm-modal" style={{ width: 640, maxWidth: '92vw', maxHeight: '85vh', overflowY: 'auto' }}>
            <div className="confirm-title">Clean up duplicates</div>
            <div className="confirm-body">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '10px 14px', lineHeight: 1.7 }}>
                Fast typing sometimes creates two versions of the same name (e.g. <b>Nagpur</b> and <b>nagp</b>). Merge them into one — every challan, LR, DR and other record using the old name is updated to the kept name. A safety backup is taken automatically before each merge.
              </div>
              <MasterDataCleanup />
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setShowCleanup(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showMerge && (
        <ChallanMergeTool onClose={() => setShowMerge(false)} onDone={load} />
      )}

      {adminAction && (
        <PinModal title="Admin PIN Required" checkPin={unlock} onSuccess={() => { const a = adminAction; setAdminAction(null); a(); }} onCancel={() => setAdminAction(null)} />
      )}
    </div>
  );
}
