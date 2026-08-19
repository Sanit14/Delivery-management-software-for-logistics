import { AlertTriangle } from 'lucide-react';

// A save that failed to reach disk is money/data at risk — this is the one modal
// in the app with no Cancel and no backdrop-dismiss. The overlay has no onClick,
// so there is no way to click past it; Retry is the only way out. Callers must
// also add its open-state to their "any overlay open" check so Escape doesn't
// slip past it and clear the form underneath.
interface Props {
  detail?: string;
  onRetry: () => void;
}

export default function SaveFailedModal({ detail, onRetry }: Props) {
  return (
    <div className="modal-overlay">
      <div className="confirm-modal" style={{ border: '2px solid var(--danger)' }}>
        <div className="confirm-title" style={{ color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={18} /> Save failed
        </div>
        <div className="confirm-body">
          <b>Your data is still here — nothing was lost.</b> {detail || 'It could not be saved to disk.'} Check the disk / network, then press Retry.
        </div>
        <div className="confirm-actions">
          <button className="btn btn-danger btn-sm" onClick={onRetry} autoFocus>Retry</button>
        </div>
      </div>
    </div>
  );
}
