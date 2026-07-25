import { useEffect, useState } from 'react';
import { X, FileText, User, Printer } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/database';
import type { DR } from '../db/database';
import { formatINR, formatDate } from '../utils/reportUtils';

/**
 * LRPreviewModal — a quick read-out of a consignment, opened by searching its LR
 * or BS number. "Model 2" design: BS + LR side-by-side in the header, consignment
 * details as soft info tiles, charges as a grid of small boxes with the Total
 * highlighted. Zero-value charges are hidden so a freight-only DR stays clean.
 * "View full memo" redirects to the source memo (the full record).
 */

// A consignment has TWO independent lifecycles, and conflating them is what made
// the same BS number read "Collected" in the wasuli list but "Pending" here:
//
//   DR.status     → has the delivery receipt been PRINTED?   (pending/printed/delivered/cancelled)
//   Wasuli.status → has the MONEY been COLLECTED?            (pending/collected/cancelled)
//
// A DR can be collected without ever being printed, and printed without being
// collected. So we show both, separately labelled, and never derive one from the
// other.

// Print state → printer icon colour. Green = printed, red = not printed yet.
const PRINT_VIEW: Record<DR['status'], { label: string; fg: string; printed: boolean }> = {
  printed:   { label: 'Printed',     fg: 'var(--success)', printed: true  },
  delivered: { label: 'Printed',     fg: 'var(--success)', printed: true  },
  pending:   { label: 'Not printed', fg: 'var(--danger)',  printed: false },
  cancelled: { label: 'Cancelled',   fg: 'var(--danger)',  printed: false },
};

// Wasuli state → pill. 'unassigned' is the extra case: a DR nobody is collecting.
type WasuliView = 'unassigned' | 'assigned' | 'collected' | 'cancelled';
const WASULI_STYLE: Record<WasuliView, { label: string; bg: string; fg: string }> = {
  collected:  { label: 'Collected',  bg: 'var(--success-bg)', fg: 'var(--success)' },
  assigned:   { label: 'Assigned',   bg: 'var(--warning-bg)', fg: 'var(--warning)' },
  unassigned: { label: 'Unassigned', bg: 'var(--border-light)', fg: 'var(--text-muted)' },
  cancelled:  { label: 'Cancelled',  bg: 'var(--danger-bg)',  fg: 'var(--danger)' },
};

