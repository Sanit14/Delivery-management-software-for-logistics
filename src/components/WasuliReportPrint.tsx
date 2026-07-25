import { forwardRef } from 'react';
import type { WasuliReport, ReportGroup, RowStatus } from '../utils/wasuliReport';
import { lrBsCell } from '../utils/wasuliReport';
import { formatINR, formatDate } from '../utils/reportUtils';
import { fmtCode } from '../utils/masterData';

/**
 * WasuliReportPrint — the ONE layout for a built WasuliReport: on screen,
 * printed, and (column-for-column) in the PDF. Renders flat for a single
 * agent and grouped (busiest first, idle agents/the unassigned pool showing
 * a "nothing in this range" line) for all agents. The parent renders this
 * visibly for the screen view and points react-to-print at the same ref for
 * printing — there is no separate on-screen table.
 */

const APP = 'Sundeep Freight Movers';
const TYPE_LABEL: Record<WasuliReport['type'], string> = {
  assigned: 'Assigned', pending: 'Pending (unassigned)', collected: 'Collected', all: 'All',
};
const STATUS_LABEL: Record<RowStatus, string> = { assigned: 'Assigned', pending: 'Pending', collected: 'Collected' };

interface Props { report: WasuliReport; }

// Fixed widths (sum to 100%) so a long name or remark wraps inside its own
// cell instead of stretching the table past the page — never a scrollbar or
// clipped text, just a taller row.
const COL_WIDTHS = ['12%', '13%', '15%', '9%', '9%', '9%', '8%', '9%', '16%'];
const cell: React.CSSProperties = { border: '0.6px solid #000', padding: '4px 5px', fontSize: '8pt', wordBreak: 'break-word' };
const cellC: React.CSSProperties = { ...cell, textAlign: 'center' };
const cellR: React.CSSProperties = { ...cell, textAlign: 'right' };
const headCell: React.CSSProperties = { ...cell, background: '#ececea', fontWeight: 700 };
const headCellC: React.CSSProperties = { ...headCell, textAlign: 'center' };
const headCellR: React.CSSProperties = { ...headCell, textAlign: 'right' };

const WasuliReportPrint = forwardRef<HTMLDivElement, Props>(({ report }, ref) => {
  const rangeLabel = (!report.range.from && !report.range.to)
    ? 'All'
    : `${report.range.from ? formatDate(report.range.from) : '…'} – ${report.range.to ? formatDate(report.range.to) : '…'}`;
  const scopeLabel = report.scope === 'single'
    ? `Agent: ${report.groups[0]?.agentName || ''}`
    : 'All agents';

  return (
    <div ref={ref} className="print-area" style={{ padding: '10mm', fontFamily: 'serif', color: '#000' }}>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '14pt' }}>{APP}</div>
      <div style={{ textAlign: 'center', fontWeight: 700, fontSize: '12pt', marginBottom: 2 }}>Agent Wasuli Report — {TYPE_LABEL[report.type]}</div>
      <div style={{ textAlign: 'center', fontSize: '9.5pt', color: '#333', marginBottom: 10 }}>{scopeLabel} · {rangeLabel}</div>

      {report.scope === 'single' ? (
        <ReportTable group={report.groups[0]} />
      ) : (
        report.groups.map(g => (
          <div key={g.agentId} style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: '10pt', borderBottom: '1px solid #000', paddingBottom: 2, marginBottom: 3 }}>
              {g.agentName} {g.agentCode ? `(${fmtCode(Number(g.agentCode))})` : ''}
            </div>
            {g.count === 0 ? (
              <div style={{ fontSize: '8.5pt', color: '#666', fontStyle: 'italic', padding: '2px 0' }}>
                Nothing in this range
              </div>
            ) : (
              <>
                <ReportTable group={g} />
                <div style={{ textAlign: 'right', fontSize: '9pt', fontWeight: 700, marginTop: 2 }}>
                  {g.agentName} subtotal: {formatINR(g.subtotal)} ({g.count})
                </div>
              </>
            )}
          </div>
        ))
      )}

      {/* Grand total */}
      <div style={{ borderTop: '1.5px solid #000', paddingTop: 6, marginTop: 8, textAlign: 'right', fontWeight: 700, fontSize: '11pt' }}>
        {report.scope === 'single'
          ? `Total: ${formatINR(report.grandTotal)} (${report.grandCount} DR)`
          : `Grand total: ${formatINR(report.grandTotal)} · ${report.grandCount} DR · ${report.agentCount} agent`}
      </div>
    </div>
  );
});
WasuliReportPrint.displayName = 'WasuliReportPrint';

function ReportTable({ group }: { group: ReportGroup | undefined }) {
  if (!group) return null;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <colgroup>{COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}</colgroup>
      <thead><tr>
        <th style={headCell}>LR / BS</th><th style={headCell}>Consignor</th><th style={headCell}>Consignee</th><th style={headCell}>Challan</th>
        <th style={headCell}>Assigned</th><th style={headCell}>Collected</th><th style={headCellC}>Status</th>
        <th style={headCellR}>Amount</th><th style={headCell}>Remark</th>
      </tr></thead>
      <tbody>
        {group.rows.map((r, i) => (
          <tr key={i} style={{ background: i % 2 === 1 ? '#f7f7f5' : undefined }}>
            <td style={cell}>{lrBsCell(r)}</td>
            <td style={cell}>{r.consignor}</td>
            <td style={cell}>{r.party}{r.trail ? <span style={{ fontSize: '7pt', color: '#555' }}> ({r.trail.join(' -> ')})</span> : ''}</td>
            <td style={cell}>#{r.challan}</td>
            <td style={cell}>{r.assignedDate ? formatDate(r.assignedDate) : ''}</td>
            <td style={cell}>{r.collectedDate ? formatDate(r.collectedDate) : ''}</td>
            <td style={cellC}>{STATUS_LABEL[r.status]}</td>
            <td style={cellR}>{r.amount.toLocaleString('en-IN')}</td>
            <td style={{ ...cell, fontStyle: r.remark ? 'italic' : undefined }}>{r.remark}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default WasuliReportPrint;
