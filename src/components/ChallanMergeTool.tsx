import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { db, seatName, logAudit } from '../db/database';
import type { Challan } from '../db/database';
import { useToast } from '../context/ToastContext';

interface SlotInfo {
  challan: Challan;
  entryCount: number;
  srMax: number;
  assignedCount: number;
  collectedCount: number;
}

async function loadSlotInfo(challan: Challan): Promise<SlotInfo> {
  const entries = await db.lrEntries.filter(e => e.challanId === challan.id && e.status === 'active' && !e.deletedAt).toArray();
  const wasuli = await db.wasuli.filter(w => w.challanId === challan.id && !w.deletedAt).toArray();
  const srNos = entries.map(e => e.srNo);
  return {
    challan,
    entryCount: entries.length,
    srMax: srNos.length ? Math.max(...srNos) : 0,
    assignedCount: wasuli.filter(w => w.status !== 'collected' && w.operatorId !== 0).length,
    collectedCount: wasuli.filter(w => w.status === 'collected').length,
  };
}

// Same firm + same challan number is the only thing that makes two memos a
// merge candidate — no fuzzy matching, this is deterministic. Any status
// combination is eligible (open+open, open+saved, saved+saved) — a saved side
// gets reopened automatically to run the merge, then the result is saved
// straight back, so the operator never sees an intermediate draft. A memo is
// only pickable here if every one of its entries is still unassigned; that's
// the real office rule (assignment always happens after merge, never before),
// stricter than the backend's own "not collected" gate.
export default function ChallanMergeTool({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Challan[]>([]);
  const [slots, setSlots] = useState<[SlotInfo | null, SlotInfo | null]>([null, null]);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    (async () => {
      const q = query.trim().toLowerCase();
      const all = await db.challans.filter(c => !c.deletedAt && (c.status === 'saved' || c.status === 'open')).toArray();
      setResults(all.filter(c => c.firmName.toLowerCase().includes(q) || c.challanNumber.includes(query.trim())).slice(0, 8));
    })();
  }, [query]);

  const pick = async (c: Challan) => {
    const info = await loadSlotInfo(c);
    setSlots(([a, b]) => (!a || a.challan.id === c.id) ? [info, b] : [a, info]);
    setQuery(''); setResults([]);
  };

  const clearSlot = (i: 0 | 1) => setSlots(s => { const next: [SlotInfo | null, SlotInfo | null] = [...s]; next[i] = null; return next; });

  const [a, b] = slots;
  const ineligible = (s: SlotInfo) =>
    s.assignedCount > 0 ? `${s.assignedCount} entr${s.assignedCount === 1 ? 'y' : 'ies'} already assigned`
    : s.collectedCount > 0 ? 'has collected cash'
    : null;

  const sameFirm = !!a && !!b && a.challan.firmName.trim().toLowerCase() === b.challan.firmName.trim().toLowerCase();
  const sameNumber = !!a && !!b && a.challan.challanNumber.trim() === b.challan.challanNumber.trim();
  const bothClean = !!a && !!b && !ineligible(a) && !ineligible(b);
  const ready = sameFirm && sameNumber && bothClean;
  const resultSr = a && b ? a.srMax + b.entryCount : 0;
  const eitherSaved = !!a && !!b && (a.challan.status === 'saved' || b.challan.status === 'saved');

  const doMerge = async () => {
    if (!a || !b || !ready) return;
    setMerging(true);
    try {
      const seat = await seatName();
      const res = await window.sqlAPI!.mergeChallansDup!(a.challan.id!, b.challan.id!, seat);
      if (res && res.ok) {
        await logAudit({
          action: 'merge', drNumber: `#${a.challan.challanNumber}`, party: a.challan.firmName,
          detail: res.backupPath || '',
        });
        showToast('Challans merged ✓', 'success');
        onDone();
        onClose();
        navigate(`/memo/${a.challan.id}/view`);
      } else {
        showToast(`Merge failed: ${res?.reason || 'Unknown error'}`, 'error');
      }
    } catch {
      showToast('Merge failed — try again', 'error');
    }
    setMerging(false);
  };

  const slotCard = (s: SlotInfo | null, i: 0 | 1) => {
    const reason = s ? ineligible(s) : null;
    return (
      <div style={{
        border: `0.5px solid ${reason ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 10, padding: 10, minHeight: 78,
        background: reason ? 'var(--danger-bg)' : undefined,
      }}>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 4 }}>{i === 0 ? 'FIRST' : 'SECOND'}</div>
        {!s ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Search and pick a challan</div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>#{s.challan.challanNumber} <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>{s.challan.status === 'saved' ? '· saved' : '· draft'}</span></div>
              <button className="btn-icon" style={{ width: 20, height: 20 }} onClick={() => clearSlot(i)} aria-label="Remove"><X size={12} /></button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{s.challan.firmName} · {s.entryCount} entries</div>
            {reason ? (
              <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>{reason} — pick a different one</div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--success, #0b8a4f)', marginTop: 6 }}>All unassigned{i === 0 ? ' · will keep this one' : ''}</div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="confirm-modal" style={{ width: 480 }}>
        <div className="confirm-title">Merge two challans</div>
        <div className="confirm-body">
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input className="form-input" style={{ paddingLeft: 32 }} placeholder="Firm or challan no..." value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          {results.length > 0 && (
            <div style={{ border: '0.5px solid var(--border)', borderRadius: 8, overflow: 'hidden', marginBottom: 10, maxHeight: 220, overflowY: 'auto' }}>
              {results.map(c => (
                <div key={c.id} onClick={() => pick(c)}
                  style={{ padding: '8px 12px', fontSize: 12.5, display: 'flex', justifyContent: 'space-between', cursor: 'pointer', borderTop: '0.5px solid var(--border)' }}>
                  <span><b>#{c.challanNumber}</b> · {c.firmName} <span style={{ color: 'var(--text-muted)' }}>{c.status === 'saved' ? '· saved' : '· draft'}</span></span>
                  <span style={{ color: 'var(--text-muted)' }}>{c.totalEntries} entries</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
            {slotCard(a, 0)}
            {slotCard(b, 1)}
          </div>

          {a && b && (!sameFirm || !sameNumber) && (
            <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>
              {!sameFirm ? "Different firms — these aren't the same challan." : "Different challan numbers — these aren't the same challan."}
            </div>
          )}
          {ready && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {a!.entryCount} entries + {b!.entryCount} entries &rarr; <b style={{ color: 'var(--text-primary)' }}>{a!.entryCount + b!.entryCount} entries, Sr 1&ndash;{resultSr}</b>.
              {eitherSaved && ' A saved side reopens automatically to do this, then saves straight back — BS numbers stay as they are.'}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>A safety backup is taken automatically first — restorable later from History if this was a mistake.</div>
            </div>
          )}
        </div>
        <div className="confirm-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!ready || merging} onClick={doMerge}>{merging ? 'Merging…' : 'Merge'}</button>
        </div>
      </div>
    </div>
  );
}
