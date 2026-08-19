import { useEffect, useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { seedDefaults, backfillDRTruckNumbers } from './db/database';
import SplashScreen from './components/SplashScreen';
import SafeModeScreen from './components/SafeModeScreen';
import { AdminProvider } from './context/AdminContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/Layout';
import AdminGuard from './components/AdminGuard';
import PageGuard from './components/PageGuard';
import Dashboard from './pages/Dashboard';
import ChallanList from './pages/ChallanList';
import ChallanHeader from './pages/ChallanHeader';
import ChallanDetail from './pages/ChallanDetail';
import SavedMemos from './pages/SavedMemos';
import SavedDRs from './pages/SavedDRs';
import MemoView from './pages/MemoView';
import Wasuli from './pages/Wasuli';
import FirmAccounts from './pages/FirmAccounts';
import FirmLedgerPage from './pages/FirmLedgerPage';
import FirmSettledRecords from './pages/FirmSettledRecords';
import FirmChallanReport from './pages/FirmChallanReport';
import Reports from './pages/Reports';
import Operators from './pages/Operators';
import MasterData from './pages/MasterData';
import EntityInfo from './pages/EntityInfo';
import SettingsPage from './pages/SettingsPage';
import History from './pages/History';
import Security from './pages/Security';

function App() {
  const [ready, setReady] = useState(false);
  const [startError, setStartError] = useState(false);
  const [safeInfo, setSafeInfo] = useState<{ active: boolean; reason?: string; opened?: { total: number }; lastGood?: { total: number; at: string; root: string } | null } | null>(null);

  useEffect(() => {
    const startTime = Date.now();
    const MIN_SPLASH = 2400; // matches the choreographed splash (truck approach + handoff)
    (async () => {
      try {
        // Blank-DB guard: if the keeper opened empty but we had data before, show
        // the safe-mode restore screen instead of seeding/opening normally. Never
        // seed defaults into a suspicious-blank db — that would look like real data.
        if (typeof window !== 'undefined' && window.sqlAPI?.safeMode) {
          try {
            const sm = await window.sqlAPI.safeMode();
            if (sm?.active) { setSafeInfo(sm); setReady(true); return; }
          } catch { /* if the check fails, fall through to normal startup */ }
        }
        await seedDefaults();
        await backfillDRTruckNumbers();
        const elapsed = Date.now() - startTime;
        const wait = Math.max(0, MIN_SPLASH - elapsed);
        setTimeout(() => setReady(true), wait);
      } catch (err) {
        console.error('Startup failed:', err);
        setStartError(true);
      }
    })();
  }, []);

  // When THIS seat restores or imports a backup, db:changed fires immediately
  // within this process (it does not reach other seats — each seat is a separate
  // process). Reload so this seat's own views reflect the new data right away.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.sqlAPI?.onDbChanged) return;
    const unsubscribe = window.sqlAPI.onDbChanged(() => {
      window.location.reload();
    });
    return unsubscribe;
  }, []);

  // For the OTHER seats: since a restore/import replaces the whole database, every
  // seat needs to know — not just the one that performed it. The keeper exposes a
  // tiny "generation" number that increments on every restore/import. Each seat
  // checks it periodically (a single small number, not real data, so this is very
  // light); if it differs from what this seat last saw, a restore/import happened
  // somewhere and this seat reloads to pick up the new data. Routine saves
  // (adding a challan, assigning wasuli, etc.) do NOT bump this — those still use
  // the per-page refresh button or Ctrl+R, by design (see the architecture guide).
  useEffect(() => {
    if (typeof window === 'undefined' || !window.sqlAPI?.getGeneration) return;
    let lastSeen: number | null = null;
    let stopped = false;
    const POLL_MS = 8000;
    const tick = async () => {
      if (stopped) return;
      try {
        const gen = await window.sqlAPI!.getGeneration!();
        if (typeof gen === 'number') {
          if (lastSeen === null) lastSeen = gen; // first check just establishes the baseline
          else if (gen !== lastSeen) { window.location.reload(); return; }
        }
      } catch { /* keeper briefly unreachable — just try again next tick */ }
      if (!stopped) setTimeout(tick, POLL_MS);
    };
    const firstTimer = setTimeout(tick, POLL_MS);
    return () => { stopped = true; clearTimeout(firstTimer); };
  }, []);

  if (startError) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 40 }}>⚠️</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#144D52' }}>App failed to start</div>
        <div style={{ fontSize: 13, color: '#4a5f5b', maxWidth: 360 }}>There was a problem loading data. Try restarting the app.</div>
        <button onClick={() => window.location.reload()} style={{ background: '#E66C32', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 22px', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Restart</button>
      </div>
    );
  }

  if (!ready) {
    return <SplashScreen />;
  }

  if (safeInfo?.active) {
    return <SafeModeScreen info={safeInfo} />;
  }

  return (
    <AdminProvider>
      <ToastProvider>
        <HashRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/info/:type/:value" element={<EntityInfo />} />
              <Route path="/challan" element={<ChallanList />} />
              <Route path="/challan/new/header" element={<ChallanHeader />} />
              <Route path="/challan/:id/header" element={<ChallanHeader />} />
              <Route path="/challan/:id/detail" element={<ChallanDetail />} />
              <Route path="/memos" element={<PageGuard pageKey="memos"><SavedMemos /></PageGuard>} />
              <Route path="/drs" element={<PageGuard pageKey="drs"><SavedDRs /></PageGuard>} />
              <Route path="/memo/:challanId/view" element={<PageGuard pageKey="memos"><MemoView /></PageGuard>} />
              <Route path="/wasuli" element={<PageGuard pageKey="wasuli"><Wasuli /></PageGuard>} />
              <Route path="/firm-accounts" element={<PageGuard pageKey="reports"><FirmAccounts /></PageGuard>} />
              <Route path="/firm-accounts/:firmName" element={<PageGuard pageKey="reports"><FirmLedgerPage /></PageGuard>} />
              <Route path="/firm-accounts/:firmName/settled" element={<PageGuard pageKey="reports"><FirmSettledRecords /></PageGuard>} />
              <Route path="/firm-accounts/:firmName/challan/:challanNumber" element={<PageGuard pageKey="reports"><FirmChallanReport /></PageGuard>} />
              <Route path="/reports" element={<PageGuard pageKey="reports"><Reports /></PageGuard>} />
              <Route path="/operators" element={<PageGuard pageKey="masterData"><Operators /></PageGuard>} />
              <Route path="/master-data" element={<PageGuard pageKey="masterData"><MasterData /></PageGuard>} />
              <Route path="/settings" element={<AdminGuard><SettingsPage /></AdminGuard>} />
              <Route path="/history" element={<PageGuard pageKey="history"><History /></PageGuard>} />
              <Route path="/security" element={<AdminGuard><Security /></AdminGuard>} />
            </Route>
          </Routes>
        </HashRouter>
      </ToastProvider>
    </AdminProvider>
  );
}

export default App;
