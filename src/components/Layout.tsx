import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { FullscreenContext } from '../context/FullscreenContext';
import BottomNav from './BottomNav';
import GlobalSearch from './GlobalSearch';

export default function Layout() {
  const [searchOpen, setSearchOpen] = useState(false);
  // Fullscreen (sidebar hidden) — toggled by the challan entry page for a wider,
  // more readable entry area; automatically off everywhere else.
  const [fs, setFs] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    const openHandler = () => setSearchOpen(true);
    window.addEventListener('keydown', handler);
    window.addEventListener('open-global-search', openHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('open-global-search', openHandler);
    };
  }, []);

  return (
    <FullscreenContext.Provider value={{ fs, setFs }}>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        {!fs && <Sidebar />}
        <div style={{ flex: 1, minWidth: 0, width: '100%', maxWidth: '100%', overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', padding: fs ? '12px' : '24px', paddingBottom: fs ? 12 : 80 }}>
          <Outlet />
        </div>
        <BottomNav />
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </FullscreenContext.Provider>
  );
}
