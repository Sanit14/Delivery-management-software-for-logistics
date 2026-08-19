import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SeatBadge from '../components/SeatBadge';
import BackupFreshnessBadge from '../components/BackupFreshnessBadge';
import { Truck, Eye, Plus, X, Search, List, FileText, Printer, ArrowRight } from 'lucide-react';
import { db } from '../db/database';
import type { Challan } from '../db/database';
import { formatINR, formatDate, todayISO } from '../utils/reportUtils';
import StatusBadge from '../components/StatusBadge';
import DeleteChallanDialog from '../components/DeleteChallanDialog';
import Walkthrough from '../components/Walkthrough';
import ViewAllModal from '../components/ViewAllModal';

interface TodayLists {
  trucks: { truckNumber: string; firmName: string; station: string; pkgs: number }[];
  memos: { challanNumber: string; firmName: string; entries: number; total: number }[];
  drs: { drNumber: string; consignee: string; amount: number }[];
}

interface OpStats {
  id: number;
  name: string;
  phone: string;
  initials: string;
  collected: number;      // rupees collected
  total: number;          // rupees allocated
  doneCount: number;      // wasuli collected (count)
  totalCount: number;     // wasuli allocated (count)
  pendingCount: number;   // still to collect (count)
}

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Good morning ☀️';
  if (h < 17) return 'Good afternoon 🌤';
  return 'Good evening 🌆';
}

