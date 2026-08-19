import { useEffect, useState, type ReactNode } from 'react';
import { Database, Trash2, Download, Upload, Truck, ShieldCheck, Info, History, Monitor } from 'lucide-react';
import { db, sqlClient, getCartageRules, saveCartageRule } from '../db/database';
import type { CartageRule } from '../db/database';
import type { RestoreSummary, RestoreForce } from '../db/sqlClient';
import PageHeader from '../components/PageHeader';
import ConfirmModal from '../components/ConfirmModal';
import PinModal from '../components/PinModal';
import RestorePreviewModal from '../components/RestorePreviewModal';
import SelectiveCleanup from '../components/SelectiveCleanup';
import { useToast } from '../context/ToastContext';
import { useAdmin } from '../context/AdminContext';

type CartageOption = 'option1' | 'option2' | 'blank';

const OPTION_LABELS: Record<CartageOption, { name: string; desc: string; color: string; bg: string }> = {
  option1: { name: 'Option 1', desc: 'Cartage adds to the total', color: '#185FA5', bg: '#E6F1FB' },
  option2: { name: 'Option 2', desc: 'Collected separately on door delivery', color: '#3B6D11', bg: '#EAF3DE' },
  blank: { name: 'Blank', desc: 'No cartage — manual entry allowed', color: '#854F0B', bg: '#FAEEDA' },
};

const EMPTY_RULE: CartageRule = {
  godownBhada: 0, godownInsurance: 0, deliveryCharges: 0,
  hamaliPerDag: 0, hamaliFlat: 0, hamaliMode: 'none',
};

