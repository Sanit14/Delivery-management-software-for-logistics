import { useEffect, useState } from 'react';
import { Trash2, AlertTriangle, X } from 'lucide-react';
import { db, sqlClient } from '../db/database';
import { useToast } from '../context/ToastContext';

/**
 * SelectiveCleanup — a two-stage modal for safely clearing chosen data categories.
 * Stage 1: pick categories (with live counts). Stage 2: confirm with a cascade summary.
 * Cascade-aware: deleting Challans also removes their entries, DRs and wasuli.
 * Uses only existing db table .clear()/delete — does not change app architecture.
 */

type Category = 'challans' | 'drs' | 'wasuli' | 'firmLedger' | 'firms' | 'stations' | 'trucks' | 'operators';

interface CatDef { id: Category; label: string; desc: string; }

const CATEGORIES: CatDef[] = [
  { id: 'challans', label: 'Challans / Memos', desc: 'Their entries, DRs and wasuli will be removed too' },
  { id: 'drs', label: 'DRs (Delivery Receipts)', desc: 'DR records only' },
  { id: 'wasuli', label: 'Wasuli Records', desc: 'Assign + collected wasuli' },
  { id: 'firmLedger', label: 'Firm Accounts (Ledger)', desc: 'Settlement / ledger entries' },
  { id: 'firms', label: 'Firms (Master Data)', desc: 'Firm name + codes' },
  { id: 'stations', label: 'Stations (Master Data)', desc: 'Station name + codes' },
  { id: 'trucks', label: 'Trucks (Master Data)', desc: 'Truck list' },
  { id: 'operators', label: 'Agents', desc: 'Agent list + codes' },
];