function Empty() {
  return <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Nothing today</div>;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [today3, setToday3] = useState<TodayLists>({ trucks: [], memos: [], drs: [] });
  const [preview, setPreview] = useState<'trucks' | 'memos' | 'drs' | null>(null);
  const [recentChallans, setRecentChallans] = useState<Challan[]>([]);
  const [opStats, setOpStats] = useState<OpStats[]>([]);
  const [openChallan, setOpenChallan] = useState<Challan | null>(null);
  const [showWalkthrough, setShowWalkthrough] = useState(false);
  const [dismissAdhura, setDismissAdhura] = useState(false);
  const [cancelAdhura, setCancelAdhura] = useState(false);
  const [viewAllOpen, setViewAllOpen] = useState(false);
  const [opQuery, setOpQuery] = useState('');
  const [opStatusFilter, setOpStatusFilter] = useState('all');

  const reload = () => { setDismissAdhura(false); setReloadKey(k => k + 1); };
  const [reloadKey, setReloadKey] = useState(0);

  const doneCancelAdhura = () => {
    setCancelAdhura(false);
    setOpenChallan(null);
    reload();
  };

  useEffect(() => {
    const load = async () => {
      const today = todayISO();

      const walkSetting = await db.settings.get('walkthroughDone');
      if (!walkSetting || walkSetting.value !== 'true') setShowWalkthrough(true);

      const [recentC, operators] = await Promise.all([
        db.challans.orderBy('id').reverse().filter(c => !c.deletedAt).limit(5).toArray(),
        // ALL operators, not just active ones. An agent who was deactivated (or was
        // created before the `active` flag existed, so it's undefined) can still be
        // holding live pending wasuli — filtering them out here is what made this card
        // read "No wasuli assigned" while the Wasuli page showed 4 pending for them.
        // The `total > 0` check below is what decides who actually appears.
        db.operators.toArray(),
      ]);

      // ── Today's three counts (with lists for the preview windows) ──
      const liveChallans = (await db.challans.toArray()).filter(c => !c.deletedAt && c.status !== 'cancelled');

      // 1) Trucks entered today = challans with entryDate today
      const trucksToday = liveChallans.filter(c => c.entryDate === today);
      const allEntries = await db.lrEntries.where('challanId').anyOf(trucksToday.map(c => c.id!)).filter(e => e.status === 'active' && !e.deletedAt).toArray();
      const pkgByChallan = new Map<number, number>();
      for (const e of allEntries) pkgByChallan.set(e.challanId, (pkgByChallan.get(e.challanId) || 0) + (e.quantity || 0));
      const trucks = trucksToday.map(c => ({ truckNumber: c.truckNumber, firmName: c.firmName, station: c.loadingStation, pkgs: pkgByChallan.get(c.id!) || 0 }));

      // 2) Memos generated today = challans saved today (status 'saved', created today)
      const memosToday = liveChallans.filter(c => c.status === 'saved' && c.entryDate === today);
      const memos = memosToday.map(c => ({ challanNumber: c.challanNumber, firmName: c.firmName, entries: c.totalEntries || 0, total: (c.totalToPay || 0) + (c.totalPaid || 0) }));

      // 3) DRs printed today = DRs with printedAt today
      const drsToday = (await db.drs.filter(d => !d.deletedAt && (d.printedAt || '').slice(0, 10) === today).toArray());
      const drs = drsToday.map(d => ({ drNumber: d.drNumber, consignee: d.consignee, amount: d.total }));

      setToday3({ trucks, memos, drs });

      setRecentChallans(recentC);
      // DRs actually marked delivered today (matches the Delivery Board logic).
      // printedAt is used as the date proxy since there is no separate deliveredAt.

      const openC = await db.challans.where('status').equals('open').filter(c => !c.deletedAt).reverse().first();
      setOpenChallan(openC || null);

      const ops: OpStats[] = [];
      for (const op of operators) {
        // Cancelled wasuli is not work owed to anyone — exclude it from both sides of
        // the ratio, or an agent shows "2/5 done" while 3 were written off.
        const assigned = await db.wasuli
          .where('operatorId').equals(op.id!)
          .filter(w => !w.deletedAt && w.status !== 'cancelled')
          .toArray();
        const done = assigned.filter(w => w.status === 'collected');
        const collected = done.reduce((s, w) => s + (w.collectedAmount || 0), 0);
        const total = assigned.reduce((s, w) => s + w.amountToCollect, 0);
        const pendingCount = assigned.length - done.length;

        // The card's job: who still owes us collection work. An agent who has
        // finished everything drops off; one with anything pending always shows.
        if (pendingCount > 0) {
          const name = op.name;
          const parts = name.split(' ');
          const initials = (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
          ops.push({
            id: op.id!, name, phone: op.phone, initials: initials.toUpperCase(),
            collected, total,
            doneCount: done.length, totalCount: assigned.length, pendingCount,
          });
        }
      }
      // Most outstanding work first.
      ops.sort((a, b) => b.pendingCount - a.pendingCount);
      setOpStats(ops);
    };
    load();
  }, [reloadKey]);

  return (
    <div>
      {showWalkthrough && <Walkthrough onDone={() => setShowWalkthrough(false)} />}

      {preview && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div className="confirm-modal" style={{ width: 420, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '0.5px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, color: 'var(--navy)' }}>
                {preview === 'trucks' && <><Truck size={16} /> Trucks today — {today3.trucks.length}</>}
                {preview === 'memos' && <><FileText size={16} /> Memos today — {today3.memos.length}</>}
                {preview === 'drs' && <><Printer size={16} /> DRs today — {today3.drs.length}</>}
              </div>
              <button className="btn-icon" onClick={() => setPreview(null)} aria-label="Close"><X size={16} /></button>
            </div>

            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {preview === 'trucks' && (
                today3.trucks.length === 0 ? <Empty /> : (
                  <table className="data-table table-compact" style={{ width: '100%' }}>
                    <thead><tr><th>Truck</th><th>Firm</th><th>Station</th><th style={{ textAlign: 'right' }}>Pkgs</th></tr></thead>
                    <tbody>{today3.trucks.map((t, i) => <tr key={i}><td>{t.truckNumber}</td><td>{t.firmName}</td><td>{t.station}</td><td style={{ textAlign: 'right' }}>{t.pkgs}</td></tr>)}</tbody>
                  </table>
                )
              )}
              {preview === 'memos' && (
                today3.memos.length === 0 ? <Empty /> : (
                  <table className="data-table table-compact" style={{ width: '100%' }}>
                    <thead><tr><th>Challan</th><th>Firm</th><th style={{ textAlign: 'right' }}>Entries</th><th style={{ textAlign: 'right' }}>Total</th></tr></thead>
                    <tbody>{today3.memos.map((m, i) => <tr key={i}><td>#{m.challanNumber}</td><td>{m.firmName}</td><td style={{ textAlign: 'right' }}>{m.entries}</td><td style={{ textAlign: 'right' }}>{formatINR(m.total)}</td></tr>)}</tbody>
                  </table>
                )
              )}
              {preview === 'drs' && (
                today3.drs.length === 0 ? <Empty /> : (
                  <table className="data-table table-compact" style={{ width: '100%' }}>
                    <thead><tr><th>BS No</th><th>Consignee</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
                    <tbody>{today3.drs.map((d, i) => <tr key={i}><td>{d.drNumber}</td><td>{d.consignee}</td><td style={{ textAlign: 'right' }}>{formatINR(d.amount)}</td></tr>)}</tbody>
                  </table>
                )
              )}
            </div>

            {preview !== 'trucks' && (
              <div style={{ padding: '12px 18px', borderTop: '0.5px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-outline btn-sm" onClick={() => { navigate(preview === 'memos' ? '/memos' : '/drs'); setPreview(null); }}>
                  View more <ArrowRight size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="page-header">
        <div>
          <div className="page-title">{greeting()}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <BackupFreshnessBadge />
          <SeatBadge />
          <button className="btn btn-primary" onClick={() => navigate('/challan/new/header')}>
            <Plus size={16} /> New Challan
          </button>
        </div>
      </div>

      {/* Global search box — find any firm, station, operator, truck, challan, BS no */}
      <button
        onClick={() => window.dispatchEvent(new Event('open-global-search'))}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px',
          background: 'var(--card)', border: '1.5px solid var(--teal-border)', borderRadius: 'var(--r-lg)',
          marginBottom: 20, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15, textAlign: 'left',
        }}
      >
        <Search size={20} color="var(--teal)" />
        <span style={{ flex: 1 }}>Search firm, station, agent, truck, challan, BS no, or code...</span>
        <span style={{ fontSize: 11, background: 'var(--teal-tint)', color: 'var(--teal)', padding: '3px 8px', borderRadius: 5, fontWeight: 700 }}>Ctrl + K</span>
      </button>

      {/* Resume open challan */}
      {openChallan && !dismissAdhura && (
        <div style={{ background: 'var(--warning-bg)', border: '1px solid var(--orange-muted)', borderRadius: 'var(--r-lg)', padding: '14px 18px', marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)' }}>⏳ Unfinished memo</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{openChallan.firmName} · Challan #{openChallan.challanNumber} · {openChallan.totalEntries} entries</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
            <button className="btn btn-outline btn-sm" onClick={() => navigate(`/challan/${openChallan.id}/detail`)}>Continue →</button>
            <button className="btn btn-danger btn-sm" onClick={() => setCancelAdhura(true)}>Cancel / New</button>
            <button title="Hide for now" className="btn-icon btn-icon-cancel" onClick={() => setDismissAdhura(true)}><X size={14} /></button>
          </div>
        </div>
      )}

      {cancelAdhura && openChallan && (
        <DeleteChallanDialog
          challan={openChallan}
          onClose={() => setCancelAdhura(false)}
          onDone={doneCancelAdhura}
        />
      )}

      {/* KPI cards — today's trucks, memos, DRs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
        {/* Trucks entered today */}
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div className="icon-box icon-box-orange"><Truck /></div>
            <span className="card-tag">Today</span>
          </div>
          <div className="stat-value">{today3.trucks.length}</div>
          <div className="stat-label">trucks entered today</div>
          <button className="btn btn-outline btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={() => setPreview('trucks')}>
            <List size={14} /> View list
          </button>
        </div>

        {/* Memos generated today */}
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div className="icon-box icon-box-success"><FileText /></div>
            <span className="card-tag">Today</span>
          </div>
          <div className="stat-value">{today3.memos.length}</div>
          <div className="stat-label">memos generated today</div>
          <button className="btn btn-outline btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={() => setPreview('memos')}>
            <Eye size={14} /> View
          </button>
        </div>

        {/* DRs printed today */}
        <div className="stat-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
            <div className="icon-box icon-box-warning"><Printer /></div>
            <span className="card-tag">Today</span>
          </div>
          <div className="stat-value">{today3.drs.length}</div>
          <div className="stat-label">DRs printed today</div>
          <button className="btn btn-outline btn-sm" style={{ marginTop: 10, width: '100%' }} onClick={() => setPreview('drs')}>
            <Eye size={14} /> View
          </button>
        </div>
      </div>

      {/* Shared row renderer: used both by the inline capped list and the ViewAllModal.
           Modal rows are read-only (no onClick/navigate). */}
      {(() => {
        const renderOpRow = (op: OpStats, clickable: boolean) => {
          const pct = op.totalCount > 0 ? Math.round((op.doneCount / op.totalCount) * 100) : 0;
          return (
            <div
              key={op.id}
              className="op-row"
              style={{ cursor: clickable ? 'pointer' : 'default', padding: '0 14px' }}
              onClick={clickable ? () => navigate('/wasuli') : undefined}
            >
              <div className="op-avatar">{op.initials}</div>
              <div className="op-info">
                <div className="op-name">{op.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                  {op.doneCount}/{op.totalCount} done · {op.pendingCount} pending
                </div>
                <div className="op-bar-bg"><div className="op-bar-fill" style={{ width: `${pct}%` }} /></div>
              </div>
              <div className="op-right">
                <div className="op-amount">{formatINR(op.collected)}</div>
                <div className="op-pct">{pct}%</div>
              </div>
            </div>
          );
        };

        return (
          <>
            {viewAllOpen && (() => {
              const modalFiltered = opStats.filter(op => {
                const matchesSearch = opQuery.trim() === '' || op.name.toLowerCase().includes(opQuery.toLowerCase());
                const matchesStatus =
                  opStatusFilter === 'pending' ? op.pendingCount > 0 :
                  opStatusFilter === 'done' ? op.pendingCount === 0 :
                  true;
                return matchesSearch && matchesStatus;
              });
              return (
                <ViewAllModal
                  title={`Agent Wasuli — ${opStats.length} agents`}
                  search={{ value: opQuery, onChange: setOpQuery, placeholder: 'Search agent name…' }}
                  filter={{
                    value: opStatusFilter,
                    onChange: setOpStatusFilter,
                    options: [
                      { value: 'all', label: 'All' },
                      { value: 'pending', label: 'Has pending' },
                      { value: 'done', label: 'Fully collected' },
                    ],
                  }}
                  onClose={() => { setViewAllOpen(false); setOpQuery(''); setOpStatusFilter('all'); }}
                >
                  {modalFiltered.length === 0 ? (
                    <div style={{ padding: '28px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No results</div>
                  ) : (
                    modalFiltered.map(op => renderOpRow(op, false))
                  )}
                </ViewAllModal>
              );
            })()}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* Agent Wasuli Panel */}
              <div className="card">
                <div className="card-header">
                  <span className="card-header-title">Agent Wasuli</span>
                  <span className="card-link" onClick={() => navigate('/wasuli')}>View all →</span>
                </div>
                <div className="card-body" style={{ paddingLeft: 0, paddingRight: 0 }}>
                  {opStats.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: '16px 0' }}>No pending wasuli</div>
                  ) : (
                    <>
                      {/* Height-capped inline list — no inner scrollbar */}
                      <div style={{ maxHeight: 340, overflow: 'hidden' }}>
                        {opStats.map(op => renderOpRow(op, true))}
                      </div>
                      {/* Secondary trigger — always visible when list is non-empty */}
                      <button
                        onClick={() => setViewAllOpen(true)}
                        style={{
                          display: 'block', width: '100%', marginTop: 8,
                          background: 'none', border: 'none', cursor: 'pointer',
                          fontSize: 12, color: 'var(--teal)', textAlign: 'center',
                          padding: '4px 0 2px',
                        }}
                      >
                        View full list ({opStats.length} agents)
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Recent Challans */}
              <div className="card">
                <div className="card-header">
                  <span className="card-header-title">Recent Challans</span>
                  <span className="card-link" onClick={() => navigate('/memos')}>See all →</span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {recentChallans.length === 0 ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 24 }}>
                      <Truck size={32} style={{ opacity: 0.2, display: 'block', margin: '0 auto 8px' }} />
                      No challan yet
                    </div>
                  ) : (
                    recentChallans.map(c => (
                      <div key={c.id} style={{ padding: '12px 18px', borderBottom: '0.5px solid var(--border-light)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                        onClick={() => navigate(`/challan/${c.id}/detail`)}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--border-light)')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>{c.firmName}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Challan #{c.challanNumber} · {formatDate(c.entryDate)}</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ fontSize: 10, background: 'var(--border-light)', color: 'var(--text-secondary)', padding: '2px 6px', borderRadius: 10 }}>{c.totalEntries} entries</span>
                          <StatusBadge status={c.status} />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        );
      })()}
    </div>
  );
}
