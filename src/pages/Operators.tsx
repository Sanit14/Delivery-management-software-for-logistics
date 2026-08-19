import { useEffect, useState } from 'react';
import { UserPlus, Pencil, Check, X, Power } from 'lucide-react';
import { db } from '../db/database';
import type { Operator } from '../db/database';
import { addOperator, fmtCode } from '../utils/masterData';
import PageHeader from '../components/PageHeader';
import { useToast } from '../context/ToastContext';

export default function Operators() {
  const { showToast } = useToast();
  const [operators, setOperators] = useState<Operator[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');

  // Pending wasuli per agent (operatorId → count). Drives both the row badge and the
  // disabled state of the deactivate button, so the block is visible BEFORE it's hit.
  const [pendingByOp, setPendingByOp] = useState<Record<number, number>>({});

  const load = async () => {
    const ops = await db.operators.toArray();
    setOperators(ops);

    const rows = await db.wasuli.filter(w => !w.deletedAt && w.status === 'pending').toArray();
    const counts: Record<number, number> = {};
    for (const w of rows) counts[w.operatorId] = (counts[w.operatorId] || 0) + 1;
    setPendingByOp(counts);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim()) { showToast('Name is required', 'error'); return; }
    await addOperator(name, phone);
    showToast(`${name.trim()} added`, 'success');
    setName(''); setPhone('');
    load();
  };

  const startEdit = (o: Operator) => {
    setEditId(o.id!);
    setEditName(o.name);
    setEditPhone(o.phone);
  };

  const saveEdit = async () => {
    if (!editId || !editName.trim()) return;
    await db.operators.update(editId, { name: editName.trim(), phone: editPhone.trim() });
    showToast('Saved', 'success');
    setEditId(null);
    load();
  };

  const toggleActive = async (o: Operator) => {
    // Deactivating an agent who still holds pending wasuli is how money goes missing:
    // the agent disappears from the Wasuli page and the dashboard card, but the DRs are
    // still out there uncollected, now with nobody visibly responsible. So we refuse.
    //
    // Cancelled wasuli is written-off work, not owed, so it doesn't block.
    // REACTIVATING is never blocked — an already-inactive agent holding wasuli is exactly
    // the broken state we're fixing, and they must be able to come back.
    if (o.active) {
      const pending = await db.wasuli
        .where('operatorId').equals(o.id!)
        .filter(w => !w.deletedAt && w.status === 'pending')
        .count();
      if (pending > 0) {
        showToast(
          `${o.name} has ${pending} pending wasuli. Collect or reassign them first — then deactivate.`,
          'error',
        );
        return;
      }
    }

    await db.operators.update(o.id!, { active: !o.active });
    showToast(o.active ? `${o.name} deactivated` : `${o.name} active again`, 'info');
    load();
  };

  return (
    <div>
      <PageHeader showBack onRefresh={load} title="Agents" subtitle="People who handle collections" />

      {/* Add form */}
      <div className="card" style={{ padding: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, width: 240 }}>
            <label className="form-label req">Name</label>
            <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Raju Kumar" onKeyDown={e => e.key === 'Enter' && add()} />
          </div>
          <div className="form-group" style={{ marginBottom: 0, width: 200 }}>
            <label className="form-label">Phone</label>
            <input className="form-input" inputMode="numeric" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 9876543210" onKeyDown={e => e.key === 'Enter' && add()} />
          </div>
          <button className="btn btn-primary" onClick={add}><UserPlus size={15} /> Add</button>
        </div>
      </div>

      {operators.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>👤</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No agents yet</div>
          <div style={{ fontSize: 13 }}>Add a new agent above</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>Code</th><th>Name</th><th>Phone</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {operators.map(o => {
                const pending = pendingByOp[o.id!] || 0;
                const blocked = o.active && pending > 0;
                return (
                <tr key={o.id} style={{ opacity: o.active ? 1 : 0.55 }}>
                  <td><span className="ac-code">{fmtCode(o.code)}</span></td>
                  <td className="td-bold">
                    {editId === o.id
                      ? <input className="form-input" style={{ padding: '6px 10px', width: 200 }} value={editName} onChange={e => setEditName(e.target.value)} />
                      : o.name}
                  </td>
                  <td>
                    {editId === o.id
                      ? <input className="form-input" style={{ padding: '6px 10px', width: 160 }} value={editPhone} onChange={e => setEditPhone(e.target.value)} />
                      : o.phone || '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span className={`pill ${o.active ? 'pill-saved' : 'pill-cancelled'}`}>{o.active ? 'Active' : 'Inactive'}</span>
                      {pending > 0 && (
                        <span className="pill pill-pending" title={`${pending} wasuli still to collect`}>
                          {pending} pending
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {editId === o.id ? (
                        <>
                          <button title="Save" className="btn-icon btn-icon-view" onClick={saveEdit}><Check /></button>
                          <button title="Cancel" className="btn-icon btn-icon-cancel" onClick={() => setEditId(null)}><X /></button>
                        </>
                      ) : (
                        <>
                          <button title="Edit" className="btn-icon btn-icon-edit" onClick={() => startEdit(o)}><Pencil /></button>
                          <button
                            title={blocked
                              ? `Cannot deactivate — ${pending} pending wasuli. Collect or reassign them first.`
                              : o.active ? 'Deactivate' : 'Activate'}
                            className={`btn-icon ${o.active ? 'btn-icon-cancel' : 'btn-icon-view'}`}
                            disabled={blocked}
                            style={blocked ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                            onClick={() => toggleActive(o)}
                          ><Power /></button>
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
    </div>
  );
}