export default function SelectiveCleanup({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { showToast } = useToast();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Set<Category>>(new Set());
  const [stage, setStage] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [challans, lrEntries, drs, wasuli, firmLedger, operators, masterData] = await Promise.all([
        db.challans.filter(c => !c.deletedAt).count(),
        db.lrEntries.count(),
        db.drs.filter(d => !d.deletedAt).count(),
        db.wasuli.filter(w => !w.deletedAt).count(),
        db.firmLedger.count(),
        db.operators.count(),
        db.masterData.toArray(),
      ]);
      setCounts({
        challans, lrEntries, drs, wasuli, firmLedger, operators,
        firms: masterData.filter(m => m.field === 'firmName').length,
        stations: masterData.filter(m => m.field === 'loadingStation').length,
        trucks: masterData.filter(m => m.field === 'truckNumber').length,
      });
    })();
  }, []);

  const toggle = (id: Category) => setPicked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const countFor = (id: Category) => counts[id] ?? 0;

  // Build the cascade summary lines for the confirm stage
  const summaryLines = (): { label: string; n: number }[] => {
    const lines: { label: string; n: number }[] = [];
    if (picked.has('challans')) {
      lines.push({ label: 'Challans / Memos', n: counts.challans || 0 });
      lines.push({ label: '↳ their entries', n: counts.lrEntries || 0 });
      lines.push({ label: '↳ their DRs', n: counts.drs || 0 });
      lines.push({ label: '↳ their wasuli', n: counts.wasuli || 0 });
      lines.push({ label: '↳ firm ledger', n: counts.firmLedger || 0 });
    } else {
      if (picked.has('drs')) lines.push({ label: 'DRs', n: counts.drs || 0 });
      if (picked.has('wasuli')) lines.push({ label: 'Wasuli records', n: counts.wasuli || 0 });
      if (picked.has('firmLedger')) lines.push({ label: 'Firm ledger', n: counts.firmLedger || 0 });
    }
    if (picked.has('firms')) lines.push({ label: 'Firms (master)', n: counts.firms || 0 });
    if (picked.has('stations')) lines.push({ label: 'Stations (master)', n: counts.stations || 0 });
    if (picked.has('trucks')) lines.push({ label: 'Trucks (master)', n: counts.trucks || 0 });
    if (picked.has('operators')) lines.push({ label: 'Agents', n: counts.operators || 0 });
    return lines;
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      // Snapshot first — same safety habit restoreFromBytes/mergeMaster already
      // follow for a destructive DB change. If the backup itself fails, abort:
      // never wipe data with no safety copy on the way out.
      if (window.sqlAPI?.backupNow) {
        const backup = await window.sqlAPI.backupNow();
        if (!backup.ok) {
          showToast('Backup failed — nothing was deleted. Check your backup folder and try again.', 'error');
          setBusy(false);
          return;
        }
      }
      // Challans cascade: entries + DRs + wasuli + ledger go with them
      if (picked.has('challans')) {
        await db.challans.clear();
        await db.lrEntries.clear();
        await db.drs.clear();
        await db.wasuli.clear();
        await db.firmLedger.clear();
        await db.drafts.clear();
      } else {
        if (picked.has('drs')) await db.drs.clear();
        if (picked.has('wasuli')) await db.wasuli.clear();
        if (picked.has('firmLedger')) await db.firmLedger.clear();
      }
      // Master data categories live in masterData (by field) — clear selectively
      if (picked.has('firms') || picked.has('stations') || picked.has('trucks')) {
        const all = await db.masterData.toArray();
        for (const m of all) {
          if (picked.has('firms') && m.field === 'firmName') await db.masterData.delete(m.id!);
          else if (picked.has('stations') && m.field === 'loadingStation') await db.masterData.delete(m.id!);
          else if (picked.has('trucks') && m.field === 'truckNumber') await db.masterData.delete(m.id!);
        }
      }
      if (picked.has('operators')) await db.operators.clear();

      if (sqlClient) await sqlClient.vacuum(); // compact file + wipe freed space
      // Tell the keeper this wipe was deliberate — otherwise the stale lastGood
      // marker trips the blank-DB safe-mode lockout on the next keeper restart.
      // Same call clearAllData() makes in SettingsPage.tsx for the full wipe.
      await window.sqlAPI?.markDataCleared?.();
      showToast('Selected data cleared ✓ Refreshing...', 'success');
      setTimeout(() => { onDone(); window.location.reload(); }, 700);
    } catch {
      showToast('Something went wrong — try again', 'error');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="confirm-modal" style={{ width: 460, maxWidth: '92vw' }}>
        {stage === 1 ? (
          <>
            <div className="confirm-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>What to clear?</span>
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={18} /></button>
            </div>
            <div className="confirm-body">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Tick the data to clear. Selecting challans also removes their DRs/wasuli.</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                {CATEGORIES.map(c => {
                  const n = countFor(c.id);
                  const on = picked.has(c.id);
                  const empty = n === 0;
                  return (
                    <label key={c.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: `1.5px solid ${on ? 'var(--orange)' : 'var(--border)'}`, borderRadius: 'var(--r-md)', cursor: empty ? 'not-allowed' : 'pointer', opacity: empty ? 0.5 : 1, background: on ? 'var(--orange-light)' : 'var(--card)' }}>
                      <input type="checkbox" checked={on} disabled={empty} onChange={() => toggle(c.id)} style={{ marginTop: 2 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)' }}>{c.label} <span style={{ color: 'var(--orange)', fontWeight: 700 }}>({n})</span></div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.desc}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
              <button className="btn btn-danger btn-sm" disabled={picked.size === 0} onClick={() => setStage(2)}>Next ({picked.size})</button>
            </div>
          </>
        ) : (
          <>
            <div className="confirm-title" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--danger)' }}>
              <AlertTriangle size={20} /> Are you sure you want to delete?
            </div>
            <div className="confirm-body">
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 10 }}>This data will be deleted (cannot be undone):</div>
              <div style={{ background: 'var(--danger-bg)', border: '1px solid #f3c2c2', borderRadius: 'var(--r-md)', padding: '12px 14px' }}>
                {summaryLines().map((l, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', color: l.label.startsWith('↳') ? 'var(--text-muted)' : 'var(--text-primary)', fontWeight: l.label.startsWith('↳') ? 400 : 600 }}>
                    <span>{l.label}</span><span style={{ fontWeight: 700 }}>{l.n}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setStage(1)}>Back</button>
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={doDelete}><Trash2 size={14} /> {busy ? 'Deleting...' : 'Yes, delete'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
