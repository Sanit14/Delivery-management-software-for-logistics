import { useEffect, useState, useRef } from 'react';
import { FileDown, FileSpreadsheet, Play, X, Pencil, Trash2, Printer, Plus } from 'lucide-react';
import { db, recomputeFirmLedger, buildChallanSummaryRow, syncChallanTotals } from '../db/database';
import type { Operator, DR, Challan } from '../db/database';
import { formatINR, formatINRPdf, formatDate, todayISO, currentMonthISO, generatePDF, generateCSV } from '../utils/reportUtils';
import FirmSummaryPrint, { type FirmSummaryData, type FirmSummaryRow, type FirmSummaryOverrides } from '../components/FirmSummaryPrint';
import { computeFirmSettlement } from '../utils/firmSettlement';
import GenericReportPrint from '../components/GenericReportPrint';
import { useReactToPrint } from 'react-to-print';
import PageHeader from '../components/PageHeader';
import AutoCompleteInput from '../components/AutoCompleteInput';
import ConfirmModal from '../components/ConfirmModal';
import { COMPANY_NAME } from '../constants/company';
import PinModal from '../components/PinModal';
import DREditModal from '../components/DREditModal';
import AgentWasuliReportView from '../components/AgentWasuliReportView';
import { useToast } from '../context/ToastContext';
import { useAdmin } from '../context/AdminContext';

const REPORTS = [
  { id: 'firm', name: 'Firm Report' },
  { id: 'station', name: 'Station Report' },
  { id: 'truck', name: 'Truck Report' },
  { id: 'agentWasuli', name: 'Agent Wasuli Report' },
  { id: 'paymode', name: 'Payment Mode' },
  { id: 'daily', name: 'Daily Summary' },
  { id: 'monthly', name: 'Monthly Summary' },
];

type SourceType = 'dr' | 'lrEntry';

// rows carry hidden __src/__id so the preview can offer edit/delete on the real record
type ReportRow = Record<string, string | number> & { __src?: SourceType; __id?: number };

interface Generated {
  columns: string[];
  rows: ReportRow[];
  summaryRow?: Record<string, string | number>;
  filterText: string;
  landscape: boolean;
  panels?: { label: string; value: string }[];
}

const PAGE_SIZE = 50;