export default function SettingsPage() {
  const { showToast } = useToast();
  const { isAdmin, unlock } = useAdmin();

  // This computer's name (PC-01 etc). Stored per-seat in seat.json, NOT in the shared
  // db — each seat must have its own, so the audit log can show which PC did what.
  const [seatName, setSeatName] = useState('');
  const [seatSaved, setSeatSaved] = useState('');

  // Charges rules state
  const [cartageRules, setCartageRules] = useState<Record<CartageOption, CartageRule>>({
    option1: { ...EMPTY_RULE }, option2: { ...EMPTY_RULE }, blank: { ...EMPTY_RULE },
  });
  const [editingOption, setEditingOption] = useState<CartageOption | null>(null);
  const [draftRule, setDraftRule] = useState<CartageRule>({ ...EMPTY_RULE });
  const [cartageAdminAction, setCartageAdminAction] = useState<(() => void) | null>(null);

  // Data management
  const [backupFolder, setBackupFolder] = useState<string>('');
  const [extraTargets, setExtraTargets] = useState<string[]>([]);
  const [secondAuditDir, setSecondAuditDir] = useState<string>('');
  const [dbSizeMB, setDbSizeMB] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [backupInterval, setBackupInterval] = useState<number>(2);
  const [pdfFolder, setPdfFolder] = useState<string>('');
  const [csvFolder, setCsvFolder] = useState<string>('');
  const [dataRoot, setDataRoot] = useState<string>('');
  const [changingRoot, setChangingRoot] = useState(false);
  const [restorePath, setRestorePath] = useState<string>('');
  // Set once a chosen file has passed structural validation and is waiting on
  // the operator to confirm what it will replace — see RestorePreviewModal.
  const [restorePreview, setRestorePreview] = useState<{ incoming: RestoreSummary; live: RestoreSummary } | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const isElectron = typeof window !== 'undefined' && !!window.sqlAPI;

  const [showClearAll, setShowClearAll] = useState(false);
  const [showSelectiveCleanup, setShowSelectiveCleanup] = useState(false);

  useEffect(() => {
    (async () => {
      const rules = await getCartageRules();
      setCartageRules(rules);
      if (window.sqlAPI?.getSeatName) {
        try {
          const s = await window.sqlAPI.getSeatName();
          setSeatName(s || '');
          setSeatSaved(s || '');
        } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getBackupFolder) {
        try { setBackupFolder(await window.sqlAPI.getBackupFolder()); } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getExtraTargets) {
        try { setExtraTargets(await window.sqlAPI.getExtraTargets()); } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getSecondAuditDir) {
        try { setSecondAuditDir(await window.sqlAPI.getSecondAuditDir()); } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getBackupInterval) {
        try { setBackupInterval(await window.sqlAPI.getBackupInterval()); } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getExportFolder) {
        try { setPdfFolder(await window.sqlAPI.getExportFolder('pdf')); } catch { /* ignore */ }
        try { setCsvFolder(await window.sqlAPI.getExportFolder('csv')); } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getDbFileSize) {
        try { setDbSizeMB((await window.sqlAPI.getDbFileSize()) / (1024 * 1024)); } catch { /* ignore */ }
      }
      if (window.sqlAPI?.getDataRoot) {
        try { setDataRoot(await window.sqlAPI.getDataRoot()); } catch { /* ignore */ }
      }
    })();
  }, []);

  // ── Extra backup copies (pendrive / second drive — customer chooses, none by default) ──
  const addExtraTarget = async () => {
    if (!window.sqlAPI?.pickExtraTarget || !window.sqlAPI?.setExtraTargets) return;
    const res = await window.sqlAPI.pickExtraTarget();
    if (res.canceled || !res.folder) return;
    const next = [...new Set([...extraTargets, res.folder])];
    await window.sqlAPI.setExtraTargets(next);
    setExtraTargets(next);
    showToast('Extra backup copy added', 'success');
  };
  const removeExtraTarget = async (folder: string) => {
    if (!window.sqlAPI?.setExtraTargets) return;
    const next = extraTargets.filter(f => f !== folder);
    await window.sqlAPI.setExtraTargets(next);
    setExtraTargets(next);
    showToast('Extra backup copy removed', 'info');
  };

  // Second audit-log location (survives even a ProgramData loss). Optional.
  const chooseSecondAuditDir = async () => {
    if (!window.sqlAPI?.pickSecondAuditDir) return;
    const res = await window.sqlAPI.pickSecondAuditDir();
    if (!res.canceled && res.folder) { setSecondAuditDir(res.folder); showToast('Second audit location set', 'success'); }
  };
  const changeInterval = async (days: number) => {
    if (!window.sqlAPI?.setBackupInterval) return;
    await window.sqlAPI.setBackupInterval(days);
    setBackupInterval(days);
    showToast(days === 0 ? 'Auto backup turned off' : (days === 1 ? 'Auto backup: daily' : `Auto backup: every ${days} days`), 'success');
  };

  // ── Shared data folder (the ONE root all seats read/write) ─────────────────
  const changeDataFolder = () => {
    if (!window.sqlAPI?.changeDataRoot) return;
    requireAdmin(async () => {
      setChangingRoot(true);
      try {
        const res = await window.sqlAPI!.changeDataRoot!();
        // On success the app relaunches itself, so we normally never get here.
        if (res && !res.ok && !res.canceled) {
          showToast(res.error || 'Could not change data folder', 'error');
        }
      } catch {
        showToast('Could not change data folder', 'error');
      } finally {
        setChangingRoot(false);
      }
    });
  };

  const doCompact = async () => {
    if (!window.sqlAPI?.vacuum || compacting) return;
    setCompacting(true);
    try {
      await window.sqlAPI.vacuum();
      if (window.sqlAPI.getDbFileSize) setDbSizeMB((await window.sqlAPI.getDbFileSize()) / (1024 * 1024));
      showToast('Database compacted', 'success');
    } catch {
      showToast('Compact failed — try again', 'error');
    } finally {
      setCompacting(false);
    }
  };

  const doBackupNow = async () => {
    if (!window.sqlAPI?.backupNow) return;
    const res = await window.sqlAPI.backupNow();
    showToast(res.ok ? 'Backup created ✓' : 'Backup failed — check the folder', res.ok ? 'success' : 'error');
  };
  // Step 1: validate the file and show the operator what it contains vs. what's
  // live, before anything is replaced — every restore AND every import, not
  // only when the file looks suspicious.
  const startRestorePreview = async (path: string) => {
    if (!window.sqlAPI?.restoreBackup) return;
    setRestoreBusy(true);
    const res = await window.sqlAPI.restoreBackup(path);
    setRestoreBusy(false);
    if (res.ok) return; // shouldn't happen without force
    if (res.needsConfirm) {
      setRestorePath(path);
      setRestorePreview({ incoming: res.incoming, live: res.live });
    } else {
      showToast(res.error || 'Restore failed', 'error');
    }
  };
  const doRestore = async () => {
    if (!window.sqlAPI?.pickRestoreFile) return;
    const picked = await window.sqlAPI.pickRestoreFile();
    if (picked.canceled || !picked.path) return;
    await startRestorePreview(picked.path);
  };
  // Step 2: operator confirmed — proceed with the actual replace. `force` is
  // whatever RestorePreviewModal decided: `true` for a normal restore, or the
  // distinct 'CONFIRM_EMPTY' signal when the operator typed the confirm word
  // for a zero-row backup.
  const confirmRestore = async (force: RestoreForce) => {
    if (!window.sqlAPI?.restoreBackup || !restorePath) return;
    setRestoreBusy(true);
    const res = await window.sqlAPI.restoreBackup(restorePath, force);
    setRestoreBusy(false);
    setRestorePath('');
    setRestorePreview(null);
    if (res.ok) {
      showToast('Restored ✓ — app is refreshing', 'success');
      setTimeout(() => window.location.reload(), 1500);
    } else {
      showToast(('error' in res && res.error) || 'Restore failed', 'error');
    }
  };
  const cancelRestore = () => { setRestorePath(''); setRestorePreview(null); };

  // Rename THIS computer. Only affects this seat (seat.json lives in this seat's own
  // userData) — the other PCs keep their own names. Past audit rows keep the old name,
  // since they record who did the action at the time.
  const saveSeat = async () => {
    const clean = seatName.trim();
    if (!clean) { showToast('Computer name cannot be empty', 'error'); return; }
    const res = await window.sqlAPI?.setSeatName?.(clean);
    if (res?.ok) {
      setSeatSaved(clean);
      showToast(`This computer is now "${clean}"`, 'success');
      // The badge and the audit stamp both read the name at startup, so reload to pick it up.
      setTimeout(() => window.location.reload(), 900);
    } else {
      showToast(res?.error || 'Name could not be saved', 'error');
    }
  };

  // ── Charges Rule editing ────────────────────────────────────────────────────
  const requireAdmin = (action: () => void) => {
    if (isAdmin) action();
    else setCartageAdminAction(() => action);
  };

  const openEdit = (opt: CartageOption) => {
    requireAdmin(() => {
      setDraftRule({ ...cartageRules[opt] });
      setEditingOption(opt);
    });
  };

  const saveDraft = async () => {
    if (!editingOption) return;
    await saveCartageRule(editingOption, draftRule);
    setCartageRules(r => ({ ...r, [editingOption]: { ...draftRule } }));
    setEditingOption(null);
    showToast(`${OPTION_LABELS[editingOption].name} rule saved ✓`, 'success');
  };

  // Number fields get coerced to number; hamaliMode stays a string
  const dr = (k: keyof CartageRule, v: string | number) =>
    setDraftRule(r => ({
      ...r,
      [k]: k === 'hamaliMode' ? v : (Number(v) || 0),
    }));

  // Dedicated setter for the mode buttons — no ambiguity
  const setHamaliMode = (mode: CartageRule['hamaliMode']) =>
    setDraftRule(r => ({ ...r, hamaliMode: mode }));

  // Hamali preview for a rule + given quantity
  const hamaliPreview = (rule: CartageRule, qty: number) => {
    if (rule.hamaliMode === 'perDag') return `₹${rule.hamaliPerDag} × ${qty} dag = ₹${rule.hamaliPerDag * qty}`;
    if (rule.hamaliMode === 'flat') return `₹${rule.hamaliFlat} flat`;
    return 'No hamali';
  };

  // ── Export / Import (unified .db — one format for everything) ────────────────
  // Export writes the COMPLETE database as a single .db file (same format as auto
  // and manual backups). Import uses the SAME validated restore path as Restore:
  // it validates the file is a real database, takes a safety snapshot, then does a
  // clean full replace — no partial JSON, no merge, no leftover rows.
  const exportAll = async () => {
    if (!window.sqlAPI?.exportDb) { showToast('Export needs the desktop app', 'error'); return; }
    try {
      const bytes = await window.sqlAPI.exportDb();       // full db as a byte array
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const d = new Date();
      link.href = url;
      link.download = `DeliveryManager_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.db`;
      link.click();
      URL.revokeObjectURL(url);
      showToast('Full backup exported ✓', 'success');
    } catch { showToast('Export failed — try again', 'error'); }
  };

  // Import a .db file chosen by the user. Reuses the same native picker + restore
  // path as "Restore", so a .db from a pendrive, email, or another PC comes back
  // exactly. Shows the confirm (with the file path) before replacing.
  const doImportDb = async () => {
    if (!window.sqlAPI?.pickRestoreFile) { showToast('Import needs the desktop app', 'error'); return; }
    const picked = await window.sqlAPI.pickRestoreFile();
    if (picked.canceled || !picked.path) return;
    await startRestorePreview(picked.path); // routes into the same confirm+restore flow as Restore
  };

  // Full reset — wipes all DATA (challans, DRs, wasuli, master) for fresh retesting.
  // Keeps Settings (PIN, company name, theme) so the app stays usable.
  const clearAllData = async () => {
    await db.challans.clear();
    await db.lrEntries.clear();
    await db.drs.clear();
    await db.wasuli.clear();
    await db.firmLedger.clear();
    await db.operators.clear();
    await db.masterData.clear();
    await db.drafts.clear();
    // reset the DR counter so BS numbers start fresh (challan numbers derive from challans table)
    await db.settings.put({ key: 'drCounter', value: '1' });
    if (sqlClient) await sqlClient.vacuum(); // physically compact + wipe freed space
    // Tell the keeper this wipe was deliberate — otherwise the stale lastGood
    // marker trips the blank-DB safe-mode lockout on the next keeper restart.
    await window.sqlAPI?.markDataCleared?.();
    setShowClearAll(false);
    showToast('All data cleared — fresh start ✓ Refreshing...', 'success');
    setTimeout(() => window.location.reload(), 800);
  };

  const section = (icon: ReactNode, title: string, children: ReactNode, adminOnly?: boolean) => (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: 'var(--orange)', display: 'flex' }}>{icon}</span>
          <span className="card-header-title">{title}</span>
          {adminOnly && (
            <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: '#FAEEDA', color: '#854F0B', display: 'flex', alignItems: 'center', gap: 4 }}>
              <ShieldCheck size={10} /> ADMIN ONLY
            </span>
          )}
        </div>
      </div>
      <div className="card-body">{children}</div>
    </div>
  );

  // Rule summary card for display
  const RuleCard = ({ opt }: { opt: CartageOption }) => {
    const rule = cartageRules[opt];
    const meta = OPTION_LABELS[opt];
    return (
      <div style={{ border: `1.5px solid ${meta.color}30`, borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{ background: meta.bg, padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, color: meta.color }}>{meta.name}</div>
            <div style={{ fontSize: 11, color: meta.color, opacity: 0.8, marginTop: 1 }}>{meta.desc}</div>
          </div>
          <button
            className="btn btn-sm"
            style={{ fontSize: 11, background: meta.color, color: '#fff', border: 'none', padding: '5px 12px', borderRadius: 6, cursor: 'pointer' }}
            onClick={() => openEdit(opt)}
          >
            ✏️ Edit Rule
          </button>
        </div>
        {/* Charges grid */}
        <div style={{ padding: '12px 14px', background: 'var(--card)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            {[
              ['G.Bhada', rule.godownBhada],
              ['GDN Insurance', rule.godownInsurance],
              ['Dly Charges (Local)', rule.deliveryCharges],
            ].map(([label, val]) => (
              <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', background: 'var(--background-secondary, #f8f9fa)', borderRadius: 6 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label as string}</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: Number(val) > 0 ? meta.color : 'var(--text-muted)' }}>
                  {Number(val) > 0 ? `₹${val}` : '—'}
                </span>
              </div>
            ))}
            {/* Hamali — special display */}
            <div style={{ padding: '6px 10px', background: 'var(--background-secondary, #f8f9fa)', borderRadius: 6 }}>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 2 }}>Hamali</div>
              {rule.hamaliMode === 'perDag' && (
                <div style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>
                  ₹{rule.hamaliPerDag} × dag count
                </div>
              )}
              {rule.hamaliMode === 'flat' && (
                <div style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>₹{rule.hamaliFlat} flat</div>
              )}
              {rule.hamaliMode === 'none' && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</div>
              )}
            </div>
          </div>
          {/* Hamali example */}
          {rule.hamaliMode === 'perDag' && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', borderTop: '0.5px solid var(--border)', paddingTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
              <Info size={11} />
              Example: 10 dag ka mal → hamali = {hamaliPreview(rule, 10)}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <PageHeader showBack title="Settings" subtitle="Company, charges rules and data" />

      {isElectron && section(<Monitor size={16} />, 'This Computer', (
        <>
          <div className="form-group">
            <label className="form-label">Computer name</label>
            <input
              className="form-input"
              value={seatName}
              placeholder="PC-01"
              onChange={e => setSeatName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveSeat(); }}
            />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              Only changes THIS computer. Give each PC a different name (PC-01, PC-02...) —
              it is stamped on every action in the History log so you can see which PC did what.
              Past history entries keep the old name.
            </div>
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={!seatName.trim() || seatName.trim() === seatSaved}
            onClick={saveSeat}
          >
            Save
          </button>
        </>
      ))}

      {section(<Truck size={16} />, 'Charges Rules', (
        <>
          {/* Info banner */}
          <div style={{ background: '#EAF3DE', border: '0.5px solid #3B6D1130', borderRadius: 'var(--r-md)', padding: '10px 14px', marginBottom: 16, fontSize: 12, color: '#3B6D11', lineHeight: 1.7 }}>
            <b>How it works:</b> When you select Opt1 / Opt2 / Blank in the entry form, the charges below fill in automatically —
            only the fields that are currently <b>empty</b>. Already-filled fields are not affected.
            Hamali is multiplied by <b>dag (quantity)</b> automatically.
          </div>

          {/* Three rule cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(['option1', 'option2', 'blank'] as CartageOption[]).map(opt => (
              <RuleCard key={opt} opt={opt} />
            ))}
          </div>

          {!isAdmin && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={13} /> PIN required to view rules — you'll be asked for it when you press Edit.
            </div>
          )}
        </>
      ), true)}

      {section(<Database size={16} />, 'Data Management', (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '10px 14px', lineHeight: 1.7 }}>
            <b>Backup format:</b> one complete <b>.db</b> file — the whole database in a single file. Export it to a pendrive or another PC; Import (or Restore) brings everything back exactly. This is the same format auto-backup uses, so any backup can be restored from anywhere.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
            <button className="btn btn-outline" onClick={exportAll}><Download size={15} /> Export Full Backup (.db)</button>
            <button className="btn btn-outline" onClick={doImportDb}><Upload size={15} /> Import Backup (.db)</button>
            <button className="btn btn-danger" onClick={() => setShowSelectiveCleanup(true)}><Trash2 size={15} /> Clear Master Data</button>
            <button className="btn btn-danger" onClick={() => setShowClearAll(true)}><Trash2 size={15} /> Clear ALL Data (Reset)</button>
          </div>
          {isElectron && (
            <div style={{ background: 'var(--teal-tint, #eef7f6)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--navy)', marginBottom: 12 }}>Auto Backup</div>

              {/* Backup runs daily whenever the app is opened. Only Daily/Off are
                  real choices — the app always backs up once a day when on. */}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Automatic backup</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 18 }}>
                {[{ d: 1, l: 'Daily' }, { d: 0, l: 'Off' }].map(opt => (
                  <button key={opt.d} onClick={() => changeInterval(opt.d)}
                    className={(backupInterval > 0 ? 1 : 0) === opt.d ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}>
                    {opt.l}
                  </button>
                ))}
              </div>

              {/* Primary backup folder is always <root>\backups — see engine.cjs
                  getBackupFolder(); no override, so it can't diverge from the root. */}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Backup folder</div>
              <div style={{ fontSize: 12, marginBottom: 10, padding: '8px 12px', background: 'var(--card)', borderRadius: 6, wordBreak: 'break-all', color: 'var(--navy)' }}>
                {backupFolder || 'root/backups'}
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn btn-outline btn-sm" onClick={doBackupNow}><Database size={14} /> Manual Backup</button>
                <button className="btn btn-outline btn-sm" onClick={doRestore}><Upload size={14} /> Restore</button>
              </div>

              {/* Extra backup copies — optional. None by default; the customer picks
                  a pendrive or second-drive folder at their site. No drive letter assumed. */}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 16, marginBottom: 8 }}>
                Extra backup copies <span style={{ color: 'var(--text-muted)' }}>(optional — pendrive or another drive)</span>
              </div>
              {extraTargets.length === 0 && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
                  No extra copies set. Backups go to the folder above only. Add a pendrive or second-drive folder for a safety copy.
                </div>
              )}
              {extraTargets.map(t => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6, padding: '6px 10px', background: 'var(--card)', borderRadius: 6 }}>
                  <span style={{ wordBreak: 'break-all', flex: 1, color: 'var(--navy)' }}>{t}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => removeExtraTarget(t)}><Trash2 size={13} /></button>
                </div>
              ))}
              <button className="btn btn-outline btn-sm" style={{ marginTop: 4 }} onClick={addExtraTarget}>
                <Download size={14} /> Add extra copy folder
              </button>

              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                Auto backup is a precaution (files older than 10 days are removed automatically). "Manual Backup" is permanent — full data, for month/year-end or a fresh start.
              </div>
            </div>
          )}

          {isElectron && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--navy)', marginBottom: 6 }}>PDF / CSV Report Folder</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
                Report PDFs and CSVs always save under the data folder, so they move with it.
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>PDF folder</div>
                <div style={{ fontSize: 12, marginBottom: 6, padding: '7px 12px', background: 'var(--border-light)', borderRadius: 6, wordBreak: 'break-all', color: 'var(--navy)' }}>{pdfFolder || 'root/PDF'}</div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>CSV folder</div>
                <div style={{ fontSize: 12, marginBottom: 6, padding: '7px 12px', background: 'var(--border-light)', borderRadius: 6, wordBreak: 'break-all', color: 'var(--navy)' }}>{csvFolder || 'root/CSV'}</div>
              </div>
            </div>
          )}

          {isElectron && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--navy)', marginBottom: 6 }}>Database Maintenance</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
                Over months and years the database file grows. Compacting reclaims space left behind by deleted records, keeping saves fast. Doing this every month or two is a good habit — it takes a moment and is completely safe.
              </div>
              <div style={{ fontSize: 12, marginBottom: 10, padding: '7px 12px', background: 'var(--border-light)', borderRadius: 6, color: 'var(--navy)' }}>
                Current database size: <b>{dbSizeMB == null ? '…' : `${dbSizeMB.toFixed(1)} MB`}</b>
              </div>
              <button className="btn btn-outline btn-sm" onClick={doCompact} disabled={compacting}>
                <Database size={14} /> {compacting ? 'Compacting…' : 'Compact Database'}
              </button>
            </div>
          )}

          {isElectron && (
            <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--navy)' }}>Data Storage Location</div>
                <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: '#FAEEDA', color: '#854F0B', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ShieldCheck size={10} /> ADMIN ONLY
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
                This is the ONE shared folder every seat/computer reads and writes to. Changing it copies the
                database, backups, PDF and CSV files to the new folder and restarts this app. After that, close
                and reopen DeliveryManager on every other seat too, so they connect to the new location.
              </div>
              <div style={{ fontSize: 12, marginBottom: 10, padding: '7px 12px', background: 'var(--border-light)', borderRadius: 6, wordBreak: 'break-all', color: 'var(--navy)' }}>
                {dataRoot || '…'}
              </div>
              <button className="btn btn-outline btn-sm" onClick={changeDataFolder} disabled={changingRoot}>
                <Database size={14} /> {changingRoot ? 'Working…' : 'Change Data Folder'}
              </button>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                Tip: pick a plain folder directly on the C: drive (e.g. <code>C:\DeliveryManagerData</code>).
                Avoid folders inside "Documents" or "Program Files" — those belong to one Windows user and
                often can't be written to from other seats.
              </div>

              {/* Second audit-log location — optional. The audit log always writes
                  to ProgramData; this adds a second copy (server/other drive) so the
                  event history survives even if ProgramData is lost. */}
              <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Audit log — second copy <span style={{ color: 'var(--text-muted)' }}>(optional)</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
                  The activity log always saves to this PC. Add a second folder (server or another drive) to keep a copy that survives even if this PC is reset.
                </div>
                {secondAuditDir && (
                  <div style={{ fontSize: 12, marginBottom: 8, padding: '7px 12px', background: 'var(--border-light)', borderRadius: 6, wordBreak: 'break-all', color: 'var(--navy)' }}>
                    {secondAuditDir}
                  </div>
                )}
                <button className="btn btn-outline btn-sm" onClick={chooseSecondAuditDir}>
                  <Database size={14} /> {secondAuditDir ? 'Change second location' : 'Add second location'}
                </button>
              </div>
            </div>
          )}

        </>
      ))}

      {section(<History size={16} />, 'Activity & Security Log', (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Every wasuli movement (assign, reassign, remove, collect, undo), changes and deleted items —
            which PC did it and when. Last 90 days. For admin use.
          </div>
          <a href="#/history" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <History size={14} /> Open History
          </a>
          <a href="#/security" className="btn btn-outline btn-sm" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <ShieldCheck size={14} /> Security
          </a>
        </>
      ), true)}

      {/* ── Charges Rule Edit Modal ── */}
      {editingOption && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setEditingOption(null); }}>
          <div className="confirm-modal" style={{ width: 500, maxWidth: '95vw' }}>
            <div className="confirm-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ background: OPTION_LABELS[editingOption].bg, color: OPTION_LABELS[editingOption].color, padding: '3px 10px', borderRadius: 6, fontSize: 13 }}>
                {OPTION_LABELS[editingOption].name}
              </span>
              Edit Charges Rule
            </div>
            <div className="confirm-body">

              {/* Fixed charges grid */}
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Fixed Charges (₹) — auto-fills when you select an entry
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 20 }}>
                {([
                  ['G.Bhada', 'godownBhada'],
                  ['GDN Insurance', 'godownInsurance'],
                  ['Dly Charges (Local)', 'deliveryCharges'],
                ] as [string, keyof CartageRule][]).map(([label, key]) => (
                  <div className="form-group" key={key} style={{ marginBottom: 0 }}>
                    <label className="form-label" style={{ fontSize: 12 }}>{label}</label>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--text-muted)' }}>₹</span>
                      <input
                        type="number" inputMode="numeric" className="form-input" style={{ paddingLeft: 24 }}
                        value={draftRule[key] as number || ''}
                        onChange={e => dr(key, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Hamali section */}
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Hamali Rule
              </div>
              <div style={{ background: 'var(--background-secondary, #f8f9fa)', borderRadius: 'var(--r-md)', padding: '14px', marginBottom: 4 }}>
                {/* Mode selector — real buttons, no hidden radios */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                  {([
                    ['perDag', '₹/Dag (multiply by quantity)', '10 dag → 10 × rate'],
                    ['flat', 'Flat ₹ (same for every entry)', 'One amount for all entries'],
                    ['none', 'No hamali', 'Will not auto-fill'],
                  ] as [CartageRule['hamaliMode'], string, string][]).map(([mode, label, hint]) => {
                    const selected = draftRule.hamaliMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setHamaliMode(mode)}
                        style={{
                          flex: 1, cursor: 'pointer', border: `1.5px solid ${selected ? 'var(--orange)' : 'var(--border)'}`,
                          borderRadius: 'var(--r-md)', padding: '8px 10px', textAlign: 'center',
                          background: selected ? 'var(--orange-light)' : 'var(--card)',
                          transition: 'all 0.15s', font: 'inherit',
                        }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, color: selected ? 'var(--orange)' : 'var(--text-primary)', marginBottom: 2 }}>{label}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{hint}</div>
                      </button>
                    );
                  })}
                </div>

                {/* Rate input */}
                {draftRule.hamaliMode === 'perDag' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className="form-group" style={{ marginBottom: 0, flex: 1 }}>
                      <label className="form-label">Rate per Dag (₹)</label>
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--text-muted)' }}>₹</span>
                        <input type="number" inputMode="numeric" className="form-input" style={{ paddingLeft: 24 }}
                          value={draftRule.hamaliPerDag || ''} onChange={e => dr('hamaliPerDag', e.target.value)} />
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 20, lineHeight: 1.5 }}>
                      × Qty (dag) = Hamali<br />
                      <span style={{ color: 'var(--orange)', fontWeight: 600 }}>
                        e.g. {draftRule.hamaliPerDag || '?'} × 10 dag = ₹{(draftRule.hamaliPerDag || 0) * 10}
                      </span>
                    </div>
                  </div>
                )}
                {draftRule.hamaliMode === 'flat' && (
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label">Flat Hamali Amount (₹)</label>
                    <div style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--text-muted)' }}>₹</span>
                      <input type="number" inputMode="numeric" className="form-input" style={{ paddingLeft: 24 }}
                        value={draftRule.hamaliFlat || ''} onChange={e => dr('hamaliFlat', e.target.value)} />
                    </div>
                  </div>
                )}
                {draftRule.hamaliMode === 'none' && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 0' }}>
                    Hamali won't auto-fill for this option — enter it manually.
                  </div>
                )}
              </div>

              {/* Live preview */}
              <div style={{ marginTop: 16, background: 'var(--navy)', borderRadius: 'var(--r-md)', padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Preview — if quantity = 10 dag
                </div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {[
                    ['G.Bhada', draftRule.godownBhada],
                    ['GDN Insurance', draftRule.godownInsurance],
                    ['Dly Charges (Local)', draftRule.deliveryCharges],
                    ['Hamali', draftRule.hamaliMode === 'perDag' ? draftRule.hamaliPerDag * 10 : draftRule.hamaliMode === 'flat' ? draftRule.hamaliFlat : 0],
                  ].map(([label, val]) => (
                    <div key={label as string}>
                      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{label as string}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: Number(val) > 0 ? 'var(--orange)' : 'rgba(255,255,255,0.3)' }}>
                        {Number(val) > 0 ? `₹${val}` : '—'}
                      </div>
                    </div>
                  ))}
                  <div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>Total Auto-Charges</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e' }}>
                      ₹{draftRule.godownBhada + draftRule.godownInsurance + draftRule.deliveryCharges +
                        (draftRule.hamaliMode === 'perDag' ? draftRule.hamaliPerDag * 10 : draftRule.hamaliMode === 'flat' ? draftRule.hamaliFlat : 0)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setEditingOption(null)}>Back</button>
              <button className="btn btn-primary btn-sm" onClick={saveDraft}>Save Rule ✓</button>
            </div>
          </div>
        </div>
      )}

      {/* Admin PIN gate for charges rule editing */}
      {cartageAdminAction && (
        <PinModal
          title="Admin PIN — Charges Rule Edit"
          checkPin={unlock}
          onSuccess={() => { const a = cartageAdminAction; setCartageAdminAction(null); a(); }}
          onCancel={() => setCartageAdminAction(null)}
        />
      )}

      {showSelectiveCleanup && (
        <SelectiveCleanup onClose={() => setShowSelectiveCleanup(false)} onDone={() => setShowSelectiveCleanup(false)} />
      )}
      {showClearAll && (
        <ConfirmModal
          title="Clear ALL data?"
          body={<>This will erase <b>everything</b> — challans, DRs, wasuli, firms, stations, agents, master data. Only company settings and PIN remain. <b>Cannot be undone!</b> Use for testing only.</>}
          confirmLabel="Yes, clear all"
          onConfirm={clearAllData}
          onCancel={() => setShowClearAll(false)}
          danger
        />
      )}

      {restorePreview && (
        <RestorePreviewModal
          incoming={restorePreview.incoming}
          live={restorePreview.live}
          busy={restoreBusy}
          onConfirm={confirmRestore}
          onCancel={cancelRestore}
        />
      )}

    </div>
  );
}
