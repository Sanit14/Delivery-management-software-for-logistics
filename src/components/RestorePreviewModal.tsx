import { useState } from 'react';
import ConfirmModal from './ConfirmModal';
import type { RestoreSummary, RestoreForce } from '../db/sqlClient';
import { formatDate } from '../utils/reportUtils';

interface Props {
  incoming: RestoreSummary;
  live: RestoreSummary;
  onConfirm: (force: RestoreForce) => void;
  onCancel: () => void;
  busy?: boolean;
}

const row = (label: string, incoming: number, live: number) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0' }}>
    <span>{label}</span>
    <span><b>{incoming.toLocaleString('en-IN')}</b> <span style={{ color: 'var(--text-muted)' }}>(currently: {live.toLocaleString('en-IN')})</span></span>
  </div>
);

const EMPTY_CONFIRM_WORD = 'EMPTY';

// Shown before EVERY restore and import — not only when the file looks
// suspicious. The operator makes the final call; this only makes sure they see
// what they're about to replace before it happens.
//
// When the incoming backup has ZERO business rows, a click alone is not enough
// — the operator must type EMPTY_CONFIRM_WORD before the button un-disables,
// and the resulting confirm sends the distinct 'CONFIRM_EMPTY' signal (checked
// again, for real, by the keeper in engine.cjs restoreFromBytes) instead of the
// same plain `true` a normal restore uses.
export default function RestorePreviewModal({ incoming, live, onConfirm, onCancel, busy }: Props) {
  const isEmpty = incoming.total === 0;
  const [confirmText, setConfirmText] = useState('');
  const confirmed = !isEmpty || confirmText.trim().toUpperCase() === EMPTY_CONFIRM_WORD;

  return (
    <ConfirmModal
      title="Restore from this backup?"
      danger
      confirmLabel={busy ? 'Restoring…' : 'Restore anyway'}
      cancelLabel="Cancel"
      confirmDisabled={busy || !confirmed}
      onConfirm={() => onConfirm(isEmpty ? 'CONFIRM_EMPTY' : true)}
      onCancel={onCancel}
      body={
        <>
          {isEmpty && (
            <div style={{ color: 'var(--danger)', fontWeight: 700, marginBottom: 10 }}>
              This backup is EMPTY. It contains no challans, memos or DRs.
            </div>
          )}
          <div style={{ marginBottom: 8 }}>Restoring this backup will replace all current data.</div>
          <div style={{ fontSize: 13, lineHeight: 1.7, background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '10px 14px' }}>
            {row('Challans', incoming.challans, live.challans)}
            {row('Memos', incoming.memos, live.memos)}
            {row('DRs', incoming.drs, live.drs)}
            {row('Firms', incoming.firms, live.firms)}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '2px 0' }}>
              <span>Newest record</span>
              <b>{incoming.newestDate ? formatDate(incoming.newestDate) : '—'}</b>
            </div>
          </div>
          {isEmpty && (
            <div className="form-group" style={{ marginTop: 10, marginBottom: 0 }}>
              <label className="form-label">Type {EMPTY_CONFIRM_WORD} to restore this empty backup anyway</label>
              <input
                className="form-input"
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder={EMPTY_CONFIRM_WORD}
                autoFocus
              />
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            A safety backup of the current data is created automatically before restoring.
          </div>
        </>
      }
    />
  );
}
