import { NavLink, useNavigate } from 'react-router-dom';
import { Home, ClipboardList, Plus, DollarSign, Menu } from 'lucide-react';

export default function BottomNav() {
  const navigate = useNavigate();

  return (
    <div className="bottom-nav-bar">
      <NavLink to="/" className={({ isActive }) => `flex flex-col items-center gap-1 text-xs ${isActive ? 'text-orange-500' : 'text-gray-500'}`} style={{ flexDirection: 'column', alignItems: 'center', display: 'flex', gap: 2, fontSize: 10, textDecoration: 'none', color: 'var(--text-muted)' }}>
        <Home size={20} /><span>Home</span>
      </NavLink>
      <NavLink to="/challan" style={{ flexDirection: 'column', alignItems: 'center', display: 'flex', gap: 2, fontSize: 10, textDecoration: 'none', color: 'var(--text-muted)' }}>
        <ClipboardList size={20} /><span>Challan</span>
      </NavLink>
      <button onClick={() => navigate('/challan/new/header')} style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--orange)', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: 'var(--shadow-md)', cursor: 'pointer', marginTop: -12 }}>
        <Plus size={22} color="white" />
      </button>
      <NavLink to="/wasuli" style={{ flexDirection: 'column', alignItems: 'center', display: 'flex', gap: 2, fontSize: 10, textDecoration: 'none', color: 'var(--text-muted)' }}>
        <DollarSign size={20} /><span>Wasuli</span>
      </NavLink>
      <NavLink to="/reports" style={{ flexDirection: 'column', alignItems: 'center', display: 'flex', gap: 2, fontSize: 10, textDecoration: 'none', color: 'var(--text-muted)' }}>
        <Menu size={20} /><span>More</span>
      </NavLink>
    </div>
  );
}
