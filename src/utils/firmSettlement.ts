import type { FirmSummaryData, FirmSummaryOverrides } from '../components/FirmSummaryPrint';

type BaseKey = 'truckHire' | 'doorDelivery' | 'crossing' | 'dcAmount' | 'pf' | 'refund';

export const signPrefix = (s: 1 | -1) => (s > 0 ? '+' : '-');

// Single source of truth for the settlement waterfall — used by the on-screen
// Firm Report (Reports.tsx), its PDF/CSV exports, and FirmSummaryPrint, so the
// four can never quietly drift apart from each other the way PF once did.
export function computeFirmSettlement(data: FirmSummaryData) {
    const raw = data.rows.reduce(
        (a, r) => ({
            toPay: a.toPay + r.toPay,
            paid: a.paid + r.paid,
            deliveryCharges: a.deliveryCharges + r.deliveryCharges,
            crossing: a.crossing + r.crossing,
            doorDelivery: a.doorDelivery + r.doorDelivery,
            truckHire: a.truckHire + r.truckHire,
            pf: a.pf + r.pf,
            refund: a.refund + r.refund,
        }),
        { toPay: 0, paid: 0, deliveryCharges: 0, crossing: 0, doorDelivery: 0, truckHire: 0, pf: 0, refund: 0 }
    );

    // Step-by-step settlement. Each base value falls back to the real computed
    // total unless a print-only override was set.
    const ov = data.overrides || {};
    const totalAmount = ov.totalAmount ?? (raw.toPay + raw.paid); // DC base
    const toPay = ov.toPay ?? raw.toPay;
    const truckHire = ov.truckHire ?? raw.truckHire;
    const doorDelivery = ov.doorDelivery ?? raw.doorDelivery;
    const crossing = ov.crossing ?? raw.crossing;
    const dcAmount = ov.dcAmount ?? data.rows.reduce((s, r) => s + r.dcAmount, 0); // each challan's own rate, summed
    const pf = ov.pf ?? raw.pf;
    const refund = ov.refund ?? raw.refund;

    // Sign per base row — flippable in edit mode (see Reports.tsx), defaulting
    // to the direction the row has always applied. No hardcoded +/- here.
    const sgn = (key: BaseKey, dflt: 1 | -1): 1 | -1 =>
        (ov[`${key}Sign` as keyof FirmSummaryOverrides] as 1 | -1 | undefined) ?? dflt;
    const truckHireSign = sgn('truckHire', -1);
    const doorDeliverySign = sgn('doorDelivery', -1);
    const crossingSign = sgn('crossing', -1);
    const dcAmountSign = sgn('dcAmount', -1);
    const pfSign = sgn('pf', 1);
    const refundSign = sgn('refund', -1);

    // Phase 1: Core settlement balance = ToPay - DC - TruckHire
    const balance = toPay + dcAmountSign * dcAmount + truckHireSign * truckHire;

    // Phase 2: Further charges applied to balance
    const savedAdjustmentLines = (data.savedAdjustmentLines || []).filter(a => a.amount);
    const savedAdjustmentTotal = savedAdjustmentLines.reduce((s, a) => s + a.sign * a.amount, 0);
    const adjustmentLines = (data.adjustmentLines || []).filter(a => a.amount);
    const adjustmentTotal = adjustmentLines.reduce((s, a) => s + a.sign * a.amount, 0);

    const finalAmount = balance
        + doorDeliverySign * doorDelivery
        + crossingSign * crossing
        + pfSign * pf
        + refundSign * refund
        + savedAdjustmentTotal
        + adjustmentTotal;

    const roundFigure = Math.round(finalAmount);

    return {
        raw, totalAmount, toPay, truckHire, doorDelivery, crossing, dcAmount, pf, refund,
        truckHireSign, doorDeliverySign, crossingSign, dcAmountSign, pfSign, refundSign,
        balance, savedAdjustmentLines, savedAdjustmentTotal,
        adjustmentLines, adjustmentTotal, finalAmount, roundFigure,
    };
}
