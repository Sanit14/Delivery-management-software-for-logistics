import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import Papa from 'papaparse';

export const formatINR = (n: number) =>
  '₹' + (n || 0).toLocaleString('en-IN');

// jsPDF's built-in fonts cannot render the ₹ glyph — use "Rs" in PDFs
export const formatINRPdf = (n: number) =>
  'Rs ' + (n || 0).toLocaleString('en-IN');

export const formatDate = (iso: string) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
};

export const daysDiff = (from: string, to?: string) => {
  if (!from) return 0;
  const a = new Date(from);
  const b = to ? new Date(to) : new Date();
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
};

// Local calendar date as YYYY-MM-DD. Uses LOCAL time (not UTC) so that work done
// after midnight in IST gets the correct local date — toISOString() would return
// the UTC date, which is still "yesterday" until 5:30am IST.
export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const currentMonthISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

interface ReportConfig {
  reportName: string;
  filters: string;
  columns: string[];
  rows: Record<string, string | number>[];
  summaryRow?: Record<string, string | number>;
  landscape?: boolean;
}

// What actually happened to an exported file: saved where it was configured to
// go, or (keeper unreachable / configured folder gone) fell back to a plain
// browser-style download. Callers use this to tell the user which one occurred
// — see the audit note above each generator for why that matters.
export type ExportResult = { ok: true; path: string } | { ok: false; fallback: true };

// jsPDF's built-in fonts cannot encode ₹ — swap to "Rs" everywhere before rendering
const rs = (v: string | number): string | number =>
  typeof v === 'string' ? v.replace(/₹\s?/g, 'Rs ') : v;

export async function generatePDF(config: ReportConfig): Promise<ExportResult> {
  const { reportName, filters, columns, rows, summaryRow, landscape } = config;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });

  const pageW = doc.internal.pageSize.getWidth();
  const today = formatDate(todayISO());

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('SUNDEEP FREIGHT MOVERS', pageW / 2, 15, { align: 'center' });
  doc.setFontSize(11);
  doc.text('Yavatmal', pageW / 2, 21, { align: 'center' });

  doc.setLineWidth(0.5);
  doc.line(10, 24, pageW - 10, 24);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Report: ${rs(reportName)}`, 10, 30);
  doc.text(`Generated: ${today}`, pageW - 10, 30, { align: 'right' });
  doc.text(`Filters: ${rs(filters)}`, 10, 36);
  doc.line(10, 39, pageW - 10, 39);

  const tableRows = rows.map(r => columns.map(c => rs(r[c] ?? '')));
  if (summaryRow) tableRows.push(columns.map(c => rs(summaryRow[c] ?? '')));

  autoTable(doc, {
    head: [columns.map(c => rs(c) as string)],
    body: tableRows,
    startY: 42,
    styles: { fontSize: 8, font: 'helvetica' },
    headStyles: { fillColor: [26, 39, 68], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    alternateRowStyles: { fillColor: [244, 246, 251] },
    bodyStyles: { fillColor: [255, 255, 255] },
    didParseCell: (data) => {
      if (summaryRow && data.row.index === rows.length) {
        data.cell.styles.fillColor = [249, 115, 22];
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawPage: () => {
      const pageCount = doc.getNumberOfPages();
      const current = doc.getCurrentPageInfo().pageNumber;
      doc.setFontSize(8);
      doc.setFont('helvetica', 'normal');
      doc.text(`Page ${current} of ${pageCount}  |  Sundeep Freight Movers`, pageW / 2, doc.internal.pageSize.getHeight() - 5, { align: 'center' });
    },
  });

  const fileName = `${reportName.replace(/\s+/g, '_')}_${today.replace(/-/g, '')}.pdf`;
  // In Electron, save into the PDF/ folder under the data root (via the keeper).
  // In the browser/dev, fall back to the normal download.
  const api = (typeof window !== 'undefined') ? window.sqlAPI : undefined;
  if (api?.saveExport) {
    try {
      const base64 = doc.output('datauristring').split(',')[1]; // strip data: prefix
      const path = await api.saveExport('pdf', fileName, base64);
      if (path) return { ok: true, path };
      doc.save(fileName); // keeper failed → fall back to download
      return { ok: false, fallback: true };
    } catch {
      doc.save(fileName);
      return { ok: false, fallback: true };
    }
  }
  doc.save(fileName);
  return { ok: false, fallback: true };
}

interface MemoPdfRow {
  drNumber: string; lrNumber: string; consignor: string; consignee: string;
  particulars: string; quantity: number; toPay: number; paid: number; pf: number;
  total: number; paymentMode: string; collection: string;
}
interface MemoPdfData {
  companyLocation: string; firmName: string; challanNumber: string; entryDate: string;
  truckNumber: string; loadingStation: string; truckHire: number;
  rows: MemoPdfRow[]; totalToPay: number; totalPaid: number; totalPF: number; totalPkgs: number; grandTotal: number;
}

/**
 * A real PDF file for one memo — same layout as the printed document (company
 * header, challan details, full entry table, totals, signature lines), built
 * directly rather than reusing the generic tabular report generator, since a
 * memo needs its own header block and footer, not just columns and rows. Saved
 * the same way every other export in the app is, into the configured PDF
 * folder via the keeper, with a normal download as the fallback.
 */
export async function generateMemoPDF(data: MemoPdfData): Promise<ExportResult> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text(data.firmName.toUpperCase(), pageW / 2, 15, { align: 'center' });
  doc.setFontSize(10);
  doc.text('DELIVERY MEMO', pageW / 2, 21, { align: 'center' });
  doc.setLineWidth(0.5);
  doc.line(10, 25, pageW - 10, 25);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  const col1 = 10, col2 = pageW / 2 + 5;
  doc.text(`Challan No.: #${data.challanNumber}`, col1, 32);
  doc.text(`Truck: ${data.truckNumber || '-'}`, col2, 32);
  doc.text(`Date: ${formatDate(data.entryDate)}`, col1, 38);
  doc.text(`Truck hire: ${data.truckHire ? formatINRPdf(data.truckHire) : '-'}`, col2, 38);
  doc.text(`From: ${data.loadingStation || '-'}`, col1, 44);
  doc.text(`To: ${data.companyLocation || '-'}`, col2, 44);
  doc.line(10, 48, pageW - 10, 48);

  autoTable(doc, {
    head: [['Consignor', 'Consignee', 'LR No.', 'Particulars', 'Pkgs', 'ToPay', 'Paid', 'PF', 'Total', 'Collection']],
    body: data.rows.map((r) => [
      r.consignor, r.consignee, r.lrNumber, r.particulars,
      r.quantity || '', r.toPay ? formatINRPdf(r.toPay) : '', r.paid ? formatINRPdf(r.paid) : '',
      r.pf ? formatINRPdf(r.pf) : '', formatINRPdf(r.total), r.collection,
    ]),
    startY: 52,
    styles: { fontSize: 7.5, font: 'helvetica' },
    headStyles: { fillColor: [26, 39, 68], textColor: 255, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [244, 246, 251] },
  });

  // @ts-expect-error jspdf-autotable augments the doc instance with lastAutoTable at runtime
  let y = (doc.lastAutoTable?.finalY || 60) + 8;
  if (y + 40 > 297) {
    doc.addPage();
    y = 20;
  }
  doc.setLineWidth(0.3);
  doc.line(10, y - 4, pageW - 10, y - 4);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(`${data.rows.length} entries`, 10, y);
  doc.text(`Pkgs: ${data.totalPkgs}`, 55, y);
  doc.text(`ToPay: ${formatINRPdf(data.totalToPay)}`, 85, y);
  doc.text(`Paid: ${formatINRPdf(data.totalPaid)}`, 120, y);
  doc.text(`PF: ${formatINRPdf(data.totalPF)}`, 150, y);
  doc.text(`Grand Total: ${formatINRPdf(data.grandTotal)}`, 175, y);

  const sigY = y + 30;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.line(20, sigY, 80, sigY);
  doc.text('Prepared By', 50, sigY + 5, { align: 'center' });
  doc.line(pageW - 80, sigY, pageW - 20, sigY);
  doc.text('Received By', pageW - 50, sigY + 5, { align: 'center' });

  doc.setFontSize(7.5);
  doc.setTextColor(120);
  doc.text(`Challan Date ${formatDate(data.entryDate)}`, pageW - 10, doc.internal.pageSize.getHeight() - 8, { align: 'right' });

  const fileName = `Memo_${data.challanNumber}_${data.entryDate.replace(/-/g, '')}.pdf`;
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

