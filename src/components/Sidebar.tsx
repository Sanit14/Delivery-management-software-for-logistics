import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, ClipboardList, FolderOpen, Receipt, DollarSign, Building2, BarChart2, Users, Settings, Database } from 'lucide-react';
import { APP_VERSION } from '../constants/version';
import { db } from '../db/database';
import Logo from './Logo';

interface Counts {
  openChallans: number;
  savedMemos: number;
  unprintedDRs: number;
  pendingWasuli: number;
}

export default function Sidebar() {
  const [counts, setCounts] = useState<Counts>({ openChallans: 0, savedMemos: 0, unprintedDRs: 0, pendingWasuli: 0 });
  const location = useLocation();

  useEffect(() => {
    const load = async () => {
      const [openChallans, savedMemos, unprintedDRs, pendingWasuli] = await Promise.all([
        db.challans.where('status').equals('open').filter(c => !c.deletedAt).count(),
        db.challans.where('status').equals('saved').filter(c => !c.deletedAt).count(),
        db.drs.where('status').equals('pending').filter(d => !d.deletedAt).count(),
        db.wasuli.where('status').equals('pending').filter(w => !w.deletedAt).count(),
      ]);
      setCounts({ openChallans, savedMemos, unprintedDRs, pendingWasuli });
    };
    load();
  }, [location.pathname]);

  const nav = (to: string, icon: React.ReactNode, label: string, badge?: number) => (
    <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      {icon}
      <span className="nav-label">{label}</span>
      {badge !== undefined && badge > 0 && <span className="nav-badge">{badge}</span>}
    </NavLink>
  );

  return (
    <div className="sidebar-full" style={{ width: 186, height: '100vh', overflowY: 'auto', background: 'var(--card)', borderRight: '0.5px solid var(--border)', boxShadow: 'var(--shadow-sm)', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '16px 16px 8px' }}>
        <Logo size={44} radiusRatio={0.3} />
        <div className="brand-name" style={{ marginTop: 8 }}>Sundeep Freight Movers</div>
        <div className="brand-sub">Yavatmal</div>
      </div>

      <div className="section-label">MAIN</div>
      {nav('/', <LayoutDashboard />, 'Dashboard')}
      {nav('/challan', <ClipboardList />, 'Challan Entry', counts.openChallans)}
      {nav('/memos', <FolderOpen />, 'Saved Memos', counts.savedMemos)}
      {nav('/drs', <Receipt />, 'Saved DRs', counts.unprintedDRs)}
      {nav('/wasuli', <DollarSign />, 'Wasuli', counts.pendingWasuli)}

      <div className="section-label">ADMIN</div>
      {nav('/firm-accounts', <Building2 />, 'Firm Accounts')}
      {nav('/reports', <BarChart2 />, 'Reports')}
      {nav('/operators', <Users />, 'Agents')}
      {nav('/master-data', <Database />, 'Master Data')}
      {nav('/settings', <Settings />, 'Settings')}

      <div style={{ marginTop: 'auto', padding: '12px 16px', fontSize: 10, color: 'var(--text-muted)', opacity: 0.7 }}>
        DeliveryManager v{APP_VERSION}
      </div>
    </div>
  );
}
