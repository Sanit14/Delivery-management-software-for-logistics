import { useEffect, useState } from 'react';
import { Merge, ArrowRight, RefreshCw, GitMerge } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import { useToast } from '../context/ToastContext';
import {
  findDuplicateGroups, mergeFieldFor, MERGE_TYPE_LABELS,
  type MergeType, type DuplicateGroup, type MergeCandidate,
  findDuplicateChallans, type DuplicateChallanGroup, type DuplicateChallanMember,
} from '../utils/masterData';

const TYPES: MergeType[] = ['firmName', 'station', 'truckNumber', 'consignor', 'consignee', 'operator'];
const TAB_CHALLANS = 'challans' as const;
type Tab = MergeType | typeof TAB_CHALLANS;

// One row in the merge confirm popup: which value keeps, which goes, and the
// per-table impact counts pulled live from the keeper before anything is written.
interface PendingMerge {
  type: MergeType;
  keep: MergeCandidate;
  remove: MergeCandidate;
  impact: Record<string, number> | null; // null = still loading counts
}

export default function MasterDataCleanup() {
  const { showToast } = useToast();
  const isElectron = typeof window !== 'undefined' && !!window.sqlAPI;

  const [tab, setTab] = useState<Tab>('firmName');
  const type = tab !== TAB_CHALLANS ? (tab as MergeType) : 'firmName'; // for master-data logic
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingMerge | null>(null);
  const [merging, setMerging] = useState(false);

  // Challan-duplicate tab state
  const [challanGroups, setChallanGroups] = useState<DuplicateChallanGroup[]>([]);
  const [challanLoading, setChallanLoading] = useState(false);
  const [pendingChallan, setPendingChallan] = useState<{
    keepMember: DuplicateChallanMember;
    removeMember: DuplicateChallanMember;
    firmName: string;
    challanNumber: string;
    eligibility: {
      ok: boolean;
      reason?: string;
      primaryCount?: number;
      primarySrMin?: number | null;
      primarySrMax?: number;
      secondaryCount?: number;
      secondaryDrCount?: number;
      secondaryPendingWasuli?: number;
      secondaryAssignedWasuli?: number;
      total?: number;
      resultSrMin?: number | null;
      resultSrMax?: number | null;
      isContiguous?: boolean;
      keepCount?: number;
      keepSrMin?: number | null;
      keepSrMax?: number;
      removeCount?: number;
    } | null;
  } | null>(null);
  const [mergingChallan, setMergingChallan] = useState(false);

  const scan = async (t: MergeType) => {
    setLoading(true);
    try { setGroups(await findDuplicateGroups(t)); }
    catch { setGroups([]); }
    setLoading(false);
  };

  const scanChallans = async () => {
    setChallanLoading(true);
    try { setChallanGroups(await findDuplicateChallans()); }
    catch { setChallanGroups([]); }
    setChallanLoading(false);
  };

  useEffect(() => {
    if (tab === TAB_CHALLANS) {
      scanChallans();
    } else {
      scan(tab as MergeType);
    }
  }, [tab]);

  // User picked which of two values to keep → fetch impact counts, then show popup.
  const askMerge = async (keep: MergeCandidate, remove: MergeCandidate) => {
    setPending({ type: tab as MergeType, keep, remove, impact: null });
    try {
      const impact = await window.sqlAPI!.mergeImpact!(mergeFieldFor(tab as MergeType), remove.key);
      setPending(p => (p ? { ...p, impact } : p));
    } catch {
      setPending(p => (p ? { ...p, impact: {} } : p));
    }
  };

  const doMerge = async () => {
    if (!pending) return;
    setMerging(true);
    try {
      await window.sqlAPI!.mergeMaster!(mergeFieldFor(pending.type), pending.remove.key, pending.keep.key);
      showToast('Merged ✓ — app is refreshing', 'success');
      setPending(null);
      await scan(pending.type); // refresh the list; other seats reload via db:changed
    } catch {
      showToast('Merge failed — try again', 'error');
    }
    setMerging(false);
  };

  const askChallanMerge = async (firmName: string, challanNumber: string, keep: DuplicateChallanMember, remove: DuplicateChallanMember) => {
    setPendingChallan({ firmName, challanNumber, keepMember: keep, removeMember: remove, eligibility: null });
    try {
      const eligibility = await window.sqlAPI!.challanMergeCheck!(keep.id, remove.id);
      if (!eligibility.ok) {
        const msg = eligibility.reason === 'has-collected'
          ? 'Cannot merge: one or more entries have collected wasuli'
          : `Cannot merge: ${eligibility.reason || 'Not eligible'}`;
        showToast(msg, 'error');
        setPendingChallan(null);
        return;
      }
      setPendingChallan(p => (p ? { ...p, eligibility } : p));
    } catch {
      showToast('Error checking challan merge eligibility', 'error');
      setPendingChallan(null);
    }
  };

  const doChallanMerge = async () => {
    if (!pendingChallan) return;
    setMergingChallan(true);
    try {
      const res = await window.sqlAPI!.mergeChallansDup!(pendingChallan.keepMember.id, pendingChallan.removeMember.id);
      if (res && res.ok) {
        showToast('Challans merged ✓ — app is refreshing', 'success');
        setPendingChallan(null);
        await scanChallans();
      } else {
        showToast(`Merge failed: ${res?.reason || 'Unknown error'}`, 'error');
      }
    } catch {
      showToast('Merge failed — try again', 'error');
    }
    setMergingChallan(false);
  };

  if (!isElectron) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Master-data cleanup is available in the desktop app.</p>;
  }

  const tableLabel = (t: string) =>
    ({ challans: 'challans', lrEntries: 'LR entries', drs: 'DRs', wasuli: 'wasuli', firmLedger: 'firm ledger' } as Record<string, string>)[t] || t;

  return (
    <div>
      {/* type tabs */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {TYPES.map(t => (
          <button
            key={t}
            className={`btn btn-sm ${t === tab ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setTab(t)}
          >
            {MERGE_TYPE_LABELS[t]}
          </button>
        ))}
        <button
          key={TAB_CHALLANS}
          className={`btn btn-sm ${tab === TAB_CHALLANS ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setTab(TAB_CHALLANS)}
        >
          <GitMerge size={13} style={{ marginRight: 4 }} /> Challans
        </button>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => (tab === TAB_CHALLANS ? scanChallans() : scan(tab as MergeType))}
          title="Re-scan"
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* MASTER DATA TABS */}
      {tab !== TAB_CHALLANS && (
        <>
          {loading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Scanning…</p>}

          {!loading && groups.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No likely duplicates found in {MERGE_TYPE_LABELS[type].toLowerCase()}. ✓
            </p>
          )}

          {!loading && groups.map((g, gi) => (
            <div key={gi} className="card" style={{ marginBottom: 10, padding: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>Possible duplicates:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {g.members.map((m, mi) => (
                  <span key={mi} style={{
                    fontSize: 13, padding: '3px 10px', borderRadius: 6,
                    background: 'var(--surface-2, #f3f4f6)', border: '1px solid var(--border, #e5e7eb)',
                  }}>
                    <b>{m.value}</b> <span style={{ color: 'var(--text-muted)' }}>({m.useCount} uses)</span>
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {g.members.slice(1).map((m, mi) => (
                  <button key={mi} className="btn btn-sm btn-outline" onClick={() => askMerge(g.members[0], m)}>
                    <Merge size={13} /> Merge "{m.value}" <ArrowRight size={12} /> "{g.members[0].value}"
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {/* CHALLANS TAB */}
      {tab === TAB_CHALLANS && (
        <>
          {challanLoading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Scanning for duplicate challans…</p>}

          {!challanLoading && challanGroups.length === 0 && (
            <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              No duplicate challans found. ✓
            </p>
          )}

          {!challanLoading && challanGroups.map((cg, cgi) => {
            // Sort members so winner (default: highest entryCount) is first
            const sortedMembers = [...cg.members].sort((a, b) => b.entryCount - a.entryCount);
            const winner = sortedMembers[0];
            const losers = sortedMembers.slice(1);

            return (
              <div key={cgi} className="card" style={{ marginBottom: 14, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>
                    Firm: <span style={{ color: 'var(--text-primary)' }}>{cg.firmName}</span> · Challan #{cg.challanNumber}
                  </div>
                  {cg.mergeable ? (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: '#dcfce7', color: '#15803d', border: '1px solid #bbf7d0' }}>
                      Can merge
                    </span>
                  ) : cg.blockedReason === 'has-collected' ? (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' }}>
                      Collected cash
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: '#fef3c7', color: '#b45309', border: '1px solid #fde68a' }}>
                      Reopen first
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
                  {sortedMembers.map((m, mi) => {
                    const isWinner = cg.mergeable && mi === 0;
                    return (
                      <div key={m.id} style={{
                        padding: 10, borderRadius: 8,
                        background: 'var(--surface-2, #f9fafb)',
                        border: isWinner ? '2px solid var(--border-accent, #3b82f6)' : '1px solid var(--border, #e5e7eb)',
                        position: 'relative'
                      }}>
                        {cg.mergeable && (
                          <span style={{
                            position: 'absolute', top: 6, right: 8, fontSize: 11, fontWeight: 700,
                            color: isWinner ? '#2563eb' : 'var(--text-muted)'
                          }}>
                            {isWinner ? 'Keeps' : 'Folds in'}
                          </span>
                        )}
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>
                          ID #{m.id} · {m.createdSeat ? `Seat: ${m.createdSeat}` : 'Unknown seat'} · Status: <b style={{ color: 'var(--text-primary)' }}>{m.status}</b>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                          <div>Entries: <b>{m.entryCount}</b> {m.entryCount > 0 && `(Sr ${m.srRange})`}</div>
                          <div>Truck: <b>{m.truckNumber || '—'}</b></div>
                          <div>Station: <b>{m.loadingStation || '—'}</b></div>
                          <div>Date: <b>{m.loadingDate || '—'}</b></div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {cg.mergeable ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border, #e5e7eb)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {(() => {
                        const totalEntries = cg.members.reduce((s, m) => s + m.entryCount, 0);
                        const isContiguous = winner.srMin === 1 && winner.srMax === winner.entryCount;
                        const resultingMax = (winner.srMax || 0) + losers.reduce((s, l) => s + l.entryCount, 0);
                        return (
                          <>
                            Result: <b>{totalEntries}</b> entries
                            {totalEntries > 0 && (isContiguous ? `, Sr 1–${resultingMax}` : ` (max Sr ${resultingMax})`)}
                          </>
                        );
                      })()}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {losers.map((loser) => (
                        <button key={loser.id} className="btn btn-sm btn-outline" onClick={() => askChallanMerge(cg.firmName, cg.challanNumber, winner, loser)}>
                          <GitMerge size={13} /> Merge ID #{loser.id} into ID #{winner.id}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic' }}>
                    {cg.blockedReason === 'has-collected'
                      ? 'One or more entries have collected wasuli and cannot be merged.'
                      : 'One or both challans are saved/cancelled. Reopen both challans first to enable merging.'}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* MASTER DATA MERGE MODAL */}
      {pending && (
        <ConfirmModal
          title="Confirm merge"
          danger
          confirmLabel={merging ? 'Merging…' : 'Yes, merge'}
          cancelLabel="Cancel"
          onCancel={() => { if (!merging) setPending(null); }}
          onConfirm={() => { if (!merging) doMerge(); }}
          body={
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              Merge <b>"{pending.remove.value}"</b> <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> <b>"{pending.keep.value}"</b>
              <div style={{ marginTop: 10 }}>
                {pending.impact === null ? (
                  <span style={{ color: 'var(--text-muted)' }}>Checking how many records will change…</span>
                ) : Object.keys(pending.impact).length === 0 ? (
                  <span style={{ color: 'var(--text-muted)' }}>
                    No transactional records reference "{pending.remove.value}"; only the master entry will be removed.
                  </span>
                ) : (
                  <>
                    This will update:
                    <ul style={{ margin: '6px 0 0 18px' }}>
                      {Object.entries(pending.impact).map(([t, n]) => (
                        <li key={t}>{n} {tableLabel(t)}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div style={{ marginTop: 10 }}>
                "{pending.remove.value}" will be removed. Combined use count:{' '}
                {pending.keep.useCount} + {pending.remove.useCount} = {pending.keep.useCount + pending.remove.useCount}.
              </div>
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
                A safety backup is taken automatically before merging. This can only be undone by restoring that backup.
              </div>
            </div>
          }
        />
      )}

      {/* CHALLAN MERGE MODAL */}
      {pendingChallan && (
        <ConfirmModal
          title="Confirm Challan Merge"
          danger
          confirmLabel={mergingChallan ? 'Merging…' : 'Yes, merge challans'}
          cancelLabel="Cancel"
          onCancel={() => { if (!mergingChallan) setPendingChallan(null); }}
          onConfirm={() => { if (!mergingChallan) doChallanMerge(); }}
          body={
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              <div style={{ marginBottom: 10 }}>
                Merging duplicate challans for <b>{pendingChallan.firmName}</b> (Challan #{pendingChallan.challanNumber}):
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12, fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface-2, #f3f4f6)', borderBottom: '1px solid var(--border, #e5e7eb)' }}>
                    <th style={{ padding: '6px', textAlign: 'left' }}>Field</th>
                    <th style={{ padding: '6px', textAlign: 'left', color: '#2563eb' }}>Winner (ID #{pendingChallan.keepMember.id})</th>
                    <th style={{ padding: '6px', textAlign: 'left', color: '#dc2626' }}>Loser (ID #{pendingChallan.removeMember.id})</th>
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>Entries</td>
                    <td style={{ padding: '6px' }}>{pendingChallan.keepMember.entryCount} (Sr {pendingChallan.keepMember.srRange})</td>
                    <td style={{ padding: '6px' }}>{pendingChallan.removeMember.entryCount} (Sr {pendingChallan.removeMember.srRange})</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>Truck</td>
                    <td style={{ padding: '6px' }}>{pendingChallan.keepMember.truckNumber || '—'}</td>
                    <td style={{ padding: '6px', color: 'var(--text-muted)' }}>{pendingChallan.removeMember.truckNumber || '—'}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>Station</td>
                    <td style={{ padding: '6px' }}>{pendingChallan.keepMember.loadingStation || '—'}</td>
                    <td style={{ padding: '6px', color: 'var(--text-muted)' }}>{pendingChallan.removeMember.loadingStation || '—'}</td>
                  </tr>
                  <tr style={{ borderBottom: '1px solid var(--border, #f3f4f6)' }}>
                    <td style={{ padding: '6px', fontWeight: 600 }}>Date</td>
                    <td style={{ padding: '6px' }}>{pendingChallan.keepMember.loadingDate || '—'}</td>
                    <td style={{ padding: '6px', color: 'var(--text-muted)' }}>{pendingChallan.removeMember.loadingDate || '—'}</td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px', fontWeight: 600 }}>Truck Hire</td>
                    <td style={{ padding: '6px' }}>₹{pendingChallan.keepMember.truckHire}</td>
                    <td style={{ padding: '6px', color: 'var(--text-muted)' }}>₹{pendingChallan.removeMember.truckHire}</td>
                  </tr>
                </tbody>
              </table>

              {pendingChallan.eligibility && (
                <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', padding: 10, borderRadius: 6, color: '#166534', marginBottom: 10, fontSize: 12, lineHeight: 1.5 }}>
                  <div>
                    <b>ID #{pendingChallan.removeMember.id}</b>'s {pendingChallan.removeMember.entryCount} entries will be appended
                    {pendingChallan.keepMember.entryCount > 0
                      ? ` starting at Sr ${(pendingChallan.eligibility.keepSrMax || 0) + 1}–${(pendingChallan.eligibility.keepSrMax || 0) + (pendingChallan.eligibility.removeCount || 0)}`
                      : ` (Sr 1–${pendingChallan.eligibility.removeCount || 1})`}
                    . Total: {pendingChallan.eligibility.total} entries
                    {pendingChallan.eligibility.isContiguous ? ` (Sr 1–${pendingChallan.eligibility.resultSrMax})` : ` (max Sr ${pendingChallan.eligibility.resultSrMax})`}.
                  </div>
                  {((pendingChallan.eligibility.secondaryDrCount || 0) > 0 || (pendingChallan.eligibility.secondaryPendingWasuli || 0) > 0 || (pendingChallan.eligibility.secondaryAssignedWasuli || 0) > 0) && (
                    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #bbf7d0' }}>
                      <b>Re-parenting records from ID #{pendingChallan.removeMember.id}:</b>
                      <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                        {(pendingChallan.eligibility.secondaryDrCount || 0) > 0 && (
                          <li>{pendingChallan.eligibility.secondaryDrCount} DR(s) (BS numbers preserved)</li>
                        )}
                        {((pendingChallan.eligibility.secondaryPendingWasuli || 0) > 0 || (pendingChallan.eligibility.secondaryAssignedWasuli || 0) > 0) && (
                          <li>
                            {(pendingChallan.eligibility.secondaryPendingWasuli || 0) + (pendingChallan.eligibility.secondaryAssignedWasuli || 0)} Wasuli row(s):{' '}
                            {pendingChallan.eligibility.secondaryPendingWasuli || 0} pending, {pendingChallan.eligibility.secondaryAssignedWasuli || 0} assigned (agent assignments preserved)
                          </li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              <ul style={{ margin: '0 0 10px 18px', padding: 0, color: 'var(--text-muted)', fontSize: 12 }}>
                <li>Challan ID #{pendingChallan.removeMember.id} will be removed; its header fields (truck, station, date, hire) are discarded.</li>
                <li>Neither challan is saved yet, so no BS numbers or firm ledger rows exist to reconcile.</li>
              </ul>

              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                A safety backup is taken automatically before merging.
              </div>
            </div>
          }
        />
      )}
    </div>
  );
}