export default function Reports() {
  const { showToast } = useToast();
  const { isAdmin, unlock } = useAdmin();
  const [active, setActive] = useState('firm');
  const [operators, setOperators] = useState<Operator[]>([]);
  const [gen, setGen] = useState<Generated | null>(null);
  const [page, setPage] = useState(0);
  // edit/delete on report rows (admin)
  const [editDR, setEditDR] = useState<DR | null>(null);
  const [deleteRow, setDeleteRow] = useState<{ src: SourceType; id: number; label: string } | null>(null);
  const [adminAction, setAdminAction] = useState<(() => void) | null>(null);

  // Firm settlement summary (dedicated — separate from generic report pipeline)
  const [firmSummary, setFirmSummary] = useState<FirmSummaryData | null>(null);
  // One-time charges the company adds to THIS generated printout only. Held in
  // state, never written to the database (no double-count with per-challan
  // ledger adjustments). Cleared whenever a new report is generated.
  const [firmAdjustments, setFirmAdjustments] = useState<{ label: string; amount: number; sign: 1 | -1 }[]>([]);
  // Print-only overrides for the base settlement rows (Total Amount, Truck Hire,
  // Door Delivery, Crossing, Delivery Chrgs, PF, Refund) — same one-time-charge
  // rule as firmAdjustments: never written to the database, cleared on regenerate.
  const [firmOverrides, setFirmOverrides] = useState<FirmSummaryOverrides>({});
  const firmPrintRef = useRef<HTMLDivElement>(null);
  const printFirmSummary = useReactToPrint({ contentRef: firmPrintRef, documentTitle: 'Firm Settlement Summary' });

  const genPrintRef = useRef<HTMLDivElement>(null);
  const printReport = useReactToPrint({ contentRef: genPrintRef, documentTitle: 'Report' });

  const requireAdmin = (action: () => void) => { if (isAdmin) action(); else setAdminAction(() => action); };

  // filters
  const [firmName, setFirmName] = useState('');
  const [station, setStation] = useState('');
  const [truck, setTruck] = useState('');
  const [mode, setMode] = useState('topay');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [singleDate, setSingleDate] = useState(todayISO());
  const [month, setMonth] = useState(currentMonthISO());

  useEffect(() => { db.operators.toArray().then(setOperators); }, []);

  const switchReport = (id: string) => {
    setActive(id);
    setGen(null);
    setFirmSummary(null);
    setPage(0);
  };

  const clearAll = () => {
    setFirmName(''); setStation(''); setTruck('');
    setDateFrom(''); setDateTo('');
    setSingleDate(todayISO()); setMonth(currentMonthISO());
    setGen(null); setFirmSummary(null); setPage(0);
    setFirmAdjustments([]); setFirmOverrides({});
  };

  const inRange = (d: string) => (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);
  const rangeText = dateFrom || dateTo ? `${formatDate(dateFrom) || '...'} to ${formatDate(dateTo) || 'today'}` : 'All dates';
  const modeLabel = (m: string) => m === 'topay' ? 'ToPay' : m === 'paid' ? 'Paid' : m === 'charges' ? 'Charges' : m === 'none' ? '—' : '—';

  // a challan counts only if it's not soft-deleted and not cancelled
  const liveChallans = async () => (await db.challans.toArray()).filter(c => !c.deletedAt && c.status !== 'cancelled');

  // Build challan-level summary rows (one row per challan): date, challan, firm, truck, station,
  // total packages, mode, total. No LR/goods/consignee detail — "which trucks arrived, how many packages, how much money".
  // A challan's "mode" = the dominant mode of its entries (mixed → "Mixed").
  const buildChallanSummary = async (
    challans: Challan[],
    opts: { showFirm?: boolean; showTruck?: boolean; showStation?: boolean } = { showFirm: true, showTruck: true, showStation: true }
  ) => {
    const cIds = challans.map(c => c.id!);
    const entries = await db.lrEntries.where('challanId').anyOf(cIds).filter(e => e.status === 'active' && !e.deletedAt).toArray();
    const byChallan = new Map<number, typeof entries>();
    for (const e of entries) {
      if (!byChallan.has(e.challanId)) byChallan.set(e.challanId, []);
      byChallan.get(e.challanId)!.push(e);
    }
    const sorted = [...challans].sort((a, b) => a.entryDate.localeCompare(b.entryDate) || (a.id || 0) - (b.id || 0));
    const rows: ReportRow[] = sorted.map(c => {
      const es = byChallan.get(c.id!) || [];
      const pkgs = es.reduce((s, e) => s + (e.quantity || 0), 0);
      const total = es.reduce((s, e) => s + e.total, 0);
      // dominant mode
      const modeCount: Record<string, number> = {};
      es.forEach(e => { modeCount[e.paymentMode] = (modeCount[e.paymentMode] || 0) + 1; });
      const distinct = Object.keys(modeCount);
      const mode = distinct.length === 0 ? '—' : distinct.length === 1 ? modeLabel(distinct[0]) : 'Mixed';
      const row: ReportRow = {
        'Date': formatDate(c.entryDate),
        'Challan No.': c.challanNumber,
        'Pkgs': pkgs,
        'Mode': mode,
        'Total': total,
      };
      if (opts.showFirm) row['Firm'] = c.firmName;
      if (opts.showTruck) row['Truck No.'] = c.truckNumber;
      if (opts.showStation) row['Station'] = c.loadingStation;
      return row;
    });
    const colOrder = ['Date', 'Challan No.', ...(opts.showFirm ? ['Firm'] : []), ...(opts.showTruck ? ['Truck No.'] : []), ...(opts.showStation ? ['Station'] : []), 'Pkgs', 'Mode', 'Total'];
    const totalPkgs = rows.reduce((s, r) => s + Number(r['Pkgs']), 0);
    const totalAmt = rows.reduce((s, r) => s + Number(r['Total']), 0);
    return { rows, colOrder, totalPkgs, totalAmt };
  };



  const generate = async () => {
    let g: Generated | null = null;

    if (active === 'firm') {
      if (!firmName.trim()) { showToast('Firm name is required', 'error'); return; }
      const q = firmName.trim().toLowerCase();
      // Case-insensitive + partial match so "ashok" finds "Ashok Industry".
      // No date range = all dates (inRange returns true when dates are empty).
      const challans = (await liveChallans())
        .filter(c => c.firmName.toLowerCase().includes(q) && inRange(c.entryDate))
        .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || (a.id || 0) - (b.id || 0));

      if (challans.length === 0) {
        // Distinguish "firm doesn't exist" from "exists but not in this date range"
        const anyForFirm = (await liveChallans()).some(c => c.firmName.toLowerCase().includes(q));
        if (anyForFirm) {
          showToast('This firm has memos, but not in this date range. Clear or change the date.', 'error');
        } else {
          showToast(`No firm or memo found named "${firmName.trim()}"`, 'error');
        }
        setFirmSummary(null);
        return;
      }

      // Sum each challan's LR entries — same shared calculation the single-challan
      // report uses, so the two can never quietly drift apart from each other.
      const rows: FirmSummaryRow[] = await Promise.all(challans.map(buildChallanSummaryRow));

      // dcPercent is DISPLAY-ONLY now (the "(X%)" text) — the actual amount deducted
      // (dcAmount) is computed per challan in buildChallanSummaryRow and summed, so a
      // rate change mid-range no longer misapplies one challan's % to the whole batch.
      const dcPercent = challans[0]?.deliveryCharges || 0;

      // Charges saved against a challan from its Challan-wise Report (Edit charges)
      // — category:'adjustment' ledger rows. Read-only here, traceable to their
      // challan, and distinct from the one-time charges below (never saved).
      const savedRows = await db.firmLedger.where('challanId').anyOf(challans.map(c => c.id!))
        .filter(r => r.category === 'adjustment').toArray();
      const savedAdjustmentLines = savedRows.map(r => ({
        challanNumber: r.challanNumber, label: r.description,
        amount: r.amount, sign: (r.type === 'debit' ? 1 : -1) as 1 | -1,
      }));

      setFirmSummary({
        firmName: challans[0].firmName,
        companyName: COMPANY_NAME,
        dateFrom, dateTo, rows, dcPercent, savedAdjustmentLines,
      });
      setFirmAdjustments([]); setFirmOverrides({}); // fresh report — no carried-over one-time charges
      setGen(null);
      setPage(0);
      return;
    }

    if (active === 'station') {
      if (!station.trim()) { showToast('Station is required', 'error'); return; }
      const challans = (await liveChallans()).filter(c => c.loadingStation.toLowerCase().includes(station.trim().toLowerCase()) && inRange(c.entryDate));
      const { rows, colOrder, totalPkgs, totalAmt } = await buildChallanSummary(challans, { showFirm: true, showTruck: true, showStation: false });
      g = {
        columns: colOrder,
        rows,
        summaryRow: { 'Date': `${rows.length} trucks`, 'Pkgs': totalPkgs, 'Total': totalAmt },
        filterText: `Station: ${station} | ${rangeText}`,
        landscape: false,
        panels: [
          { label: 'Trucks', value: String(rows.length) },
          { label: 'Total Packages', value: String(totalPkgs) },
          { label: 'Total Amount', value: formatINR(totalAmt) },
        ],
      };
    }

    if (active === 'truck') {
      if (!truck.trim()) { showToast('Truck number is required', 'error'); return; }
      const challans = (await liveChallans()).filter(c => c.truckNumber.toLowerCase().includes(truck.trim().toLowerCase()) && inRange(c.entryDate));
      const { rows, colOrder, totalPkgs, totalAmt } = await buildChallanSummary(challans, { showFirm: true, showTruck: false, showStation: true });
      g = {
        columns: colOrder,
        rows,
        summaryRow: { 'Date': `${rows.length} trips`, 'Pkgs': totalPkgs, 'Total': totalAmt },
        filterText: `Truck: ${truck} | ${rangeText}`,
        landscape: false,
        panels: [
          { label: 'Kitni Trips', value: String(rows.length) },
          { label: 'Total Packages', value: String(totalPkgs) },
          { label: 'Total Amount', value: formatINR(totalAmt) },
        ],
      };
    }

    if (active === 'paymode') {
      const liveIds = new Set((await liveChallans()).map(c => c.id!));
      const entries = (await db.lrEntries.where('paymentMode').equals(mode).filter(e => e.status === 'active' && !e.deletedAt && liveIds.has(e.challanId)).toArray());
      const challanIds = Array.from(new Set(entries.map(e => e.challanId)));
      const challans = await db.challans.where('id').anyOf(challanIds).toArray();
      const cMap = new Map(challans.map(c => [c.id!, c]));
      const wasuliAll = mode !== 'paid' ? await db.wasuli.filter(w => !w.deletedAt).toArray() : [];
      const wMap = new Map(wasuliAll.map(w => [w.lrEntryId, w]));
      const inDateRange = entries.filter(e => inRange(cMap.get(e.challanId)?.entryDate || ''));
      const extraCol = mode === 'topay';
      const rows: ReportRow[] = inDateRange.map(e => {
        const c = cMap.get(e.challanId);
        const base: ReportRow = {
          'Challan No.': e.challanNumber, 'LR No.': e.lrNumber, 'Date': formatDate(c?.entryDate || ''),
          'Firm': c?.firmName || '', 'Consignee': e.consignee, 'Station': c?.loadingStation || '',
          'Total': e.total, 'Status': e.status,
          __src: 'lrEntry', __id: e.id!,
        };
        if (extraCol) base['Wasuli Status'] = wMap.has(e.id!) ? (wMap.get(e.id!)!.operatorId ? 'Assigned' : 'Not Assigned') : 'Not Assigned';
        return base;
      });
      const cols = ['Challan No.', 'LR No.', 'Date', 'Firm', 'Consignee', 'Station', 'Total', 'Status'];
      if (extraCol) cols.push('Wasuli Status');
      g = {
        columns: cols,
        rows,
        summaryRow: { 'Challan No.': `${rows.length} entries`, 'Total': rows.reduce((s, r) => s + Number(r['Total']), 0) },
        filterText: `Mode: ${modeLabel(mode)} | ${rangeText}`,
        landscape: true,
      };
    }

    if (active === 'daily') {
      const challans = (await liveChallans()).filter(c => c.entryDate === singleDate);
      const { rows, colOrder, totalPkgs, totalAmt } = await buildChallanSummary(challans, { showFirm: true, showTruck: true, showStation: true });
      const wasuliToday = await db.wasuli.filter(w => w.status === 'collected' && w.collectedDate === singleDate && !w.deletedAt).toArray();
      const pendingW = await db.wasuli.where('status').equals('pending').filter(w => !w.deletedAt).toArray();
      const collectedToday = wasuliToday.reduce((s, w) => s + (w.collectedAmount || 0), 0);
      const pendingTotal = pendingW.reduce((s, w) => s + w.amountToCollect, 0);
      g = {
        columns: colOrder,
        rows,
        summaryRow: { 'Date': `${rows.length} trucks`, 'Pkgs': totalPkgs, 'Total': totalAmt },
        filterText: `Date: ${formatDate(singleDate)} | ${rows.length} trucks, ${totalPkgs} packages`,
        landscape: false,
        panels: [
          { label: 'Trucks arrived', value: String(rows.length) },
          { label: 'Total Packages', value: String(totalPkgs) },
          { label: 'Total Value', value: formatINR(totalAmt) },
          { label: 'Collected today', value: formatINR(collectedToday) },
          { label: 'Pending Wasuli', value: formatINR(pendingTotal) },
        ],
      };
    }

    if (active === 'monthly') {
      const challans = (await liveChallans()).filter(c => c.entryDate.startsWith(month));
      const { rows, colOrder, totalPkgs, totalAmt } = await buildChallanSummary(challans, { showFirm: true, showTruck: true, showStation: true });
      g = {
        columns: colOrder,
        rows,
        summaryRow: { 'Date': `${rows.length} trucks`, 'Pkgs': totalPkgs, 'Total': totalAmt },
        filterText: `Month: ${month} | ${rows.length} trucks, ${totalPkgs} packages, ${formatINRPdf(totalAmt)}`,
        landscape: false,
        panels: [
          { label: 'Total trucks (month)', value: String(rows.length) },
          { label: 'Total Packages', value: String(totalPkgs) },
          { label: 'Total Revenue', value: formatINR(totalAmt) },
        ],
      };
    }

    if (g) {
      setGen(g);
      setPage(0);
      if (g.rows.length === 0) showToast('No entries found for these filters', 'info');
    }
  };

  const activeName = REPORTS.find(r => r.id === active)?.name || '';

  const downloadPDF = async () => {
    if (!gen) return;
    const result = await generatePDF({
      reportName: activeName,
      filters: gen.filterText,
      columns: gen.columns,
      rows: gen.rows.map(r => {
        const out: Record<string, string | number> = {};
        for (const c of gen.columns) {
          const v = r[c];
          out[c] = typeof v === 'number' && ['Total', 'Freight', 'Cartage', 'Hamali', 'G.Bhada', 'GDN Insu', 'Dly Chg', 'Amount', 'Assigned ₹', 'Collected ₹'].includes(c) ? formatINRPdf(v) : (v ?? '');
        }
        return out;
      }),
      summaryRow: gen.summaryRow ? Object.fromEntries(gen.columns.map(c => {
        const v = gen.summaryRow![c];
        const isMoney = ['Total', 'Freight', 'Cartage', 'Hamali', 'G.Bhada', 'GDN Insu', 'Dly Chg', 'Amount', 'Assigned ₹', 'Collected ₹'].includes(c);
        return [c, typeof v === 'number' && isMoney ? formatINRPdf(v) : (v ?? '')];
      })) : undefined,
      landscape: gen.landscape,
    });
    if (result.ok) showToast(`Saved to ${result.path}`, 'success');
    else showToast("Shared folder not reachable — file saved to your computer's Downloads folder", 'warning');
  };

  const downloadCSV = async () => {
    if (!gen) return;
    const result = await generateCSV({
      reportName: activeName,
      filters: gen.filterText,
      columns: gen.columns,
      rows: gen.rows,
      landscape: gen.landscape,
    });
    if (result.ok) showToast(`Saved to ${result.path}`, 'success');
    else showToast("Shared folder not reachable — file saved to your computer's Downloads folder", 'warning');
  };

  // Open the edit modal for a report row's source record. Only 'dr' rows have
  // an edit path here — lrEntry corrections belong in ChallanDetail instead.
  const openEditRow = async (row: ReportRow) => {
    if (row.__src === 'dr') {
      const d = await db.drs.get(row.__id!);
      if (d) setEditDR(d);
    }
  };

  // soft-delete a report row's source record + recompute ledger where relevant
  const doDeleteRow = async () => {
    if (!deleteRow) return;
    const now = new Date().toISOString();
    if (deleteRow.src === 'dr') {
      const d = await db.drs.get(deleteRow.id);
      await db.drs.update(deleteRow.id, { deletedAt: now });
      if (d) await recomputeFirmLedger(d.firmName);
    } else if (deleteRow.src === 'lrEntry') {
      const e = await db.lrEntries.get(deleteRow.id);
      await db.lrEntries.update(deleteRow.id, { deletedAt: now, status: 'cancelled' });
      if (e) {
        const linkedDr = await db.drs.where('lrEntryId').equals(deleteRow.id).first();
        if (linkedDr) await db.drs.update(linkedDr.id!, { deletedAt: now });
        const linkedW = await db.wasuli.where('lrEntryId').equals(deleteRow.id).first();
        if (linkedW) await db.wasuli.update(linkedW.id!, { deletedAt: now });
        const c = await db.challans.get(e.challanId);
        if (c) {
          await recomputeFirmLedger(c.firmName);
          await syncChallanTotals(e.challanId);
        }
      }
    }
    showToast('Deleted', 'info');
    setDeleteRow(null);
    generate();
  };

  const afterRecordSaved = (result?: 'ok' | 'locked' | 'stale') => {
    if (result === 'stale') {
      showToast('Someone else just changed this record — the report is refreshing, edit again', 'error');
    } else if (result === 'locked') {
      showToast('Wasuli is already assigned to an agent — it cannot be edited now', 'error');
    } else {
      showToast('Updated', 'success');
    }
    setEditDR(null);
    generate();
  };

  const totalPages = gen ? Math.max(1, Math.ceil(gen.rows.length / PAGE_SIZE)) : 1;
  const pageRows = gen ? gen.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : [];
  const moneyCols = ['Total', 'Freight', 'Amount', 'Assigned ₹', 'Collected ₹'];

  return (
    <div>
      <PageHeader showBack onRefresh={() => db.operators.toArray().then(setOperators)} title="Reports" subtitle="Download PDF and CSV" />

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* Report list */}
        <div className="card" style={{ width: 200, flexShrink: 0, padding: '8px 0' }}>
          {REPORTS.map((r, i) => (
            <div
              key={r.id}
              onClick={() => switchReport(r.id)}
              style={{
                padding: '10px 14px', fontSize: 13, cursor: 'pointer',
                fontWeight: active === r.id ? 600 : 500,
                color: active === r.id ? 'var(--orange)' : 'var(--text-secondary)',
                background: active === r.id ? 'var(--orange-light)' : 'transparent',
                borderLeft: active === r.id ? '2px solid var(--orange)' : '2px solid transparent',
              }}
            >
              {i + 1}. {r.name}
            </div>
          ))}
        </div>

        {/* Right side */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Agent Wasuli Report is fully self-contained (its own agent/status/date
              controls, its own Print/PDF/CSV) — it doesn't use the generic
              filter card + Generate Report flow below at all. */}
          {active === 'agentWasuli' && <AgentWasuliReportView operators={operators} />}

          {active !== 'agentWasuli' && (
            <>
              {/* Filters */}
              <div className="card" style={{ padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  {active === 'firm' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 240 }}>
                      <label className="form-label req">Firm Name</label>
                      <AutoCompleteInput field="firmName" value={firmName} onChange={setFirmName} placeholder="Search firm..." />
                    </div>
                  )}
                  {active === 'station' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 240 }}>
                      <label className="form-label req">Loading Station</label>
                      <AutoCompleteInput field="loadingStation" value={station} onChange={setStation} placeholder="Station..." />
                    </div>
                  )}
                  {active === 'truck' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 240 }}>
                      <label className="form-label req">Truck Number</label>
                      <AutoCompleteInput field="truckNumber" value={truck} onChange={setTruck} placeholder="MH-31-..." />
                    </div>
                  )}
                  {active === 'firm' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 160, alignSelf: 'flex-end' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, paddingBottom: 8 }}>
                        Choose a custom date range below (empty = all memos)
                      </div>
                    </div>
                  )}
                  {active === 'paymode' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 160 }}>
                      <label className="form-label req">Mode</label>
                      <select className="form-select" value={mode} onChange={e => setMode(e.target.value)}>
                        <option value="topay">ToPay</option>
                        <option value="paid">Paid</option>
                      </select>
                    </div>
                  )}
                  {active === 'daily' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 180 }}>
                      <label className="form-label req">Date</label>
                      <input className="form-input" type="date" value={singleDate} onChange={e => setSingleDate(e.target.value)} />
                    </div>
                  )}
                  {active === 'monthly' && (
                    <div className="form-group" style={{ marginBottom: 0, width: 180 }}>
                      <label className="form-label req">Month</label>
                      <input className="form-input" type="month" value={month} onChange={e => setMonth(e.target.value)} />
                    </div>
                  )}
                  {!['daily', 'monthly'].includes(active) && (
                    <>
                      <div className="form-group" style={{ marginBottom: 0, width: 160 }}>
                        <label className="form-label">From</label>
                        <input className="form-input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                      </div>
                      <div className="form-group" style={{ marginBottom: 0, width: 160 }}>
                        <label className="form-label">To</label>
                        <input className="form-input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                      </div>
                    </>
                  )}
                  <button className="btn btn-primary" onClick={generate}><Play size={15} /> Generate Report</button>
                  <button className="btn btn-ghost" onClick={clearAll}><X size={15} /> Clear</button>
                </div>
              </div>

              {/* Firm Settlement Summary (dedicated view) */}
              {active === 'firm' && firmSummary && (
                <FirmSummaryView data={firmSummary} adjustments={firmAdjustments} onAdjustmentsChange={setFirmAdjustments}
                  overrides={firmOverrides} onOverridesChange={setFirmOverrides} onPrint={printFirmSummary} onPdf={async () => {
                    const s = computeFirmSettlement({ ...firmSummary, adjustmentLines: firmAdjustments, overrides: firmOverrides });
                    const cols = ['Date', 'Challan No.', 'Truck No.', 'Station', 'ToPay', 'Paid', 'Dly Chg (Local)', 'Crossing', 'Door', 'Truck Hire', 'PF', 'Refund'];
                    const result = await generatePDF({
                      reportName: `Firm Settlement — ${firmSummary.firmName}`,
                      filters: `${firmSummary.dateFrom || '…'} to ${firmSummary.dateTo || '…'}  ·  D.C. ${firmSummary.dcPercent}%`,
                      columns: cols,
                      rows: firmSummary.rows.map(r => ({
                        'Date': formatDate(r.date), 'Challan No.': r.challanNumber, 'Truck No.': r.truckNumber, 'Station': r.loadingStation,
                        'ToPay': formatINRPdf(r.toPay), 'Paid': formatINRPdf(r.paid), 'Dly Chg (Local)': formatINRPdf(r.deliveryCharges),
                        'Crossing': formatINRPdf(r.crossing), 'Door': formatINRPdf(r.doorDelivery), 'Truck Hire': formatINRPdf(r.truckHire),
                        'PF': formatINRPdf(r.pf), 'Refund': formatINRPdf(r.refund),
                      })),
                      summaryRow: { 'Date': 'TOTAL', 'ToPay': formatINRPdf(s.raw.toPay), 'Paid': formatINRPdf(s.raw.paid), 'Refund': `Final: ${formatINRPdf(s.roundFigure)}` },
                      landscape: true,
                    });
                    if (result.ok) showToast(`Saved to ${result.path}`, 'success');
                    else showToast("Shared folder not reachable — file saved to your computer's Downloads folder", 'warning');
                  }} />
              )}

              {/* Summary panels */}
              {gen?.panels && gen.panels.length > 0 && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                  {gen.panels.map(p => (
                    <div key={p.label} className="stat-card" style={{ padding: 12, minWidth: 150 }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--navy)' }}>{p.value}</div>
                      <div className="stat-label">{p.label}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Preview */}
              {gen && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)' }}>
                      {activeName} — {gen.rows.length} rows
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-outline btn-sm" onClick={printReport}><Printer size={14} /> Print</button>
                      <button className="btn btn-secondary btn-sm" onClick={downloadPDF}><FileDown size={14} /> Download PDF</button>
                      <button className="btn btn-outline btn-sm" onClick={downloadCSV}><FileSpreadsheet size={14} /> Download CSV</button>
                    </div>
                  </div>

                  {gen.rows.length > 0 && (
                    <div className="table-wrap" style={{ overflowX: 'auto' }}>
                      <table className="data-table table-compact">
                        <thead>
                          <tr>{gen.columns.map(c => <th key={c}>{c}</th>)}<th>Actions</th></tr>
                        </thead>
                        <tbody>
                          {pageRows.map((r, i) => (
                            <tr key={i}>
                              {gen.columns.map(c => (
                                <td key={c} className={moneyCols.includes(c) ? 'td-orange' : ''}>
                                  {typeof r[c] === 'number' && moneyCols.concat(['Cartage', 'Hamali', 'G.Bhada', 'GDN Insu', 'Dly Chg']).includes(c) ? formatINR(r[c] as number) : r[c]}
                                </td>
                              ))}
                              <td>
                                {r.__src && (
                                  <div style={{ display: 'flex', gap: 4 }}>
                                    {r.__src !== 'lrEntry' && (
                                      <button title="Edit (Admin)" className="btn-icon btn-icon-edit" onClick={() => requireAdmin(() => openEditRow(r))}><Pencil /></button>
                                    )}
                                    <button title="Delete (Admin)" className="btn-icon btn-icon-delete" onClick={() => requireAdmin(() => setDeleteRow({ src: r.__src!, id: r.__id!, label: String(r[gen.columns[1]] ?? r[gen.columns[0]] ?? '') }))}><Trash2 /></button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                          {gen.summaryRow && page === totalPages - 1 && (
                            <tr style={{ background: 'var(--orange-light)' }}>
                              {gen.columns.map(c => {
                                const v = gen.summaryRow![c];
                                const isMoney = moneyCols.concat(['Cartage', 'Hamali', 'G.Bhada', 'GDN Insu', 'Dly Chg']).includes(c);
                                return (
                                  <td key={c} style={{ fontWeight: 700, color: 'var(--orange)' }}>
                                    {typeof v === 'number' && isMoney ? formatINR(v) : v ?? ''}
                                  </td>
                                );
                              })}
                              <td />
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {totalPages > 1 && (
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', marginTop: 12 }}>
                      <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Previous</button>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {page + 1} of {totalPages}</span>
                      <button className="btn btn-ghost btn-sm" disabled={page === totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
                    </div>
                  )}
                </>
              )}

              {!gen && !(active === 'firm' && firmSummary) && (
                <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: 40, marginBottom: 8, opacity: 0.3 }}>📊</div>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>Select a report, set filters</div>
                  <div style={{ fontSize: 13 }}>Then press "Generate Report"</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Admin PIN gate for report edit/delete */}
      {adminAction && (
        <PinModal
          title="Admin PIN Required"
          checkPin={unlock}
          onSuccess={() => { const a = adminAction; setAdminAction(null); a(); }}
          onCancel={() => setAdminAction(null)}
        />
      )}

      {editDR && (
        <DREditModal dr={editDR} onSaved={afterRecordSaved} onClose={() => setEditDR(null)} />
      )}

      {deleteRow && (
        <ConfirmModal
          title="Delete this record?"
          body={<><b>{deleteRow.label}</b> will be deleted. It can be restored from History within 90 days.</>}
          confirmLabel="Yes, delete"
          onConfirm={doDeleteRow}
          onCancel={() => setDeleteRow(null)}
          danger
        />
      )}

      {/* Hidden print area for firm settlement summary */}
      <div style={{ display: 'none' }}>
        {firmSummary && <FirmSummaryPrint ref={firmPrintRef} data={{ ...firmSummary, adjustmentLines: firmAdjustments, overrides: firmOverrides }} />}
        {gen && (
          <GenericReportPrint
            ref={genPrintRef}
            title={activeName}
            filterText={gen.filterText}
            columns={gen.columns}
            rows={gen.rows}
            summaryRow={gen.summaryRow}
            landscape={gen.landscape}
          />
        )}
      </div>
    </div>
  );
}

// ── On-screen Firm Settlement Summary view ──────────────────────────────────
function FirmSummaryView({ data, adjustments, onAdjustmentsChange, overrides, onOverridesChange, onPrint, onPdf }: {
  data: FirmSummaryData;
  adjustments: { label: string; amount: number; sign: 1 | -1 }[];
  onAdjustmentsChange: (a: { label: string; amount: number; sign: 1 | -1 }[]) => void;
  overrides: FirmSummaryOverrides;
  onOverridesChange: (o: FirmSummaryOverrides) => void;
  onPrint: () => void; onPdf: () => void;
}) {
  // One-time charges for THIS printout only — held in parent state, never saved.
  const [editing, setEditing] = useState(false);
  // Local pagination — independent of the parent Reports page state.
  const [page, setPage] = useState(0);
  // Reset to page 0 whenever data changes (firm/date-range switch).
  useEffect(() => { setPage(0); }, [data]);
  const totalPages = Math.max(1, Math.ceil(data.rows.length / PAGE_SIZE));
  const pageRows = data.rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  // Same waterfall FirmSummaryPrint and the PDF/CSV exports use — one source of
  // truth so the screen, the printout, and the exports can never disagree.
  const {
    raw: t, toPay, truckHire, doorDelivery, crossing, dcAmount, pf, refund,
    truckHireSign, doorDeliverySign, crossingSign, dcAmountSign, pfSign, refundSign,
    balance, savedAdjustmentLines: savedLines, adjustmentLines: oneTimeLines, roundFigure,
  } = computeFirmSettlement({ ...data, adjustmentLines: adjustments, overrides });
  const num = (n: number) => (Math.round(n) || 0).toLocaleString('en-IN');
  // Paisa-aware — same as FirmSummaryPrint.numP: shows DC as e.g. "49.95" not "50"
  const numP = (n: number) => {
    const v = +(n || 0).toFixed(2);
    return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const prefix = (s: 1 | -1) => (s > 0 ? '+' : '-');

  const exportCSV = () => {
    const header = ['Date', 'Challan No', 'Truck No', 'Load Date', 'Loading Station', 'ToPay', 'Paid', 'Dly Chgs (Local)', 'Crossing', 'Door', 'Truck Hire', 'PF', 'Refund'];
    const lines = data.rows.map(r => [
      formatDate(r.date), r.challanNumber, r.truckNumber, formatDate(r.loadingDate), r.loadingStation,
      r.toPay, r.paid, r.deliveryCharges, r.crossing, r.doorDelivery, r.truckHire, r.pf, r.refund,
    ].join(','));
    const summary = [
      '', `ToPay,${toPay}`,
      `${prefix(dcAmountSign)} Delivery Charges ${data.dcPercent}%,${dcAmount}`,
      `${prefix(truckHireSign)} Truck Hire,${truckHire}`,
      `Balance,${balance}`,
      `${prefix(doorDeliverySign)} Door Delivery,${doorDelivery}`,
      `${prefix(crossingSign)} Crossing,${crossing}`,
      `${prefix(pfSign)} PF,${pf}`, `${prefix(refundSign)} Refund,${refund}`,
      ...savedLines.map(a => `#${a.challanNumber} ${a.sign > 0 ? '+' : '-'} ${a.label || 'Adjustment'},${a.amount}`),
      ...oneTimeLines.map(a => `${a.sign > 0 ? '+' : '-'} ${a.label || 'Adjustment'},${a.amount}`),
      `AMOUNT (ROUND FIGURE),${roundFigure}`,
    ];
    const csv = [header.join(','), ...lines, ...summary].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${data.firmName}_Settlement_${todayISO()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const rangeLabel = data.dateFrom || data.dateTo
    ? `${data.dateFrom ? formatDate(data.dateFrom) : 'start'} to ${data.dateTo ? formatDate(data.dateTo) : 'today'}`
    : 'All memos';

  const sLine = (label: string, amt: number, balance?: boolean, paisa?: boolean) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', fontStyle: balance ? 'italic' : 'normal', fontWeight: balance ? 700 : 400 }}>
      <span style={{ color: balance ? 'var(--navy)' : 'var(--text-secondary)' }}>{label}</span>
      <span style={{ flex: 1, borderBottom: '1px dotted var(--border)', margin: '0 8px', transform: 'translateY(-3px)' }} />
      <span style={{ fontWeight: 600, minWidth: 80, textAlign: 'right', color: balance ? 'var(--navy)' : 'var(--text-primary)' }}>₹{paisa ? numP(amt) : num(amt)}</span>
    </div>
  );

  // Same row, but editable — for the base charge rows, reusing the effective
  // value (override, or the real computed default) as the input's starting point.
  // signKey/sign are omitted for ToPay (the base row — no direction to flip).
  const eLine = (label: string, key: keyof FirmSummaryOverrides, effective: number, signKey?: keyof FirmSummaryOverrides, sign?: 1 | -1) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', gap: 8 }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ flex: 1, borderBottom: '1px dotted var(--border)', margin: '0 8px', transform: 'translateY(-3px)' }} />
      <input className="form-input" style={{ width: 90, textAlign: 'right' }} type="number" value={effective}
        onChange={e => onOverridesChange({ ...overrides, [key]: Number(e.target.value) || 0 })} />
      {signKey && (
        <select className="form-select" style={{ width: 56 }} value={sign}
          onChange={e => onOverridesChange({ ...overrides, [signKey]: Number(e.target.value) as 1 | -1 })}>
          <option value={-1}>−</option>
          <option value={1}>+</option>
        </select>
      )}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--navy)' }}>{data.firmName}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Challan-wise Delivery Summary · {rangeLabel} · {data.rows.length} memos</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!editing && <button className="btn btn-outline btn-sm" onClick={() => setEditing(true)}><Pencil size={14} /> Edit charges</button>}
          <button className="btn btn-secondary btn-sm" onClick={onPrint}><Printer size={14} /> Print</button>
          <button className="btn btn-secondary btn-sm" onClick={onPdf}><FileDown size={14} /> PDF</button>
          <button className="btn btn-outline btn-sm" onClick={exportCSV}><FileSpreadsheet size={14} /> CSV</button>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrap" style={{ overflowX: 'auto', marginBottom: 20 }}>
        <table className="data-table table-compact">
          <thead>
            <tr>
              <th>Date</th><th>Ch. No</th><th>Truck No</th><th>Load Date</th><th>Loading Station</th>
              <th style={{ textAlign: 'right' }}>ToPay</th><th style={{ textAlign: 'right' }}>Paid</th>
              <th style={{ textAlign: 'right' }}>Dly.Chgs (Local)</th><th style={{ textAlign: 'right' }}>Cros</th>
              <th style={{ textAlign: 'right' }}>Door</th><th style={{ textAlign: 'right' }}>T.Hire</th>
              <th style={{ textAlign: 'right' }}>PF</th><th style={{ textAlign: 'right' }}>Refund</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={i}>
                <td>{formatDate(r.date)}</td>
                <td className="td-bold">{r.challanNumber}</td>
                <td>{r.truckNumber}</td>
                <td>{formatDate(r.loadingDate)}</td>
                <td>{r.loadingStation}</td>
                <td style={{ textAlign: 'right' }}>{num(r.toPay)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.paid)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.deliveryCharges)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.crossing)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.doorDelivery)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.truckHire)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.pf)}</td>
                <td style={{ textAlign: 'right' }}>{num(r.refund)}</td>
              </tr>
            ))}
            {/* TOTAL row — only on last page; totals are always from full data.rows */}
            {page === totalPages - 1 && (
              <tr style={{ background: 'var(--orange-light)', fontWeight: 700 }}>
                <td colSpan={5} style={{ textAlign: 'right' }}>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{num(t.toPay)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.paid)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.deliveryCharges)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.crossing)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.doorDelivery)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.truckHire)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.pf)}</td>
                <td style={{ textAlign: 'right' }}>{num(t.refund)}</td>
              </tr>
            )}

          </tbody>
        </table>
      </div>

      {/* Pager — same labels as generic report (Previous/Next) */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Previous</button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {page + 1} of {totalPages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page === totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</button>
        </div>
      )}

      <div className="card" style={{ padding: 20, maxWidth: 420, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 14, color: 'var(--navy)', marginBottom: 12 }}>Report In Rupees</div>
        {editing ? eLine('ToPay', 'toPay', toPay) : sLine('ToPay', toPay)}
        {editing ? eLine(`Delivery Chrgs (${data.dcPercent}%)`, 'dcAmount', dcAmount, 'dcAmountSign', dcAmountSign) : sLine(`${prefix(dcAmountSign)} Delivery Chrgs (${data.dcPercent}%)`, dcAmount, false, true)}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -2, marginBottom: 4 }}>
          (ToPay ₹{num(toPay)} + Paid ₹{num(t.paid)}) × {data.dcPercent}%
        </div>
        {editing ? eLine('Truck Hire', 'truckHire', truckHire, 'truckHireSign', truckHireSign) : sLine(`${prefix(truckHireSign)} Truck Hire`, truckHire)}
        {sLine('Balance', balance, true, true)}
        {editing ? eLine('Door Delivery', 'doorDelivery', doorDelivery, 'doorDeliverySign', doorDeliverySign) : sLine(`${prefix(doorDeliverySign)} Door Delivery`, doorDelivery)}
        {editing ? eLine('Crossing', 'crossing', crossing, 'crossingSign', crossingSign) : sLine(`${prefix(crossingSign)} Crossing`, crossing)}
        {editing ? eLine('PF', 'pf', pf, 'pfSign', pfSign) : sLine(`${prefix(pfSign)} PF`, pf)}
        {editing ? eLine('Refund', 'refund', refund, 'refundSign', refundSign) : sLine(`${prefix(refundSign)} Refund`, refund)}

        {/* Saved charges — from each challan's own Challan-wise Report (Edit
            charges). Read-only here in both modes; to change one, open that
            challan's report. */}
        {savedLines.length > 0 && (
          <div style={{ borderTop: '1px dashed var(--border)', marginTop: 8, paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Saved charges (from challan reports)</div>
            {savedLines.map((a, i) => (
              <div key={i}>{sLine(`${a.sign > 0 ? '+' : '-'} #${a.challanNumber} · ${a.label || 'Adjustment'}`, a.amount)}</div>
            ))}
          </div>
        )}

        {/* One-time charges — this printout only, never saved to the database. */}
        {!editing && oneTimeLines.map((a, i) => (
          <div key={i}>{sLine(`${a.sign > 0 ? '+' : '-'} ${a.label || 'Adjustment'}`, a.amount)}</div>
        ))}
        {editing && (
          <div style={{ borderTop: '1px dashed var(--border)', marginTop: 8, paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>One-time charges — this printout only, not saved</div>
            {adjustments.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                <select className="form-select" style={{ width: 76 }} value={a.sign}
                  onChange={e => onAdjustmentsChange(adjustments.map((row, idx) => idx === i ? { ...row, sign: Number(e.target.value) as 1 | -1 } : row))}>
                  <option value={1}>+ add</option>
                  <option value={-1}>− less</option>
                </select>
                <input className="form-input" style={{ flex: 1 }} placeholder="label (e.g. crossing)" value={a.label}
                  onChange={e => onAdjustmentsChange(adjustments.map((row, idx) => idx === i ? { ...row, label: e.target.value } : row))} />
                <input className="form-input" style={{ width: 90 }} type="number" placeholder="₹" value={a.amount || ''}
                  onChange={e => onAdjustmentsChange(adjustments.map((row, idx) => idx === i ? { ...row, amount: Number(e.target.value) || 0 } : row))} />
                <button className="btn btn-ghost btn-sm" onClick={() => onAdjustmentsChange(adjustments.filter((_, idx) => idx !== i))}><X size={14} /></button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-outline btn-sm" onClick={() => onAdjustmentsChange([...adjustments, { label: '', amount: 0, sign: -1 }])}><Plus size={13} /> Add charge line</button>
              <button className="btn btn-primary btn-sm" onClick={() => setEditing(false)}>Done</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              Edits here affect this printout only. To save a charge against a challan, open its Challan-wise Report.
            </div>
          </div>
        )}

        <div style={{ borderTop: '2px solid var(--navy)', borderBottom: '2px solid var(--navy)', marginTop: 10, padding: '10px 0', display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 16 }}>
          <span style={{ color: 'var(--navy)' }}>AMOUNT (ROUND FIGURE)</span>
          <span style={{ color: 'var(--orange)' }}>₹{num(roundFigure)}</span>
        </div>
      </div>
    </div>
  );
}

