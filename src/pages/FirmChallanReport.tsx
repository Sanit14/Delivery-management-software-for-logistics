import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import { Pencil, Plus, X } from 'lucide-react';
import { db, buildChallanSummaryRow, getChallanAdjustments, saveChallanAdjustments, type ChallanAdjustment } from '../db/database';
import { useToast } from '../context/ToastContext';
import type { FirmLedger } from '../db/database';
import PageHeader from '../components/PageHeader';
import FirmSummaryPrint, { type FirmSummaryData } from '../components/FirmSummaryPrint';
import { computeFirmSettlement } from '../utils/firmSettlement';
import LedgerTable from '../components/LedgerTable';
import { COMPANY_NAME } from '../constants/company';

/**
 * The single-challan version of the Firm Report. Same report/calculation, scoped
 * to one challan. Freeform charge lines (crossing, loading, etc.) are editable
 * here and stored against this challan; the screen, the print, Firm Accounts,
 * the ledger, and History all read the same challan-keyed rows, so they never
 * disagree. PF is entry-level only (Σ lrEntries.pf) — always read-only here.
 */
export default function FirmChallanReport() {
  const { firmName: rawName, challanNumber: rawChallan } = useParams();
  const firmName = decodeURIComponent(rawName || '');
  const challanNumber = decodeURIComponent(rawChallan || '');
  const [summary, setSummary] = useState<FirmSummaryData | null>(null);
  const [ledgerRows, setLedgerRows] = useState<FirmLedger[]>([]);
  const [adjustments, setAdjustments] = useState<ChallanAdjustment[]>([]);
  const [notFound, setNotFound] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({ contentRef: printRef, documentTitle: `Challan ${challanNumber} Report` });

  const load = useCallback(async () => {
    const challan = await db.challans.filter(c => !c.deletedAt && c.firmName === firmName && c.challanNumber === challanNumber).first();
    if (!challan) { setNotFound(true); return; }
    const row = await buildChallanSummaryRow(challan);
    setSummary({
      firmName, companyName: COMPANY_NAME,
      dateFrom: challan.entryDate, dateTo: challan.entryDate,
      rows: [row], dcPercent: challan.deliveryCharges || 0,
    });
    setLedgerRows(await db.firmLedger.where('challanId').equals(challan.id!).toArray());
    setAdjustments(await getChallanAdjustments(challan.id!));
  }, [firmName, challanNumber]);

  useEffect(() => { load(); }, [load]);

  if (notFound) {
    return (
      <div>
        <PageHeader showBack backFallback={`/firm-accounts/${encodeURIComponent(firmName)}`} title="Challan not found" subtitle={firmName} />
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          No challan numbered #{challanNumber} found for {firmName}.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader showBack backFallback={`/firm-accounts/${encodeURIComponent(firmName)}`}
        title={`Challan #${challanNumber} — Report`} subtitle={firmName} />

      {summary && (
        <>
          <FirmChallanSummaryView data={summary} onPrint={handlePrint} savedAdjustments={adjustments} onSaved={load} />

          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)', margin: '20px 0 10px' }}>Full ledger for this challan</div>
          {ledgerRows.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>No ledger entries recorded for this challan.</div>
          ) : (
            <LedgerTable entries={ledgerRows} />
          )}

          <div style={{ display: 'none' }}>
            <FirmSummaryPrint ref={printRef} data={{ ...summary, adjustmentLines: adjustments }} />
          </div>
        </>
      )}
    </div>
  );
}

