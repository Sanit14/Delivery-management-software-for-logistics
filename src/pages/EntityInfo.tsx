import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, MapPin, Truck, User, FileText, Eye } from 'lucide-react';
import { db } from '../db/database';
import type { Challan } from '../db/database';
import { formatDate } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';

type InfoType = 'firm' | 'station' | 'truck' | 'operator' | 'challan';

interface SummaryRow {
  challanNumber: string;
  challanId: number;
  date: string;
  firm: string;
  truck: string;
  station: string;
  pkgs: number;
  mode: string;
}

const modeLabel = (m: string) => m === 'topay' ? 'ToPay' : m === 'paid' ? 'Paid' : '—';

export default function EntityInfo() {
  const { type, value: rawValue } = useParams<{ type: InfoType; value: string }>();
  const value = decodeURIComponent(rawValue || '');
  const navigate = useNavigate();
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalPkgs, setTotalPkgs] = useState(0);

  const load = useCallback(async () => {
      setLoading(true);
      const all = (await db.challans.toArray()).filter(c => !c.deletedAt && c.status !== 'cancelled');
      let challans: Challan[] = [];
      const v = value.toLowerCase();

      if (type === 'firm') challans = all.filter(c => c.firmName.toLowerCase() === v);
      else if (type === 'station') challans = all.filter(c => c.loadingStation.toLowerCase() === v);
      else if (type === 'truck') challans = all.filter(c => c.truckNumber.toLowerCase() === v);
      else if (type === 'challan') challans = all.filter(c => c.challanNumber.toLowerCase() === v);
      else if (type === 'operator') {
        // Operator: challans whose DRs were assigned to this operator (via wasuli)
        const op = (await db.operators.toArray()).find(o => o.name.toLowerCase() === v);
        if (op) {
          const wasuli = await db.wasuli.where('operatorId').equals(op.id!).filter(w => !w.deletedAt).toArray();
          const cIds = new Set(wasuli.map(w => w.challanId));
          challans = all.filter(c => cIds.has(c.id!));
        }
      }

      const cIds = challans.map(c => c.id!);
      const entries = await db.lrEntries.where('challanId').anyOf(cIds).filter(e => e.status === 'active' && !e.deletedAt).toArray();
      const byChallan = new Map<number, typeof entries>();
      for (const e of entries) {
        if (!byChallan.has(e.challanId)) byChallan.set(e.challanId, []);
        byChallan.get(e.challanId)!.push(e);
      }

      const sorted = challans.sort((a, b) => b.entryDate.localeCompare(a.entryDate) || (b.id || 0) - (a.id || 0));
      let pkgSum = 0;
      const out: SummaryRow[] = sorted.map(c => {
        const es = byChallan.get(c.id!) || [];
        const pkgs = es.reduce((s, e) => s + (e.quantity || 0), 0);
        pkgSum += pkgs;
        const modes = Array.from(new Set(es.map(e => e.paymentMode)));
        const mode = modes.length === 0 ? '—' : modes.length === 1 ? modeLabel(modes[0]) : 'Mixed';
        return { challanNumber: c.challanNumber, challanId: c.id!, date: c.entryDate, firm: c.firmName, truck: c.truckNumber, station: c.loadingStation, pkgs, mode };
      });
      setRows(out);
      setTotalPkgs(pkgSum);
      setLoading(false);
  }, [type, value]);
  useEffect(() => { load(); }, [load]);

  const typeMeta: Record<InfoType, { icon: React.ReactNode; label: string }> = {
    firm: { icon: <Building2 size={18} />, label: 'Firm' },
    station: { icon: <MapPin size={18} />, label: 'Station' },
    truck: { icon: <Truck size={18} />, label: 'Truck' },
    operator: { icon: <User size={18} />, label: 'Agent' },
    challan: { icon: <FileText size={18} />, label: 'Challan' },
  };
  const meta = typeMeta[(type as InfoType)] || typeMeta.firm;

  return (
    <div>
      <button onClick={() => navigate(-1)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', background: 'none', border: 'none', cursor: 'pointer', marginBottom: 12 }}>
        <ArrowLeft size={14} /> Back
      </button>
      <PageHeader
        showBack onRefresh={load}
        title={value}
        subtitle={`${meta.label} — how many vehicles arrived, how many packages (info only — financials in admin section)`}
      />

      {/* Summary stats (no money) */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="stat-card" style={{ padding: 14, minWidth: 140 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--navy)' }}>{rows.length}</div>
          <div className="stat-label">{type === 'challan' ? 'Challan' : 'Vehicles / Trips'}</div>
        </div>
        <div className="stat-card" style={{ padding: 14, minWidth: 140 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--navy)' }}>{totalPkgs}</div>
          <div className="stat-label">Total Packages</div>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>Loading...</div>
      ) : rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.3 }}>📭</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No records found</div>
        </div>
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Challan No.</th>
                {type !== 'firm' && <th>Firm</th>}
                {type !== 'truck' && <th>Truck No.</th>}
                {type !== 'station' && <th>Station</th>}
                <th>Pkgs</th><th>Mode</th><th>Preview</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{formatDate(r.date)}</td>
                  <td className="td-bold">
                    <Link to={`/info/challan/${encodeURIComponent(r.challanNumber)}`} style={{ color: 'var(--orange)', textDecoration: 'none' }}>
                      #{r.challanNumber}
                    </Link>
                  </td>
                  {type !== 'firm' && <td>{r.firm}</td>}
                  {type !== 'truck' && <td>{r.truck}</td>}
                  {type !== 'station' && <td>{r.station}</td>}
                  <td>{r.pkgs}</td>
                  <td>{r.mode}</td>
                  <td>
                    <Link to={`/memo/${r.challanId}/view`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--orange)', textDecoration: 'none', fontWeight: 600 }}>
                      <Eye size={13} /> Preview
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 12, color: 'var(--text-muted)' }}>
        For money, settlement, and account details, go to <Link to="/firm-accounts" style={{ color: 'var(--orange)', fontWeight: 600 }}>Firm Accounts</Link> (admin PIN) or <Link to="/reports" style={{ color: 'var(--orange)', fontWeight: 600 }}>Reports</Link>.
      </div>
    </div>
  );
}
