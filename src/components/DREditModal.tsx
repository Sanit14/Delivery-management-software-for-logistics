import { useEffect, useState } from 'react';
import { updateDRCharges, getDRWasuliLock } from '../db/database';
import type { DR } from '../db/database';
import { formatINR } from '../utils/reportUtils';

// otherCharges removed — godownInsurance is the correct field on DR
// PF is collected from the consignee same as freight — NOT a charges-rule
// field (unlike cartage/hamali/g.bhada/etc.), just listed alongside them here.
const CHARGE_FIELDS = [
  ['freight',          'Freight (₹)'],
  ['cartage',          'Cartage'],
  ['hamali',           'Hamali'],
  ['godownBhada',      'G.Bhada'],
  ['godownInsurance',  'GDN Insurance'],
  ['deliveryCharges',  'Dly.Chrgs (Local)'],
  ['pf',               'PF'],
] as const;

type ChargeKey = typeof CHARGE_FIELDS[number][0];

interface Props {
  dr: DR;
  onSaved: (result: 'ok' | 'locked' | 'stale') => void;
  onClose: () => void;
}

export default function DREditModal({ dr, onSaved, onClose }: Props) {
  const [charges, setCharges] = useState<Record<ChargeKey, string>>({
    freight:         String(dr.freight || ''),
    cartage:         String(dr.cartage || ''),
    hamali:          String(dr.hamali || ''),
    godownBhada:     String(dr.godownBhada || ''),
    godownInsurance: String(dr.godownInsurance || ''),
    deliveryCharges: String(dr.deliveryCharges || ''),
    pf:              String(dr.pf || ''),
  });

  // Same lock rule updateDRCharges enforces server-side — read here too so the
  // modal can disable fields ahead of time instead of letting the operator type
  // into a DR whose save will just be refused.
  const [locked, setLocked] = useState(false);
  const [lockedCollected, setLockedCollected] = useState(false);
  useEffect(() => {
    let alive = true;
    getDRWasuliLock(dr.id!).then(({ locked, wasuli }) => {
      if (!alive) return;
      setLocked(locked);
      setLockedCollected(wasuli?.status === 'collected');
    });
    return () => { alive = false; };
  }, [dr.id]);

  const oldSum = CHARGE_FIELDS.reduce((s, [k]) => s + ((dr as unknown as Record<ChargeKey, number>)[k] || 0), 0);
  const newSum = CHARGE_FIELDS.reduce((s, [k]) => s + (Number(charges[k]) || 0), 0);
  const newTotal = dr.total - oldSum + newSum;

  const save = async () => {
    const c = {
      freight: Number(charges.freight) || 0,
      cartage: Number(charges.cartage) || 0,
      hamali: Number(charges.hamali) || 0,
      godownBhada: Number(charges.godownBhada) || 0,
      godownInsurance: Number(charges.godownInsurance) || 0,
      deliveryCharges: Number(charges.deliveryCharges) || 0,
      pf: Number(charges.pf) || 0,
    };
    // Pass the total we saw when this modal opened (dr.total). If another seat
    // changed this DR in the meantime, updateDRCharges returns staleConflict and
    // we ask the user to reload instead of silently overwriting.
    const res = await updateDRCharges(dr.id!, c, dr.total);
    onSaved(res.staleConflict ? 'stale' : (res.lockedByAgent ? 'locked' : 'ok'));
  };

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="confirm-modal" style={{ width: 440 }}>
        <div className="confirm-title">Edit BS {dr.drNumber} — {dr.consignee}</div>
        <div className="confirm-body">
          {locked && (
            <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--danger-bg, #fdecea)', color: 'var(--danger, #C0392B)', borderRadius: 'var(--r-md)', fontSize: 13, fontWeight: 600 }}>
              {lockedCollected
                ? "This DR's amount has already been collected. Charges can't be changed."
                : 'This DR is assigned to an agent for collection. Charges can\'t be changed.'}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {CHARGE_FIELDS.map(([k, label]) => (
              <div className="form-group" key={k} style={{ marginBottom: 4 }}>
                <label className="form-label">{label}</label>
                <input
                  className="form-input" type="number" inputMode="numeric"
                  style={{ padding: '8px 12px' }}
                  value={charges[k]}
                  disabled={locked}
                  onChange={e => setCharges(c => ({ ...c, [k]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--orange-light)', borderRadius: 'var(--r-md)', fontSize: 14, fontWeight: 700, color: 'var(--orange)' }}>
            New total: {formatINR(newTotal)}
          </div>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Back</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={locked}>Save ✓</button>
        </div>
      </div>
    </div>
  );
}
