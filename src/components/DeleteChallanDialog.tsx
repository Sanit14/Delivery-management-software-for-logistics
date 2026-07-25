import { useEffect, useRef, useState } from 'react';
import ConfirmModal from './ConfirmModal';
import { cascadeDeleteChallan } from '../db/database';
import type { Challan } from '../db/database';
import { useToast } from '../context/ToastContext';
import { formatINR } from '../utils/reportUtils';

interface Props {
  challan: Challan;
  onClose: () => void;
  /** Called ONLY after a real ok:true from the keeper, so the caller's list
   *  reload (or removal) always reflects server truth — never called on
   *  needsConfirm, error, or a thrown/network failure. */
  onDone: () => void;
}

const COLLECTED_CONFIRM_WORD = 'DELETE';

type Stage =
  | { kind: 'checking' }
  | { kind: 'assigned'; count: number }
  | { kind: 'collected'; count: number; amount: number };

/**
 * ONE shared delete flow, used by ChallanList, Dashboard, and SavedMemos.
 * The keeper's classify/confirm-token gate (engine.cjs cascadeDeleteChallanSync)
 * is the sole authority — this component just calls it, then reacts:
 *   - ok:true                    -> toast + onDone(), no dialog ever shown.
 *   - needsConfirm 'assigned'    -> CAUTION dialog -> confirm -> re-call with
 *                                   CONFIRM_ASSIGNED.
 *   - needsConfirm 'collected'   -> STRONG dialog, type-to-confirm -> re-call
 *                                   with CONFIRM_COLLECTED.
 *   - ok:false (other) or thrown -> error toast, onClose(). onDone() is never
 *     called on this path, so the caller's list is never touched before a real
 *     ok:true comes back from the keeper.
 */
export default function DeleteChallanDialog({ challan, onClose, onDone }: Props) {
  const { showToast } = useToast();
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const attempted = useRef(false);

  const attempt = async (confirm?: 'CONFIRM_ASSIGNED' | 'CONFIRM_COLLECTED') => {
    setBusy(true);
    try {
      const res = await cascadeDeleteChallan(challan.id!, confirm);
      if (res.ok) {
        showToast(`Challan #${challan.challanNumber} deleted`, 'success');
        onDone();
        onClose();
        return;
      }
      if (res.needsConfirm === 'assigned') {
        setStage({ kind: 'assigned', count: res.counts.assigned });
        setBusy(false);
        return;
      }
      if (res.needsConfirm === 'collected') {
        setStage({ kind: 'collected', count: res.counts.collected, amount: res.counts.collectedAmount });
        setBusy(false);
        return;
      }
      showToast(res.error || 'Delete failed', 'error');
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Delete failed', 'error');
      onClose();
    }
  };

  // Fire the no-token attempt once, on mount — this IS the "no dialog" clean
  // path: a challan with no locked wasuli deletes right here with no modal at
  // all. A dialog only appears if the keeper comes back with needsConfirm.
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (stage.kind === 'checking') return null;

  if (stage.kind === 'assigned') {
    const n = stage.count;
    return (
      <ConfirmModal
        title="Delete this challan?"
        danger
        body={
          <div style={{ background: '#FAEEDA', border: '1px solid #BA751740', borderRadius: 'var(--r-md)', padding: '10px 12px', color: '#854F0B', fontSize: 13 }}>
            Challan <b>#{challan.challanNumber}</b> has <b>{n}</b> assigned wasuli {n === 1 ? 'entry' : 'entries'} (given to an agent). Deleting removes {n === 1 ? 'it' : 'them'} too.
          </div>
        }
        confirmLabel={busy ? 'Deleting…' : 'Delete anyway'}
        cancelLabel="Cancel"
        confirmDisabled={busy}
        onConfirm={() => attempt('CONFIRM_ASSIGNED')}
        onCancel={onClose}
      />
    );
  }

  // stage.kind === 'collected'
  const { count: n, amount } = stage;
  const confirmed = confirmText.trim().toUpperCase() === COLLECTED_CONFIRM_WORD;
  return (
    <ConfirmModal
      title={`Delete challan #${challan.challanNumber}?`}
      danger
      confirmLabel={busy ? 'Deleting…' : 'Delete anyway'}
      cancelLabel="Cancel"
      confirmDisabled={busy || !confirmed}
      onConfirm={() => attempt('CONFIRM_COLLECTED')}
      onCancel={onClose}
      body={
        <>
          <div style={{ background: '#FBE4E1', border: '1px solid #C0392B40', borderRadius: 'var(--r-md)', padding: '10px 12px', color: '#96281B', fontSize: 13, marginBottom: 10 }}>
            Challan <b>#{challan.challanNumber}</b> has <b>{n}</b> COLLECTED wasuli {n === 1 ? 'entry' : 'entries'} — <b>{formatINR(amount)}</b> already received.
            Deleting permanently removes this cash record from all reports.
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Type {COLLECTED_CONFIRM_WORD} to delete</label>
            <input
              className="form-input"
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              placeholder={COLLECTED_CONFIRM_WORD}
              autoFocus
            />
          </div>
        </>
      }
    />
  );
}
