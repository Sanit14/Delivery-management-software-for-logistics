import { useEffect, useState } from 'react';
import { ShieldAlert, RotateCcw, FolderOpen } from 'lucide-react';
import type { RestoreSummary, RestoreForce } from '../db/sqlClient';
import RestorePreviewModal from './RestorePreviewModal';

interface SafeInfo {
  active: boolean;
  reason?: string;
  opened?: { total: number };
  lastGood?: { total: number; at: string; root: string } | null;
}
interface BackupRow { file: string; path: string; kind: string; size: number; mtime: number; locations?: string[]; }

// Full-screen screen shown ONLY when the keeper's blank-DB guard trips: the
// database opened empty but we previously had data. The live file is NOT
// overwritten. The office can pick a backup and restore, or hand it to the admin.
// This turns the incident from "silent blank + panic" into "guided recovery".
export default function SafeModeScreen({ info }: { info: SafeInfo }) {
  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState('');
  // Set once a candidate file has passed structural validation and is waiting
  // on the operator to confirm what it will replace — see RestorePreviewModal.
  const [preview, setPreview] = useState<{ b: BackupRow; incoming: RestoreSummary; live: RestoreSummary } | null>(null);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.sqlAPI : undefined;
    if (!api?.listBackups) return;
    api.listBackups().then(setBackups).catch(() => setBackups([]));
  }, []);

  const fmtDate = (ms: number) => new Date(ms).toLocaleString();
  const fmtSize = (b: number) => b > 1024 * 1024 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

  // Step 1: validate the file and show the operator what it contains vs. what's
  // live, before anything is replaced — every restore, not only suspicious ones.
  const startRestore = async (b: BackupRow) => {
    const api = window.sqlAPI;
    if (!api?.restoreBackup) return;
    setRestoring(b.file); setError('');
    try {
      const r = await api.restoreBackup(b.path);
      if (r.ok) { window.location.reload(); return; } // shouldn't happen without force
      if (r.needsConfirm) setPreview({ b, incoming: r.incoming, live: r.live });
      else setError(r.error || 'Restore failed');
    } catch { setError('Restore failed — try another backup or contact admin'); }
    setRestoring(null);
  };

  // Step 2: operator confirmed — proceed with the actual replace. `force` is
  // whatever RestorePreviewModal decided: `true` for a normal restore, or the
  // distinct 'CONFIRM_EMPTY' signal when the operator typed the confirm word
  // for a zero-row backup.
  const confirmRestore = async (force: RestoreForce) => {
    if (!preview) return;
    const api = window.sqlAPI;
    if (!api?.restoreBackup) return;
    setRestoring(preview.b.file); setError('');
    try {
      const r = await api.restoreBackup(preview.b.path, force);
      if (r.ok) { window.location.reload(); return; }
      setError(('error' in r && r.error) || 'Restore failed');
    } catch { setError('Restore failed — try another backup or contact admin'); }
    setPreview(null);
    setRestoring(null);
  };

  const root = info.lastGood?.root || '';
  const had = info.lastGood?.total ?? 0;

  return (
    <div style={{ minHeight: '100vh', background: '#fff8f5', padding: '32px 20px', overflowY: 'auto' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <ShieldAlert size={28} color="#dc2626" />
          <h1 style={{ fontSize: 20, fontWeight: 800, color: '#7f1d1d', margin: 0 }}>Data safety check — please read</h1>
        </div>
        <p style={{ fontSize: 14, color: '#4a5f5b', lineHeight: 1.6 }}>
          The database opened <b>empty (0 records)</b>, but this computer previously had{' '}
          <b>{had} records</b>. To protect your data, the app has <b>not</b> changed the file and has
          paused here instead of opening blank. Your backups are safe. Pick a backup below to restore,
          or call your administrator.
        </p>

        <div style={{ background: '#fff', border: '1px solid #f0d9d0', borderRadius: 10, padding: '12px 16px', margin: '14px 0', fontSize: 12.5, color: '#4a5f5b' }}>
          <div><b>Data folder:</b> <span style={{ wordBreak: 'break-all' }}>{root || '(unknown)'}</span></div>
          <div><b>Last known good:</b> {had} records {info.lastGood?.at ? `on ${new Date(info.lastGood.at).toLocaleString()}` : ''}</div>
          <div><b>Opened now:</b> {info.opened?.total ?? 0} records</div>
        </div>

        {error && <div style={{ color: '#dc2626', fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{error}</div>}

        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#144D52', margin: '18px 0 8px' }}>Available backups</h2>
        {backups.length === 0 && (
          <p style={{ fontSize: 13, color: '#4a5f5b' }}>
            No backups were found in the known folders. Contact your administrator — a backup may exist
            on a pendrive or another drive that needs to be added first.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {backups.map(b => (
            <div key={b.file} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#144D52' }}>
                  {fmtDate(b.mtime)} <span style={{ fontSize: 11, fontWeight: 500, color: '#6b7280' }}>· {b.kind} · {fmtSize(b.size)}</span>
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', wordBreak: 'break-all' }}>{b.file}</div>
              </div>
              <button
                onClick={() => startRestore(b)}
                disabled={!!restoring}
                style={{ background: '#E66C32', color: '#fff', border: 'none', borderRadius: 7, padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: restoring ? 'default' : 'pointer', opacity: restoring ? 0.6 : 1, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
              >
                <RotateCcw size={14} /> {restoring === b.file ? 'Restoring…' : 'Restore this'}
              </button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={() => window.sqlAPI?.pickRestoreFile?.().then(r => { if (!r.canceled && r.path) startRestore({ file: r.path.split(/[\\/]/).pop() || r.path, path: r.path, kind: 'file', size: 0, mtime: Date.now() }); })}
            style={{ background: '#fff', color: '#144D52', border: '1px solid #144D52', borderRadius: 7, padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <FolderOpen size={14} /> Choose a backup file…
          </button>
        </div>
      </div>

      {preview && (
        <RestorePreviewModal
          incoming={preview.incoming}
          live={preview.live}
          busy={!!restoring}
          onConfirm={confirmRestore}
          onCancel={() => { setPreview(null); setRestoring(null); }}
        />
      )}
    </div>
  );
}
