import { useState } from 'react';
import { Truck, ClipboardList, Printer } from 'lucide-react';
import { db } from '../db/database';

const steps = [
  { icon: <Truck size={40} color="var(--orange)" />, title: 'New entry', body: 'Start a new entry here — press "New Challan" and fill the firm details.' },
  { icon: <ClipboardList size={40} color="var(--orange)" />, title: 'LR Entries', body: 'Fill all the LR entries of the memo here — add them one by one.' },
  { icon: <Printer size={40} color="var(--orange)" />, title: 'Save & Print', body: 'All done? Press SAVE MEMO and print the DRs — easy!' },
];

interface WalkthroughProps {
  onDone: () => void;
}

export default function Walkthrough({ onDone }: WalkthroughProps) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);

  // Always write the flag — whether user finishes all steps or clicks Skip
  const finish = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await db.settings.put({ key: 'walkthroughDone', value: 'true' });
    } catch {
      // Even if DB write fails, dismiss the overlay so the app is usable
    } finally {
      onDone();
    }
  };

  const s = steps[step];
  const isLast = step === steps.length - 1;

  return (
    <div className="pin-overlay">
      <div style={{ background: 'var(--card)', borderRadius: 'var(--r-xl)', padding: 32, width: 360, boxShadow: 'var(--shadow-lg)', animation: 'fadeIn 0.3s ease', textAlign: 'center' }}>
        <div style={{ marginBottom: 20 }}>{s.icon}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--navy)', marginBottom: 10 }}>Step {step + 1}: {s.title}</div>
        <div style={{ fontSize: 14, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 28 }}>{s.body}</div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginBottom: 24 }}>
          {steps.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i === step ? 'var(--orange)' : 'var(--border)' }} />
          ))}
        </div>
        {isLast ? (
          <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={finish} disabled={saving}>
            Get started →
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 10 }}>
            {/* Skip also calls finish() — so walkthroughDone is always written */}
            <button className="btn btn-ghost btn-sm" onClick={finish} disabled={saving}>Skip</button>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setStep(s => s + 1)}>
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
