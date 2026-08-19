import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Package, Truck, Building2, MapPin, User, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../db/database';
import { fmtCode } from '../utils/masterData';
import LRPreviewModal from './LRPreviewModal';
import { bsMatches } from '../utils/bsMatch';

interface SearchResult {
  type: 'challan' | 'bs' | 'firm' | 'station' | 'truck' | 'operator' | 'lr';
  label: string;
  sub: string;
  link: string;
  drId?: number; // for 'lr' results: which DR to preview
}

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

export default function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [lrPreview, setLrPreview] = useState<{ drId: number; kind: 'lr' | 'bs' } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (open) { setQuery(''); setResults([]); setTimeout(() => inputRef.current?.focus(), 50); }
  }, [open]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const search = async () => {
      const q = query.trim().toLowerCase();
      const qNum = q.replace(/^0+/, '');   // for code matching: "0027" -> "27"
      const out: SearchResult[] = [];

      // Firms (master data, coded) — match by name or code
      const firms = await db.masterData.where('field').equals('firmName').toArray();
      firms
        .filter(f => f.value.toLowerCase().includes(q) || (f.code != null && String(f.code).startsWith(qNum)))
        .slice(0, 5)
        .forEach(f => out.push({
          type: 'firm', label: f.value, sub: `Firm · ${fmtCode(f.code)}`,
          link: `/firm-accounts/${encodeURIComponent(f.value)}`,
        }));

      // Stations (master data, coded)
      const stations = await db.masterData.where('field').equals('loadingStation').toArray();
      stations
        .filter(s => s.value.toLowerCase().includes(q) || (s.code != null && String(s.code).startsWith(qNum)))
        .slice(0, 5)
        .forEach(s => out.push({
          type: 'station', label: s.value, sub: `Station · ${fmtCode(s.code)}`,
          link: `/info/station/${encodeURIComponent(s.value)}`,
        }));

      // Operators (coded)
      const ops = await db.operators.toArray();
      ops
        .filter(o => o.name.toLowerCase().includes(q) || (o.code != null && String(o.code).startsWith(qNum)))
        .slice(0, 5)
        .forEach(o => out.push({
          type: 'operator', label: o.name, sub: `Agent · ${fmtCode(o.code)}`,
          link: `/info/operator/${encodeURIComponent(o.name)}`,
        }));

      // Trucks (no code) — from master data
      const trucks = await db.masterData.where('field').equals('truckNumber').toArray();
      trucks
        .filter(t => t.value.toLowerCase().includes(q))
        .slice(0, 5)
        .forEach(t => out.push({
          type: 'truck', label: t.value, sub: 'Truck',
          link: `/info/truck/${encodeURIComponent(t.value)}`,
        }));

      // Challans by challan number
      const challans = await db.challans.filter(c =>
        !c.deletedAt && c.challanNumber.toLowerCase().includes(q)
      ).limit(5).toArray();
      challans.forEach(c => out.push({
        type: 'challan', label: `Challan #${c.challanNumber}`, sub: `${c.firmName} · ${c.truckNumber}`,
        link: `/info/challan/${encodeURIComponent(c.challanNumber)}`,
      }));

      // BS/LR numbers (DRs) — one ranked match across both identifiers, so an
      // exact LR hit outranks a BS number that merely shares the same digits
      // (previously BS and LR were separate, unranked queries with BS always
      // listed first — see bsMatch.ts for the shared scoring).
      const allDrs = await db.drs.filter(d => !d.deletedAt).toArray();
      bsMatches(allDrs, query, 5, true).forEach(d => {
        // ponytail: label by which field plainly contains the query — good enough since both rarely match the same DR.
        const isLr = !!d.lrNumber && d.lrNumber.toLowerCase().includes(q) && !d.drNumber.toLowerCase().includes(q);
        out.push(isLr
          ? { type: 'lr', label: `LR ${d.lrNumber}`, sub: `${d.consignee} · BS ${d.drNumber}`, link: '', drId: d.id }
          : { type: 'bs', label: `BS ${d.drNumber}`, sub: d.consignee, link: '', drId: d.id });
      });

      setResults(out);
    };
    const t = setTimeout(search, 150);
    return () => clearTimeout(t);
  }, [query]);

  if (!open) return null;

  const icons: Record<string, React.ReactNode> = {
    challan: <Truck size={14} />, bs: <Package size={14} />, firm: <Building2 size={14} />,
    station: <MapPin size={14} />, truck: <Truck size={14} />, operator: <User size={14} />,
    lr: <FileText size={14} />,
  };

  return (
    <div className="global-search-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="global-search-box">
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '0.5px solid var(--border)', gap: 10 }}>
          <Search size={18} color="var(--text-muted)" />
          <input
            ref={inputRef}
            style={{ flex: 1, border: 'none', outline: 'none', fontSize: 15, fontFamily: 'inherit', background: 'transparent', color: 'var(--text-primary)' }}
            placeholder="Firm, station, agent, truck, challan, BS no, or code..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && onClose()}
          />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>
        </div>
        {results.length > 0 ? (
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {results.map((r, i) => (
              <div
                key={i}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer', borderBottom: '0.5px solid var(--border-light)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--orange-light)')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
                onClick={() => {
                  if ((r.type === 'lr' || r.type === 'bs') && r.drId) { setLrPreview({ drId: r.drId, kind: r.type }); }
                  else { navigate(r.link); onClose(); }
                }}
              >
                <span style={{ color: 'var(--orange)', flexShrink: 0 }}>{icons[r.type]}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>{r.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.sub}</div>
                </div>
              </div>
            ))}
          </div>
        ) : query ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No results — "{query}"</div>
        ) : (
          <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: 12 }}>Type a firm, station, agent, or truck name/code, or a challan/BS/LR number...</div>
        )}
      </div>

      {lrPreview != null && (
        <LRPreviewModal drId={lrPreview.drId} heading={lrPreview.kind} onClose={() => { setLrPreview(null); onClose(); }} />
      )}
    </div>
  );
}