export async function generateCSV(config: ReportConfig, fileName?: string): Promise<ExportResult> {
  const { reportName, filters, columns, rows } = config;
  const today = formatDate(todayISO());

  const meta = [
    [`# Sundeep Freight Movers — ${reportName}`],
    [`# Filters: ${filters}`],
    [`# Generated: ${today}`],
    [],
  ];

  // Excel collapses date-looking values (dd-mm-yyyy) to ### when the column is narrow,
  // and sometimes auto-reformats them. Force any dd-mm-yyyy cell to be treated as TEXT
  // by wrapping it so Excel shows it literally regardless of column width.
  const asText = (v: unknown): string | number => {
    if (typeof v === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(v)) {
      return `="${v}"`;   // Excel reads ="18-06-2026" as the literal text, never a date
    }
    return v as string | number;
  };

  const data = rows.map(r => columns.map(c => asText(r[c] ?? '')));
  const csv = Papa.unparse({ fields: columns, data });
  const metaStr = meta.map(r => r.join(',')).join('\n');
  const full = metaStr + '\n' + csv;
  const outName = fileName || `${reportName.replace(/\s+/g, '_')}_${today.replace(/-/g, '')}.csv`;

  const browserDownload = () => {
    const blob = new Blob([full], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = outName;
    link.click();
    URL.revokeObjectURL(url);
  };

  // In Electron, save into the CSV/ folder under the data root (via the keeper).
  const api = (typeof window !== 'undefined') ? window.sqlAPI : undefined;
  if (api?.saveExport) {
    try {
      const path = await api.saveExport('csv', outName, full);
      if (path) return { ok: true, path };
    } catch { /* fall through to browser download */ }
    browserDownload();
    return { ok: false, fallback: true };
  }
  browserDownload();
  return { ok: false, fallback: true };
}
