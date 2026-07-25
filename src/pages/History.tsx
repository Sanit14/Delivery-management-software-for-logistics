import { useEffect, useState, useCallback, useRef } from 'react';
import { ArrowRight, ArrowLeftRight, CircleX, Check, CornerUpLeft, Trash2, FileText, RotateCcw, Pencil, Plus, Save } from 'lucide-react';
import { useReactToPrint } from 'react-to-print';
import { db, getAuditLog, restoreChallanCascade } from '../db/database';
import type { AuditEntry, Challan, LREntry, DR } from '../db/database';
import { formatINR, formatDate, daysDiff } from '../utils/reportUtils';
import DateRangePicker from '../components/DateRangePicker';
import { type DateRange, inRange } from '../utils/dateRange';
import PageHeader from '../components/PageHeader';
import { useToast } from '../context/ToastContext';

type Tab = 'movement' | 'deleted';
interface DeletedItem { kind: 'challan' | 'entry' | 'dr'; id: number; label: string; sub: string; deletedAt: string; }

const ACTION_META: Record<AuditEntry['action'], { label: string; icon: React.ReactNode; color: string }> = {
  assign:   { label: 'Assigned',   icon: <ArrowRight size={16} />,     color: 'var(--text-secondary)' },
  reassign: { label: 'Reassigned', icon: <ArrowLeftRight size={16} />, color: 'var(--orange)' },
  remove:   { label: 'Removed',    icon: <CircleX size={16} />,        color: 'var(--warning)' },
  collect:  { label: 'Collected',  icon: <Check size={16} />,          color: 'var(--success)' },
  undo:     { label: 'Undo',       icon: <CornerUpLeft size={16} />,   color: 'var(--text-muted)' },
  delete:   { label: 'Deleted',    icon: <Trash2 size={16} />,         color: 'var(--danger)' },
  edit:     { label: 'Edited',     icon: <Pencil size={16} />,         color: 'var(--orange)' },
  add:      { label: 'Entry Added', icon: <Plus size={16} />,          color: 'var(--text-secondary)' },
  create:   { label: 'Memo Created', icon: <FileText size={16} />,     color: 'var(--text-secondary)' },
  save:     { label: 'Memo Saved', icon: <Save size={16} />,           color: 'var(--success)' },
};

