import { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';

/**
 * SeatBadge — shows this seat's name (e.g. "PC-01") in the corner, and on first
 * run asks the seat to name itself. The name is stored PER-SEAT (each seat has its
 * own), so the audit log can show which PC did what.
 *
 * Browser/dev (no window.sqlAPI.getSeatName) → renders nothing.
 */

function suggestDefault(): string {
  // A simple, predictable default the admin asked for: PC-01.
  return 'PC-01';
}

export default function SeatBadge() {
  const [name, setName] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState(suggestDefault());
  const [err, setErr] = useState('');

  useEffect(() => {
    const api = window.sqlAPI;
    if (!api?.getSeatName) { setName(''); return; } // not electron → no badge
    api.getSeatName().then(n => {
      if (n) setName(n);
      else { setName(''); setAsking(true); } // first run on this seat
    }).catch(() => setName(''));
  }, []);

  const save = async () => {
    const clean = draft.trim();
    if (!clean) { setErr('Please enter a name'); return; }
    const res = await window.sqlAPI?.setSeatName?.(clean);
    if (res && res.ok) { setName(clean); setAsking(false); setErr(''); }
    else setErr(res?.error || 'Not saved');
  };

  // Not electron, or no name context → render nothing.
  if (!name && !asking) return null;

  return (
    <>
      {name && (
        <div title="This computer's name (for audit)" style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, color: 'var(--text-secondary)', background: 'var(--card)',
          border: '0.5px solid var(--border)', borderRadius: 999, padding: '4px 10px',
        }}>
          <Monitor size={13} /> {name}
        </div>
      )}

      {asking && (
        <div className="modal-overlay">
          <div className="confirm-modal" style={{ width: 360 }}>
            <div className="confirm-title">Set Computer Name</div>
            <div className="confirm-body">
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
                Give each computer a unique name (e.g. PC-01, PC-02). This will only be asked once.
                It is used in the audit/history log — to track which PC performed which action.
              </div>
              <input className="form-input" autoFocus value={draft}
                onChange={e => { setDraft(e.target.value); setErr(''); }}
                onKeyDown={e => { if (e.key === 'Enter') save(); }} placeholder="PC-01" />
              {err && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 6 }}>{err}</div>}
            </div>
            <div className="confirm-actions">
              <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
