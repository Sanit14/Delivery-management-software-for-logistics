import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useReactToPrint } from 'react-to-print';
import { Printer, FileDown, FileText, RotateCcw } from 'lucide-react';
import { db, cascadeReopenChallan } from '../db/database';
import type { Challan } from '../db/database';
import { generateMemoPDF } from '../utils/reportUtils';
import PageHeader from '../components/PageHeader';
import MemoPrint, { type MemoPrintRow } from '../components/MemoPrint';
import ConfirmModal from '../components/ConfirmModal';
import { collectionLabel } from '../utils/collectionLabel';
import { useToast } from '../context/ToastContext';

/**
 * The full, permanent record of one saved memo — reused everywhere a saved
 * challan needs to be shown in full: "View" from Saved Memos, a Challan-number
 * search hit from Saved DRs or Firm Accounts. One page, one source of truth,
 * so it can never drift into two different-looking versions of the same memo.
 *
 * The screen renders MemoPrint directly (visibly) — not a separate on-screen
 * table. Screen, Print, and Save as PDF are the same document.
 */
export default function MemoView() {
  const { challanId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const autoPrint = searchParams.get('print') === '1';
  const id = Number(challanId);
  const { showToast } = useToast();

  const [challan, setChallan] = useState<Challan | null>(null);
  const [companyLocation, setCompanyLocation] = useState('—');
  const [rows, setRows] = useState<MemoPrintRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reopenConfirm, setReopenConfirm] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({ contentRef: printRef, documentTitle: challan ? `Memo ${challan.challanNumber}` : 'Memo' });

  const fetchFreshData = useCallback(async () => {
    const c = await db.challans.get(id);
    if (!c) return null;
    const cl = await db.settings.get('companyLocation');
    const compLoc = cl?.value || '—';
    const entries = await db.lrEntries.where('challanId').equals(id).filter(e => e.status === 'active' && !e.deletedAt).sortBy('srNo');
    const drs = await db.drs.where('challanId').equals(id).filter(d => !d.deletedAt).toArray();
    const wasuli = await db.wasuli.where('challanId').equals(id).filter(w => !w.deletedAt).toArray();
    const drByEntry = new Map(drs.map(d => [d.lrEntryId, d]));
    const wasuliByDr = new Map(wasuli.map(w => [w.drId, w]));

    const freshRows = entries.map(entry => {
      const dr = drByEntry.get(entry.id!) || null;
      return { entry, dr, wasuli: dr ? wasuliByDr.get(dr.id!) || null : null };
    });

    const totalToPay = freshRows.reduce((s, r) => s + (r.entry.paymentMode === 'topay' ? r.entry.toPay : 0), 0);
    const totalPaid = freshRows.reduce((s, r) => s + (r.entry.paymentMode === 'paid' ? r.entry.paid : 0), 0);
    const totalPF = freshRows.reduce((s, r) => s + (r.entry.pf || 0), 0);
    const totalPkgs = freshRows.reduce((s, r) => s + (Number(r.entry.quantity) || 0), 0);
    const grandTotal = freshRows.reduce((s, r) => s + r.entry.total, 0);

    return {
      challan: c,
      companyLocation: compLoc,
      rows: freshRows,
      totalToPay,
      totalPaid,
      totalPF,
      totalPkgs,
      grandTotal,
    };
  }, [id]);

  useEffect(() => {
    (async () => {
      const fresh = await fetchFreshData();
      if (fresh) {
        setChallan(fresh.challan);
        setCompanyLocation(fresh.companyLocation);
        setRows(fresh.rows);
      }
      setLoading(false);
    })();
  }, [id, fetchFreshData]);

  // Fires only once loading + rows are actually ready — printing an empty
  // shell (if this ran immediately on mount) would show a blank document.
  useEffect(() => {
    if (autoPrint && !loading && challan) setTimeout(() => handlePrint(), 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrint, loading, challan]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>;
  if (!challan) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Memo not found.</div>;



  const handleReopen = async () => {
    try {
      await cascadeReopenChallan(challan.id!);
      showToast('Challan reopened for editing', 'info');
      navigate(`/challan/${challan.id}/detail`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Reopen failed', 'error');
    } finally {
      setReopenConfirm(false);
    }
  };

  const handlePrintClick = async () => {
    const fresh = await fetchFreshData();
    if (fresh) {
      setChallan(fresh.challan);
      setCompanyLocation(fresh.companyLocation);
      setRows(fresh.rows);
      setTimeout(() => {
        handlePrint();
      }, 150);
    }
  };

  return (
    <div>
      <PageHeader showBack backFallback="/memos" title={`Challan #${challan.challanNumber}`} subtitle={challan.firmName} />

      {/* Button order: Print DR · Reopen memo · Print · Save as PDF */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 14 }}>
        <button
          className="btn btn-outline btn-sm"
          onClick={() => navigate(`/drs?q=${encodeURIComponent(challan.challanNumber)}`)}
        >
          <FileText size={14} /> Print DR
        </button>
        {challan.status === 'saved' && (
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setReopenConfirm(true)}
          >
            <RotateCcw size={14} /> Reopen memo
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={handlePrintClick}><Printer size={14} /> Print</button>
        <button className="btn btn-outline btn-sm" onClick={async () => {
          const fresh = await fetchFreshData();
          if (!fresh) {
            showToast('Memo not found.', 'error');
            return;
          }
          const result = await generateMemoPDF({
            companyLocation: fresh.companyLocation, firmName: fresh.challan.firmName, challanNumber: fresh.challan.challanNumber,
            entryDate: fresh.challan.entryDate, truckNumber: fresh.challan.truckNumber, loadingStation: fresh.challan.loadingStation,
            truckHire: fresh.challan.truckHire || 0,
            rows: fresh.rows.map(r => ({
              drNumber: r.dr?.drNumber || '—', lrNumber: r.entry.lrNumber, consignor: r.entry.consignor,
              consignee: r.entry.consignee, particulars: r.entry.particulars,
              quantity: Number(r.entry.quantity) || 0, toPay: r.entry.toPay || 0, paid: r.entry.paid || 0, pf: r.entry.pf || 0,
              total: r.entry.total, paymentMode: r.entry.paymentMode, collection: collectionLabel(r),
            })),
            totalToPay: fresh.totalToPay,
            totalPaid: fresh.totalPaid,
            totalPF: fresh.totalPF,
            totalPkgs: fresh.totalPkgs,
            grandTotal: fresh.grandTotal,
          });
          if (result.ok) showToast(`Saved to ${result.path}`, 'success');
          else showToast("Shared folder not reachable — file saved to your computer's Downloads folder", 'warning');
        }}>
          <FileDown size={14} /> Save as PDF
        </button>
      </div>

      <div className="memo-doc-wrap">
        <MemoPrint ref={printRef} challan={challan} companyLocation={companyLocation} rows={rows} />
      </div>

      {reopenConfirm && (
        <ConfirmModal
          title="Reopen this memo?"
          body={
            <>
              Challan <b>#{challan.challanNumber}</b> becomes editable again; BS numbers stay as they are;
              only changed entries update on re-save.
            </>
          }
          confirmLabel="Reopen"
          onConfirm={handleReopen}
          onCancel={() => setReopenConfirm(false)}
        />
      )}
    </div>
  );
}
