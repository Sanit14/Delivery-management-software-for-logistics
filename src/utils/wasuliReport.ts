import type { DateRange } from './dateRange';
import { inRange } from './dateRange';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatDate, todayISO, type ExportResult } from './reportUtils';

/**
 * Builds the wasuli report data structure used by the preview, print, and PDF.
 *
 * One shape handles every case:
 *   - single agent  → exactly one group (rendered flat)
 *   - all agents    → many groups (rendered grouped, with a grand total)
 *   - assigned      → has an agent, not yet collected (assignedDate is the event)
 *   - pending       → the unassigned pool — no agent yet (only meaningful under "all agents")
 *   - collected     → collectedDate is the event, amount = collectedAmount
 *   - all           → every status together; both dates shown, blank where not applicable
 *
 * Rules locked with the user:
 *   - All agents are ALWAYS shown (Option A). An agent with no DRs in the range
 *     still appears, with an empty row list and a zero subtotal. The unassigned
 *     pool gets the same treatment as a synthetic "Unassigned" group.
 *   - Groups are sorted by DR count descending (busiest agent on top, agents with
 *     nothing assigned fall to the bottom).
 *   - Rows within a group are sorted by date (oldest first).
 *   - Remark stays as its own column in every status — blank where there isn't one.
 */

export type ReportType = 'assigned' | 'pending' | 'collected' | 'all';
export type RowStatus = 'assigned' | 'pending' | 'collected';

export interface ReportRow {
  bsNumber: string;     // DR number
  lrNumber: string;     // LR number
  consignor: string;    // consignor
  party: string;        // consignee / firmName
  challan: string;       // challan number
  assignedDate: string;  // ISO date this DR was assigned, '' if never
  collectedDate: string; // ISO date this DR was collected, '' if not yet
  status: RowStatus;
  amount: number;       // amountToCollect (assigned/pending) or collectedAmount (collected)
  remark: string;       // wasuli notes — blank is fine, an honest empty column
  trail?: string[];     // reassign chain (e.g. ["Suresh","Navaz"]) if reassigned
}

export interface ReportGroup {
  agentId: number;      // 0 = the synthetic "Unassigned" group
  agentName: string;
  agentCode: string;
  rows: ReportRow[];
  subtotal: number;
  count: number;
}

export interface WasuliReport {
  type: ReportType;
  range: DateRange;
  scope: 'single' | 'all';
  groups: ReportGroup[];
  grandTotal: number;
  grandCount: number;
  agentCount: number;   // real agents (excludes the synthetic Unassigned group) that had at least one DR in range
}

// Minimal shapes the builder needs (kept loose so callers can pass their WRow).
interface WasuliLike {
  operatorId: number;
  status: string;
  amountToCollect: number;
  collectedAmount?: number;
  assignedDate?: string;
  collectedDate?: string;
  drNumber?: string;
  lrNumber?: string;
  consigneeName?: string;
  consignor?: string;
  challanNumber?: string;
  notes?: string;
}
interface AgentLike { id?: number; name: string; code?: string | number; }

// A wasuli row's status is derived, not stored directly: 'collected' rows are
// collected; everything else is 'assigned' (has an agent) or 'pending' (the
// unassigned pool) depending on operatorId. Wasuli.status never actually goes
// to 'cancelled' in practice (challans/entries do; wasuli rows are soft-deleted
// instead), so there's no third case to special-case here.
function rowStatus(r: WasuliLike): RowStatus {
  if (r.status === 'collected') return 'collected';
  return r.operatorId !== 0 ? 'assigned' : 'pending';
}

