import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';

interface Health {
  lastBackupMs: number;
  intervalDays: number;
  targets: { dir: string; exists: boolean; newestMs: number }[];
}

// Small dashboard badge showing how fresh the last backup is. Green under 24h,
// amber 24–48h, red past 48h (or never). Also flags when a configured extra
// target (pendrive/second drive) is missing or stale, so an unplugged pendrive
// is visible at a glance rather than discovered in a crisis.
export default function BackupFreshnessBadge() {
  const [health, setHealth] = useState<Health | null>(null);
  // 'now' is captured inside useEffect (post-render) so Date.now() is called
  // outside the render phase — satisfies react-hooks/purity.
  const [now, setNow] = useState(0);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.sqlAPI : undefined;
    if (!api?.backupHealth) return;
    let alive = true;
    const load = async () => {
      try {
        const h = await api.backupHealth!();
        if (alive) { setHealth(h); setNow(Date.now()); }
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 5 * 60 * 1000); // refresh every 5 min
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!health) return null;

  const ageH = health.lastBackupMs ? (now - health.lastBackupMs) / 3600000 : Infinity;

  // Solid, high-contrast colours (the faint tint washed out on the teal header).
  let bg = '#16a34a';                    // green = fresh
  const fg = '#ffffff';
  let text: string;
  if (!health.lastBackupMs) { bg = '#dc2626'; text = 'No backup yet'; }
  else if (ageH < 24) { text = ageH < 1 ? 'Backup: just now' : `Backup: ${Math.floor(ageH)}h ago`; }
  else if (ageH < 48) { bg = '#d97706'; text = 'Backup: 1 day ago'; }
  else { bg = '#dc2626'; text = `Backup: ${Math.floor(ageH / 24)} days ago`; }

  // An extra target that exists in config but has no recent file (or folder gone).
  const staleExtra = health.targets.slice(1).some(t => !t.exists || (health.lastBackupMs && t.newestMs < health.lastBackupMs - 3600000));
  if (staleExtra) { bg = '#d97706'; } // amber if an extra copy is missing/stale

  const danger = !health.lastBackupMs || ageH >= 48;
  // Exact time on hover, so the office can see the precise last-backup moment.
  const exact = health.lastBackupMs ? new Date(health.lastBackupMs).toLocaleString() : 'never';
  const title = staleExtra
    ? `Last backup: ${exact} — but an extra copy (pendrive/second drive) is missing or out of date`
    : `Last successful backup: ${exact}`;

  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 10,
        color: fg, background: bg,
        border: '1px solid rgba(0,0,0,0.08)',
      }}
    >
      {danger ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}
      {text}{staleExtra ? ' · extra copy stale' : ''}
    </span>
  );
}
