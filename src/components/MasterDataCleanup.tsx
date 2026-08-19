import { useEffect, useState } from 'react';
import { Merge, ArrowRight, RefreshCw } from 'lucide-react';
import ConfirmModal from './ConfirmModal';
import { useToast } from '../context/ToastContext';
import {
  findDuplicateGroups, mergeFieldFor, MERGE_TYPE_LABELS,
  type MergeType, type DuplicateGroup, type MergeCandidate,
} from '../utils/masterData';

const TYPES: MergeType[] = ['firmName', 'station', 'truckNumber'];

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

  const [tab, setTab] = useState<MergeType>('firmName');
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<PendingMerge | null>(null);
  const [merging, setMerging] = useState(false);

  const scan = async (t: MergeType) => {
    setLoading(true);
    try { setGroups(await findDuplicateGroups(t)); }
    catch { setGroups([]); }
    setLoading(false);
  };

  useEffect(() => { scan(tab); }, [tab]);

  // User picked which of two values to keep → fetch impact counts, then show popup.
  const askMerge = async (keep: MergeCandidate, remove: MergeCandidate) => {
    setPending({ type: tab, keep, remove, impact: null });
    try {
      const impact = await window.sqlAPI!.mergeImpact!(mergeFieldFor(tab), remove.key);
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
          className="btn btn-sm btn-ghost"
          onClick={() => scan(tab)}
          title="Re-scan"
          style={{ marginLeft: 'auto' }}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {loading && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Scanning…</p>}

      {!loading && groups.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No likely duplicates found in {MERGE_TYPE_LABELS[tab].toLowerCase()}. ✓
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
    </div>
  );
}
