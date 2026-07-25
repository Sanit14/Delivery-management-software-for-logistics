import { forwardRef } from 'react';
import type { Challan, LREntry, DR, Wasuli } from '../db/database';
import { formatINR, formatDate } from '../utils/reportUtils';
import { collectionLabel } from '../utils/collectionLabel';

export interface MemoPrintRow { entry: LREntry; dr: DR | null; wasuli: Wasuli | null }

interface Props {
  challan: Challan;
  companyLocation: string;
  rows: MemoPrintRow[];
}

/**
 * The proper printable memo document — this is what "Print Memo" and "Save
 * PDF" actually render, following the same .print-area convention every other
 * print document in the app already uses. Without this, calling window.print()
 * on the plain on-screen page had nothing to show — the shared print
 * stylesheet hides everything except elements inside .print-area.
 */
const MemoPrint = forwardRef<HTMLDivElement, Props>(function MemoPrint({ challan, companyLocation, rows }, ref) {
  const totalToPay = rows.reduce((s, r) => s + (r.entry.paymentMode === 'topay' ? r.entry.toPay : 0), 0);
  const totalPaid = rows.reduce((s, r) => s + (r.entry.paymentMode === 'paid' ? r.entry.paid : 0), 0);
  const totalPF = rows.reduce((s, r) => s + (r.entry.pf || 0), 0);
  const totalPkgs = rows.reduce((s, r) => s + (Number(r.entry.quantity) || 0), 0);
  const grandTotal = rows.reduce((s, r) => s + r.entry.total, 0);

  const td: React.CSSProperties = { border: '0.5px solid #000', padding: '1.6mm 2mm', fontSize: '8.5pt' };
  const th: React.CSSProperties = { ...td, background: '#ebebeb', fontWeight: 700, textAlign: 'left' };

  return (
    <div ref={ref} className="print-area" style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '4mm' }}>
      <style>{`@media print { @page { size: A4 portrait; margin: 10mm; } }`}</style>

      <div style={{ textAlign: 'center', borderBottom: '2px solid #000', paddingBottom: '2mm', marginBottom: '4mm' }}>
        <div style={{ fontWeight: 700, fontSize: '16pt' }}>{challan.firmName}</div>
        <div style={{ fontWeight: 700, fontSize: '9pt', letterSpacing: '2px', marginTop: '1mm' }}>DELIVERY MEMO</div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2mm', fontSize: '9pt', marginBottom: '4mm' }}>
        <div><b>Challan No.:</b> #{challan.challanNumber}</div>
        <div><b>Truck:</b> {challan.truckNumber || '—'}</div>
        <div><b>Date:</b> {formatDate(challan.entryDate)}</div>
        <div><b>Truck hire:</b> {challan.truckHire ? formatINR(challan.truckHire) : '—'}</div>
        <div><b>From:</b> {challan.loadingStation || '—'}</div>
        <div><b>To:</b> {companyLocation || '—'}</div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '4mm' }}>
        <thead>
          <tr>
            <th style={th}>Consignor</th>
            <th style={th}>Consignee</th>
            <th style={th}>LR No.</th>
            <th style={th}>Particulars</th>
            <th style={{ ...th, textAlign: 'right' }}>Pkgs</th>
            <th style={{ ...th, textAlign: 'right' }}>ToPay</th>
            <th style={{ ...th, textAlign: 'right' }}>Paid</th>
            <th style={{ ...th, textAlign: 'right' }}>PF</th>
            <th style={{ ...th, textAlign: 'right' }}>Total</th>
            <th style={th}>Collection</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.entry.id}>
              <td style={td}>{r.entry.consignor}</td>
              <td style={td}>{r.entry.consignee}</td>
              <td style={td}>{r.entry.lrNumber}</td>
              <td style={td}>{r.entry.particulars}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.entry.quantity || ''}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.entry.toPay ? formatINR(r.entry.toPay) : ''}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.entry.paid ? formatINR(r.entry.paid) : ''}</td>
              <td style={{ ...td, textAlign: 'right' }}>{r.entry.pf ? formatINR(r.entry.pf) : ''}</td>
              <td style={{ ...td, textAlign: 'right' }}>{formatINR(r.entry.total)}</td>
              <td style={td}>{collectionLabel(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8mm', fontSize: '9.5pt', paddingTop: '2mm', borderTop: '1.5px solid #000', marginBottom: '10mm' }}>
        <span>{rows.length} entries</span>
        <span>Pkgs: <b>{totalPkgs}</b></span>
        <span>ToPay: <b>{formatINR(totalToPay)}</b></span>
        <span>Paid: <b>{formatINR(totalPaid)}</b></span>
        <span>PF: <b>{formatINR(totalPF)}</b></span>
        <span>Grand Total: <b>{formatINR(grandTotal)}</b></span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9pt', marginTop: '12mm' }}>
        <div style={{ borderTop: '1px solid #000', paddingTop: '1.5mm', width: '45mm', textAlign: 'center' }}>Prepared By</div>
        <div style={{ borderTop: '1px solid #000', paddingTop: '1.5mm', width: '45mm', textAlign: 'center' }}>Received By</div>
      </div>

      <div style={{ marginTop: '6mm', fontSize: '7.5pt', color: '#555', textAlign: 'right' }}>Challan Date {formatDate(challan.entryDate)}</div>
    </div>
  );
});

export default MemoPrint;
