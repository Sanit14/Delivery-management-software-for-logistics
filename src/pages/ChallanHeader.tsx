import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import { db, logAudit, seatName } from '../db/database';
import type { Challan } from '../db/database';
import { learnValues, checkDuplicate, fmtCode, type DuplicateMatch } from '../utils/masterData';
import { todayISO } from '../utils/reportUtils';
import AutoCompleteInput from '../components/AutoCompleteInput';

function StepProgress({ step }: { step: number }) {
  const steps = [{ label: 'Truck Details' }, { label: 'LR Entries' }, { label: 'Print DRs' }];
  return (
    <div className="step-progress">
      {steps.map((s, i) => {
        const state = i < step ? 'done' : i === step ? 'active' : 'locked';
        return (
          <React.Fragment key={i}>
            <div className="step-item">
              <div className={`step-circle ${state}`}>{state === 'done' ? <Check size={14} /> : i + 1}</div>
              <div className={`step-label ${state}`}>{s.label}</div>
            </div>
            {i < steps.length - 1 && <div className={`step-connector ${i < step ? 'done' : ''}`} />}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export default function ChallanHeader() {
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = !id || id === 'new';

  const [form, setForm] = useState({
    firmName: '', entryDate: todayISO(), loadingDate: todayISO(),
    loadingStation: '', truckNumber: '', challanNumber: '',
    truckHire: '', deliveryCharges: '',
    deliveryChargesType: 'percent' as 'fixed' | 'percent',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [challan, setChallan] = useState<Challan | null>(null);
  // Duplicate-detection popup: holds pending near-matches to confirm before saving
  const [dupCheck, setDupCheck] = useState<{ field: 'firmName' | 'loadingStation' | 'truckNumber'; typed: string; match: DuplicateMatch | null }[] | null>(null);
  const [challanNumWarn, setChallanNumWarn] = useState<string | null>(null);
  const [challanNumWarned, setChallanNumWarned] = useState(false);

  useEffect(() => {
    const init = async () => {
      if (!isNew && id) {
        const c = await db.challans.get(Number(id));
        if (c) {
          setChallan(c);
          setForm({
            firmName: c.firmName, entryDate: c.entryDate, loadingDate: c.loadingDate,
            loadingStation: c.loadingStation, truckNumber: c.truckNumber,
            challanNumber: c.challanNumber, truckHire: String(c.truckHire || ''),
            deliveryCharges: String(c.deliveryCharges || ''),
            deliveryChargesType: c.deliveryChargesType || 'percent',
          });
        }
      }
      // Challan number is NOT auto-generated — it comes from the firm's own challan paper.
      // The worker types it in. (Only the BS/DR number is a software-controlled serial.)
    };
    init();
  }, [id, isNew]);

  const set = (k: string, v: string) => {
    setForm(f => ({ ...f, [k]: v }));
    if (errors[k]) setErrors(e => { const n = { ...e }; delete n[k]; return n; });
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.firmName.trim()) e.firmName = 'This field is required';
    if (!form.entryDate) e.entryDate = 'This field is required';
    if (!form.loadingDate) e.loadingDate = 'This field is required';
    if (!form.loadingStation.trim()) e.loadingStation = 'This field is required';
    if (!form.truckNumber.trim()) e.truckNumber = 'This field is required';
    if (!form.challanNumber.trim()) e.challanNumber = 'This field is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleNewEntry = async () => {
    if (!validate()) return;
    // Challan number comes from the firm's paper — different firms may reuse numbers, so
    // we DON'T hard-block. We only ALERT if the SAME firm already used this challan number
    // (likely a double-entry mistake). The worker can still proceed if it's genuine.
    const num = form.challanNumber.trim();
    const sameFirmSameNum = (await db.challans.filter(c =>
      c.challanNumber === num &&
      c.firmName.trim().toLowerCase() === form.firmName.trim().toLowerCase() &&
      !c.deletedAt
    ).toArray()).some(c => isNew || c.id !== Number(id));
    if (sameFirmSameNum && !challanNumWarned) {
      setChallanNumWarn(num);   // show soft alert; proceeding requires confirm
      return;
    }
    // Spelling-check for coded fields (firm + station) — near-duplicates need a
    // choice (use existing or keep as new); a genuinely new name (no match at
    // all) still gets a quick confirm, so nothing new is ever added by accident.
    const checks: { field: 'firmName' | 'loadingStation' | 'truckNumber'; typed: string; match: DuplicateMatch | null }[] = [];
    const firmDup = await checkDuplicate('firmName', form.firmName);
    if (!firmDup || !firmDup.exact) checks.push({ field: 'firmName', typed: form.firmName, match: firmDup });
    const stationDup = await checkDuplicate('loadingStation', form.loadingStation);
    if (!stationDup || !stationDup.exact) checks.push({ field: 'loadingStation', typed: form.loadingStation, match: stationDup });
    // Truck plates: never suggest a near-match substitution — "MH-31-AB-1234" vs
    // "...1235" is one character apart but almost always a genuinely different
    // truck, not a typo. Only ever confirm "this is a new plate", never "did you
    // mean this other truck".
    const truckDup = await checkDuplicate('truckNumber', form.truckNumber);
    if (!truckDup || !truckDup.exact) checks.push({ field: 'truckNumber', typed: form.truckNumber, match: null });

    if (checks.length > 0) {
      setDupCheck(checks);   // show popup; saving waits for user decision
      return;
    }
    await saveAndProceed();
  };

  // Apply the user's choice from the duplicate popup: use existing name, or keep typed (new)
  const resolveDuplicate = (field: 'firmName' | 'loadingStation' | 'truckNumber', useExistingValue: string | null) => {
    if (useExistingValue !== null) {
      setForm(f => ({ ...f, [field]: useExistingValue }));
    }
  };

  const confirmDuplicates = async () => {
    setDupCheck(null);
    await saveAndProceed();
  };

  const saveAndProceed = async () => {
    const now = new Date().toISOString();
    let cId: number;

    if (isNew) {
      cId = await db.challans.add({
        challanNumber: form.challanNumber,
        firmName: form.firmName,
        entryDate: form.entryDate,
        loadingDate: form.loadingDate,
        loadingStation: form.loadingStation,
        truckNumber: form.truckNumber,
        truckHire: Number(form.truckHire) || 0,
        deliveryCharges: Number(form.deliveryCharges) || 0,
        deliveryChargesType: form.deliveryChargesType,
        status: 'open',
        totalToPay: 0, totalPaid: 0, totalEntries: 0,
        createdAt: now, updatedAt: now,
        createdSeat: await seatName(),
      }) as number;
      await logAudit({ action: 'create', party: form.firmName, detail: `Challan #${form.challanNumber}` });
    } else {
      cId = Number(id);
      await db.challans.update(cId, {
        firmName: form.firmName, entryDate: form.entryDate, loadingDate: form.loadingDate,
        loadingStation: form.loadingStation, truckNumber: form.truckNumber,
        challanNumber: form.challanNumber, truckHire: Number(form.truckHire) || 0,
        deliveryCharges: Number(form.deliveryCharges) || 0,
        deliveryChargesType: form.deliveryChargesType,
        updatedAt: now,
      });
      const newNum = form.challanNumber.trim();
      await db.lrEntries.where('challanId').equals(cId).modify(e => { e.challanNumber = newNum; });
      await db.drs.where('challanId').equals(cId).modify(d => { d.challanNumber = newNum; });
      await db.firmLedger.where('challanId').equals(cId).modify(l => { l.challanNumber = newNum; });
    }

    await learnValues([
      { field: 'firmName', value: form.firmName },
      { field: 'loadingStation', value: form.loadingStation },
      { field: 'truckNumber', value: form.truckNumber },
    ]);

    navigate(`/challan/${cId}/detail`);
  };

  const isSaved = challan?.status === 'saved';

  const F = ({ label, name, req, children }: { label: string; name: string; req?: boolean; children: React.ReactNode }) => (
    <div className="form-group">
      <label className={`form-label ${req ? 'req' : ''}`}>{label}</label>
      {children}
      {errors[name] && <div className="form-field-error">{errors[name]}</div>}
    </div>
  );

  return (
    <div>
      <StepProgress step={0} />

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 24, borderBottom: '2px solid var(--border)' }}>
        <div style={{ padding: '8px 20px', fontWeight: 600, fontSize: 13, color: 'var(--orange)', borderBottom: '2px solid var(--orange)', marginBottom: -2, cursor: 'pointer' }}>Header</div>
        <div style={{ padding: '8px 20px', fontWeight: 500, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}
          onClick={() => { if (!isNew && id) navigate(`/challan/${id}/detail`); }}>Detail</div>
      </div>

      <div className="card teal-form" style={{ padding: 28, maxWidth: 880 }}>
        {F({
          label: 'Firm Name', name: 'firmName', req: true, children:
            <AutoCompleteInput field="firmName" value={form.firmName} onChange={v => set('firmName', v)} placeholder="Sending transport firm name" hasError={!!errors.firmName} />
        })}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {F({
            label: 'Entry Date', name: 'entryDate', req: true, children:
              <input type="date" className={`form-input ${errors.entryDate ? 'field-error' : ''}`} value={form.entryDate} onChange={e => set('entryDate', e.target.value)} />
          })}
          {F({
            label: 'Loading Date', name: 'loadingDate', req: true, children:
              <input type="date" className={`form-input ${errors.loadingDate ? 'field-error' : ''}`} value={form.loadingDate} onChange={e => set('loadingDate', e.target.value)} />
          })}
          {F({
            label: 'Loading Station', name: 'loadingStation', req: true, children:
              <AutoCompleteInput field="loadingStation" value={form.loadingStation} onChange={v => set('loadingStation', v)} placeholder="City/Station" hasError={!!errors.loadingStation} />
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {F({
            label: 'Truck No.', name: 'truckNumber', req: true, children:
              <AutoCompleteInput field="truckNumber" value={form.truckNumber} onChange={v => set('truckNumber', v)} hint="MH-31-AB-1234" hasError={!!errors.truckNumber} />
          })}
          {F({
            label: 'Challan No.', name: 'challanNumber', req: true, children:
              <input className={`form-input ${errors.challanNumber ? 'field-error' : ''}`} value={form.challanNumber} onChange={e => set('challanNumber', e.target.value)} />
          })}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {F({
            label: 'Truck Hire (₹)', name: 'truckHire', children:
              <input type="number" className="form-input" value={form.truckHire} onChange={e => set('truckHire', e.target.value)} min={0} inputMode="numeric" />
          })}

          {/* Delivery Charges — always % of freight (our commission) */}
          <div className="form-group">
            <label className="form-label">
              Delivery Charges&nbsp;
              <span style={{ fontWeight: 400, opacity: 0.85, fontSize: 11 }}>(% of freight)</span>
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type="number" className="form-input"
                value={form.deliveryCharges}
                onChange={e => set('deliveryCharges', e.target.value)}
                min={0} inputMode="numeric"
                placeholder="e.g. 6 for 6%"
                style={{ paddingRight: 28 }}
              />
              <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--text-muted)', fontWeight: 600 }}>%</span>
            </div>
            <div className="form-hint" style={{ marginTop: 4 }}>
              {form.deliveryCharges || 0}% of total freight (ToPay + Paid) — this is your commission
            </div>
          </div>
        </div>

        {!isSaved && (
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button className="btn btn-primary" onClick={handleNewEntry}>New Entry →</button>
            <button className="btn btn-ghost" onClick={() => navigate('/challan')}>Back</button>
          </div>
        )}
        {isSaved && (
          <div style={{ background: 'var(--success-bg)', borderRadius: 'var(--r-md)', padding: '10px 14px', marginTop: 8, color: 'var(--success)', fontSize: 13, fontWeight: 500 }}>
            ✓ Memo saved — header is locked
          </div>
        )}
      </div>

      {/* Duplicate / new-name check popup */}
      {dupCheck && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setDupCheck(null); }}>
          <div className="confirm-modal" style={{ width: 440 }}>
            <div className="confirm-title">{dupCheck.some(d => d.match) ? 'Similar name found' : 'New name'}</div>
            <div className="confirm-body">
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
                One quick check before saving, so nothing gets added twice under two different spellings.
              </div>
              {dupCheck.map((d, i) => (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                    {d.field === 'firmName' ? 'Firm' : d.field === 'loadingStation' ? 'Station' : 'Truck'} — you typed: <b style={{ color: 'var(--text-primary)' }}>{d.typed}</b>
                  </div>
                  {d.match ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => resolveDuplicate(d.field, d.match!.value)}
                        style={{ flex: 1, justifyContent: 'center' }}
                      >
                        Use this: {d.match.value} · {fmtCode(d.match.code)}
                      </button>
                      <button
                        className="btn btn-outline btn-sm"
                        onClick={() => resolveDuplicate(d.field, null)}
                        style={{ flex: 1, justifyContent: 'center' }}
                      >
                        Create new: {d.typed}
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      Nothing similar on file — this will be saved as a brand new {d.field === 'firmName' ? 'firm' : d.field === 'loadingStation' ? 'station' : 'truck'}.
                    </div>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Choose above and then press confirm below.
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setDupCheck(null)}>Go back</button>
              <button className="btn btn-primary btn-sm" onClick={confirmDuplicates}>Confirm & continue</button>
            </div>
          </div>
        </div>
      )}

      {challanNumWarn && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setChallanNumWarn(null); }}>
          <div className="confirm-modal" style={{ width: 420 }}>
            <div className="confirm-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>⚠️ Challan number already exists</div>
            <div className="confirm-body">
              <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                This firm's (<b>({form.firmName})</b>) challan number <b>{challanNumWarn}</b> has already been used.
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
                If this is correct, proceed. If entered by mistake, correct the number.
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setChallanNumWarn(null)}>Fix number</button>
              <button className="btn btn-primary btn-sm" onClick={() => { setChallanNumWarn(null); setChallanNumWarned(true); handleNewEntry(); }}>Continue anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
