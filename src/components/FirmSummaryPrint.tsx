import { forwardRef } from 'react';
import { formatDate, todayISO } from '../utils/reportUtils';
import { computeFirmSettlement, signPrefix } from '../utils/firmSettlement';

export interface FirmSummaryRow {
    date: string;
    challanNumber: string;
    truckNumber: string;
    loadingDate: string;
    loadingStation: string;
    toPay: number;
    paid: number;
    deliveryCharges: number;
    crossing: number;
    doorDelivery: number;
    truckHire: number;
    pf: number;
    refund: number;
    dcAmount: number;
}

// Print/PDF-only overrides for the base settlement rows — never written to the
// database. Undefined for any field falls back to the real computed total.
// Each base row also carries its own sign — flippable in edit mode, defaulting
// to the direction the row has always applied (PF is the one '+' by default).
export interface FirmSummaryOverrides {
    totalAmount?: number;
    toPay?: number;
    truckHire?: number; truckHireSign?: 1 | -1;
    doorDelivery?: number; doorDeliverySign?: 1 | -1;
    crossing?: number; crossingSign?: 1 | -1;
    dcAmount?: number; dcAmountSign?: 1 | -1;
    pf?: number; pfSign?: 1 | -1;
    refund?: number; refundSign?: 1 | -1;
}

export interface FirmSummaryData {
    firmName: string;
    companyName: string;
    dateFrom: string;
    dateTo: string;
    rows: FirmSummaryRow[];
    dcPercent: number;
    // One-time charges for THIS printout only — never saved to the database.
    adjustmentLines?: { label: string; amount: number; sign: 1 | -1 }[];
    // Charges already saved against a challan (category:'adjustment' ledger rows)
    // — read-only here, traceable back to their challan.
    savedAdjustmentLines?: { challanNumber: string; label: string; amount: number; sign: 1 | -1 }[];
    overrides?: FirmSummaryOverrides;
}

