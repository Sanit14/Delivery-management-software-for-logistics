import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Lock, LockOpen, ShieldCheck, AlertTriangle } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PinModal from '../components/PinModal';
import { useToast } from '../context/ToastContext';
import {
  TOGGLEABLE_PAGES, getProtectedPages, setPageProtected,
  checkMasterPin, setSystemPin, setMasterPin, isMasterDefault,
} from '../db/security';

type PinTarget = 'system' | 'master';

// One flow for both PINs — verify → new → confirm, reusing the same PinModal
// three times. Differs only in what step 1 asks for. The "new" step's checkPin
// has nothing to validate (any 4 digits are accepted); it just needs the typed
// value, which PinModal's onSuccess now hands back directly — no more abusing
// checkPin as a side-effecting value-capture callback.
function ChangePinFlow({ target, onDone, onCancel }: { target: PinTarget; onDone: () => void; onCancel: () => void }) {
  const { showToast } = useToast();
  const [step, setStep] = useState<'verify' | 'new' | 'confirm'>('verify');
  const [newPin, setNewPin] = useState('');

  // key={step} forces a fresh PinModal instance per step — without it, React
  // sees the same component type at the same position across the step
  // transition and reuses the instance, so the entered digits from the
  // previous step (e.g. the verify PIN) leak into the next step's pin state.
  if (step === 'verify') {
    return (
      <PinModal
        key="verify"
        title={target === 'system' ? 'Enter Master PIN' : 'Enter current Master PIN'}
        checkPin={checkMasterPin}
        onSuccess={() => setStep('new')}
        onCancel={onCancel}
      />
    );
  }
  if (step === 'new') {
    return (
      <PinModal
        key="new"
        title={target === 'system' ? 'Set a new System PIN' : 'Set a new Master PIN'}
        checkPin={async () => true}
        onSuccess={(pin) => { setNewPin(pin); setStep('confirm'); }}
        onCancel={onCancel}
      />
    );
  }
  return (
    <PinModal
      key="confirm"
      title="Confirm the new PIN"
      checkPin={async (pin) => pin === newPin}
      onSuccess={async () => {
        if (target === 'system') await setSystemPin(newPin);
        else await setMasterPin(newPin);
        showToast(target === 'system' ? 'System PIN changed' : 'Master PIN changed', 'success');
        onDone();
      }}
      onCancel={onCancel}
    />
  );
}

export default function Security() {
  const { showToast } = useToast();
  const navigate = useNavigate();

  // Master-PIN gate to view the whole page.
  const [unlocked, setUnlocked] = useState(false);

  const [protectedPages, setProtectedPagesState] = useState<string[]>([]);
  const [selectedPage, setSelectedPage] = useState<string>(TOGGLEABLE_PAGES[0].key);
  const [masterDefault, setMasterDefault] = useState(true);

  const [changeTarget, setChangeTarget] = useState<PinTarget | null>(null);

  // removing a page PIN (weakening protection) re-confirms the Master PIN
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const loadState = useCallback(async () => {
    setProtectedPagesState(await getProtectedPages());
    setMasterDefault(await isMasterDefault());
  }, []);
  useEffect(() => { if (unlocked) loadState(); }, [unlocked, loadState]);

  // ── Master-PIN gate ──
  if (!unlocked) {
    return (
      <PinModal
        title="Security — enter Master PIN"
        checkPin={checkMasterPin}
        onSuccess={() => setUnlocked(true)}
        onCancel={() => navigate('/settings')}
      />
    );
  }

  const togglePage = async (pageKey: string, on: boolean) => {
    await setPageProtected(pageKey, on);
    await loadState();
    showToast(on ? 'PIN added to this page' : 'PIN removed from this page', on ? 'success' : 'info');
  };

  const selectedProtected = protectedPages.includes(selectedPage);
  const selectedLabel = TOGGLEABLE_PAGES.find(p => p.key === selectedPage)?.label || '';

  // Two identical cards — same name/status-pill/Change-button shape for both
  // keys, so there's nothing new to learn between them.
  const cards: { target: PinTarget; title: string; icon: React.ReactNode; description: string; active: boolean; warning?: string }[] = [
    {
      target: 'system', title: 'System PIN', icon: <ShieldCheck size={17} />, active: true,
      description: 'Everyday key. Opens locked pages, Settings, and admin actions.',
    },
    {
      target: 'master', title: 'Master PIN', icon: <KeyRound size={17} />, active: !masterDefault,
      description: 'Recovery key. The only way to change the System PIN or remove a page lock.',
      warning: masterDefault ? "Still the factory default. Change it so a leaked PIN can't be reused." : undefined,
    },
  ];

  return (
    <div style={{ paddingBottom: 60 }}>
      <PageHeader showBack title="Security" subtitle="Manage the System PIN and Master PIN here" backFallback="/settings" />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        {cards.map(c => (
          <div key={c.target} className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {c.icon} <span style={{ fontWeight: 700 }}>{c.title}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: c.warning ? 6 : 12 }}>
              {c.description}
            </div>
            {c.warning && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--warning)', marginBottom: 12 }}>
                <AlertTriangle size={13} /> {c.warning}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, padding: '2px 9px', borderRadius: 6, background: c.active ? 'var(--success-bg)' : 'var(--warning-bg)', color: c.active ? 'var(--success)' : 'var(--warning)' }}>
                {c.active ? 'Active' : 'Factory default'}
              </span>
              <button className="btn btn-primary btn-sm" onClick={() => setChangeTarget(c.target)}><KeyRound size={14} /> Change</button>
            </div>
          </div>
        ))}
      </div>

      {/* Page PIN manager */}
      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Manage page PIN</div>

        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Select page</div>
        <select className="form-select" style={{ marginBottom: 16 }} value={selectedPage} onChange={e => setSelectedPage(e.target.value)}>
          {TOGGLEABLE_PAGES.map(p => (
            <option key={p.key} value={p.key}>
              {p.label} — {protectedPages.includes(p.key) ? 'PIN on' : 'no PIN'}
            </option>
          ))}
        </select>

        <div style={{ background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{selectedLabel}</span>
              {selectedProtected && <span style={{ fontSize: 12, padding: '2px 9px', borderRadius: 6, background: 'var(--success-bg)', color: 'var(--success)' }}>PIN on</span>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {selectedProtected ? 'Opens with System PIN' : 'No PIN yet — anyone can open'}
            </div>
          </div>
          {selectedProtected ? (
            <button className="btn btn-outline btn-sm" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={() => setRemoveTarget(selectedPage)}>
              <LockOpen size={14} /> Remove PIN
            </button>
          ) : (
            <button className="btn btn-outline btn-sm" onClick={() => togglePage(selectedPage, true)}>
              <Lock size={14} /> Add PIN
            </button>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          All protected pages open with the same System PIN. Settings and Security always stay locked.
        </div>
      </div>

      {changeTarget && (
        <ChangePinFlow
          target={changeTarget}
          onDone={() => { setChangeTarget(null); loadState(); }}
          onCancel={() => setChangeTarget(null)}
        />
      )}

      {/* Removing a page's PIN weakens protection, so re-confirm the Master PIN. */}
      {removeTarget && (
        <PinModal
          title="Enter Master PIN — to remove PIN"
          checkPin={checkMasterPin}
          onSuccess={async () => { await togglePage(removeTarget, false); setRemoveTarget(null); }}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </div>
  );
}