export function buildWasuliReport(
  type: ReportType,
  range: DateRange,
  agents: AgentLike[],
  rows: WasuliLike[],
  scopeAgentId: number | 'all',
  trails: Record<string, string[]> = {},
): WasuliReport {
  const matches = (r: WasuliLike) => type === 'all' || rowStatus(r) === type;
  // The date that "counts" for range filtering: a collected row's event is when
  // it was collected; an uncollected row's event is when it was assigned.
  const eventDate = (r: WasuliLike) => (rowStatus(r) === 'collected' ? r.collectedDate : r.assignedDate) || '';

  const agentList = scopeAgentId === 'all' ? agents : agents.filter(a => a.id === scopeAgentId);
  // Unassigned rows never belong to a real agent — only surfaced as a synthetic
  // group when browsing all agents with a status that can include them. A
  // specific agent selection + Pending correctly yields nothing (an agent can't
  // own an unassigned DR).
  const includeUnassigned = scopeAgentId === 'all' && (type === 'pending' || type === 'all');

  const buildGroup = (agentId: number, agentName: string, agentCode: string): ReportGroup => {
    const mine = rows.filter(r => (r.operatorId || 0) === agentId && matches(r) && inRange(eventDate(r), range));
    const reportRows: ReportRow[] = mine.map(r => ({
      bsNumber: r.drNumber || '', lrNumber: r.lrNumber || '', consignor: r.consignor || '', party: r.consigneeName || '', challan: r.challanNumber || '',
      assignedDate: r.assignedDate || '', collectedDate: r.collectedDate || '',
      status: rowStatus(r),
      amount: rowStatus(r) === 'collected' ? (r.collectedAmount || 0) : r.amountToCollect,
      remark: r.notes || '',
      trail: (r.drNumber && trails[r.drNumber] && trails[r.drNumber].length > 1) ? trails[r.drNumber] : undefined,
    })).sort((x, y) => {
      const dx = x.collectedDate || x.assignedDate, dy = y.collectedDate || y.assignedDate;
      return dx < dy ? -1 : dx > dy ? 1 : 0; // oldest first
    });

    const subtotal = reportRows.reduce((s, r) => s + r.amount, 0);
    return { agentId, agentName, agentCode, rows: reportRows, subtotal, count: reportRows.length };
  };

  const groups: ReportGroup[] = agentList.map(a => buildGroup(a.id || 0, a.name, String(a.code ?? '')));
  if (includeUnassigned) groups.push(buildGroup(0, 'Unassigned', ''));

  // Busiest first; agents with nothing fall to the bottom. Tie-break by name.
  groups.sort((g1, g2) => g2.count - g1.count || g1.agentName.localeCompare(g2.agentName));

  const grandTotal = groups.reduce((s, g) => s + g.subtotal, 0);
  const grandCount = groups.reduce((s, g) => s + g.count, 0);
  const agentCount = groups.filter(g => g.count > 0 && g.agentId !== 0).length;

  return {
    type, range,
    scope: scopeAgentId === 'all' ? 'all' : 'single',
    groups, grandTotal, grandCount, agentCount,
  };
}

const TYPE_LABEL: Record<ReportType, string> = {
  assigned: 'Assigned', pending: 'Pending (unassigned)', collected: 'Collected', all: 'All',
};
const STATUS_LABEL: Record<RowStatus, string> = { assigned: 'Assigned', pending: 'Pending', collected: 'Collected' };

// Combined LR/BS cell — used by the print view and the PDF. Shows just the
// present one if either side is blank (a not-yet-saved entry has no BS yet).
export const lrBsCell = (r: Pick<ReportRow, 'lrNumber' | 'bsNumber'>): string =>
  r.lrNumber && r.bsNumber ? `${r.lrNumber} / ${r.bsNumber}` : (r.lrNumber || r.bsNumber || '');