// Plain number with Indian grouping, no currency symbol (clean for print tables)
const num = (n: number) => (Math.round(n) || 0).toLocaleString('en-IN');
// Paisa-aware: shows exactly 2 decimal places for amounts like DC that can have paisa
const numP = (n: number) => {
    const v = +(n || 0).toFixed(2);
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const prefix = signPrefix;

interface Props {
    data: FirmSummaryData;
}

const FirmSummaryPrint = forwardRef<HTMLDivElement, Props>(function FirmSummaryPrint({ data }, ref) {
    const {
        raw: t, toPay, truckHire, doorDelivery, crossing, dcAmount, pf, refund,
        truckHireSign, doorDeliverySign, crossingSign, dcAmountSign, pfSign, refundSign,
        balance, savedAdjustmentLines, adjustmentLines, roundFigure,
    } = computeFirmSettlement(data);

    return (
        <div ref={ref} className="firm-summary-print print-area">
            <style>{`
        .firm-summary-print { font-family: 'Times New Roman', serif; color: #000; padding: 8mm; }
        .fsp-company { text-align: center; font-size: 16pt; font-weight: 700; font-style: italic; margin-bottom: 2px; }
        .fsp-title { text-align: center; font-size: 13pt; font-weight: 700; margin-bottom: 4px; }
        .fsp-date { font-size: 10pt; margin-bottom: 6px; }
        .fsp-table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
        .fsp-table th, .fsp-table td { border: 0.5px solid #000; padding: 3px 4px; text-align: left; }
        .fsp-table th { font-weight: 700; background: #f0f0f0; text-align: center; }
        .fsp-table td.num, .fsp-table th.num { text-align: right; }
        .fsp-table tr.totals td { font-weight: 700; background: #f6f6f6; }
        .fsp-report-title { text-align: center; font-weight: 700; font-size: 11pt; margin: 14px 0 8px; }
        .fsp-summary { width: 360px; margin: 0 auto; font-size: 10pt; }
        .fsp-line { display: flex; justify-content: space-between; align-items: baseline; padding: 2px 0; }
        .fsp-line .label { white-space: nowrap; }
        .fsp-line .dots { flex: 1; border-bottom: 1px dotted #999; margin: 0 6px; transform: translateY(-3px); }
        .fsp-line .amt { font-weight: 600; min-width: 70px; text-align: right; }
        .fsp-dc-base { font-size: 8pt; color: #555; margin-top: -2px; margin-bottom: 2px; }
        .fsp-balance { font-style: italic; font-weight: 700; }
        .fsp-subhead { font-size: 8pt; color: #555; border-top: 0.5px dashed #999; margin-top: 6px; padding-top: 4px; }
        .fsp-final { border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; margin-top: 8px; padding: 6px 0; font-weight: 700; font-size: 11pt; }
        @media print { @page { size: A4 portrait; margin: 8mm; } }
      `}</style>

            <div className="fsp-company">{data.firmName}</div>
            <div className="fsp-title">Challan Wise Delivery Summary</div>
            <div className="fsp-date">{formatDate(todayISO())}</div>

            <table className="fsp-table">
                <thead>
                    <tr>
                        <th>DATE</th>
                        <th>CH. NO</th>
                        <th>TRUCK NO</th>
                        <th>LOAD.DATE</th>
                        <th>LOADING STATION</th>
                        <th className="num">TOPAY</th>
                        <th className="num">PAID</th>
                        <th className="num">Delv.Chgs (Local)</th>
                        <th className="num">CROS</th>
                        <th className="num">DOOR</th>
                        <th className="num">T.HIRE</th>
                        <th className="num">PF</th>
                        <th className="num">REFUND</th>
                    </tr>
                </thead>
                <tbody>
                    {data.rows.map((r, i) => (
                        <tr key={i}>
                            <td>{formatDate(r.date)}</td>
                            <td>{r.challanNumber}</td>
                            <td>{r.truckNumber}</td>
                            <td>{formatDate(r.loadingDate)}</td>
                            <td>{r.loadingStation}</td>
                            <td className="num">{r.toPay ? num(r.toPay) : '0'}</td>
                            <td className="num">{r.paid ? num(r.paid) : '0'}</td>
                            <td className="num">{r.deliveryCharges ? num(r.deliveryCharges) : '0'}</td>
                            <td className="num">{r.crossing ? num(r.crossing) : '0'}</td>
                            <td className="num">{r.doorDelivery ? num(r.doorDelivery) : '0'}</td>
                            <td className="num">{r.truckHire ? num(r.truckHire) : '0'}</td>
                            <td className="num">{r.pf ? num(r.pf) : '0'}</td>
                            <td className="num">{r.refund ? num(r.refund) : '0'}</td>
                        </tr>
                    ))}
                    <tr className="totals">
                        <td colSpan={5} style={{ textAlign: 'right' }}>TOTAL</td>
                        <td className="num">{num(t.toPay)}</td>
                        <td className="num">{num(t.paid)}</td>
                        <td className="num">{num(t.deliveryCharges)}</td>
                        <td className="num">{num(t.crossing)}</td>
                        <td className="num">{num(t.doorDelivery)}</td>
                        <td className="num">{num(t.truckHire)}</td>
                        <td className="num">{num(t.pf)}</td>
                        <td className="num">{num(t.refund)}</td>
                    </tr>
                </tbody>
            </table>

            <div className="fsp-report-title">Report In Rupees</div>

            <div className="fsp-summary">
                <div className="fsp-subhead" style={{ marginTop: 0 }}>SETTLEMENT</div>
                <div className="fsp-line"><span className="label">ToPay</span><span className="dots" /><span className="amt">{num(toPay)}</span></div>
                <div className="fsp-line"><span className="label">{prefix(dcAmountSign)} Delivery Chrgs ({data.dcPercent}%)</span><span className="dots" /><span className="amt">{numP(dcAmount)}</span></div>
                <div className="fsp-dc-base">(ToPay ₹{num(toPay)} + Paid ₹{num(t.paid)}) × {data.dcPercent}%</div>
                <div className="fsp-line"><span className="label">{prefix(truckHireSign)} Truck Hire</span><span className="dots" /><span className="amt">{num(truckHire)}</span></div>
                <div className="fsp-line fsp-balance" style={{ borderBottom: '1px solid #000', paddingBottom: 4, marginBottom: 6 }}><span className="label">Balance</span><span className="dots" /><span className="amt">{numP(balance)}</span></div>

                <div className="fsp-subhead">FURTHER CHARGES</div>
                <div className="fsp-line"><span className="label">{prefix(doorDeliverySign)} Door Delivery</span><span className="dots" /><span className="amt">{num(doorDelivery)}</span></div>
                <div className="fsp-line"><span className="label">{prefix(crossingSign)} Crossing</span><span className="dots" /><span className="amt">{num(crossing)}</span></div>
                <div className="fsp-line"><span className="label">{prefix(pfSign)} PF</span><span className="dots" /><span className="amt">{num(pf)}</span></div>
                <div className="fsp-line"><span className="label">{prefix(refundSign)} Refund</span><span className="dots" /><span className="amt">{num(refund)}</span></div>
                {savedAdjustmentLines.length > 0 && (
                    <>
                        <div className="fsp-subhead">Saved charges (from challan reports)</div>
                        {savedAdjustmentLines.map((a, i) => (
                            <div key={i} className="fsp-line"><span className="label">#{a.challanNumber} · {a.label || 'Adjustment'}</span><span className="dots" /><span className="amt">{a.sign > 0 ? '+' : '-'}{num(a.amount)}</span></div>
                        ))}
                    </>
                )}
                {adjustmentLines.length > 0 && (
                    <>
                        <div className="fsp-subhead">One-time charges (this printout only)</div>
                        {adjustmentLines.map((a, i) => (
                            <div key={i} className="fsp-line"><span className="label">{a.sign > 0 ? '+' : '-'} {a.label || 'Adjustment'}</span><span className="dots" /><span className="amt">{num(a.amount)}</span></div>
                        ))}
                    </>
                )}
                <div className="fsp-line fsp-final"><span className="label">AMOUNT (ROUND FIGURE)</span><span className="dots" /><span className="amt">{num(roundFigure)}</span></div>
            </div>
        </div>
    );
});

export default FirmSummaryPrint;