export default function LRPreviewModal({ drId, onClose, heading = 'lr' }: { drId: number; onClose: () => void; heading?: 'lr' | 'bs' }) {
  const navigate = useNavigate();
  const [dr, setDr] = useState<DR | null>(null);
  const [agent, setAgent] = useState<string>('');
  const [wasuli, setWasuli] = useState<WasuliView>('unassigned');

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await db.drs.get(drId);
      if (!alive) return;
      setDr(d || null);
      if (d) {
        // The wasuli record carries the COLLECTION status — the DR carries only the
        // print status. We were already loading this row for the agent name; now we
        // read its status too instead of throwing it away.
        const w = (await db.wasuli.filter(x => x.drId === d.id && !x.deletedAt).toArray())[0];
        if (!alive) return;
        // A row existing isn't the same as being assigned — every DR gets a wasuli
        // row up front (pending, operatorId 0) before any agent picks it up. Only
        // operatorId !== 0 means an actual agent is on it (same check wasuliReport.ts
        // and collectionLabel.ts already use — this was the one place that skipped it).
        setWasuli(!w ? 'unassigned' : w.status === 'collected' ? 'collected' : w.status === 'cancelled' ? 'cancelled' : w.operatorId !== 0 ? 'assigned' : 'unassigned');
        if (w && w.operatorId) {
          const op = await db.operators.get(w.operatorId);
          if (alive && op) setAgent(op.name);
        }
      }
    })();
    return () => { alive = false; };
  }, [drId]);

  if (!dr) return null;

  const print = PRINT_VIEW[dr.status];
  const wasuliStyle = WASULI_STYLE[wasuli];

  // Header number blocks — the searched number leads, the other follows.
  const numbers: { label: string; value: string }[] = heading === 'bs'
    ? [{ label: 'BS number', value: dr.drNumber || '—' }, { label: 'LR number', value: dr.lrNumber || '—' }]
    : [{ label: 'LR number', value: dr.lrNumber || '—' }, { label: 'BS number', value: dr.drNumber || '—' }];

  // Soft info tile (label over value on a light background)
  const infoTile = (label: string, value: React.ReactNode) => (
    <div style={{ background: 'var(--border-light)', borderRadius: 8, padding: '8px 10px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );

  // Bordered charge box (label over amount) — only rendered when the amount is nonzero
  const chargeBox = (label: string, amount: number) => (
    <div key={label} style={{ border: '0.5px solid var(--border)', borderRadius: 8, padding: '7px 9px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{formatINR(amount)}</div>
    </div>
  );

  const charges: { label: string; amount: number }[] = [
    { label: 'Freight', amount: dr.freight },
    { label: 'PF', amount: dr.pf },
    { label: 'Cartage', amount: dr.cartage },
    { label: 'Hamali', amount: dr.hamali },
    { label: 'G. Bhada', amount: dr.godownBhada },
    { label: 'GDN insu', amount: dr.godownInsurance },
    { label: 'Dly charges (Local)', amount: dr.deliveryCharges },
    { label: 'Other', amount: dr.otherCharges },
  ].filter(c => c.amount !== 0);

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="confirm-modal" style={{ width: 560, maxWidth: '94vw', padding: 0, overflow: 'hidden' }}>
        {/* Header — BS + LR side by side, status pill, close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px', borderBottom: '0.5px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{numbers[0].label}</div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>{numbers[0].value}</div>
          </div>
          <div style={{ borderLeft: '0.5px solid var(--border)', paddingLeft: 14 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{numbers[1].label}</div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>{numbers[1].value}</div>
          </div>
          {/* Two statuses, never conflated: DR print state (printer icon) and wasuli
              collection state (pill). Green printer = printed, red = not printed. */}
          <span
            title={`DR: ${print.label}`}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: print.fg, fontSize: 12, fontWeight: 600 }}
          >
            <Printer size={15} />
            {print.label}
          </span>
          <span
            title={`Wasuli: ${wasuliStyle.label}`}
            style={{ fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 999, background: wasuliStyle.bg, color: wasuliStyle.fg }}
          >
            {wasuliStyle.label}
          </span>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        {/* Consignment details — soft info tiles */}
        <div style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          {infoTile('Consignor', dr.consignor || '—')}
          {infoTile('Consignee', dr.consignee || '—')}
          {infoTile('From → To', `${dr.fromStation || '—'} → Yavatmal`)}
          {infoTile('Truck', dr.truckNumber || '—')}
          {infoTile('Contain · Pkg', `${dr.particulars || '—'} · ${dr.quantity}`)}
          {infoTile('LR date', dr.bookingDate ? formatDate(dr.bookingDate) : '—')}
        </div>

        {/* Charges — bordered boxes + highlighted total */}
        <div style={{ padding: '0 16px 12px' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Charges</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
            {charges.map(c => chargeBox(c.label, c.amount))}
            <div style={{ background: 'var(--orange-light)', borderRadius: 8, padding: '7px 9px', minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 600 }}>Total</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--warning)' }}>{formatINR(dr.total)}</div>
            </div>
          </div>
        </div>

        {/* Footer — agent (if assigned) + view memo */}
        <div style={{ padding: '10px 16px', borderTop: '0.5px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {agent ? <><User size={13} /> Agent: {agent}</> : null}
          </span>
          <button className="btn btn-outline btn-sm" onClick={() => { navigate(`/memo/${dr.challanId}/view`); onClose(); }}>
            <FileText size={14} /> View full memo
          </button>
        </div>
      </div>
    </div>
  );
}