// Receipt-style settlement view with editable adjustment lines. Existing saved
// adjustments load into the editor so they can be changed or removed; Save is
// replace-all (see saveChallanAdjustments).
function FirmChallanSummaryView({ data, onPrint, savedAdjustments, onSaved }: {
  data: FirmSummaryData; onPrint: () => void; savedAdjustments: ChallanAdjustment[]; onSaved: () => void;
}) {
  const r = data.rows[0];
  const num = (n: number) => (Math.round(n) || 0).toLocaleString('en-IN');

  // Charge lines added below are firm-settlement-only adjustments — they never
  // touch toPay/paid/deliveryCharges/truckHire, so the DR, memo, and wasuli
  // collection amount are never affected by anything on this screen.
  const { showToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<ChallanAdjustment[]>([]);

  // Same waterfall as the Firm Report and Print/PDF (computeFirmSettlement) —
  // this screen used to hand-roll its own net (ToPay+Paid combined, and
  // Crossing/Door Delivery mislabeled "plus" while actually subtracted), which
  // could silently disagree with the Print/PDF button two lines below for the
  // exact same challan. Now both read from the one function.
  const settlement = computeFirmSettlement({ ...data, adjustmentLines: editing ? rows : savedAdjustments });
  const {
    toPay, truckHire, doorDelivery, crossing, dcAmount, pf, refund,
    truckHireSign, doorDeliverySign, crossingSign, dcAmountSign, pfSign, refundSign,
    roundFigure,
  } = settlement;
  const net = roundFigure;

  // When entering edit mode, seed the editor with the saved adjustments (so they
  // are editable), or a blank starter row if none exist yet.
  const startEdit = () => {
    setRows(savedAdjustments.length
      ? savedAdjustments.map(a => ({ ...a }))
      : [{ label: '', amount: 0, sign: -1 }]);
    setEditing(true);
  };

  const line = (label: string, amt: number, bold = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', fontWeight: bold ? 700 : 400 }}>
      <span style={{ color: bold ? 'var(--navy)' : 'var(--text-secondary)' }}>{label}</span>
      <span style={{ flex: 1, borderBottom: '1px dotted var(--border)', margin: '0 8px', transform: 'translateY(-3px)' }} />
      <span style={{ minWidth: 90, textAlign: 'right', color: bold ? 'var(--navy)' : 'var(--text-primary)' }}>
        {amt < 0 ? '−' : ''}₹{num(Math.abs(amt))}
      </span>
    </div>
  );

  const setRow = (i: number, patch: Partial<ChallanAdjustment>) =>
    setRows(rs => rs.map((row, idx) => idx === i ? { ...row, ...patch } : row));

  const save = async () => {
    setSaving(true);
    try {
      const clean = rows.filter(a => a.amount > 0);
      await saveChallanAdjustments(r.challanNumber, data.firmName, clean);
      showToast('Charges saved — firm balance updated', 'success');
      setEditing(false);
      onSaved();
    } catch { showToast('Could not save charges', 'error'); }
    setSaving(false);
  };

  return (
    <div className="card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>{data.firmName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Challan #{r.challanNumber} · Truck {r.truckNumber || '—'} · {r.loadingStation || 'no station'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && <button className="btn btn-outline btn-sm" onClick={startEdit}><Pencil size={14} /> Edit charges</button>}
          <button className="btn btn-outline btn-sm" onClick={onPrint}>Print</button>
        </div>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        {line('Freight (ToPay)', toPay)}
        {line(`less Delivery Charges (${data.dcPercent}%)`, dcAmountSign * dcAmount)}
        {line('less Truck Hire', truckHireSign * truckHire)}
        {line('plus PF', pfSign * pf)}
        {crossing > 0 && line('less Crossing', crossingSign * crossing)}
        {doorDelivery > 0 && line('less Door Delivery', doorDeliverySign * doorDelivery)}
        {refund > 0 && line('less Refund', refundSign * refund)}

        {/* When NOT editing, show the saved adjustments as read lines. */}
        {!editing && savedAdjustments.map((a, i) => (
          <div key={i}>{line(`${a.sign > 0 ? 'plus' : 'less'} ${a.label || 'Adjustment'}`, a.sign * a.amount)}</div>
        ))}

        {/* When editing, show them as editable rows (change amount/label/sign or remove). */}
        {editing && (
          <div style={{ borderTop: '1px dashed var(--border)', marginTop: 8, paddingTop: 10 }}>
            {rows.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <select className="form-select" style={{ width: 72 }} value={a.sign} onChange={e => setRow(i, { sign: Number(e.target.value) as 1 | -1 })}>
                  <option value={1}>+ add</option>
                  <option value={-1}>− less</option>
                </select>
                <input className="form-input" style={{ flex: 1 }} placeholder="label (e.g. crossing)" value={a.label} onChange={e => setRow(i, { label: e.target.value })} />
                <input className="form-input" style={{ width: 90 }} type="number" placeholder="₹" value={a.amount || ''} onChange={e => setRow(i, { amount: Number(e.target.value) || 0 })} />
                <button className="btn btn-ghost btn-sm" onClick={() => setRows(rs => rs.filter((_, idx) => idx !== i))}><X size={14} /></button>
              </div>
            ))}
            <button className="btn btn-outline btn-sm" onClick={() => setRows(rs => [...rs, { label: '', amount: 0, sign: -1 }])}><Plus size={13} /> Add charge line</button>
          </div>
        )}

        <div style={{ borderTop: '2px solid var(--navy)', marginTop: 6, paddingTop: 8 }}>
          {line(net >= 0 ? 'Net — added to firm balance' : 'Net — deducted from firm balance', net, true)}
        </div>

        {editing && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}
