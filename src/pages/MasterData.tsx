import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus, Pencil, Check, X, Trash2, Building2, MapPin, Truck, Users } from 'lucide-react';
import { db } from '../db/database';
import {
  listEntities, addEntity, editEntity, deleteEntity, countChallanUsage,
  editTruck, deleteTruck, countAgentUsage, addOperator, fmtCode, type MasterEntity,
} from '../utils/masterData';
import PageHeader from '../components/PageHeader';
import ConfirmModal from '../components/ConfirmModal';
import PinModal from '../components/PinModal';
import { useToast } from '../context/ToastContext';
import { useAdmin } from '../context/AdminContext';

type Tab = 'firm' | 'station' | 'truck' | 'operator';

interface OperatorRow { id: number; name: string; phone: string; code?: number; active: boolean; }
interface TruckRow { id: number; value: string; useCount: number; }

export default function MasterData() {
  const { showToast } = useToast();
  const { unlock } = useAdmin();
  const location = useLocation();
  // When opened as a detour (e.g. "New agent" from Wasuli), the caller passes
  // openTab (which tab to show) and from (where Back should return to).
  const navState = (location.state || {}) as { openTab?: Tab; from?: string };
  const [showDeletePin, setShowDeletePin] = useState(false);
  const [tab, setTab] = useState<Tab>(navState.openTab || 'firm');

  const [firms, setFirms] = useState<MasterEntity[]>([]);
  const [stations, setStations] = useState<MasterEntity[]>([]);
  const [trucks, setTrucks] = useState<TruckRow[]>([]);
  const [operators, setOperators] = useState<OperatorRow[]>([]);

  const [newName, setNewName] = useState('');
  const [newDetails, setNewDetails] = useState('');
  const [newPhone, setNewPhone] = useState('');

  // editing state — works across all tabs
  const [editKey, setEditKey] = useState<string | null>(null); // unique key per row
  const [editName, setEditName] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [editPhone, setEditPhone] = useState('');

  // delete confirmation
  const [delTarget, setDelTarget] = useState<{ kind: Tab; id: number; name: string; usage: number } | null>(null);

  const load = async () => {
    setFirms(await listEntities('firm'));
    setStations(await listEntities('station'));
    const truckRows = await db.masterData.where('field').equals('truckNumber').toArray();
    setTrucks(truckRows.map(r => ({ id: r.id!, value: r.value, useCount: r.useCount })).sort((a, b) => b.useCount - a.useCount));
    const ops = await db.operators.toArray();
    setOperators(ops.map(o => ({ id: o.id!, name: o.name, phone: o.phone, code: o.code, active: o.active })).sort((a, b) => (a.code || 0) - (b.code || 0)));
  };
  useEffect(() => { load(); }, []);

  const resetEdit = () => { setEditKey(null); setEditName(''); setEditDetails(''); setEditPhone(''); };

  // ── ADD ──
  const handleAdd = async () => {
    if (!newName.trim()) { showToast('Name is required', 'error'); return; }
    if (tab === 'firm' || tab === 'station') {
      const code = await addEntity(tab, newName, newDetails.trim() || undefined);
      if (code === null) { showToast('This already exists', 'error'); return; }
      showToast(`${newName.trim()} added · code ${fmtCode(code)}`, 'success');
    } else if (tab === 'operator') {
      const code = await addOperator(newName, newPhone);
      showToast(`${newName.trim()} added · code ${fmtCode(code)}`, 'success');
    } else if (tab === 'truck') {
      const exists = await db.masterData.where('field').equals('truckNumber').filter(r => r.value.toLowerCase() === newName.trim().toLowerCase()).first();
      if (exists) { showToast('This truck already exists', 'error'); return; }
      await db.masterData.add({ field: 'truckNumber', value: newName.trim(), useCount: 0 });
      showToast(`${newName.trim()} added`, 'success');
    }
    setNewName(''); setNewDetails(''); setNewPhone('');
    load();
  };

  // ── EDIT (save) ──
  const saveEdit = async () => {
    if (!editName.trim()) { showToast('Name cannot be empty', 'error'); return; }
    if (!editKey) return;
    const [kind, idStr] = editKey.split(':');
    const id = Number(idStr);
    if (kind === 'firm' || kind === 'station') {
      await editEntity(id, editName, editDetails.trim() || undefined);
    } else if (kind === 'operator') {
      await db.operators.update(id, { name: editName.trim(), phone: editPhone.trim() });
    } else if (kind === 'truck') {
      const truck = trucks.find(t => t.id === id);
      if (truck) await editTruck(truck.value, editName.trim());
    }
    showToast('Updated', 'success');
    resetEdit();
    load();
  };

  // ── DELETE (with usage check) ──
  const askDelete = async (kind: Tab, id: number, name: string) => {
    let usage = 0;
    if (kind === 'firm') usage = await countChallanUsage('firm', name);
    else if (kind === 'station') usage = await countChallanUsage('station', name);
    else if (kind === 'truck') usage = (await db.challans.filter(c => !c.deletedAt && c.truckNumber.toLowerCase() === name.toLowerCase()).toArray()).length;
    else if (kind === 'operator') usage = await countAgentUsage(id);
    setDelTarget({ kind, id, name, usage });
  };

  // Step 1: user confirmed in the ConfirmModal → now require the admin PIN before deleting.
  const confirmDelete = () => {
    if (!delTarget) return;
    setShowDeletePin(true);
  };

  // Step 2: PIN verified → actually delete.
  const runDelete = async () => {
    if (!delTarget) return;
    const { kind, id } = delTarget;
    if (kind === 'operator') {
      // never hard-delete an agent with assignments — deactivate instead
      if (delTarget.usage > 0) { await db.operators.update(id, { active: false }); showToast('Agent has wasuli — deactivated instead', 'info'); }
      else { await db.operators.delete(id); showToast('Agent deleted', 'success'); }
    } else if (kind === 'truck') {
      await deleteTruck(delTarget.name); showToast('Truck deleted', 'success');
    } else {
      await deleteEntity(id); showToast(`${kind === 'firm' ? 'Firm' : 'Station'} deleted`, 'success');
    }
    setShowDeletePin(false);
    setDelTarget(null);
    load();
  };

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'firm', label: 'Firms', icon: <Building2 size={15} /> },
    { id: 'station', label: 'Stations', icon: <MapPin size={15} /> },
    { id: 'truck', label: 'Trucks', icon: <Truck size={15} /> },
    { id: 'operator', label: 'Agents', icon: <Users size={15} /> },
  ];

  const codedList = tab === 'firm' ? firms : tab === 'station' ? stations : [];

  const addLabel = tab === 'firm' ? 'Firm' : tab === 'station' ? 'Station' : tab === 'truck' ? 'Truck No.' : 'Agent';
  const addPlaceholder = tab === 'firm' ? 'e.g. Ashok Industry' : tab === 'station' ? 'e.g. Pusad' : tab === 'truck' ? 'e.g. MH-29-AB-1234' : 'e.g. Raju Kumar';

  return (
    <div>
      <PageHeader showBack onRefresh={load} title="Master Data" subtitle="Firms, stations, trucks and agents — add, edit, delete" />

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 18, borderBottom: '2px solid var(--border)', flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); resetEdit(); setNewName(''); setNewDetails(''); setNewPhone(''); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px', fontWeight: tab === t.id ? 700 : 500, fontSize: 14, background: 'none', border: 'none', cursor: 'pointer', color: tab === t.id ? 'var(--orange)' : 'var(--text-muted)', borderBottom: tab === t.id ? '2px solid var(--orange)' : '2px solid transparent', marginBottom: -2 }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Add bar — all tabs */}
      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 180 }}>
            <label className="form-label">Name of {addLabel}</label>
            <input className="form-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder={addPlaceholder} onKeyDown={e => e.key === 'Enter' && handleAdd()} />
          </div>
          {(tab === 'firm' || tab === 'station') && (
            <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 180 }}>
              <label className="form-label">Details (optional)</label>
              <input className="form-input" value={newDetails} onChange={e => setNewDetails(e.target.value)} placeholder="phone, address, etc." onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            </div>
          )}
          {tab === 'operator' && (
            <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 140 }}>
              <label className="form-label">Phone (optional)</label>
              <input className="form-input" inputMode="numeric" value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="9876543210" onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            </div>
          )}
          <button className="btn btn-primary" onClick={handleAdd}><Plus size={16} /> Add</button>
        </div>
      </div>

      {/* Firm / Station table */}
      {(tab === 'firm' || tab === 'station') && (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th style={{ width: 80 }}>Code</th><th>Name</th><th>Details</th><th style={{ width: 90 }}>Use Count</th><th style={{ width: 110 }}>Actions</th></tr></thead>
            <tbody>
              {codedList.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No {tab} found</td></tr>
              ) : codedList.map(e => {
                const key = `${tab}:${e.id}`;
                const editing = editKey === key;
                return (
                  <tr key={e.id}>
                    <td><span className="ac-code">{fmtCode(e.code)}</span></td>
                    <td className="td-bold">{editing ? <input className="form-input" style={{ padding: '6px 10px', maxWidth: 220 }} value={editName} onChange={ev => setEditName(ev.target.value)} /> : e.name}</td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 13 }}>{editing ? <input className="form-input" style={{ padding: '6px 10px', maxWidth: 220 }} value={editDetails} onChange={ev => setEditDetails(ev.target.value)} placeholder="details" /> : (e.details || '—')}</td>
                    <td>{e.useCount}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {editing ? (
                          <>
                            <button title="Save" className="btn-icon btn-icon-edit" onClick={saveEdit}><Check size={14} /></button>
                            <button title="Cancel" className="btn-icon btn-icon-cancel" onClick={resetEdit}><X size={14} /></button>
                          </>
                        ) : (
                          <>
                            <button title="Edit" className="btn-icon btn-icon-edit" onClick={() => { setEditKey(key); setEditName(e.name); setEditDetails(e.details || ''); }}><Pencil size={14} /></button>
                            <button title="Delete" className="btn-icon btn-icon-delete" onClick={() => askDelete(tab, e.id, e.name)}><Trash2 size={14} /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Truck table — editable, no code */}
      {tab === 'truck' && (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th>Truck No.</th><th style={{ width: 100 }}>Use Count</th><th style={{ width: 110 }}>Actions</th></tr></thead>
            <tbody>
              {trucks.length === 0 ? (
                <tr><td colSpan={3} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No trucks</td></tr>
              ) : trucks.map(t => {
                const key = `truck:${t.id}`;
                const editing = editKey === key;
                return (
                  <tr key={t.id}>
                    <td className="td-bold">{editing ? <input className="form-input" style={{ padding: '6px 10px', maxWidth: 200 }} value={editName} onChange={ev => setEditName(ev.target.value)} /> : t.value}</td>
                    <td>{t.useCount}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {editing ? (
                          <>
                            <button title="Save" className="btn-icon btn-icon-edit" onClick={saveEdit}><Check size={14} /></button>
                            <button title="Cancel" className="btn-icon btn-icon-cancel" onClick={resetEdit}><X size={14} /></button>
                          </>
                        ) : (
                          <>
                            <button title="Edit" className="btn-icon btn-icon-edit" onClick={() => { setEditKey(key); setEditName(t.value); }}><Pencil size={14} /></button>
                            <button title="Delete" className="btn-icon btn-icon-delete" onClick={() => askDelete('truck', t.id, t.value)}><Trash2 size={14} /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Agents table — editable, coded */}
      {tab === 'operator' && (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead><tr><th style={{ width: 80 }}>Code</th><th>Naam</th><th>Phone</th><th style={{ width: 90 }}>Status</th><th style={{ width: 110 }}>Actions</th></tr></thead>
            <tbody>
              {operators.length === 0 ? (
                <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>No agents</td></tr>
              ) : operators.map(o => {
                const key = `operator:${o.id}`;
                const editing = editKey === key;
                return (
                  <tr key={o.id} style={{ opacity: o.active ? 1 : 0.55 }}>
                    <td><span className="ac-code">{fmtCode(o.code)}</span></td>
                    <td className="td-bold">{editing ? <input className="form-input" style={{ padding: '6px 10px', maxWidth: 180 }} value={editName} onChange={ev => setEditName(ev.target.value)} /> : o.name}</td>
                    <td>{editing ? <input className="form-input" style={{ padding: '6px 10px', maxWidth: 140 }} value={editPhone} onChange={ev => setEditPhone(ev.target.value)} placeholder="phone" /> : (o.phone || '—')}</td>
                    <td>
                      <span className={`pill ${o.active ? 'pill-saved' : 'pill-cancelled'}`} style={{ cursor: 'pointer' }} onClick={async () => { await db.operators.update(o.id, { active: !o.active }); load(); }}>{o.active ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {editing ? (
                          <>
                            <button title="Save" className="btn-icon btn-icon-edit" onClick={saveEdit}><Check size={14} /></button>
                            <button title="Cancel" className="btn-icon btn-icon-cancel" onClick={resetEdit}><X size={14} /></button>
                          </>
                        ) : (
                          <>
                            <button title="Edit" className="btn-icon btn-icon-edit" onClick={() => { setEditKey(key); setEditName(o.name); setEditPhone(o.phone); }}><Pencil size={14} /></button>
                            <button title="Delete" className="btn-icon btn-icon-delete" onClick={() => askDelete('operator', o.id, o.name)}><Trash2 size={14} /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ padding: '10px 14px', fontSize: 12, color: 'var(--text-muted)' }}>Click the status to toggle Active/Inactive.</div>
        </div>
      )}

      {delTarget && !showDeletePin && (
        <ConfirmModal
          title={`Delete ${delTarget.name}?`}
          body={
            delTarget.kind === 'operator' && delTarget.usage > 0
              ? <>This agent has <b>{delTarget.usage}</b> wasuli records. It will not be deleted — only <b>deactivated</b> (records stay safe).</>
              : delTarget.usage > 0
                ? <><b>{delTarget.name}</b> is currently used in <b>{delTarget.usage}</b> challans. Old challans stay as they are, but it will be removed from the master list and autocomplete.</>
                : <><b>{delTarget.name}</b> will be removed from the master list.</>
          }
          confirmLabel={delTarget.kind === 'operator' && delTarget.usage > 0 ? 'Deactivate' : 'Yes, delete'}
          onConfirm={confirmDelete}
          onCancel={() => setDelTarget(null)}
          danger
        />
      )}
      {showDeletePin && (
        <PinModal
          title="Enter Admin PIN to delete"
          checkPin={unlock}
          onSuccess={runDelete}
          onCancel={() => { setShowDeletePin(false); setDelTarget(null); }}
        />
      )}
    </div>
  );
}
