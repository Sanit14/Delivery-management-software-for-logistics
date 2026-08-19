import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PinModal from './PinModal';
import { isPageProtected, checkPin } from '../db/security';
import { PageLockContext } from '../context/PageLockContext';

/**
 * PageGuard — gates a page based on the per-page protection toggles set in the
 * Security screen. A page is locked if it's in the protected list (or is an
 * always-protected page). Unlike the old all-or-nothing AdminGuard, this respects
 * the toggles, so only the pages the owner chose to protect ask for the PIN.
 *
 * Session behaviour: each protected page requires its own PIN entry every time
 * it is opened. React Router unmounts the route element on navigation, which
 * resets the component-local unlocked state.
 *
 * `pageKey` is the page's key (e.g. 'wasuli'); 'settings'/'security' are always
 * protected regardless of toggles.
 */
export default function PageGuard({ pageKey, children }: { pageKey: string; children: React.ReactNode }) {
  const navigate = useNavigate();
  const [needsPin, setNeedsPin] = useState<boolean | null>(null); // null = still checking
  // ponytail: unlock state is LOCAL to this mounted guard, not the shared isAdmin
  // flag. React Router unmounts the route element on navigation, so leaving the
  // page discards this state and returning re-prompts — no location watcher, no
  // path→pageKey map, no re-locking logic. App refresh re-locks for free because
  // nothing is persisted.
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    let alive = true;
    isPageProtected(pageKey).then((p) => { if (alive) setNeedsPin(p); }).catch(() => { if (alive) setNeedsPin(false); });
    return () => { alive = false; };
  }, [pageKey]);

  // Still determining whether this page is protected — render nothing briefly.
  if (needsPin === null) return null;

  // Not protected, or already unlocked for this page instance → show the page.
  if (!needsPin || unlocked) {
    return (
      <PageLockContext.Provider value={{ relock: () => setUnlocked(false) }}>
        {children}
      </PageLockContext.Provider>
    );
  }

  const goHome = () => navigate('/', { replace: true });

  return (
    <PinModal
      title="Enter PIN"
      onSuccess={() => setUnlocked(true)}
      onCancel={goHome}
      onTooManyAttempts={goHome}
      checkPin={async (pin) => checkPin(pin)}
    />
  );
}
