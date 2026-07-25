import { useEffect, useState, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import { MoreVertical, Building2, Search, Printer, Eye, X } from 'lucide-react';
import { db, logAudit, deleteEntryCascade } from '../db/database';
import type { DR } from '../db/database';
import { formatINR, formatDate, todayISO } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import ConfirmModal from '../components/ConfirmModal';
import PinModal from '../components/PinModal';
import PrintDRPage from '../components/PrintDRPage';
import DREditModal from '../components/DREditModal';
import LRPreviewModal from '../components/LRPreviewModal';
import { useToast } from '../context/ToastContext';
import { useAdmin } from '../context/AdminContext';

const PAGE_SIZE = 20;

// Ascending BS/DR order — shared by the default on-screen list order and the
// print preview (orderForPrint) so the two can never diverge. localeCompare is
// safe here because drNumber is fixed-width zero-padded ("26-000009" <
// "26-000010" lexically).
const compareByDrNumber = (a: DR, b: DR) => a.drNumber.localeCompare(b.drNumber);

export default function SavedDRs() {
  const { showToast } = useToast();
  const { isAdmin, unlock } = useAdmin();
  const [searchParams] = useSearchParams();
  const [allDRs, setAllDRs] = useState<DR[]>([]);
  const [companyName, setCompanyName] = useState('Sundeep Freight Movers');
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [printDRs, setPrintDRs] = useState<DR[]>([]);
  const [editTarget, setEditTarget] = useState<DR | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DR | null>(null);
  const [adminAction, setAdminAction] = useState<(() => void) | null>(null);
  const [previewDrId, setPreviewDrId] = useState<number | null>(null);
  const [previewList, setPreviewList] = useState<DR[] | null>(null);
  const [openMenuId, setOpenMenuId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'printed' | 'notPrinted'>('all');
  const printRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    // Ascending BS/DR order by default, matching the print preview — see
    // compareByDrNumber. sortDir just reverses this at render time.
    const all = await db.drs.orderBy('id').filter(d => !d.deletedAt).toArray();
    all.sort(compareByDrNumber);
    setAllDRs(all);
    const cn = await db.settings.get('companyName');
    setCompanyName(cn?.value || 'Sundeep Freight Movers');
  };
  useEffect(() => { load(); }, []);

  const requireAdmin = (action: () => void) => {
    if (isAdmin) action();
    else setAdminAction(() => action);
  };

  const today = todayISO();
  const isSearching = !!(search || dateFrom || dateTo);

  const inDateRange = (d: DR) => {
    if (!dateFrom && !dateTo) return true;
    const date = d.deliveryDate;
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return true;
  };

  // Status filter applies before anything below is built, so search results,
  // today's list, and each firm card's list all honor it consistently.
  const filteredDRs = useMemo(() => {
    if (statusFilter === 'all') return allDRs;
    if (statusFilter === 'notPrinted') return allDRs.filter(d => d.status !== 'printed');
    return allDRs.filter(d => d.status === statusFilter);
  }, [allDRs, statusFilter]);

  const applySortDir = (list: DR[]) => sortDir === 'desc' ? [...list].reverse() : list;

  const todaysDRs = useMemo(
    () => applySortDir(filteredDRs.filter(d => d.deliveryDate === today)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filteredDRs, today, sortDir]
  );

  const matchingFirms = useMemo(() => {
    if (!search) return [];
    const q = search.toLowerCase();
    const firms = new Set(filteredDRs.filter(d => d.firmName.toLowerCase().includes(q)).map(d => d.firmName));
    return Array.from(firms).sort();
  }, [filteredDRs, search]);

  const directMatches = useMemo(() => {
    if (!search || matchingFirms.length > 0) return [];
    const q = search.toLowerCase();
    const list = filteredDRs.filter(d =>
      inDateRange(d) && (
        d.drNumber.toLowerCase().includes(q) ||
        d.lrNumber.toLowerCase().includes(q) ||
        d.challanNumber.includes(search) ||
        d.consignor.toLowerCase().includes(q) ||
        d.consignee.toLowerCase().includes(q)
      )
    );
    return applySortDir(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredDRs, search, matchingFirms, dateFrom, dateTo, sortDir]);

  const dateOnlyMatches = useMemo(() => {
    if (search) return [];
    if (!dateFrom && !dateTo) return [];
    return applySortDir(filteredDRs.filter(inDateRange));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredDRs, search, dateFrom, dateTo, sortDir]);

  // Holds the list actually handed to the printer — read from onAfterPrint
  // instead of the printDRs state, since the setTimeout below fires against
  // whichever handlePrint closure printMany captured, not a later render's.
  const printDRsRef = useRef<DR[]>([]);

  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: 'Delivery Receipt',
    // THE FIX: only flag DRs 'printed' once the print dialog has actually run
    // its course — not before it's even shown. The old code wrote status:
    // 'printed' immediately on clicking Print, so hitting Cancel still left
    // the DRs flagged printed.
    onAfterPrint: () => {
      const list = printDRsRef.current;
      if (list.length === 0) return;
      const now = new Date().toISOString();
      Promise.all(list.map(d => db.drs.update(d.id!, { status: 'printed', printedAt: now }))).then(load);
    },
  });

  // Print always goes ascending BS/DR order, independent of the on-screen
  // sort-direction toggle — same compareByDrNumber the default list order
  // uses, so print and the on-screen default can never diverge.
  const orderForPrint = (list: DR[]) => [...list].sort(compareByDrNumber);

  const printMany = (list: DR[]) => {
    if (list.length === 0) return;
    const ordered = orderForPrint(list);
    printDRsRef.current = ordered;
    setPrintDRs(ordered);
    setSelected(new Set());
    setPreviewList(null);
    setTimeout(() => handlePrint(), 250);
  };

  const doDelete = async () => {
    if (!deleteTarget?.id) return;
    const res = await deleteEntryCascade(deleteTarget.lrEntryId);
    if (!res.ok) {
      showToast('Cannot delete — its wasuli is already assigned or collected', 'error');
      setDeleteTarget(null);
      return;
    }
    await logAudit({ action: 'delete', drNumber: deleteTarget.drNumber, party: deleteTarget.consignee, amount: deleteTarget.total, detail: 'DR deleted' });
    showToast('DR deleted — you can restore it from History', 'info');
    setDeleteTarget(null);
    load();
  };

  const toggleSelect = (id: number) => {
    setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const DRRow = ({ d }: { d: DR }) => (
    <div className="card" style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', position: 'relative' }}>
      <input type="checkbox" checked={selected.has(d.id!)} onChange={() => toggleSelect(d.id!)} style={{ width: 16, height: 16 }} aria-label="Select for printing" />
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          <span className="td-bold">{d.drNumber}</span> <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· LR {d.lrNumber} · #{d.challanNumber}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {d.consignor} → <span className="td-navy">{d.consignee}</span> · {formatDate(d.deliveryDate)}
        </div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 700 }} className="td-orange">{formatINR(d.total)}</div>
      <StatusBadge status={d.status} />
      <button className="btn-icon" onClick={() => setOpenMenuId(openMenuId === d.id ? null : d.id!)} aria-label="Actions">
        <MoreVertical size={16} />
      </button>
      {openMenuId === d.id && (
        <div
          onMouseLeave={() => setOpenMenuId(null)}
          style={{ position: 'absolute', top: '100%', right: 12, zIndex: 20, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.15)', overflow: 'hidden', minWidth: 150 }}>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => { setPreviewDrId(d.id!); setOpenMenuId(null); }}>View</div>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => { printMany([d]); setOpenMenuId(null); }}>Print</div>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer' }} onClick={() => { setOpenMenuId(null); requireAdmin(() => setEditTarget(d)); }}>Edit</div>
          <div className="menu-item" style={{ padding: '9px 14px', fontSize: 13, cursor: 'pointer', color: 'var(--red, #C0392B)' }} onClick={() => { setOpenMenuId(null); requireAdmin(() => setDeleteTarget(d)); }}>Delete</div>
        </div>
      )}
    </div>
  );

  const FirmCard = ({ firm }: { firm: string }) => {
    const [innerQuery, setInnerQuery] = useState('');
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const firmDRs = useMemo(() => {
      let list = filteredDRs.filter(d => d.firmName === firm && inDateRange(d));
      if (innerQuery) {
        const q = innerQuery.toLowerCase();
        list = list.filter(d =>
          d.drNumber.toLowerCase().includes(q) || d.lrNumber.toLowerCase().includes(q) ||
          d.challanNumber.includes(innerQuery) || d.consignor.toLowerCase().includes(q) || d.consignee.toLowerCase().includes(q)
        );
      }
      return applySortDir(list);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filteredDRs, firm, innerQuery, dateFrom, dateTo, sortDir]);

    return (
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'var(--teal-tint)', borderRadius: 'var(--r-lg) var(--r-lg) 0 0' }}>
          <Building2 size={16} color="var(--teal)" />
          <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--navy)' }}>{firm}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>{firmDRs.length} DR{firmDRs.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={{ padding: 10 }}>
          <div style={{ position: 'relative', marginBottom: 10 }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input className="form-input" style={{ paddingLeft: 28, fontSize: 12.5, height: 32 }}
              placeholder="Search by LR, BS, challan no, consignor, consignee"
              value={innerQuery} onChange={e => { setInnerQuery(e.target.value); setVisibleCount(PAGE_SIZE); }} />
          </div>
          {firmDRs.length === 0 ? (
            <div style={{ padding: '16px 4px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>No match within this firm.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {firmDRs.slice(0, visibleCount).map(d => <DRRow key={d.id} d={d} />)}
            </div>
          )}
          {firmDRs.length > visibleCount && (
            <div style={{ textAlign: 'center', padding: '10px 0 2px' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
                Showing {Math.min(visibleCount, firmDRs.length)} of {firmDRs.length} — Load more
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const [flatVisibleCount, setFlatVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => { setFlatVisibleCount(PAGE_SIZE); }, [search, dateFrom, dateTo]);
  const flatList = directMatches.length > 0 ? directMatches : dateOnlyMatches;

  // Currently visible DRs, across whichever view is active — "Select all" only
  // ever touches what's on screen right now, never the whole database.
  const currentlyVisible = useMemo(() => {
    if (!isSearching) return todaysDRs;
    if (matchingFirms.length > 0) return filteredDRs.filter(d => matchingFirms.includes(d.firmName) && inDateRange(d));
    return flatList.slice(0, flatVisibleCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSearching, todaysDRs, matchingFirms, filteredDRs, flatList, flatVisibleCount, dateFrom, dateTo]);

  const allVisibleSelected = currentlyVisible.length > 0 && currentlyVisible.every(d => selected.has(d.id!));
  const toggleSelectAll = () => {
    if (allVisibleSelected) setSelected(new Set());
    else setSelected(new Set(currentlyVisible.map(d => d.id!)));
  };

  const selectedDRs = allDRs.filter(d => selected.has(d.id!));

  return (
    <div>
      <PageHeader showBack onRefresh={load} title="Saved DRs"
        subtitle={isSearching ? (matchingFirms.length > 0 ? `${matchingFirms.length} firm match` : `${flatList.length} results`) : `${todaysDRs.length} generated today`} />

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 200px' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Firm, LR no, BS no, challan no, consignor, consignee..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <input type="date" className="form-input" style={{ flex: '0 0 140px' }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <input type="date" className="form-input" style={{ flex: '0 0 140px' }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
        {(dateFrom || dateTo) && <button className="btn btn-ghost btn-sm" onClick={() => { setDateFrom(''); setDateTo(''); }}>Reset dates</button>}
        <select className="form-select" style={{ flex: '0 0 160px' }} value={sortDir} onChange={e => setSortDir(e.target.value as 'asc' | 'desc')} aria-label="Sort order">
          <option value="asc">Oldest → Newest</option>
          <option value="desc">Newest → Oldest</option>
        </select>
        <select className="form-select" style={{ flex: '0 0 150px' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="Status filter">
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="printed">Printed</option>
          <option value="notPrinted">Not printed</option>
        </select>
      </div>

      {currentlyVisible.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={toggleSelectAll}>
            {allVisibleSelected ? 'Unselect all' : `Select all shown (${currentlyVisible.length})`}
          </button>
        </div>
      )}

      {!isSearching ? (
        todaysDRs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>🧾</div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Nothing generated yet today</div>
            <div style={{ fontSize: 13 }}>Search above to find any past DR by firm, LR, BS, or challan number</div>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>Today — {todaysDRs.length} DR{todaysDRs.length !== 1 ? 's' : ''} generated</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {todaysDRs.map(d => <DRRow key={d.id} d={d} />)}
            </div>
          </>
        )
      ) : matchingFirms.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {matchingFirms.map(firm => <FirmCard key={firm} firm={firm} />)}
        </div>
      ) : flatList.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>🔍</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No match</div>
          <div style={{ fontSize: 13 }}>Try a different firm, LR, BS, challan number, or date range</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {flatList.slice(0, flatVisibleCount).map(d => <DRRow key={d.id} d={d} />)}
          </div>
          {flatList.length > flatVisibleCount && (
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setFlatVisibleCount(v => v + PAGE_SIZE)}>
                Showing {Math.min(flatVisibleCount, flatList.length)} of {flatList.length} — Load more
              </button>
            </div>
          )}
        </>
      )}

      {selected.size > 0 && (
        <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100, background: 'var(--navy)', boxShadow: '0 -4px 20px rgba(0,0,0,0.15)', padding: '14px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, color: '#fff' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.size} DRs selected</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{Math.ceil(selected.size / 6)} A4 page{Math.ceil(selected.size / 6) !== 1 ? 's' : ''} · 6 per page</div>
            <button onClick={() => setSelected(new Set())} style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>Clear</button>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline" onClick={() => setPreviewList(orderForPrint(selectedDRs))}>
              <Eye size={16} /> Preview
            </button>
            <button className="btn btn-primary" onClick={() => printMany(selectedDRs)}>
              <Printer size={16} /> Print {selected.size} DRs
            </button>
          </div>
        </div>
      )}

      {adminAction && (
        <PinModal title="Admin PIN Required" checkPin={unlock} onSuccess={() => { const a = adminAction; setAdminAction(null); a(); }} onCancel={() => setAdminAction(null)} />
      )}

      {editTarget && (
        <DREditModal dr={editTarget} onSaved={(result) => {
          if (result === 'stale') showToast(`BS ${editTarget.drNumber} was just changed by someone else — refreshing the list, please edit again`, 'error');
          else if (result === 'locked') showToast(`BS ${editTarget.drNumber}'s wasuli is already assigned to an agent — it can no longer be edited`, 'error');
          else showToast(`BS ${editTarget.drNumber} updated`, 'success');
          setEditTarget(null);
          load();
        }} onClose={() => setEditTarget(null)} />
      )}

      {deleteTarget && (
        <ConfirmModal title="Delete this DR?" body={<>DR <b>{deleteTarget.drNumber}</b> ({deleteTarget.consignee}) will be deleted. It can be restored from History.</>} confirmLabel="Yes, delete" onConfirm={doDelete} onCancel={() => setDeleteTarget(null)} danger />
      )}

      {previewDrId !== null && (
        <LRPreviewModal drId={previewDrId} heading="bs" onClose={() => setPreviewDrId(null)} />
      )}

      {previewList && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPreviewList(null); }}>
          <div style={{
            background: '#fff', borderRadius: 'var(--r-xl)', width: 900, maxWidth: '96vw', maxHeight: '90vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: 'var(--shadow-lg)',
          }}>
            <div style={{
              background: 'var(--navy)', color: '#fff', padding: '14px 18px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0,
            }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>Print preview — {previewList.length} DRs</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-primary btn-sm" onClick={() => printMany(previewList)}>
                  <Printer size={14} /> Print
                </button>
                <button className="btn-icon" style={{ color: '#fff' }} onClick={() => setPreviewList(null)} aria-label="Close">
                  <X size={16} />
                </button>
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: 16, background: '#e8e8e8' }}>
              <PrintDRPage drs={previewList} companyName={companyName} />
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'none' }}>
        <PrintDRPage ref={printRef} drs={printDRs} companyName={companyName} />
      </div>
    </div>
  );
}