// ── CSV export — same bespoke-blob-download convention as the Firm Settlement
// report's exportCSV (Reports.tsx), since this is a grouped document, not a
// flat ReportRow table the generic generateCSV() pipeline is shaped for.
export function exportWasuliReportCSV(report: WasuliReport): void {
  const header = ['Agent', 'BS No', 'LR No', 'Party', 'Challan', 'Assigned Date', 'Collected Date', 'Status', 'Remark', 'Amount'];
  const lines: string[] = [];
  for (const g of report.groups) {
    for (const r of g.rows) {
      lines.push([
        `${g.agentName}${g.agentCode ? ` (${g.agentCode})` : ''}`, r.bsNumber, r.lrNumber, r.party, `#${r.challan}`,
        r.assignedDate ? formatDate(r.assignedDate) : '', r.collectedDate ? formatDate(r.collectedDate) : '',
        STATUS_LABEL[r.status], r.remark, r.amount,
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    if (report.scope === 'all') lines.push(`,,,,,,,,Subtotal (${g.agentName}),${g.subtotal}`);
  }
  lines.push(report.scope === 'single'
    ? `,,,,,,,,TOTAL (${report.grandCount} DR),${report.grandTotal}`
    : `,,,,,,,,GRAND TOTAL (${report.agentCount} agents · ${report.grandCount} DR),${report.grandTotal}`);
  const csv = [header.join(','), ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `Wasuli_${report.type}_${todayISO()}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ── Real PDF generation (saves a .pdf file, like the app's other reports) ──
// Builds the same flat (single agent) / grouped (all agents) layout as the screen
// print, but as a downloadable PDF via jsPDF — so the PDF button truly produces a
// file instead of opening the print dialog.
const rs = (v: string | number): string =>
  (typeof v === 'string' ? v : String(v)).replace(/₹\s?/g, 'Rs ');

export async function generateWasuliReportPDF(report: WasuliReport): Promise<ExportResult> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const today = formatDate(todayISO());
  const rangeLabel = (!report.range.from && !report.range.to)
    ? 'All dates'
    : `${report.range.from ? formatDate(report.range.from) : '...'} to ${report.range.to ? formatDate(report.range.to) : '...'}`;
  const scopeLabel = report.scope === 'single'
    ? `Agent: ${report.groups[0]?.agentName || ''}`
    : 'All agents';

  doc.setFontSize(16); doc.setFont('helvetica', 'bold');
  doc.text('SUNDEEP FREIGHT MOVERS', pageW / 2, 15, { align: 'center' });
  doc.setFontSize(12);
  doc.text(`Agent Wasuli Report - ${TYPE_LABEL[report.type]}`, pageW / 2, 22, { align: 'center' });
  doc.setFontSize(9); doc.setFont('helvetica', 'normal');
  doc.text(`${scopeLabel}  |  ${rangeLabel}`, pageW / 2, 28, { align: 'center' });
  doc.text(`Generated: ${today}`, pageW - 10, 28, { align: 'right' });
  doc.setLineWidth(0.4); doc.line(10, 31, pageW - 10, 31);

  let y = 36;
  const cols = ['LR / BS', 'Consignor', 'Consignee', 'Challan', 'Assigned', 'Collected', 'Status', 'Amount', 'Remark'];
  const amtCol = 7;
  const statusCol = 6;
  // Fixed mm widths (sum to the ~190mm usable A4 width) — same fixed-width
  // idea as the on-screen/print table, so a long name or remark wraps inside
  // its own cell instead of pushing the table wider than the page.
  const colWidths = [22.8, 24.7, 28.5, 17.1, 17.1, 17.1, 15.2, 17.1, 30.4];

  const drawGroupTable = (rows: ReportRow[], heading?: string) => {
    if (heading) {
      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(rs(heading), 10, y);
      y += 2;
    }
    autoTable(doc, {
      head: [cols],
      body: rows.map(r => [
        lrBsCell(r), rs(r.consignor), rs(r.party) + (r.trail ? ` (${r.trail.join(' -> ')})` : ''), `#${r.challan}`,
        r.assignedDate ? formatDate(r.assignedDate) : '',
        r.collectedDate ? formatDate(r.collectedDate) : '',
        STATUS_LABEL[r.status],
        r.amount.toLocaleString('en-IN'), rs(r.remark),
      ]),
      startY: y,
      margin: { left: 10, right: 10 },
      styles: { fontSize: 7.5, font: 'helvetica', cellWidth: 'wrap' },
      headStyles: { fillColor: [26, 39, 68], textColor: 255, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [244, 246, 251] },
      columnStyles: {
        ...Object.fromEntries(colWidths.map((w, i) => [i, { cellWidth: w }])),
        [statusCol]: { cellWidth: colWidths[statusCol], halign: 'center' },
        [amtCol]: { cellWidth: colWidths[amtCol], halign: 'right' },
      },
    });
    // @ts-expect-error lastAutoTable is added by the plugin
    y = doc.lastAutoTable.finalY + 4;
  };

  if (report.scope === 'single') {
    drawGroupTable(report.groups[0]?.rows || []);
  } else {
    report.groups.forEach(g => {
      if (y > 260) { doc.addPage(); y = 15; }
      const heading = `${g.agentName}${g.agentCode ? ` (${g.agentCode})` : ''}`;
      if (g.count === 0) {
        doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.text(rs(heading), 10, y);
        doc.setFontSize(8); doc.setFont('helvetica', 'italic');
        doc.text(`(nothing in this range)`, 60, y);
        y += 7;
      } else {
        drawGroupTable(g.rows, heading);
        doc.setFontSize(8.5); doc.setFont('helvetica', 'bold');
        doc.text(`${g.agentName} subtotal: Rs ${g.subtotal.toLocaleString('en-IN')} (${g.count})`, pageW - 10, y, { align: 'right' });
        y += 6;
      }
    });
  }

  if (y > 270) { doc.addPage(); y = 15; }
  doc.setLineWidth(0.5); doc.line(10, y, pageW - 10, y); y += 6;
  doc.setFontSize(11); doc.setFont('helvetica', 'bold');
  const grand = report.scope === 'single'
    ? `Total: Rs ${report.grandTotal.toLocaleString('en-IN')} (${report.grandCount} DR)`
    : `Grand total: Rs ${report.grandTotal.toLocaleString('en-IN')}  |  ${report.grandCount} DR  |  ${report.agentCount} agent`;
  doc.text(grand, pageW - 10, y, { align: 'right' });

  const fileName = `Wasuli_${report.type}_${today.replace(/-/g, '')}.pdf`;
  const api = (typeof window !== 'undefined') ? window.sqlAPI : undefined;
  if (api?.saveExport) {
    try {
      const base64 = doc.output('datauristring').split(',')[1];
      const path = await api.saveExport('pdf', fileName, base64);
      if (path) return { ok: true, path };
      doc.save(fileName);
      return { ok: false, fallback: true };
    } catch {
      doc.save(fileName);
      return { ok: false, fallback: true };
    }
  }
  doc.save(fileName);
  return { ok: false, fallback: true };
}
