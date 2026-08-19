import { forwardRef } from 'react';
import type { DR } from '../db/database';
import { formatDate } from '../utils/reportUtils';

interface PrintDRPageProps {
  drs: DR[];
  companyName: string;
}

// Option 3 — full charges table with a prominent GRAND TOTAL row.
// 6 DRs per A4 page (2 columns x 3 rows). Larger, readable fonts.
// "BS No." is a label only; the underlying field stays drNumber.
function DRCell({ dr, companyName }: { dr: DR; companyName: string }) {
  const td: React.CSSProperties = { border: '0.5px solid #000', padding: '1.2mm', textAlign: 'center', fontSize: '8.5pt' };
  const th: React.CSSProperties = { ...td, background: '#ebebeb', fontWeight: 700 };
  const ref: React.CSSProperties = { fontSize: '9.5pt' };
  // Long consignor/consignee/particulars would otherwise paint outward over the
  // neighbouring DR cell (.dr-cell is overflow:hidden, but that alone still lets
  // a too-tall block push the rest of this cell's content past the fold). Clamp
  // to 2 lines with an ellipsis so one long name never costs another DR its print.
  const clamp2: React.CSSProperties = {
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  };
  return (
    <div className="dr-cell">
      {/* Centered company header */}
      <div style={{ textAlign: 'center', borderBottom: '1.5px solid #000', paddingBottom: '1.2mm', marginBottom: '1.8mm' }}>
        <div style={{ fontWeight: 700, fontSize: '14pt', lineHeight: 1.1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{dr.firmName || companyName}</div>
        <div style={{ fontWeight: 700, fontSize: '8pt', letterSpacing: '2.5px' }}>DELIVERY RECEIPT</div>
      </div>

      {/* Top reference rows */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1mm', ...ref }}>
        <span><b>BS No:</b> {dr.drNumber}</span>
        <span><b>LR No:</b> {dr.lrNumber}</span>
        {/* LR Date = booking date (when goods were dispatched) */}
        <span><b>LR Date:</b> {formatDate(dr.bookingDate || '')}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.8mm', ...ref }}>
        <span><b>From:</b> {dr.fromStation}</span>
        <span><b>To:</b> Yavatmal</span>
        {/* Dly Date = actual delivery date (when DR is printed) */}
        <span><b>Dly Date:</b> {formatDate(dr.deliveryDate)}</span>
      </div>

      {/* Consignor & consignee bold above the table */}
      <div style={{ borderTop: '0.5px solid #999', paddingTop: '1.5mm', marginBottom: '1.8mm' }}>
        <div style={{ fontSize: '12pt', fontWeight: 700, lineHeight: 1.35, ...clamp2 }}>Consignor: {dr.consignor}</div>
        <div style={{ fontSize: '12pt', fontWeight: 700, lineHeight: 1.35, ...clamp2 }}>Consignee: {dr.consignee}</div>
        <div style={{ fontSize: '9.5pt', marginTop: '0.8mm', ...clamp2 }}>
          <b>Contain:</b> {dr.particulars} &nbsp;·&nbsp; <b>No. of Pkg:</b> {dr.quantity}
          {dr.truckNumber ? <> &nbsp;·&nbsp; <b>Truck:</b> {dr.truckNumber}</> : null}
        </div>
      </div>

      {/* Full charges table + big grand-total row */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2mm' }}>
        <thead>
          <tr>
            <th style={th}>Freight</th>
            <th style={th}>PF</th>
            <th style={th}>Cartage</th>
            <th style={th}>Hamali</th>
            <th style={th}>G.Bhada</th>
            <th style={th}>GDN.Insu</th>
            <th style={th}>Dly.Chrg</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={td}>{dr.freight > 0 ? dr.freight.toLocaleString('en-IN') : ''}</td>
            <td style={td}>{dr.pf ? dr.pf.toLocaleString('en-IN') : ''}</td>
            <td style={td}>{dr.cartage > 0 ? dr.cartage.toLocaleString('en-IN') : ''}</td>
            <td style={td}>{dr.hamali > 0 ? dr.hamali.toLocaleString('en-IN') : ''}</td>
            <td style={td}>{dr.godownBhada > 0 ? dr.godownBhada.toLocaleString('en-IN') : ''}</td>
            <td style={td}>{dr.godownInsurance > 0 ? dr.godownInsurance.toLocaleString('en-IN') : ''}</td>
            <td style={td}>{dr.deliveryCharges > 0 ? dr.deliveryCharges.toLocaleString('en-IN') : ''}</td>
          </tr>
          <tr>
            <td colSpan={6} style={{ border: '1.5px solid #000', padding: '1.8mm', textAlign: 'right', fontWeight: 700, fontSize: '12pt', background: '#f2f2f2' }}>GRAND TOTAL</td>
            <td style={{ border: '1.5px solid #000', fontWeight: 800, fontSize: '15pt', background: '#f2f2f2', textAlign: 'center' }}>{dr.total > 0 ? dr.total.toLocaleString('en-IN') : ''}</td>
          </tr>
        </tbody>
      </table>

      {/* Signature + NB */}
      <div style={{ fontSize: '10pt', marginTop: '2.5mm', marginBottom: '1.5mm' }}>
        Signature of Consignee Person: _____________________
      </div>
      <div style={{ fontSize: '6.5pt', borderTop: '0.5px solid #ccc', paddingTop: '1mm', color: '#555', lineHeight: 1.25 }}>
        NB: We consignee received goods of self on lorry receipt to hand over the consignee copy will be our liability and responsibility.
      </div>
    </div>
  );
}

const PrintDRPage = forwardRef<HTMLDivElement, PrintDRPageProps>(function PrintDRPage({ drs, companyName }, ref) {
  // 6 DRs per page (2 x 3 grid)
  const pages: (DR | null)[][] = [];
  for (let i = 0; i < drs.length; i += 6) {
    const page: (DR | null)[] = drs.slice(i, i + 6);
    while (page.length < 6) page.push(null);
    pages.push(page);
  }

  return (
    <div ref={ref} className="print-area">
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 5mm; }
          .dr-grid { height: 280mm !important; }
        }
      `}</style>
      {pages.map((page, pi) => (
        <div key={pi} className="dr-grid" style={{ pageBreakAfter: pi < pages.length - 1 ? 'always' : 'auto' }}>
          {page.map((dr, di) =>
            dr ? (
              <DRCell key={dr.id} dr={dr} companyName={companyName} />
            ) : (
              <div key={di} className="dr-cell dr-empty" />
            )
          )}
        </div>
      ))}
    </div>
  );
});

export default PrintDRPage;
