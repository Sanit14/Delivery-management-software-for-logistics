import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAdmin } from '../context/AdminContext';
import PinModal from './PinModal';

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const { isAdmin, unlock } = useAdmin();
  const navigate = useNavigate();

  if (isAdmin) return <>{children}</>;

  // Cancel or too many wrong attempts → go cleanly to the dashboard (home),
  // never leave the user stuck on the PIN screen or glitch the history.
  const goHome = () => navigate('/', { replace: true });

  return (
    <PinModal
      title="Admin Access Required"
      onSuccess={() => { }}
      onCancel={goHome}
      onTooManyAttempts={goHome}
      checkPin={async (pin) => {
        const ok = await unlock(pin);
        return ok;
      }}
    />
  );
}
