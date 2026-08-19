import { useEffect, useState, useRef, useMemo } from 'react';
import { useReactToPrint } from 'react-to-print';
import { Printer, FileDown, FileSpreadsheet } from 'lucide-react';
import { db, getReassignTrails } from '../db/database';
import type { Operator } from '../db/database';
import DateRangePicker from './DateRangePicker';
import type { DateRange } from '../utils/dateRange';
import { buildWasuliReport, generateWasuliReportPDF, exportWasuliReportCSV, type ReportType, type WasuliReport } from '../utils/wasuliReport';
import WasuliReportPrint from './WasuliReportPrint';
import { fmtCode } from '../utils/masterData';
import { useToast } from '../context/ToastContext';

interface WasuliRow {
  operatorId: number; status: string; amountToCollect: number; collectedAmount?: number;
  assignedDate?: string; assignedAt?: string; collectedDate?: string; collectedAt?: string; drNumber?: string; lrNumber?: string;
  consigneeName?: string; consignor?: string; challanNumber?: string; notes?: string;
}

const TYPES: { id: ReportType; label: string }[] = [
  { id: 'assigned', label: 'Assigned' }, { id: 'pending', label: 'Unassigned' },
  { id: 'collected', label: 'Collected' }, { id: 'all', label: 'All' },
];

/**
 * The one Agent Wasuli Report — replaces the old "Agent Wasuli" / "Pending
 * Wasuli" generic-table reports and the Wasuli page's own Report modal.
 * Loads every (non-deleted) wasuli row up front, same as the Wasuli
 * operational page now does, for the "Unassigned" status. buildWasuliReport
 * (the one wasuli-report engine) does the grouping; WasuliReportPrint (the
 * one layout) renders it — visibly here, and identically for Print/PDF/CSV.
 */
export default function AgentWasuliReportView({ operators }: { operators: Operator[] }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<WasuliRow[]>([]);
  const [trails, setTrails] = useState<Record<string, string[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [agentId, setAgentId] = useState<number | 'all'>('all');
  const [type, setType] = useState<ReportType>('assigned');
  const [range, setRange] = useState<DateRange>({ from: '', to: '' });

  const printRef = useRef<HTMLDivElement>(null);
  const runPrint = useReactToPrint({ contentRef: printRef, documentTitle: 'Agent Wasuli Report' });

  useEffect(() => {
    (async () => {
      const all = await db.wasuli.filter(w => !w.deletedAt).toArray();
      const drs = await db.drs.where('id').anyOf(all.map(w => w.drId)).toArray();
      const drMap = new Map(drs.map(d => [d.id!, d]));
      setRows(all.map(w => {
        const d = drMap.get(w.drId);
        // DR.consignee/consignor are the authoritative, always-synced copies
        // (see generateDRs / updateDRCharges) — w.consigneeName is an older
        // denormalized copy on the wasuli row itself that can be blank on
        // legacy rows. Prefer the DR's, fall back to the row's own copy.
        return {
          operatorId: w.operatorId, status: w.status, amountToCollect: w.amountToCollect, collectedAmount: w.collectedAmount,
          assignedDate: w.assignedDate, assignedAt: w.assignedAt, collectedDate: w.collectedDate, collectedAt: w.collectedAt, notes: w.notes,
          consigneeName: d?.consignee || w.consigneeName,
          drNumber: d?.drNumber || '', lrNumber: d?.lrNumber || '', challanNumber: d?.challanNumber || '',
          consignor: d?.consignor || '',
        };
      }));
      setTrails(await getReassignTrails());
      setLoaded(true);
    })();
  }, []);

  const report: WasuliReport = useMemo(
    () => buildWasuliReport(type, range, operators, rows, agentId, trails),
    [type, range, operators, rows, agentId, trails]
  );

  const segStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 14px', fontSize: 13, cursor: 'pointer', fontWeight: active ? 600 : 500,
    background: active ? 'var(--orange)' : 'var(--card)', color: active ? '#fff' : 'var(--text-secondary)',
    border: '0.5px solid var(--border)', marginLeft: -1,
  });

  if (!loaded) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>;

  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, width: 200 }}>
            <label className="form-label">Agent</label>
            <select className="form-select" value={agentId === 'all' ? 'all' : String(agentId)}
              onChange={e => setAgentId(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">All agents</option>
              {operators.map(o => <option key={o.id} value={o.id}>{o.name}{fmtCode(o.code) ? ` · ${fmtCode(o.code)}` : ''}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Status</label>
            <div style={{ display: 'flex', borderRadius: 'var(--r-md)', overflow: 'hidden' }}>
              {TYPES.map(t => <div key={t.id} style={segStyle(type === t.id)} onClick={() => setType(t.id)}>{t.label}</div>)}
            </div>
          </div>
          <div style={{ minWidth: 260 }}><DateRangePicker value={range} onChange={setRange} /></div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 14 }}>
        <button className="btn btn-outline btn-sm" onClick={() => runPrint()}><Printer size={14} /> Print</button>
        <button className="btn btn-outline btn-sm" onClick={async () => {
          const result = await generateWasuliReportPDF(report);
          if (result.ok) showToast(`Saved to ${result.path}`, 'success');
          else showToast("Shared folder not reachable — file saved to your computer's Downloads folder", 'warning');
        }}><FileDown size={14} /> PDF</button>
        <button className="btn btn-outline btn-sm" onClick={() => exportWasuliReportCSV(report)}><FileSpreadsheet size={14} /> CSV</button>
      </div>

      {/* Scroll wrapper — caps on-screen height so the app window never
          stretches when there are many agents. react-to-print prints the
          full printRef content regardless of on-screen scroll, so Print /
          PDF / CSV always emit every agent. */}
      <div className="memo-doc-wrap" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
        <WasuliReportPrint ref={printRef} report={report} />
      </div>
    </div>
  );
}
