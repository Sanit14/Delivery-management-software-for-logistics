import { forwardRef } from 'react';
import { formatINR, formatDate, todayISO } from '../utils/reportUtils';

/**
 * GenericReportPrint — a clean, all-rows printable layout for the generic reports
 * (station, truck, agent, paymode, pending, daily, monthly). Mirrors the working
 * FirmSummaryPrint structure (.print-area class + @media print @page rule) so
 * react-to-print produces a proper A4 preview/printout — no pagination, no
 * Actions column, no UI chrome.
 */

interface ReportRow { [key: string]: string | number | undefined; }

interface Props {
  title: string;
  filterText: string;
  columns: string[];
  rows: ReportRow[];
  summaryRow?: Record<string, string | number>;
  companyName?: string;
  landscape?: boolean;
}

const MONEY = ['Total', 'Freight', 'Cartage', 'Hamali', 'G.Bhada', 'GDN Insu', 'Dly Chg', 'Amount', 'Assigned \u20b9', 'Collected \u20b9'];

const GenericReportPrint = forwardRef<HTMLDivElement, Props>(
  ({ title, filterText, columns, rows, summaryRow, companyName = 'Sundeep Freight Movers', landscape = false }, ref) => {
    const fmt = (c: string, v: string | number | undefined) =>
      typeof v === 'number' && MONEY.includes(c) ? formatINR(v) : (v ?? '');

    return (
      <div ref={ref} className="generic-report-print print-area">
        <style>{`
        .generic-report-print { font-family: 'Times New Roman', serif; color: #000; padding: 8mm; }
        .grp-company { text-align: center; font-size: 16pt; font-weight: 700; margin-bottom: 2px; }
        .grp-title { text-align: center; font-size: 12pt; font-weight: 700; margin-bottom: 2px; }
        .grp-filter { text-align: center; font-size: 9.5pt; color: #333; margin-bottom: 8px; }
        .grp-table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
        .grp-table th, .grp-table td { border: 0.5px solid #000; padding: 3px 5px; text-align: left; }
        .grp-table th { font-weight: 700; background: #f0f0f0; }
        .grp-table td.num, .grp-table th.num { text-align: right; }
        .grp-table tr.totals td { font-weight: 700; background: #f6f6f6; }
        .grp-foot { margin-top: 8px; font-size: 8pt; color: #666; text-align: right; }
        @media print { @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 8mm; } }
      `}</style>

        <div className="grp-company">{companyName}</div>
        <div className="grp-title">{title}</div>
        <div className="grp-filter">{filterText}</div>

        <table className="grp-table">
          <thead>
            <tr>{columns.map(c => <th key={c} className={MONEY.includes(c) ? 'num' : ''}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map(c => (
                  <td key={c} className={MONEY.includes(c) ? 'num' : ''}>{fmt(c, r[c])}</td>
                ))}
              </tr>
            ))}
            {summaryRow && (
              <tr className="totals">
                {columns.map(c => (
                  <td key={c} className={MONEY.includes(c) ? 'num' : ''}>{fmt(c, summaryRow[c])}</td>
                ))}
              </tr>
            )}
          </tbody>
        </table>

        <div className="grp-foot">Printed: {formatDate(todayISO())}</div>
      </div>
    );
  }
);
GenericReportPrint.displayName = 'GenericReportPrint';

export default GenericReportPrint;
