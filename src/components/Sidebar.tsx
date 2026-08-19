import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, ClipboardList, FolderOpen, Receipt, DollarSign, Building2, BarChart2, Users, Settings, Database } from 'lucide-react';
import { APP_VERSION } from '../constants/version';
import { db } from '../db/database';
import { formatCount, todayISO } from '../utils/reportUtils';
import Logo from './Logo';

interface Counts {
  openChallans: number;
  todaysMemos: number;
  todaysDRs: number;
  todaysWasuli: number;
}

export default function Sidebar() {
  const [counts, setCounts] = useState<Counts>({ openChallans: 0, todaysMemos: 0, todaysDRs: 0, todaysWasuli: 0 });
  const location = useLocation();

  useEffect(() => {
    const load = async () => {
      const today = todayISO();
      // Memos/DRs/Wasuli badges show today's activity, not the all-time backlog —
      // otherwise they only ever grow (nothing here reaches a terminal "done"
      // state that would shrink the count back down). Open challans stays
      // all-time since it's inherently small (rarely more than one at once).
      const [openChallans, todaysMemos, todaysDRs, unassignedTodayRows] = await Promise.all([
        db.challans.where('status').equals('open').filter(c => !c.deletedAt).count(),
        db.challans.filter(c => !c.deletedAt && c.status === 'saved' && c.entryDate === today).count(),
        db.drs.filter(d => !d.deletedAt && d.deliveryDate === today).count(),
        db.wasuli.where('status').equals('pending').filter(w => !w.deletedAt && w.operatorId === 0).toArray(),
      ]);
      // Wasuli rows carry no date of their own — "today" means the delivery
      // date of the DR they're for, same field todaysDRs above uses.
      const drsForWasuli = await db.drs.where('id').anyOf(unassignedTodayRows.map(w => w.drId)).toArray();
      const deliveryDateById = new Map(drsForWasuli.map(d => [d.id!, d.deliveryDate]));
      const todaysWasuli = unassignedTodayRows.filter(w => deliveryDateById.get(w.drId) === today).length;
      setCounts({ openChallans, todaysMemos, todaysDRs, todaysWasuli });
    };
    load();
  }, [location.pathname]);

  const nav = (to: string, icon: React.ReactNode, label: string, badge?: number) => (
    <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      {icon}
      <span className="nav-label">{label}</span>
      {badge !== undefined && badge > 0 && <span className="nav-badge">{formatCount(badge)}</span>}
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
      {nav('/memos', <FolderOpen />, 'Saved Memos', counts.todaysMemos)}
      {nav('/drs', <Receipt />, 'Saved DRs', counts.todaysDRs)}
      {nav('/wasuli', <DollarSign />, 'Wasuli', counts.todaysWasuli)}

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