export default function History() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>('movement');

  // movement
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [actionFilter, setActionFilter] = useState<AuditEntry['action'] | 'all'>('all');
  const [range, setRange] = useState<DateRange>({ from: '', to: '' });
  const printRef = useRef<HTMLDivElement>(null);

  // deleted
  const [deleted, setDeleted] = useState<DeletedItem[]>([]);

  const loadAudit = useCallback(async () => {
    const rows = await getAuditLog();
    setAudit(rows);
  }, []);

  // Loads and displays only — it never deletes anything. The 90-day purge of
  // old soft-deleted rows runs as a background sweep in the keeper instead
  // (electron/keeper/engine.cjs purgeOldDeleted), never as a side effect of
  // opening this screen.
  const loadDeleted = useCallback(async () => {
    const cutoff = 90;
    const items: DeletedItem[] = [];
    const challans = (await db.challans.toArray()).filter(c => c.deletedAt && daysDiff(c.deletedAt.split('T')[0]) <= cutoff) as Challan[];
    const entries = (await db.lrEntries.toArray()).filter(e => e.deletedAt && daysDiff(e.deletedAt.split('T')[0]) <= cutoff) as LREntry[];
    const drs = (await db.drs.toArray()).filter(d => d.deletedAt && daysDiff(d.deletedAt.split('T')[0]) <= cutoff) as DR[];
    for (const c of challans) {
      items.push({ kind: 'challan', id: c.id!, label: `Challan #${c.challanNumber}`, sub: `${c.firmName} · ${c.totalEntries} entries`, deletedAt: c.deletedAt! });
    }
    for (const e of entries) {
      items.push({ kind: 'entry', id: e.id!, label: `LR ${e.lrNumber}`, sub: `${e.consignee} · ${formatINR(e.total)} · Challan #${e.challanNumber}`, deletedAt: e.deletedAt! });
    }
    for (const d of drs) {
      items.push({ kind: 'dr', id: d.id!, label: `DR ${d.drNumber}`, sub: `${d.consignee} · ${formatINR(d.total)}`, deletedAt: d.deletedAt! });
    }
    items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    setDeleted(items);
  }, []);

  useEffect(() => {
    loadAudit().catch(() => {});
    loadDeleted().catch(() => {});
  }, [loadAudit, loadDeleted]);

  const restore = async (item: DeletedItem) => {
    try {
      if (item.kind === 'challan') await restoreChallanCascade(item.id);
      else if (item.kind === 'entry') await db.lrEntries.update(item.id, { deletedAt: null as unknown as undefined });
      else await db.drs.update(item.id, { deletedAt: null as unknown as undefined });
      showToast(item.kind === 'challan' ? `${item.label} restored` : 'Restored', 'success');
      loadDeleted();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Restore failed', 'error');
    }
  };

  const filteredAudit = audit.filter(e =>
    (actionFilter === 'all' || e.action === actionFilter) && inRange(e.at.slice(0, 10), range)
  );

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${formatDate(iso.slice(0, 10))} ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  };

  const runPrint = useReactToPrint({ contentRef: printRef, documentTitle: 'History Report' });

  return (
    <div style={{ paddingBottom: 60 }}>
      <PageHeader showBack onRefresh={() => { loadAudit(); loadDeleted(); }} title="History" subtitle="All movement, changes and deleted items — last 90 days"
        right={tab === 'movement' ? <button className="btn btn-outline btn-sm" onClick={() => runPrint()}><FileText size={14} /> Export</button> : undefined} />

      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '0.5px solid var(--border)' }}>
        {([['movement', 'Movement & changes'], ['deleted', 'Deleted items']] as const).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding: '8px 14px', fontSize: 14, fontWeight: tab === id ? 700 : 500, background: 'none', border: 'none', cursor: 'pointer',
            color: tab === id ? 'var(--orange)' : 'var(--text-secondary)', borderBottom: tab === id ? '2px solid var(--orange)' : '2px solid transparent', marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {tab === 'movement' ? (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'flex-start' }}>
            <select className="form-select" style={{ width: 'auto', minWidth: 140 }} value={actionFilter} onChange={e => setActionFilter(e.target.value as AuditEntry['action'] | 'all')}>
              <option value="all">All actions</option>
              <option value="assign">Assigned</option>
              <option value="reassign">Reassigned</option>
              <option value="remove">Removed</option>
              <option value="collect">Collected</option>
              <option value="undo">Undo</option>
              <option value="delete">Deleted</option>
              <option value="edit">Edited</option>
              <option value="add">Entry Added</option>
              <option value="create">Memo Created</option>
              <option value="save">Memo Saved</option>
            </select>
            <div style={{ minWidth: 260 }}><DateRangePicker value={range} onChange={setRange} /></div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            {filteredAudit.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No records in this filter</div>
            ) : filteredAudit.map(e => {
              const meta = ACTION_META[e.action];
              return (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>
                  <span style={{ color: meta.color, display: 'flex' }}>{meta.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13 }}>
                      <b>{e.drNumber || '—'}</b> {meta.label.toLowerCase()}
                      {e.fromAgent && e.toAgent && <> · {e.fromAgent} <ArrowRight size={11} style={{ verticalAlign: -1 }} /> {e.toAgent}</>}
                      {!e.fromAgent && e.toAgent && <> · {e.toAgent}</>}
                      {e.fromAgent && !e.toAgent && <> · {e.fromAgent} se</>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {e.party}{e.amount ? ` · ${formatINR(e.amount)}` : ''}{e.detail ? ` · "${e.detail}"` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {fmtTime(e.at)}<br />{e.seat || '—'}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {deleted.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>No deleted items</div>
          ) : deleted.map(item => (
            <div key={`${item.kind}-${item.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '0.5px solid var(--border)' }}>
              <Trash2 size={16} style={{ color: 'var(--text-muted)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}><b>{item.label}</b> · {item.sub}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Deleted {fmtTime(item.deletedAt)}</div>
              </div>
              <button className="btn btn-outline btn-sm" onClick={() => restore(item)}><RotateCcw size={13} /> Restore</button>
            </div>
          ))}
        </div>
      )}

      {/* hidden print target for the movement export */}
      <div style={{ display: 'none' }}>
        <div ref={printRef} style={{ padding: '10mm', fontFamily: 'serif' }}>
          <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '14pt' }}>SUNDEEP FREIGHT MOVERS</div>
          <div style={{ textAlign: 'center', fontSize: '11pt', marginBottom: 10 }}>History — Movement &amp; Changes</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9pt' }}>
            <thead><tr>
              {['When', 'PC', 'Action', 'BS No', 'Party', 'Agent', 'Amount'].map(h => <th key={h} style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {filteredAudit.map(e => (
                <tr key={e.id}>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{fmtTime(e.at)}</td>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{e.seat}</td>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{ACTION_META[e.action].label}</td>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{e.drNumber}</td>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{e.party}</td>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px' }}>{[e.fromAgent, e.toAgent].filter(Boolean).join(' -> ')}</td>
                  <td style={{ border: '0.5px solid #000', padding: '2px 4px', textAlign: 'right' }}>{e.amount ? e.amount.toLocaleString('en-IN') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
