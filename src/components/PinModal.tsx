import { useState, useRef, useEffect } from 'react';
import { Lock, Delete } from 'lucide-react';

interface PinModalProps {
  title: string;
  onSuccess: (pin: string) => void;
  onCancel: () => void;
  checkPin: (pin: string) => Promise<boolean>;
  onTooManyAttempts?: () => void;
  maxAttempts?: number;
}

export default function PinModal({ title, onSuccess, onCancel, checkPin, onTooManyAttempts, maxAttempts = 4 }: PinModalProps) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const handleKey = (k: string) => {
    if (k === 'del') {
      setPin(p => p.slice(0, -1));
      setError('');
      return;
    }
    if (pin.length >= 4) return;
    const next = pin + k;
    setPin(next);
    setError('');
    if (next.length === 4) handleUnlock(next);
  };

  const handleUnlock = async (p = pin) => {
    if (p.length !== 4) return;
    if (await checkPin(p)) {
      onSuccess(p);
    } else {
      const nextAttempts = attempts + 1;
      setAttempts(nextAttempts);
      setShaking(true);
      setPin('');
      setTimeout(() => setShaking(false), 400);
      if (onTooManyAttempts && nextAttempts >= maxAttempts) {
        setError(`${maxAttempts} wrong attempts — returning to the home page`);
        setTimeout(() => onTooManyAttempts(), 900);
      } else {
        const left = maxAttempts - nextAttempts;
        setError(onTooManyAttempts && left <= 2 ? `Wrong PIN — ${left} ${left === 1 ? 'try' : 'tries'} left` : 'Wrong PIN — try again');
      }
    }
  };

  // keyboard entry: digits type, Backspace deletes, Enter unlocks, Escape cancels
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handleKey(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handleKey('del');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleUnlock();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <div className="pin-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={`pin-modal ${shaking ? 'shake' : ''}`} ref={wrapRef}>
        <div className="pin-modal-header">
          <Lock />
          <span>{title}</span>
        </div>
        <div className="pin-body">
          <div className="pin-dots">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className={`pin-dot ${pin.length > i ? 'filled' : ''}`} />
            ))}
          </div>
          <div className="pin-keypad">
            {keys.map((k, i) => {
              if (k === '') return <div key={i} />;
              return (
                <button key={i} className="pin-key" onClick={() => handleKey(k)}>
                  {k === 'del' ? <Delete size={18} /> : k}
                </button>
              );
            })}
          </div>
          <button className="pin-unlock" onClick={() => handleUnlock()}>Unlock</button>
          {error && <div className="pin-error">{error}</div>}
          <span className="pin-cancel" onClick={onCancel}>Cancel</span>
        </div>
      </div>
    </div>
  );
}
