import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import { Printer } from 'lucide-react';
import { db } from '../db/database';
import type { FirmLedger } from '../db/database';
import { formatINR, formatDate } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';

const PAGE_SIZE = 20;

/**
 * The real settlement history for a firm — actual payments made or received,
 * and manual adjustments — separate from the memo-wise breakdown (which shows
 * every memo's numbers, settled or not). This page answers "when did money
 * actually move, and how much", chronologically, with a printable record.
 */
export default function FirmSettledRecords() {
  const { firmName: rawName } = useParams();
  const firmName = decodeURIComponent(rawName || '');
  const [rows, setRows] = useState<FirmLedger[]>([]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const printRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    // Settlement/adjustment rows only — challanId 0 marks a non-memo cash movement.
    const all = await db.firmLedger.where('firmName').equals(firmName).filter(e => e.challanId === 0).sortBy('id');
    setRows(all.reverse());
  };
  useEffect(() => { load(); }, [firmName]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => rows.filter(r => {
    if (dateFrom && r.entryDate < dateFrom) return false;
    if (dateTo && r.entryDate > dateTo) return false;
    return true;
  }), [rows, dateFrom, dateTo]);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [dateFrom, dateTo]);

  const totalGiven = filtered.filter(r => r.type === 'debit').reduce((s, r) => s + r.amount, 0);
  const totalReceived = filtered.filter(r => r.type === 'credit').reduce((s, r) => s + r.amount, 0);

  const handlePrint = useReactToPrint({ contentRef: printRef, documentTitle: `${firmName} — Settled Records` });

  return (
    <div>
      <PageHeader showBack backFallback={`/firm-accounts/${encodeURIComponent(firmName)}`} onRefresh={load}
        title="Settled Records" subtitle={firmName} />

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="form-input" type="date" style={{ width: 160 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>to</span>
        <input className="form-input" type="date" style={{ width: 160 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
        {(dateFrom || dateTo) && <button className="btn btn-ghost btn-sm" onClick={() => { setDateFrom(''); setDateTo(''); }}>Reset dates</button>}
        <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} onClick={handlePrint}><Printer size={14} /> Print report</button>
      </div>

      <div className="totals-bar" style={{ marginBottom: 16 }}>
        <div className="totals-item"><span className="totals-label">Entries:</span><span className="totals-value white">{filtered.length}</span></div>
        <div className="totals-item"><span className="totals-label">Given to firm:</span><span className="totals-value white">{formatINR(totalGiven)}</span></div>
        <div className="totals-item"><span className="totals-label">Received from firm:</span><span className="totals-value white">{formatINR(totalReceived)}</span></div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>📒</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>No settlements recorded yet</div>
          <div style={{ fontSize: 13 }}>Recorded settlements and manual adjustments will appear here</div>
        </div>
      ) : (
        <>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Date</th><th>Type</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
              <tbody>
                {filtered.slice(0, visibleCount).map(r => (
                  <tr key={r.id}>
                    <td>{formatDate(r.entryDate)}</td>
                    <td style={{ textTransform: 'capitalize' }}>{r.category}</td>
                    <td style={{ fontSize: 12 }}>{r.description}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.type === 'debit' ? '#854F0B' : '#3B6D11' }}>
                      {r.type === 'debit' ? '+' : '−'} {formatINR(r.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length > visibleCount && (
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
                Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} — Load more
              </button>
            </div>
          )}
        </>
      )}

      {/* Printable version — full filtered list, not just what's currently visible on screen */}
      <div style={{ display: 'none' }}>
        <div ref={printRef} style={{ padding: 24, fontFamily: 'Georgia, serif' }}>
          <h2 style={{ marginBottom: 4 }}>{firmName} — Settled Records</h2>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 16 }}>
            {dateFrom || dateTo ? `${dateFrom ? formatDate(dateFrom) : 'start'} to ${dateTo ? formatDate(dateTo) : 'today'}` : 'All dates'}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #000' }}>
                <th style={{ textAlign: 'left', padding: 4 }}>Date</th><th style={{ textAlign: 'left', padding: 4 }}>Type</th>
                <th style={{ textAlign: 'left', padding: 4 }}>Description</th><th style={{ textAlign: 'right', padding: 4 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} style={{ borderBottom: '0.5px solid #ccc' }}>
                  <td style={{ padding: 4 }}>{formatDate(r.entryDate)}</td>
                  <td style={{ padding: 4, textTransform: 'capitalize' }}>{r.category}</td>
                  <td style={{ padding: 4 }}>{r.description}</td>
                  <td style={{ padding: 4, textAlign: 'right' }}>{r.type === 'debit' ? '+' : '−'} {formatINR(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 16, fontSize: 12 }}>
            Given to firm: {formatINR(totalGiven)} &nbsp;·&nbsp; Received from firm: {formatINR(totalReceived)}
          </div>
        </div>
      </div>
    </div>
  );
}
