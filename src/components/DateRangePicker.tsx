import { todayISO } from '../utils/reportUtils';
import type { DateRange } from '../utils/dateRange';

/**
 * DateRangePicker — a reusable from/to date range with quick-pick chips
 * (Today, This week, This month, All). Drop into any report or filter.
 *
 * "All" sets an empty range (from='' to=''), meaning no date filtering.
 * The parent owns the from/to state and passes setters; this component is
 * presentational so the same range can drive a preview, a print, and a PDF.
 *
 * Helpers (inRange, the DateRange type) live in ../utils/dateRange so this file
 * only exports a component (React Fast Refresh requirement).
 */

function startOfWeekISO(): string {
  const d = new Date();
  const day = d.getDay();            // 0=Sun..6=Sat
  const diff = (day + 6) % 7;        // days since Monday
  d.setDate(d.getDate() - diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
  /** Optional label above the control. */
  label?: string;
}

export default function DateRangePicker({ value, onChange, label }: Props) {
  const today = todayISO();

  const chips: { id: string; label: string; range: DateRange }[] = [
    { id: 'today', label: 'Today', range: { from: today, to: today } },
    { id: 'week', label: 'This week', range: { from: startOfWeekISO(), to: today } },
    { id: 'month', label: 'This month', range: { from: startOfMonthISO(), to: today } },
    { id: 'all', label: 'All', range: { from: '', to: '' } },
  ];

  // Which chip (if any) matches the current value, for highlighting.
  const activeChip = chips.find(c => c.range.from === value.from && c.range.to === value.to)?.id || '';

  const chipStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 12, padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
    border: '0.5px solid ' + (active ? 'var(--orange)' : 'var(--border)'),
    background: active ? 'var(--orange)' : 'var(--card)',
    color: active ? '#fff' : 'var(--text-secondary)', fontWeight: active ? 600 : 500,
  });

  return (
    <div>
      {label && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>{label}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input type="date" className="form-input" style={{ flex: 1 }} value={value.from}
          max={value.to || today}
          onChange={e => onChange({ ...value, from: e.target.value })} />
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>to</span>
        <input type="date" className="form-input" style={{ flex: 1 }} value={value.to}
          min={value.from || undefined} max={today}
          onChange={e => onChange({ ...value, to: e.target.value })} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {chips.map(c => (
          <span key={c.id} style={chipStyle(activeChip === c.id)} onClick={() => onChange(c.range)}>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
