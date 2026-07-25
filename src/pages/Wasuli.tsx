import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, UserCog, XCircle, Plus, RotateCcw, ArrowRight } from 'lucide-react';
import { db, CLEAR, logAudit, getReassignTrails } from '../db/database';
import type { Wasuli, DR, Operator } from '../db/database';
import { formatINR, formatDate, daysDiff, todayISO } from '../utils/reportUtils';
import { fmtCode } from '../utils/masterData';
import { bsMatches, resolveBs } from '../utils/bsMatch';
import PageHeader from '../components/PageHeader';
import ConfirmModal from '../components/ConfirmModal';
import ViewAllModal from '../components/ViewAllModal';
import { useToast } from '../context/ToastContext';
import { SkeletonCard, SkeletonStyles } from '../components/Skeleton';

interface WRow extends Wasuli {
  drNumber: string;
  lrNumber: string;
  challanNumber: string;
  consignor: string;
}

const WASULI_CAP = 15;

export default function Wasuli() {
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [operators, setOperators] = useState<Operator[]>([]);
  const [agentId, setAgentId] = useState<number | 0>(0);
  const [assigned, setAssigned] = useState<WRow[]>([]);
  const [collected, setCollected] = useState<WRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'pending' | 'collected'>('pending');

  const [assignBs, setAssignBs] = useState('');
  const [collectBs, setCollectBs] = useState('');
  const [inlineMsg, setInlineMsg] = useState<{ text: string; kind: 'error' | 'ok' } | null>(null);
  const assignRef = useRef<HTMLInputElement>(null);
  // Quick-match dropdown: candidates + live matches + keyboard highlight, per box.
  const [allDrs, setAllDrs] = useState<{ drNumber: string; lrNumber: string; consignor: string; consignee: string }[]>([]);
  const [assignMatches, setAssignMatches] = useState<{ drNumber: string; lrNumber: string; consignor: string; consignee: string }[]>([]);
  const [collectMatches, setCollectMatches] = useState<{ drNumber: string; lrNumber: string; consignor: string; consignee: string }[]>([]);
  const [assignHi, setAssignHi] = useState(-1);
  const [collectHi, setCollectHi] = useState(-1);

  const [collectTarget, setCollectTarget] = useState<WRow | null>(null);
  const [collectDate, setCollectDate] = useState(todayISO());
  const [remark, setRemark] = useState('');
  const [skipRemark, setSkipRemark] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<WRow | null>(null);
  const [reassignOp, setReassignOp] = useState(0);
  const [cancelTarget, setCancelTarget] = useState<WRow | null>(null);
  const [uncollectTarget, setUncollectTarget] = useState<WRow | null>(null);
  const [trails, setTrails] = useState<Record<string, string[]>>({});

  // "View all" modal state
  const [viewAll, setViewAll] = useState(false);
  const [modalQuery, setModalQuery] = useState('');
  const [modalChallan, setModalChallan] = useState('all');

  const joinDRs = async (ws: Wasuli[]): Promise<WRow[]> => {
    const drs = await db.drs.where('id').anyOf(ws.map(w => w.drId)).toArray();
    const m = new Map<number, DR>(drs.map(d => [d.id!, d]));
    return ws.map(w => {
      const d = m.get(w.drId);
      // DR.consignee/consignor are the authoritative, always-synced copies
      // (see generateDRs / updateDRCharges) — w.consigneeName is an older
      // denormalized copy on the wasuli row itself that can be blank on
      // legacy rows. Prefer the DR's, fall back to the row's own copy.
      return {
        ...w, drNumber: d?.drNumber || '', lrNumber: d?.lrNumber || '', challanNumber: d?.challanNumber || '',
        consignor: d?.consignor || '', consigneeName: d?.consignee || w.consigneeName,
      };
    });
  };

  const load = useCallback(async () => {
    const all = await db.wasuli.filter(w => !w.deletedAt).toArray();
    setAssigned(await joinDRs(all.filter(w => w.status === 'pending' && w.operatorId !== 0)));
    setCollected(await joinDRs(all.filter(w => w.status === 'collected')));
    const ops = await db.operators.toArray();
    setOperators(ops);
    setAgentId(prev => prev || (ops.find(o => o.active)?.id ?? 0));
    setTrails(await getReassignTrails());
    // Candidates for the quick-match dropdown on the assign/collect boxes: typing
    // "47" should surface this year's "26-00047" without typing the year.
    setAllDrs((await db.drs.filter(d => !d.deletedAt).toArray()).map(d => ({ drNumber: d.drNumber, lrNumber: d.lrNumber, consignor: d.consignor, consignee: d.consignee })));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.sqlAPI?.onDbChanged) return;
    return window.sqlAPI.onDbChanged(() => load());
  }, [load]);

  const flash = (text: string, kind: 'error' | 'ok') => {
    setInlineMsg({ text, kind });
    setTimeout(() => setInlineMsg(null), 3500);
  };

  const findWasuliByBS = async (bsNum: string) => {
    const drs = await db.drs.toArray();
    const dr = drs.find(d => d.drNumber === bsNum && !d.deletedAt);
    if (!dr) return { dr: null, w: null };
    const w = (await db.wasuli.filter(x => x.drId === dr.id && !x.deletedAt).toArray())[0] || null;
    return { dr, w };
  };

  // LR numbers aren't guaranteed unique (Task 2 only warns on a duplicate,
  // never blocks it) — when resolveBs can't find a unique match, this tells
  // the caller whether that's because it genuinely doesn't exist, or because
  // it matches more than one saved DR, so the error message doesn't lie.
  const ambiguousLrCount = (typed: string) => allDrs.filter(d => d.lrNumber === typed).length;

  const doAssign = async (picked?: string) => {
    const typed = (picked ?? assignBs).trim();
    if (!typed) return;
    if (!agentId) { flash('Please select an agent first', 'error'); return; }
    // "47" resolves to this year's full number ("26-00047"); a full/old number
    // typed exactly still matches itself, and so does an exact LR number.
    // Fall back to the raw text so the not-found message echoes what was typed.
    const bsNum = resolveBs(allDrs, typed, true)?.drNumber ?? typed;
    setAssignMatches([]); setAssignHi(-1);
    const { dr, w } = await findWasuliByBS(bsNum);
    if (!dr) {
      const dupCount = ambiguousLrCount(typed);
      if (dupCount > 1) { flash(`LR ${typed} matches ${dupCount} saved DRs — pick one from the list`, 'error'); setAssignMatches(bsMatches(allDrs, typed, 6, true)); return; }
      flash(`${bsNum} — BS number not found`, 'error'); setAssignBs(''); return;
    }
    if (!w) { flash(`${bsNum} — no amount pending on this DR`, 'error'); setAssignBs(''); return; }
    if (w.status === 'collected') { flash(`${bsNum} — already collected`, 'error'); setAssignBs(''); return; }
    if (w.operatorId === agentId) { flash(`${bsNum} — already assigned to this agent`, 'error'); setAssignBs(''); return; }
    if (w.operatorId !== 0) {
      const other = operators.find(o => o.id === w.operatorId);
      flash(`${bsNum} — assigned to ${other?.name || 'another agent'}`, 'error'); setAssignBs(''); return;
    }
    await db.wasuli.update(w.id!, { operatorId: agentId, assignedDate: todayISO() });
    // DR.consignee is the authoritative, always-synced copy (see generateDRs /
    // updateDRCharges) — w.consigneeName is an older denormalized copy on the
    // wasuli row itself that can be blank on legacy rows. Prefer the DR's.
    const consigneeDisplay = dr.consignee || w.consigneeName;
    await logAudit({ action: 'assign', drNumber: bsNum, party: consigneeDisplay, amount: w.amountToCollect, toAgent: operators.find(o => o.id === agentId)?.name });
    flash(`${bsNum} — ${consigneeDisplay} assigned`, 'ok');
    setAssignBs(''); assignRef.current?.focus(); load();
  };

  const doCollectByBS = async (picked?: string) => {
    const typed = (picked ?? collectBs).trim();
    if (!typed) return;
    const bsNum = resolveBs(allDrs, typed, true)?.drNumber ?? typed;
    setCollectMatches([]); setCollectHi(-1);
    const { dr, w } = await findWasuliByBS(bsNum);
    if (!dr) {
      const dupCount = ambiguousLrCount(typed);
      if (dupCount > 1) { flash(`LR ${typed} matches ${dupCount} saved DRs — pick one from the list`, 'error'); setCollectMatches(bsMatches(allDrs, typed, 6, true)); return; }
      flash(`${bsNum} — BS number not found`, 'error'); setCollectBs(''); return;
    }
    if (!w) { flash(`${bsNum} — no amount pending on this DR`, 'error'); setCollectBs(''); return; }
    if (w.status === 'collected') { flash(`${bsNum} — already collected`, 'error'); setCollectBs(''); return; }
    if (w.operatorId === 0) { flash(`${bsNum} — not yet assigned to any agent`, 'error'); setCollectBs(''); return; }
    const wrow = (await joinDRs([w]))[0];
    setCollectBs('');
    openCollect(wrow);
  };

  const openCollect = (r: WRow) => {
    setCollectTarget(r);
    setCollectDate(todayISO());
    setRemark('');
  };

  const confirmCollect = async () => {
    if (!collectTarget?.id) return;
    const fresh = await db.wasuli.get(collectTarget.id);
    const amount = fresh ? fresh.amountToCollect : collectTarget.amountToCollect;
    if (!fresh) {
      console.warn(`Wasuli record ${collectTarget.id} not found in DB at confirm time`);
    }
    await db.wasuli.update(collectTarget.id, {
      status: 'collected', collectedDate: collectDate,
      collectedAmount: amount,
      notes: skipRemark ? (collectTarget.notes || '') : remark,
    });
    await logAudit({ action: 'collect', drNumber: collectTarget.drNumber, party: collectTarget.consigneeName, amount: amount, toAgent: operators.find(o => o.id === collectTarget.operatorId)?.name, detail: skipRemark ? undefined : remark });
    showToast(`${collectTarget.consigneeName} — ${formatINR(amount)} collected`, 'success');
    setCollectTarget(null); load();
  };

  const doReassign = async () => {
    if (!reassignTarget?.id || !reassignOp) return;
    const fromName = operators.find(o => o.id === reassignTarget.operatorId)?.name;
    const toName = operators.find(o => o.id === reassignOp)?.name;
    await db.wasuli.update(reassignTarget.id, { operatorId: reassignOp, assignedDate: todayISO() });
    await logAudit({ action: 'reassign', drNumber: reassignTarget.drNumber, party: reassignTarget.consigneeName, amount: reassignTarget.amountToCollect, fromAgent: fromName, toAgent: toName });
    showToast(`Reassigned to ${toName}`, 'success');
    setReassignTarget(null); setReassignOp(0); load();
  };
  const doCancel = async () => {
    if (!cancelTarget?.id) return;
    const fromName = operators.find(o => o.id === cancelTarget.operatorId)?.name;
    await db.wasuli.update(cancelTarget.id, { operatorId: 0, assignedDate: '' });
    await logAudit({ action: 'remove', drNumber: cancelTarget.drNumber, party: cancelTarget.consigneeName, amount: cancelTarget.amountToCollect, fromAgent: fromName });
    showToast('Returned to unassigned pool', 'info'); setCancelTarget(null); load();
  };
  const doUncollect = async () => {
    if (!uncollectTarget?.id) return;
    await db.wasuli.update(uncollectTarget.id, { status: 'pending', collectedDate: CLEAR, collectedAmount: CLEAR });
    await logAudit({ action: 'undo', drNumber: uncollectTarget.drNumber, party: uncollectTarget.consigneeName, amount: uncollectTarget.amountToCollect, toAgent: operators.find(o => o.id === uncollectTarget.operatorId)?.name });
    showToast('Marked as pending again', 'info'); setUncollectTarget(null); load();
  };

  const myPending = assigned.filter(r => r.operatorId === agentId);
  const myCollected = collected.filter(r => r.operatorId === agentId);
  const agent = operators.find(o => o.id === agentId);

  const dayPill = (days: number): React.CSSProperties => {
    if (days >= 7) return { color: 'var(--danger)', background: 'var(--danger-bg)', fontWeight: 700, padding: '2px 8px', borderRadius: 10, fontSize: 11 };
    if (days >= 4) return { color: 'var(--warning)', background: 'var(--warning-bg)', fontWeight: 600, padding: '2px 8px', borderRadius: 10, fontSize: 11 };
    return { color: 'var(--text-muted)', fontSize: 11 };
  };

  const list = tab === 'pending' ? myPending : myCollected;

  // Shared row renderer — used in both the inline table and the modal table so
  // actions and layout can never diverge. The same handlers are passed through.
  const renderRow = (r: WRow) => {
    const days = daysDiff(r.assignedDate || '');
    return (
      <tr key={r.id}>
        <td className="td-bold">{r.drNumber}</td>
        <td>
           {r.consigneeName}
           {tab === 'pending' && trails[r.drNumber] && trails[r.drNumber].length > 1 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              {trails[r.drNumber].map((name, i) => (
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  {i > 0 && <ArrowRight size={10} />}
                  {name}
                </span>
              ))}
            </div>
          )}
        </td>
        <td>#{r.challanNumber}</td>
        <td>{tab === 'pending'
          ? <span style={dayPill(days)}>{days === 0 ? 'Today' : `${days}d`}</span>
          : formatDate(r.collectedDate || '')}</td>
        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--orange)' }}>
          {formatINR(tab === 'pending' ? r.amountToCollect : (r.collectedAmount || 0))}
        </td>
        <td>
          {tab === 'pending' ? (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <button title="Collected" className="btn-icon" style={{ background: 'var(--success-bg)', color: 'var(--success)' }} onClick={() => openCollect(r)}><Check size={14} /></button>
              <button title="Reassign to another agent" className="btn-icon btn-icon-edit" onClick={() => { setReassignTarget(r); setReassignOp(0); }}><UserCog size={14} /></button>
              <button title="Remove (back to pool)" className="btn-icon btn-icon-cancel" onClick={() => setCancelTarget(r)}><XCircle size={14} /></button>
            </div>
          ) : (
            <button title="Undo — back to pending" className="btn-icon btn-icon-cancel" onClick={() => setUncollectTarget(r)}><RotateCcw size={14} /></button>
          )}
        </td>
      </tr>
    );
  };

  // Table header — reused in both inline and modal tables
  const tableHead = (
    <thead><tr>
      <th>BS No.</th><th>Party</th><th>Challan</th>
      <th>{tab === 'pending' ? 'Assigned' : 'Collected'}</th>
      <th style={{ textAlign: 'right' }}>Amount</th>
      <th style={{ width: 120 }}>Action</th>
    </tr></thead>
  );

  // Distinct challan numbers in the current list for the modal filter
  const challanOptions = [
    { value: 'all', label: 'All challans' },
    ...Array.from(new Set(list.map(r => r.challanNumber).filter(Boolean)))
      .sort()
      .map(c => ({ value: c, label: `#${c}` })),
  ];

  // Modal-filtered list
  const modalList = list.filter(r =>
    (modalChallan === 'all' || r.challanNumber === modalChallan) &&
    (r.drNumber + ' ' + r.consigneeName).toLowerCase().includes(modalQuery.toLowerCase())
  );

  return (
    <div style={{ paddingBottom: 60 }}>
      <PageHeader showBack onRefresh={load} title="Wasuli — collection" subtitle="Select an agent to assign and collect DRs by BS number" />

      {loading ? (
        <><SkeletonStyles /><div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}><SkeletonCard /><SkeletonCard /></div></>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Agent</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-select" style={{ flex: 1, minWidth: 0 }} value={agentId} onChange={e => setAgentId(Number(e.target.value))}>
                  {operators.filter(o => o.active).map(o => <option key={o.id} value={o.id}>{o.name} · {fmtCode(o.code)}</option>)}
                </select>
                <button className="btn btn-outline btn-sm" title="Add new agent"
                  onClick={() => navigate('/master-data', { state: { from: '/wasuli', openTab: 'operator' } })}>
                  <Plus size={14} /> New
                </button>
              </div>
            </div>
            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>DRs pending</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--orange)' }}>{myPending.length}</div>
            </div>
            <div className="stat-card" style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>DRs collected</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success, #0b8a4f)' }}>{myCollected.length}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input ref={assignRef} className="form-input" style={{ width: '100%' }} placeholder="BS / LR no. to assign" autoFocus
                  value={assignBs}
                  onChange={e => { setAssignBs(e.target.value); setAssignMatches(bsMatches(allDrs, e.target.value, 6, true)); setAssignHi(-1); }}
                  onBlur={() => setTimeout(() => { setAssignMatches([]); setAssignHi(-1); }, 150)}
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setAssignHi(h => Math.min(h + 1, assignMatches.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setAssignHi(h => Math.max(h - 1, -1)); }
                    else if (e.key === 'Escape') { setAssignMatches([]); setAssignHi(-1); }
                    else if (e.key === 'Enter') { doAssign(assignHi >= 0 ? assignMatches[assignHi].drNumber : undefined); }
                  }} />
                {assignMatches.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: 'var(--card, #fff)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.12)', marginTop: 4, overflow: 'hidden' }}>
                    {assignMatches.map((m, i) => (
                      <div key={m.drNumber} onMouseDown={e => { e.preventDefault(); doAssign(m.drNumber); }}
                        style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10, background: i === assignHi ? 'var(--border-light)' : undefined }}>
                        <b>{m.drNumber}{m.lrNumber ? ` / ${m.lrNumber}` : ''}</b>
                        <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[m.consignor, m.consignee].filter(Boolean).join(' → ')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button className="btn btn-primary btn-sm" onClick={() => doAssign()}><Plus size={14} /> Assign</button>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input className="form-input" style={{ width: '100%' }} placeholder="BS / LR no. to mark collected"
                  value={collectBs}
                  onChange={e => { setCollectBs(e.target.value); setCollectMatches(bsMatches(allDrs, e.target.value, 6, true)); setCollectHi(-1); }}
                  onBlur={() => setTimeout(() => { setCollectMatches([]); setCollectHi(-1); }, 150)}
                  onKeyDown={e => {
                    if (e.key === 'ArrowDown') { e.preventDefault(); setCollectHi(h => Math.min(h + 1, collectMatches.length - 1)); }
                    else if (e.key === 'ArrowUp') { e.preventDefault(); setCollectHi(h => Math.max(h - 1, -1)); }
                    else if (e.key === 'Escape') { setCollectMatches([]); setCollectHi(-1); }
                    else if (e.key === 'Enter') { doCollectByBS(collectHi >= 0 ? collectMatches[collectHi].drNumber : undefined); }
                  }} />
                {collectMatches.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 30, background: 'var(--card, #fff)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.12)', marginTop: 4, overflow: 'hidden' }}>
                    {collectMatches.map((m, i) => (
                      <div key={m.drNumber} onMouseDown={e => { e.preventDefault(); doCollectByBS(m.drNumber); }}
                        style={{ padding: '7px 12px', fontSize: 13, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', gap: 10, background: i === collectHi ? 'var(--border-light)' : undefined }}>
                        <b>{m.drNumber}{m.lrNumber ? ` / ${m.lrNumber}` : ''}</b>
                        <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{[m.consignor, m.consignee].filter(Boolean).join(' → ')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button className="btn btn-sm" style={{ background: 'var(--success, #0b8a4f)', color: '#fff' }} onClick={() => doCollectByBS()}><Check size={14} /> Collected</button>
            </div>
          </div>
          <div style={{ height: 18, marginBottom: 10, fontSize: 12.5, color: inlineMsg?.kind === 'error' ? 'var(--danger)' : 'var(--success, #0b8a4f)' }}>
            {inlineMsg?.text || ''}
          </div>

          <div style={{ display: 'flex', gap: 4, marginBottom: 10, borderBottom: '2px solid var(--border)' }}>
            {(['pending', 'collected'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                padding: '8px 16px', fontSize: 14, fontWeight: tab === t ? 700 : 500, background: 'none', border: 'none', cursor: 'pointer',
                color: tab === t ? 'var(--orange)' : 'var(--text-muted)', borderBottom: tab === t ? '2px solid var(--orange)' : '2px solid transparent', marginBottom: -2,
              }}>
                {t === 'pending' ? `Pending (${myPending.length})` : `Collected (${myCollected.length})`}
              </button>
            ))}
          </div>

          <div className="card" style={{ overflow: 'visible' }}>
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="data-table entries-table">
                {tableHead}
                <tbody>
                  {list.length === 0 ? (
                    <tr><td colSpan={6} style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                      {agent ? `No ${tab === 'pending' ? 'pending' : 'collected'} DR for ${agent.name}` : 'Select agent'}
                    </td></tr>
                  ) : list.slice(0, WASULI_CAP).map(r => renderRow(r))}
                </tbody>
              </table>
            </div>
            {/* "View all" bar — shown only when list exceeds the cap */}
            {list.length > WASULI_CAP && (
              <div
                onClick={() => { setModalQuery(''); setModalChallan('all'); setViewAll(true); }}
                style={{
                  textAlign: 'center', padding: '10px 0', cursor: 'pointer', fontWeight: 700, fontSize: 13,
                  background: '#FFF4EE', color: 'var(--orange)', borderTop: '1px solid var(--border)',
                  borderRadius: '0 0 var(--r-md) var(--r-md)',
                }}
              >
                View all {list.length} →
              </div>
            )}
          </div>
        </>
      )}

      {/* "View all" modal — full list with search + challan filter, same action handlers */}
      {viewAll && (
        <ViewAllModal
          title={`${agent?.name ?? ''} · ${tab === 'pending' ? 'Pending' : 'Collected'} — ${list.length}`}
          search={{ value: modalQuery, onChange: setModalQuery, placeholder: 'Search BS no. / party…' }}
          filter={challanOptions.length > 2 ? { value: modalChallan, onChange: setModalChallan, options: challanOptions } : undefined}
          onClose={() => setViewAll(false)}
        >
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table entries-table" style={{ width: '100%' }}>
              {tableHead}
              <tbody>
                {modalList.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', padding: '28px', color: 'var(--text-muted)', fontSize: 13 }}>No results</td></tr>
                ) : modalList.map(r => renderRow(r))}
              </tbody>
            </table>
          </div>
        </ViewAllModal>
      )}

      {collectTarget && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setCollectTarget(null); }}>
          <div className="confirm-modal" style={{ width: 380 }}>
            <div className="confirm-title">Payment collected?</div>
            <div className="confirm-body">
               <div style={{ background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '12px 14px', marginBottom: 14 }}>
                 <div style={{ fontWeight: 700 }}>{collectTarget.consigneeName}</div>
                 <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>BS {collectTarget.drNumber} · Challan #{collectTarget.challanNumber}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--orange)', marginTop: 4 }}>{formatINR(collectTarget.amountToCollect)}</div>
                {collectTarget.amountToCollect === 0 && (
                   <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 2 }}>(Crossing DR — nothing to collect)</div>
                 )}
              </div>
              <div className="form-group" style={{ marginBottom: 12 }}>
                <label className="form-label">Collection date</label>
                <input type="date" className="form-input" value={collectDate} onChange={e => setCollectDate(e.target.value)} />
              </div>
              {!skipRemark && (
                <div className="form-group" style={{ marginBottom: 10 }}>
                  <label className="form-label">Remark (optional)</label>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                    {['Cash', 'UPI', 'Card'].map(m => (
                      <button key={m} type="button"
                        className={remark.startsWith(m) ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
                        onClick={() => {
                          // Set/replace the leading method, keeping any extra text the
                          // user already typed after it. Tapping the active one clears it.
                          const methods = ['Cash', 'UPI', 'Card'];
                          const rest = methods.reduce((s, x) => s.startsWith(x) ? s.slice(x.length).replace(/^[\s—-]+/, '') : s, remark).trim();
                          setRemark(remark.startsWith(m) ? rest : (rest ? `${m} — ${rest}` : m));
                        }}>
                        {m}
                      </button>
                    ))}
                  </div>
                  <textarea className="form-input" style={{ minHeight: 54 }} placeholder="e.g. UPI — ref 4512, or cheque no..." value={remark} onChange={e => setRemark(e.target.value)} />
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={skipRemark} onChange={e => setSkipRemark(e.target.checked)} /> Don't ask for remark every time
              </label>
              <div className="form-hint" style={{ marginTop: 8 }}>The full amount will be marked collected (not partial).</div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setCollectTarget(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={confirmCollect}>Collected</button>
            </div>
          </div>
        </div>
      )}

      {reassignTarget && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setReassignTarget(null); }}>
          <div className="confirm-modal" style={{ width: 360 }}>
            <div className="confirm-title">Assign to which agent?</div>
            <div className="confirm-body">
              <select className="form-select" value={reassignOp} onChange={e => setReassignOp(Number(e.target.value))}>
                <option value={0}>Select agent...</option>
                {operators.filter(o => o.active && o.id !== reassignTarget.operatorId).map(o => <option key={o.id} value={o.id}>{o.name} · {fmtCode(o.code)}</option>)}
              </select>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setReassignTarget(null)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={doReassign} disabled={!reassignOp}>Reassign</button>
            </div>
          </div>
        </div>
      )}

      {cancelTarget && (
        <ConfirmModal title="Back to pool?" body={<><b>{cancelTarget.consigneeName}</b> will go back to the unassigned pool.</>} confirmLabel="Yes, remove" onConfirm={doCancel} onCancel={() => setCancelTarget(null)} danger />
      )}
      {uncollectTarget && (
        <ConfirmModal title="Back to pending?" body={<><b>{uncollectTarget.consigneeName}</b> 's collection will go back to pending.</>} confirmLabel="Yes, undo" onConfirm={doUncollect} onCancel={() => setUncollectTarget(null)} danger />
      )}

    </div>
  );
}
