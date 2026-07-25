import { useCallback, useEffect, useState, useRef, useContext } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Plus, Trash2, Edit, Check, CheckCircle, RefreshCw, Keyboard, Lock, X, Home, Maximize2, Minimize2, Menu, Search } from 'lucide-react';
import { db, sqlClient, getCartageRules, classifyPaymentMode, deleteEntryCascade, logAudit, seatName } from '../db/database';
import type { Challan, LREntry, CartageRule } from '../db/database';
import { learnValues, type DuplicateMatch } from '../utils/masterData';
import { formatINR, todayISO } from '../utils/reportUtils';
import AutoCompleteInput from '../components/AutoCompleteInput';
import PaymentModeBadge from '../components/PaymentModeBadge';
import ConfirmModal from '../components/ConfirmModal';
import SaveFailedModal from '../components/SaveFailedModal';
import { useToast } from '../context/ToastContext';
import { FullscreenContext } from '../context/FullscreenContext';

// godownInsurance is the UI name for what is stored as otherCharges in LREntry

// Booking date is stored as ISO (YYYY-MM-DD) and displayed as DD-MM-YYYY
// via isoToDMY. Storage, reports, and prints always see the ISO format.
function isoToDMY(iso: string): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return iso;
}

const EMPTY_FORM = {
  consignor: '', consignee: '', fromStation: '', lrNumber: '', pmNumber: '',
  bookingDate: todayISO(), particulars: '', quantity: '',
  toPay: '', paid: '', crossing: '', doorDelivery: '', pf: '', refund: '',
  cartage: '', cartageOption: '' as '' | 'option1' | 'option2' | 'blank',
  godownBhada: '', deliveryCharges: '', godownInsurance: '', hamali: '',
};

type FormType = typeof EMPTY_FORM;

// ── Per-PC keyboard shortcuts ──
// Stored in localStorage, which on the NComputing setup is per-Windows-account —
// i.e. per seat. Each PC keeps its own keys; Enter and Esc are fixed for everyone.
type ShortcutAction =
  | 'add-entry' | 'save-memo' | 'clear-form' | 'refresh-entries'
  | 'focus-consignor' | 'focus-consignee' | 'focus-lr' | 'focus-qty'
  | 'focus-topay' | 'focus-paid' | 'focus-charges' | 'focus-hamali';

const ACTION_LABELS: Record<ShortcutAction, string> = {
  'add-entry': 'Add entry', 'save-memo': 'Save memo', 'clear-form': 'Clear form',
  'refresh-entries': 'Refresh entries list',
  'focus-consignor': 'Jump to Consignor', 'focus-consignee': 'Jump to Consignee',
  'focus-lr': 'Jump to LR no', 'focus-qty': 'Jump to Qty',
  'focus-topay': 'Jump to ToPay', 'focus-paid': 'Jump to Paid',
  'focus-charges': 'Jump to Charges', 'focus-hamali': 'Jump to Hamali',
};
const SHORTCUT_KEYS = ['F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10'];
const DEFAULT_SHORTCUTS: { key: string; action: ShortcutAction }[] = [
  { key: 'F2', action: 'focus-consignor' },
  { key: 'F4', action: 'focus-topay' },
  { key: 'F9', action: 'save-memo' },
];
const SC_STORAGE_KEY = 'dm-challan-shortcuts';

function loadShortcuts(): { key: string; action: ShortcutAction }[] {
  try {
    const raw = localStorage.getItem(SC_STORAGE_KEY);
    if (!raw) return [...DEFAULT_SHORTCUTS];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((s: { key?: string; action?: string }) =>
        typeof s?.key === 'string' && typeof s?.action === 'string' && s.action in ACTION_LABELS);
    }
  } catch { /* corrupted — fall back to defaults */ }
  return [...DEFAULT_SHORTCUTS];
}

export default function ChallanDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const challanId = Number(id);

  // ── Fullscreen (wider entry area) ──
  // Hides the sidebar for maximum width. Remembered per PC (same per-seat storage
  // as the shortcuts) and switched off automatically when leaving this page, so
  // the rest of the app always shows its normal sidebar.
  const { fs, setFs } = useContext(FullscreenContext);
  useEffect(() => {
    try { if (localStorage.getItem('dm-challan-fullscreen') === '1') setFs(true); } catch { /* storage unavailable */ }
    return () => setFs(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleFs = () => {
    const next = !fs;
    setFs(next);
    try { localStorage.setItem('dm-challan-fullscreen', next ? '1' : '0'); } catch { /* storage unavailable */ }
  };

  const [challan, setChallan] = useState<Challan | null>(null);

  // An already-saved challan reaching this route (Dashboard/ChallanList/etc.
  // linking to /challan/:id/detail) redirects straight to the formatted memo —
  // this page only ever renders the open/editable entry form.
  useEffect(() => {
    if (challan?.status === 'saved') navigate(`/memo/${challanId}/view`, { replace: true });
  }, [challan?.status, challanId, navigate]);

  const [entries, setEntries] = useState<LREntry[]>([]);
  const [form, setForm] = useState<FormType>({ ...EMPTY_FORM });
  const [nextSr, setNextSr] = useState(1);
  const [editId, setEditId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<LREntry | null>(null);
  const [saveMemoConfirm, setSaveMemoConfirm] = useState(false);
  // A write that failed to reach disk — blocks everything until Retry succeeds
  // (see SaveFailedModal). retry re-runs the exact save that failed.
  const [saveError, setSaveError] = useState<{ detail?: string; retry: () => void } | null>(null);
  const [savingMemo, setSavingMemo] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [addAnim, setAddAnim] = useState(false);
  const [newRowId, setNewRowId] = useState<number | null>(null);
  const [autoSaveLabel, setAutoSaveLabel] = useState('');
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [cartageRules, setCartageRules] = useState<Record<'option1' | 'option2' | 'blank', CartageRule> | null>(null);
  // Tracks which auto-charge fields the user manually edited — auto-calc won't overwrite these
  const [manualFields, setManualFields] = useState<Set<string>>(new Set());
  // Memo-wide default charges option: chosen once (top-bar pill or first-entry popup),
  // stays fixed for the whole memo; the pill is the single place to change it.
  const [memoDefaultCartage, setMemoDefaultCartage] = useState<'' | 'option1' | 'option2' | 'blank'>('');
  // Booking-date default: '' until the first entry saves, then carries forward
  // for the memo. Reseeds from the memo's own entries on load so reopening a
  // half-finished memo doesn't snap back to today (see load() below).
  const [memoDefaultBookingDate, setMemoDefaultBookingDate] = useState('');
  // Calendar picker state — open/close, which month grid to show, and the
  // mid-memo date-change confirmation (form-state only, no DB writes).
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<{ y: number; m: number }>(() => { const t = new Date(); return { y: t.getFullYear(), m: t.getMonth() }; });
  const [dateChangeConfirm, setDateChangeConfirm] = useState<{ newISO: string } | null>(null);
  const [showCartageDefaultPopup, setShowCartageDefaultPopup] = useState(false);
  const [nameCheck, setNameCheck] = useState<{ field: 'consignor' | 'consignee' | 'fromStation'; typed: string; match: DuplicateMatch | null }[] | null>(null);
  const [popupChoice, setPopupChoice] = useState<'option1' | 'option2' | 'blank'>('option1');
  // LR duplicate warning — current-year scope, keyed off bookingDate's year, not createdAt.
  const [lrDupTarget, setLrDupTarget] = useState<{ consignee: string; locationLabel: string } | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Per-PC shortcuts
  const [shortcuts, setShortcuts] = useState<{ key: string; action: ShortcutAction }[]>(loadShortcuts);
  const [scOpen, setScOpen] = useState(false);
  const [scDraft, setScDraft] = useState<{ key: string; action: ShortcutAction }[]>([]);

  // Saved-entries search — collapsed icon by default, expands inline in the top bar.
  const [query, setQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const openSearch = () => { setIsSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 10); };
  const closeSearch = () => { setIsSearchOpen(false); setQuery(''); };

  const consignorRef = useRef<HTMLInputElement>(null);
  const consigneeRef = useRef<HTMLInputElement>(null);
  const fromStRef = useRef<HTMLInputElement>(null);
  const lrRef = useRef<HTMLInputElement>(null);
  const qtyRef = useRef<HTMLInputElement>(null);
  const toPayRef = useRef<HTMLInputElement>(null);
  const paidRef = useRef<HTMLInputElement>(null);
  const hamaliRef = useRef<HTMLInputElement>(null);
  const calRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const c = await db.challans.get(challanId);
    setChallan(c || null);
    const rules = await getCartageRules();
    setCartageRules(rules);
    const e = await db.lrEntries
      .where('challanId').equals(challanId)
      .filter(x => x.status === 'active' && !x.deletedAt)
      .sortBy('srNo');
    setEntries(e);
    setNextSr(e.length ? Math.max(...e.map(x => x.srNo)) + 1 : 1);
    // Seed the booking-date lock from the memo's own entries (sorted by srNo,
    // same as the screen) — reopening a half-finished memo shows its existing
    // date instead of snapping back to today. Takes the LAST entry, not the
    // first: if the operator unlocked and changed the date partway through,
    // the last entry carries the current default, not entry 1's original date.
    setMemoDefaultBookingDate(e.length > 0 ? e[e.length - 1].bookingDate : '');
  }, [challanId]);

  useEffect(() => { load(); setMemoDefaultCartage(''); }, [challanId, load]);

  // ── Two-worker catch-up ──
  // Re-queries JUST the saved-entries list (and next serial number) — never the
  // form being typed — so two workers adding to the same memo see each other's
  // entries appear without any manual action.
  const refreshEntries = async () => {
    const e = await db.lrEntries
      .where('challanId').equals(challanId)
      .filter(x => x.status === 'active' && !x.deletedAt)
      .sortBy('srNo');
    setEntries(e);
    setNextSr(e.length ? Math.max(...e.map(x => x.srNo)) + 1 : 1);
  };

  useEffect(() => {
    const t = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshEntries().catch(() => { /* keeper briefly unreachable — next tick */ });
    }, 12000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challanId]);

  const [refreshing, setRefreshing] = useState(false);
  const doManualRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    // Minimum 400ms spin so the user sees it happened, even if the reload is instant
    try { await Promise.all([load(), new Promise(r => setTimeout(r, 400))]); }
    finally { setRefreshing(false); }
  };

  // Close the calendar popover on any click outside the date-picker container
  useEffect(() => {
    if (!datePickerOpen) return;
    const h = (e: MouseEvent) => { if (calRef.current && !calRef.current.contains(e.target as Node)) setDatePickerOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [datePickerOpen]);

  // Auto-save draft
  useEffect(() => {
    clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(async () => {
      await db.drafts.put({ challanId, formData: JSON.stringify(form), savedAt: new Date().toISOString() });
      setAutoSaveLabel('Saved ✓');
      setTimeout(() => setAutoSaveLabel(''), 2000);
    }, 800);
    return () => clearTimeout(autosaveTimer.current);
  }, [form, challanId]);

  // Recovery: offer to restore an unfinished draft (never auto-fills)
  const [draftOffer, setDraftOffer] = useState<FormType | null>(null);
  useEffect(() => {
    const checkDraft = async () => {
      const draft = await db.drafts.get(challanId);
      if (draft) {
        try {
          const d = JSON.parse(draft.formData);
          if (d.consignor || d.lrNumber) { setDraftOffer(d); return; }
        } catch { /* stale draft — ignore */ }
      }
    };
    checkDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptDraft = () => { if (draftOffer) setForm(draftOffer); setDraftOffer(null); };
  const discardDraft = async () => {
    setDraftOffer(null);
    try { await db.drafts.delete(challanId); } catch { /* ignore */ }
  };

  const n = (v: string) => Number(v) || 0;

  const calcTotal = (f: FormType) => {
    // The TOTAL is what the customer owes at delivery (goes on the DR + wasuli).
    // Freight is only owed for ToPay; a "Paid" entry's freight was already paid at
    // origin, so it must NOT be added here — only our charges apply. So the freight
    // base is toPay only (paid is recorded in its own field for the firm ledger,
    // but never collected from the customer again).
    // Crossing/door-delivery/refund/cartage boxes were removed from entry; those
    // adjustments now live in the report section instead.
    // PF IS collected from the consignee (and separately owed to the firm via
    // the ledger — see createLedgerEntries) — so it belongs in the total, same
    // as freight.
    const base = n(f.toPay);
    return base + n(f.pf)
      + n(f.godownBhada) + n(f.deliveryCharges) + n(f.godownInsurance) + n(f.hamali);
  };

  const set = (k: keyof FormType, v: string) => {
    setForm(f => ({ ...f, [k]: v }));
    if (errors[k]) setErrors(e => { const x = { ...e }; delete x[k]; return x; });
  };

  const setManual = (k: 'godownBhada' | 'godownInsurance' | 'deliveryCharges' | 'hamali', v: string) => {
    setManualFields(s => new Set(s).add(k));
    set(k, v);
  };

  // Calendar picker helpers
  const openDatePicker = () => {
    const iso = form.bookingDate || todayISO();
    const dt = new Date(iso);
    setCalMonth({ y: dt.getFullYear(), m: dt.getMonth() });
    setDatePickerOpen(true);
  };
  const pickDate = (iso: string) => {
    setDatePickerOpen(false);
    // Mid-memo date-change confirmation: if the picked date differs from the
    // memo's existing date and there are already saved entries, show a small
    // popup — form state only, no database writes from this popup.
    if (!editId && memoDefaultBookingDate && iso !== memoDefaultBookingDate && entries.length > 0) {
      setDateChangeConfirm({ newISO: iso });
    } else {
      set('bookingDate', iso);
    }
  };

  const computeHamali = (rule: CartageRule, qty: number): string => {
    if (rule.hamaliMode === 'perDag' && rule.hamaliPerDag > 0 && qty > 0) return String(rule.hamaliPerDag * qty);
    if (rule.hamaliMode === 'flat' && rule.hamaliFlat > 0) return String(rule.hamaliFlat);
    return '';
  };

  // Apply a charges option to the current form (auto charges refresh cleanly)
  const selectCartageOption = (option: 'option1' | 'option2' | 'blank') => {
    setManualFields(new Set());
    setForm(f => {
      if (!cartageRules || option === 'blank') {
        return option === 'blank'
          ? { ...f, cartageOption: option, godownBhada: '', godownInsurance: '', deliveryCharges: '', hamali: '' }
          : { ...f, cartageOption: option };
      }
      const rule = cartageRules[option];
      const qty = Number(f.quantity) || 0;
      return {
        ...f,
        cartageOption: option,
        godownBhada: rule.godownBhada > 0 ? String(rule.godownBhada) : '',
        godownInsurance: rule.godownInsurance > 0 ? String(rule.godownInsurance) : '',
        deliveryCharges: rule.deliveryCharges > 0 ? String(rule.deliveryCharges) : '',
        hamali: computeHamali(rule, qty),
      };
    });
  };

  // The top-bar pill: choosing here sets BOTH the memo default and the current form.
  const chooseCartage = (option: 'option1' | 'option2' | 'blank') => {
    setMemoDefaultCartage(option);
    selectCartageOption(option);
  };

  // Recompute hamali when quantity changes (perDag rules depend on qty)
  useEffect(() => {
    if (!cartageRules) return;
    const opt = form.cartageOption;
    if (opt !== 'option1' && opt !== 'option2') return;
    if (manualFields.has('hamali')) return;
    const rule = cartageRules[opt];
    if (rule.hamaliMode !== 'perDag') return;
    const qty = Number(form.quantity) || 0;
    const newHamali = computeHamali(rule, qty);
    if (newHamali !== form.hamali) {
      setForm(f => ({ ...f, hamali: newHamali }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.quantity, form.cartageOption, cartageRules]);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.lrNumber.trim()) e.lrNumber = 'Required';
    if (!form.consignor.trim()) e.consignor = 'Required';
    if (!form.consignee.trim()) e.consignee = 'Required';

    const amountFields: (keyof typeof form)[] = ['toPay', 'paid', 'deliveryCharges'];
    for (const k of amountFields) {
      if (n(form[k] as string) < 0) e[k as string] = 'Cannot be negative';
    }
    // An entry is ToPay OR Paid, never both — a mixed entry silently orphans
    // one amount out of the firm ledger (see createLedgerEntries).
    if (n(form.toPay) > 0 && n(form.paid) > 0) {
      e.toPay = 'Entry cannot have both ToPay and Paid';
      e.paid = 'Entry cannot have both ToPay and Paid';
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleAdd = async () => {
    if (!validate()) return;
    const dup = await findLrDuplicate();
    if (dup) { setLrDupTarget(dup); return; }
    // Entry page: no spelling/new-name confirmation here — the worker verifies each
    // entry as they go, so an interruption per entry is unwanted. New names are still
    // learned when the entry is saved (see learnValues in doActualAdd). The header page
    // keeps its own name check for firm / loading station / truck.
    await doActualAdd();
  };

  // Warns (never blocks) when the typed LR number already exists on another active
  // entry booked in the same year — the office reuses the LR pad each January, so
  // scope is the bookingDate's year, not createdAt. Excludes the entry being edited
  // so re-saving an entry against itself never false-fires. Purely informational:
  // does not touch BS/DR allocation, which stays independent (see generateDRs).
  const findLrDuplicate = async (): Promise<{ consignee: string; locationLabel: string } | null> => {
    const lr = form.lrNumber.trim();
    const year = form.bookingDate.slice(0, 4);
    if (!lr || !/^\d{4}$/.test(year)) return null; // date not fully typed yet — skip rather than block
    const dup = await db.lrEntries.where('lrNumber').equals(lr)
      .filter(e => e.status === 'active' && !e.deletedAt && e.id !== editId && e.bookingDate.slice(0, 4) === year)
      .first();
    if (!dup) return null;
    const dr = await db.drs.where('lrEntryId').equals(dup.id!).filter(d => !d.deletedAt).first();
    const locationLabel = dr ? `BS ${dr.drNumber}` : `Sr ${dup.srNo}, ${dup.challanId === challanId ? 'this memo' : `Challan #${dup.challanNumber}`}`;
    return { consignee: dup.consignee, locationLabel };
  };

  const confirmLrDuplicate = async () => {
    setLrDupTarget(null);
    await doActualAdd();
  };

  const resolveNameCheck = (field: 'consignor' | 'consignee' | 'fromStation', useExistingValue: string | null) => {
    if (useExistingValue !== null) set(field, useExistingValue);
  };

  const confirmNameCheck = async () => {
    setNameCheck(null);
    await doActualAdd();
  };

  const doActualAdd = async () => {
    try {

      // Per-entry delivery charge for the DR total: manual override, else the
      // FLAT rupee default from the memo's cartage rule. Always flat rupees —
      // never a percentage (that's the header's separate "Delivery Charges" %).
      const cartageOpt: 'option1' | 'option2' | 'blank' = form.cartageOption || 'blank';
      const effDlyCharges = form.deliveryCharges ? n(form.deliveryCharges) : (cartageRules?.[cartageOpt].deliveryCharges || 0);

      const total = calcTotal({ ...form, deliveryCharges: String(effDlyCharges) });
      const paymentMode = classifyPaymentMode(n(form.toPay), n(form.paid), total);

      const now = new Date().toISOString();
      let rid: number;
      const isFirstEntry = !editId && !memoDefaultCartage && entries.length === 0;

      if (editId) {
        const existingW = await db.wasuli.where('lrEntryId').equals(editId).first();
        const wasuliLocked = !!existingW && (existingW.status !== 'pending' || existingW.operatorId !== 0);
        if (wasuliLocked) {
          showToast('This DR is already allocated / collected and cannot be edited', 'error');
          return;
        }
        await db.lrEntries.update(editId, {
          consignor: form.consignor, consignee: form.consignee, fromStation: form.fromStation,
          lrNumber: form.lrNumber, pmNumber: form.pmNumber, bookingDate: form.bookingDate,
          particulars: form.particulars, quantity: n(form.quantity),
          toPay: n(form.toPay), paid: n(form.paid), paymentMode,
          crossing: 0, doorDelivery: 0, pf: n(form.pf), refund: 0,
          cartage: 0,
          cartageOption: cartageOpt, godownBhada: n(form.godownBhada),
          deliveryCharges: effDlyCharges,
          otherCharges: n(form.godownInsurance), hamali: n(form.hamali), total,
        });
        rid = editId;
        setEditId(null);
        showToast('Entry updated', 'success');
      } else {
        const newEntry = {
          challanId, challanNumber: challan!.challanNumber,
          consignor: form.consignor, consignee: form.consignee, fromStation: form.fromStation,
          lrNumber: form.lrNumber, pmNumber: form.pmNumber, bookingDate: form.bookingDate,
          particulars: form.particulars, quantity: n(form.quantity),
          toPay: n(form.toPay), paid: n(form.paid), paymentMode,
          crossing: 0, doorDelivery: 0, pf: n(form.pf), refund: 0,
          cartage: 0,
          cartageOption: cartageOpt, godownBhada: n(form.godownBhada),
          deliveryCharges: effDlyCharges,
          otherCharges: n(form.godownInsurance), hamali: n(form.hamali), total,
          status: 'active' as const, createdAt: now, seat: await seatName(),
        };
        if (sqlClient) {
          // Atomic serial allocation, scoped to THIS challan — same primitive BS
          // numbers use, but per-parent instead of table-wide, so two seats adding
          // to this memo at once can never land on the same Sr No, and Sr No
          // restarts at 1 for each new memo instead of climbing across the whole
          // business.
          const res = await sqlClient.addWithNumber('lrEntries', { ...newEntry, srNo: 0 }, 'srNo', '', { field: 'challanId', value: challanId });
          rid = res.id;
          await db.lrEntries.update(rid, { srNo: parseInt(String(res.srNo), 10) });
        } else {
          rid = await db.lrEntries.add({ ...newEntry, srNo: nextSr }) as number;
        }
        await logAudit({ action: 'add', party: newEntry.consignee, detail: `LR ${newEntry.lrNumber}` });
        showToast(`Entry #${nextSr} saved`, 'success');
      }

      await learnValues([
        { field: 'consignor', value: form.consignor },
        { field: 'consignee', value: form.consignee },
        { field: 'fromStation', value: form.fromStation },
        { field: 'particulars', value: form.particulars },
      ]);

      await db.drafts.delete(challanId);
      setNewRowId(rid);
      setTimeout(() => setNewRowId(null), 1200);
      setAddAnim(true);
      setTimeout(() => setAddAnim(false), 300);

      // After the FIRST entry (if the pill wasn't used yet): prompt for the memo default
      if (isFirstEntry) {
        setPopupChoice(cartageOpt);
        setShowCartageDefaultPopup(true);
      }

      // Booking-date lock: locks in on entry 1, or re-sets when the operator
      // deliberately unlocked it for this entry — same shape as memoDefaultCartage,
      // just keyed off whatever was typed instead of a fixed choice. Never
      // touched during an edit (existing entries aren't retro-dated).
      // bookingDateChanged: true on the first entry, or whenever the operator
      // picked a date different from the memo default (via the calendar).
      const bookingDateChanged = !editId && (isFirstEntry || form.bookingDate !== memoDefaultBookingDate);
      if (bookingDateChanged) setMemoDefaultBookingDate(form.bookingDate);

      const def = isFirstEntry ? cartageOpt : memoDefaultCartage;
      const nextBookingDate = bookingDateChanged ? form.bookingDate : (memoDefaultBookingDate || todayISO());
      setForm({ ...applyDefaultToForm({ ...EMPTY_FORM }, def), bookingDate: nextBookingDate });
      setManualFields(new Set());
      await load();
      setTimeout(() => consignorRef.current?.focus(), 50);
    } catch (err) {
      console.error('Add entry failed:', err);
      setSaveError({ detail: 'This entry could not be saved.', retry: doActualAdd });
    }
  };

  const applyDefaultToForm = (base: FormType, def: '' | 'option1' | 'option2' | 'blank'): FormType => {
    if (!def || def === 'blank') {
      return { ...base, cartageOption: def === 'blank' ? 'blank' : '' };
    }
    if (!cartageRules) return { ...base, cartageOption: def };
    const rule = cartageRules[def];
    return {
      ...base,
      cartageOption: def,
      godownBhada: rule.godownBhada > 0 ? String(rule.godownBhada) : '',
      godownInsurance: rule.godownInsurance > 0 ? String(rule.godownInsurance) : '',
      deliveryCharges: rule.deliveryCharges > 0 ? String(rule.deliveryCharges) : '',
      // hamali stays empty — recalculates live once quantity is entered
    };
  };

  const confirmMemoDefault = () => {
    setMemoDefaultCartage(popupChoice);
    setShowCartageDefaultPopup(false);
    setForm(f => applyDefaultToForm({ ...f }, popupChoice));
  };

  const clearForm = () => {
    setForm({ ...applyDefaultToForm({ ...EMPTY_FORM }, memoDefaultCartage), bookingDate: memoDefaultBookingDate || todayISO() });
    setEditId(null); setErrors({}); setManualFields(new Set()); setDatePickerOpen(false);
    setTimeout(() => consignorRef.current?.focus(), 30);
  };

  const handleEdit = (e: LREntry) => {
    setEditId(e.id!);
    setForm({
      consignor: e.consignor, consignee: e.consignee, fromStation: e.fromStation,
      lrNumber: e.lrNumber, pmNumber: e.pmNumber, bookingDate: e.bookingDate,
      particulars: e.particulars, quantity: String(e.quantity),
      toPay: String(e.toPay || ''), paid: String(e.paid || ''),
      crossing: '', doorDelivery: '', pf: String(e.pf || ''), refund: '',
      cartage: '', cartageOption: e.cartageOption,
      godownBhada: String(e.godownBhada || ''), deliveryCharges: String(e.deliveryCharges || ''),
      godownInsurance: String(e.otherCharges || ''), hamali: String(e.hamali || ''),
    });
    setManualFields(new Set(['godownBhada', 'godownInsurance', 'deliveryCharges', 'hamali']));
    setTimeout(() => consignorRef.current?.focus(), 30);
  };

  const handleDelete = async () => {
    if (!deleteTarget?.id) return;
    const res = await deleteEntryCascade(deleteTarget.id);
    if (!res.ok) {
      showToast('Cannot delete — its DR is already assigned or collected', 'error');
      setDeleteTarget(null);
      return;
    }
    showToast('Entry deleted', 'success');
    setDeleteTarget(null);
    await load();
  };

  const handleSaveMemo = async () => {
    setSavingMemo(true);
    try {
      const seat = await seatName();
      const finalize = async (totalToPay: number, totalPaid: number, totalEntries: number, liveEntries: LREntry[]) => {
        for (const e of liveEntries) {
          await learnValues([
            { field: 'consignor', value: e.consignor },
            { field: 'consignee', value: e.consignee },
            { field: 'fromStation', value: e.fromStation },
            { field: 'particulars', value: e.particulars },
          ]);
        }
        await db.drafts.delete(challanId);
        await logAudit({ action: 'save', party: challan?.firmName, amount: totalToPay + totalPaid, detail: `Challan #${challan?.challanNumber} — ${totalEntries} entries` });
        setSaveMemoConfirm(false);
        setSavedSuccess(true);
        setChallan(c => c ? { ...c, status: 'saved', totalToPay, totalPaid, totalEntries } : c);
        setTimeout(() => setSavedSuccess(false), 2500);
        await load();
        navigate(`/memo/${challanId}/view`);
      };

      if (window.sqlAPI?.saveMemo) {
        // Runs status-check -> update -> generateDRs -> createLedgerEntries as ONE
        // atomic keeper-side turn — two seats clicking Save Memo on the same memo
        // at once can no longer both pass the checks and double the firm ledger.
        const res = await window.sqlAPI.saveMemo(challanId, seat);
        if (!res.ok) {
          setSaveMemoConfirm(false);
          if (res.reason === 'already-saved') { showToast('This memo was just saved by another seat', 'info'); await load(); }
          else if (res.reason === 'no-entries') showToast('Add at least one entry first', 'error');
          else showToast('Challan not found — refresh the page and try again', 'error');
          return;
        }
        const liveEntries = await db.lrEntries.where('challanId').equals(challanId).filter(x => x.status === 'active' && !x.deletedAt).toArray();
        await finalize(res.totalToPay!, res.totalPaid!, res.totalEntries!, liveEntries);
        return;
      }
    } catch (err) {
      setSaveMemoConfirm(false);
      console.error('Save memo failed:', err);
      setSaveError({ detail: 'This memo could not be saved.', retry: handleSaveMemo });
    } finally {
      setSavingMemo(false);
    }
  };

  const totalToPay = entries.filter(e => e.paymentMode === 'topay').reduce((s, e) => s + e.toPay, 0);
  const totalPaid = entries.filter(e => e.paymentMode === 'paid').reduce((s, e) => s + e.paid, 0);
  const grandTotal = entries.reduce((s, e) => s + e.total, 0);
  const isSaved = challan?.status === 'saved';
  const anyOverlayOpen = !!(deleteTarget || saveMemoConfirm || draftOffer || showCartageDefaultPopup || scOpen || optionsOpen || nameCheck || saveError || lrDupTarget || dateChangeConfirm);

  // ── Shortcut actions ──
  const runAction = (action: ShortcutAction) => {
    switch (action) {
      case 'add-entry': if (!isSaved) handleAdd(); break;
      case 'save-memo': if (!isSaved && entries.length > 0) setSaveMemoConfirm(true); break;
      case 'clear-form': if (!isSaved) clearForm(); break;
      case 'refresh-entries': doManualRefresh(); break;
      case 'focus-consignor': consignorRef.current?.focus(); break;
      case 'focus-consignee': consigneeRef.current?.focus(); break;
      case 'focus-lr': lrRef.current?.focus(); break;
      case 'focus-qty': qtyRef.current?.focus(); break;
      case 'focus-topay': toPayRef.current?.focus(); break;
      case 'focus-paid': paidRef.current?.focus(); break;
      case 'focus-charges': hamaliRef.current?.focus(); break;
      case 'focus-hamali': hamaliRef.current?.focus(); break;
    }
  };

  // Global key handling: Esc clears the form; configured F-keys run their action.
  // Both are suspended while any popup/modal is open, so keys never fight a dialog.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && optionsOpen) { setOptionsOpen(false); return; }
      if (e.key === 'Escape' && isSearchOpen) { closeSearch(); return; }
      if (e.key === 'Escape' && datePickerOpen) { setDatePickerOpen(false); return; }
      if (anyOverlayOpen) return;
      if (e.key === 'Escape') {
        if (!isSaved) { e.preventDefault(); clearForm(); }
        return;
      }
      const sc = shortcuts.find(s => s.key === e.key);
      if (sc) { e.preventDefault(); runAction(sc.action); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortcuts, anyOverlayOpen, optionsOpen, isSearchOpen, datePickerOpen, isSaved, entries.length, form, editId, memoDefaultCartage, cartageRules, challan, nextSr]);

  // Shortcut editor helpers
  const openScEditor = () => { setScDraft(shortcuts.map(s => ({ ...s }))); setScOpen(true); };
  const saveScEditor = () => {
    setShortcuts(scDraft);
    try { localStorage.setItem(SC_STORAGE_KEY, JSON.stringify(scDraft)); } catch { /* storage unavailable — keys work for this session */ }
    setScOpen(false);
    showToast('Shortcuts saved for this PC', 'success');
  };

  const optLabel = (o: '' | 'option1' | 'option2' | 'blank') =>
    o === 'option1' ? 'Opt1' : o === 'option2' ? 'Opt2' : o === 'blank' ? 'Blank' : 'choose';

  // Compact input helper (render function, not a component — keeps focus stable)
  const CI = ({ label, name, type = 'number', req, r, small, theme = 'green' }: {
    label: string; name: keyof FormType; type?: string; req?: boolean;
    r?: React.RefObject<HTMLInputElement | null>; small?: boolean; theme?: 'green' | 'orange';
  }) => (
    <div>
      <div style={fieldLabelStyle(theme)}>{label}{req && <span style={{ color: '#8A2A0F' }}> *</span>}</div>
      <input
        ref={r}
        type={type} inputMode={type === 'number' ? 'numeric' : undefined}
        className={`form-input ${errors[name] ? 'field-error' : ''}`}
        style={{ ...fieldBoxStyle(theme, small), borderColor: errors[name] ? '#C0392B' : undefined }}
        value={form[name]} onChange={e => set(name, e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
        title={errors[name] || undefined}
      />
      {errors[name] && <div style={{ fontSize: 11, fontWeight: 700, color: '#C0392B', marginTop: 2 }}>{errors[name]}</div>}
    </div>
  );

  // Manual auto-charge input (marks the field manual so rules stop overwriting it)
  const MI = ({ label, name, r }: { label: string; name: 'godownBhada' | 'godownInsurance' | 'deliveryCharges' | 'hamali'; r?: React.RefObject<HTMLInputElement | null> }) => (
    <div>
      <div style={fieldLabelStyle('orange')}>{label}{manualFields.has(name) && <span title="Manual — auto-calc off"> ✎</span>}</div>
      <input
        ref={r}
        type="number" inputMode="numeric"
        className="form-input"
        style={fieldBoxStyle('orange', true)}
        value={form[name]} onChange={e => setManual(name, e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
      />
    </div>
  );

  // One combined auto-calculation hint line (hamali per-dag)
  const autoHints: string[] = [];
  if (cartageRules && (form.cartageOption === 'option1' || form.cartageOption === 'option2')
    && cartageRules[form.cartageOption].hamaliMode === 'perDag' && !manualFields.has('hamali')) {
    const rule = cartageRules[form.cartageOption];
    autoHints.push(`Hamali auto: ₹${rule.hamaliPerDag}/dag × ${Number(form.quantity) || 0} = ₹${rule.hamaliPerDag * (Number(form.quantity) || 0)}`);
  }

  // Two-color solid theme: green groups hold names/text (Party, Consignment),
  // orange groups hold money (Amount, Charges). Solid fills throughout, no
  // transparency, bold text, generous padding for easy reading at speed.
  const GREEN_DARK = '#04342C', GREEN_MID = '#1D9E75', GREEN_PALE = '#E1F5EE';
  const ORANGE_DARK = '#4A1B0C', ORANGE_MID = '#D85A30', ORANGE_PALE = '#F0997B', ORANGE_TINT = '#FAECE7';

  const groupStyle = (theme: 'green' | 'orange', big = false): React.CSSProperties => ({
    border: `2px solid ${theme === 'green' ? GREEN_DARK : ORANGE_DARK}`,
    borderRadius: 10,
    padding: big ? '20px 16px 16px' : '18px 14px 14px',
    position: 'relative',
    background: theme === 'green' ? GREEN_MID : ORANGE_PALE,
  });
  const legendStyle = (theme: 'green' | 'orange'): React.CSSProperties => ({
    position: 'absolute', top: -13, left: 12,
    background: theme === 'green' ? GREEN_DARK : ORANGE_DARK,
    color: theme === 'green' ? GREEN_PALE : ORANGE_TINT,
    padding: '3px 14px', borderRadius: 5,
    fontSize: 14, fontWeight: 700,
  });
  const fieldLabelStyle = (theme: 'green' | 'orange'): React.CSSProperties => ({
    fontSize: 13.5, fontWeight: 700, marginBottom: 5,
    color: theme === 'green' ? GREEN_DARK : ORANGE_DARK,
  });
  const fieldBoxStyle = (theme: 'green' | 'orange', small = false): React.CSSProperties => ({
    padding: small ? '8px 9px' : '10px 12px', fontSize: small ? 15 : 17, fontWeight: 700,
    minHeight: 0, height: small ? 40 : 46, width: '100%', minWidth: 0, boxSizing: 'border-box',
    border: `1.5px solid ${theme === 'green' ? GREEN_DARK : ORANGE_DARK}`,
    color: theme === 'green' ? GREEN_DARK : ORANGE_DARK,
    background: '#fff',
  });

  const sortedEntries = [...entries].sort((a, b) => (b.srNo - a.srNo) || ((b.id || 0) - (a.id || 0)));

  // Search filter — derived from sortedEntries, never a separate stored array,
  // so it can't desync from entries on add/edit/delete.
  const q = query.trim().toLowerCase();
  const visibleEntries = q
    ? sortedEntries.filter(e =>
        String(e.lrNumber).toLowerCase().includes(q) ||
        e.consignor.toLowerCase().includes(q) ||
        e.consignee.toLowerCase().includes(q))
    : sortedEntries;

  return (
    <div style={{ height: fs ? 'calc(100vh - 24px)' : 'calc(100vh - 48px)', marginBottom: fs ? 0 : -56, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#F1EFE8' }}>

      {/* ── Top bar: navigation left · identity centre · controls right ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: GREEN_DARK, color: GREEN_PALE, borderRadius: 10, marginBottom: 14 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn-icon" onClick={() => navigate('/')} title="Go to Dashboard (typed data is drafted automatically)" aria-label="Home"
            style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: GREEN_PALE, background: GREEN_MID, borderRadius: 8 }}>
            <Home size={17} />
          </button>
          <button className="btn btn-ghost btn-sm" style={{ color: GREEN_PALE, minHeight: 32, padding: '4px 14px', fontSize: 13.5, fontWeight: 700, background: GREEN_MID, borderRadius: 8 }} onClick={() => navigate(`/challan/${challanId}/header`)}>Header</button>
        </span>

        <span style={{ flex: 1, textAlign: 'center', fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          Firm: <b style={{ color: '#fff' }}>{challan?.firmName || '—'}</b>
          <span style={{ opacity: 0.55, margin: '0 10px' }}>·</span>
          Challan: <b style={{ color: '#fff' }}>#{challan?.challanNumber || '—'}</b>
          <span style={{ opacity: 0.55, margin: '0 10px' }}>·</span>
          Truck: <b style={{ color: '#fff' }}>{challan?.truckNumber || '—'}</b>
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {autoSaveLabel && <span style={{ fontSize: 12, fontWeight: 700, color: '#9FE1CB' }}>{autoSaveLabel}</span>}

          <span style={{ display: 'flex', alignItems: 'center' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search LR / consignor / consignee"
              aria-label="Search saved entries"
              style={{
                width: isSearchOpen ? 200 : 0,
                opacity: isSearchOpen ? 1 : 0,
                padding: isSearchOpen ? '6px 10px' : '6px 0',
                marginRight: isSearchOpen ? 6 : 0,
                border: 'none', borderRadius: 8, fontSize: 12.5, fontWeight: 600,
                color: GREEN_DARK, background: '#fff', minWidth: 0,
                transition: 'width 220ms ease, opacity 220ms ease, padding 220ms ease, margin-right 220ms ease',
              }}
            />
            <button className="btn-icon" onClick={() => (isSearchOpen ? closeSearch() : openSearch())}
              title="Search entries" aria-label={isSearchOpen ? 'Close search' : 'Search entries'}
              style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: GREEN_PALE, background: GREEN_MID, borderRadius: 8, flexShrink: 0 }}>
              {isSearchOpen ? <X size={16} /> : <Search size={16} />}
            </button>
          </span>

          <button className="btn-icon" onClick={doManualRefresh} title="Refresh entries (see other seats' additions)" aria-label="Refresh entries"
            style={{ width: 32, height: 32, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: GREEN_PALE, background: GREEN_MID, borderRadius: 8 }}>
            <RefreshCw size={16} style={{ transition: 'transform 0.4s', transform: refreshing ? 'rotate(360deg)' : 'none' }} />
          </button>

          <span style={{ position: 'relative' }}>
            <button onClick={() => setOptionsOpen(o => !o)}
              style={{ background: ORANGE_MID, color: '#fff', border: `2px solid ${ORANGE_DARK}`, padding: '6px 16px', borderRadius: 8, fontSize: 13.5, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Menu size={15} /> Options
            </button>
            {optionsOpen && (
              <div style={{ position: 'absolute', top: '115%', right: 0, zIndex: 40, background: '#fff', border: `2px solid ${GREEN_DARK}`, borderRadius: 10, boxShadow: '0 8px 22px rgba(0,0,0,0.25)', overflow: 'hidden', minWidth: 270 }}>
                <div onClick={() => { toggleFs(); setOptionsOpen(false); }}
                  style={{ padding: '12px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, color: GREEN_DARK, borderBottom: `1px solid ${GREEN_PALE}` }}>
                  {fs ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  {fs ? 'Exit full screen (show sidebar)' : 'Full screen (hide sidebar)'}
                </div>
                {!isSaved && (
                  <div style={{ padding: '12px 16px', borderBottom: `1px solid ${GREEN_PALE}` }}>
                    <div style={{ fontSize: 14, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 9, color: ORANGE_DARK, marginBottom: 9 }}>
                      <Lock size={14} /> Charges default: <b>{optLabel(memoDefaultCartage)}</b>
                    </div>
                    <div style={{ display: 'flex', gap: 7 }}>
                      {(['option1', 'option2', 'blank'] as const).map(o => (
                        <button key={o} onClick={() => chooseCartage(o)}
                          style={{ flex: 1, padding: '7px 0', borderRadius: 7, border: `2px solid ${ORANGE_DARK}`, background: memoDefaultCartage === o ? ORANGE_MID : ORANGE_TINT, fontWeight: 700, fontSize: 13, cursor: 'pointer', color: memoDefaultCartage === o ? '#fff' : ORANGE_DARK }}>
                          {optLabel(o)}
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 11.5, fontWeight: 600, color: ORANGE_DARK, marginTop: 7 }}>Memo default — applies to every entry</div>
                  </div>
                )}
                <div onClick={() => { setOptionsOpen(false); openScEditor(); }}
                  style={{ padding: '12px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, color: GREEN_DARK }}>
                  <Keyboard size={15} /> Keyboard shortcuts…
                </div>
              </div>
            )}
          </span>
        </span>
      </div>

      {/* ── Compact entry form (hidden once saved) ── */}
      {!isSaved && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 14, marginBottom: 14 }}>
            <div style={groupStyle('green', true)}>
              <div style={legendStyle('green')}>Party</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,0.8fr)', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={fieldLabelStyle('green')}>Consignor<span style={{ color: '#8A2A0F' }}> *</span></div>
                  <AutoCompleteInput field="consignor" value={form.consignor} onChange={v => set('consignor', v)} hasError={!!errors.consignor} inputRef={consignorRef} onEnter={handleAdd} style={fieldBoxStyle('green')} />
                  {errors.consignor && <div style={{ fontSize: 11, fontWeight: 700, color: '#C0392B', marginTop: 2 }}>{errors.consignor}</div>}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={fieldLabelStyle('green')}>Consignee<span style={{ color: '#8A2A0F' }}> *</span></div>
                  <AutoCompleteInput field="consignee" value={form.consignee} onChange={v => set('consignee', v)} hasError={!!errors.consignee} inputRef={consigneeRef} onEnter={handleAdd} style={fieldBoxStyle('green')} />
                  {errors.consignee && <div style={{ fontSize: 11, fontWeight: 700, color: '#C0392B', marginTop: 2 }}>{errors.consignee}</div>}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={fieldLabelStyle('green')}>From stn</div>
                  <AutoCompleteInput field="fromStation" value={form.fromStation} onChange={v => set('fromStation', v)} inputRef={fromStRef} onEnter={handleAdd} style={fieldBoxStyle('green')} />
                </div>
              </div>
            </div>

            <div style={groupStyle('green', true)}>
              <div style={legendStyle('green')}>Consignment</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 52px minmax(0,0.8fr) minmax(0,0.78fr) minmax(0,0.7fr) minmax(0,1fr)', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={fieldLabelStyle('green')}>LR no<span style={{ color: '#8A2A0F' }}> *</span></div>
                  <input ref={lrRef} className={`form-input ${errors.lrNumber ? 'field-error' : ''}`}
                    style={{ ...fieldBoxStyle('green'), borderColor: errors.lrNumber ? '#C0392B' : undefined }}
                    value={form.lrNumber} onChange={e => set('lrNumber', e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }} />
                  {errors.lrNumber && <div style={{ fontSize: 11, fontWeight: 700, color: '#C0392B', marginTop: 2 }}>{errors.lrNumber}</div>}
                </div>
                <div style={{ minWidth: 44 }}>
                  <div style={fieldLabelStyle('green')}>Sr</div>
                  <input className="form-input" value={editId ? 'edit' : nextSr} readOnly
                    style={{ ...fieldBoxStyle('green'), minWidth: 44, background: GREEN_PALE, textAlign: 'center' }} />
                </div>
                {CI({ label: 'PM no', name: 'pmNumber', type: 'text' })}
                {/* B.date — always-clickable calendar picker, no pencil/unlock flow */}
                <div style={{ minWidth: 0, position: 'relative' }} ref={calRef}>
                  <div style={fieldLabelStyle('orange')}>B.date</div>
                  <div
                    onClick={openDatePicker}
                    title="Click to pick booking date"
                    style={{ ...fieldBoxStyle('orange'), cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', userSelect: 'none' }}
                  >
                    <span style={{ fontSize: 13, fontFamily: 'Inter, monospace', whiteSpace: 'nowrap' }}>{isoToDMY(form.bookingDate || todayISO())}</span>
                    <span style={{ fontSize: 10, color: ORANGE_MID, marginLeft: 4, lineHeight: 1 }}>▼</span>
                  </div>
                  {datePickerOpen && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 50, background: '#fff', border: `2px solid ${ORANGE_DARK}`, borderRadius: 10, boxShadow: '0 8px 22px rgba(0,0,0,0.25)', padding: '10px 8px', marginTop: 4, minWidth: 210 }}>
                      {/* Month navigation */}
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                        <button onClick={() => setCalMonth(cm => { const d = new Date(cm.y, cm.m - 1); return { y: d.getFullYear(), m: d.getMonth() }; })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: ORANGE_DARK, fontWeight: 700, fontSize: 16, padding: '0 6px', lineHeight: 1 }}>‹</button>
                        <span style={{ fontSize: 12, fontWeight: 700, color: ORANGE_DARK }}>{new Date(calMonth.y, calMonth.m).toLocaleString('default', { month: 'long' })} {calMonth.y}</span>
                        <button onClick={() => setCalMonth(cm => { const d = new Date(cm.y, cm.m + 1); return { y: d.getFullYear(), m: d.getMonth() }; })} style={{ background: 'none', border: 'none', cursor: 'pointer', color: ORANGE_DARK, fontWeight: 700, fontSize: 16, padding: '0 6px', lineHeight: 1 }}>›</button>
                      </div>
                      {/* Day-of-week headers */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 3 }}>
                        {['S','M','T','W','T','F','S'].map((d, i) => <div key={i} style={{ fontSize: 10, fontWeight: 700, color: ORANGE_DARK, textAlign: 'center', padding: '2px 0' }}>{d}</div>)}
                      </div>
                      {/* Day grid */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                        {(() => {
                          const firstDay = new Date(calMonth.y, calMonth.m, 1).getDay();
                          const daysInMonth = new Date(calMonth.y, calMonth.m + 1, 0).getDate();
                          const cells: React.ReactNode[] = [];
                          for (let i = 0; i < firstDay; i++) cells.push(<div key={`e${i}`} />);
                          for (let d = 1; d <= daysInMonth; d++) {
                            const iso = `${calMonth.y}-${String(calMonth.m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                            const sel = form.bookingDate === iso;
                            cells.push(<button key={d} onClick={() => pickDate(iso)} style={{ fontSize: 11, fontWeight: sel ? 700 : 500, padding: '3px 1px', borderRadius: 4, border: sel ? `2px solid ${ORANGE_DARK}` : '2px solid transparent', background: sel ? ORANGE_MID : 'transparent', color: sel ? '#fff' : ORANGE_DARK, cursor: 'pointer', textAlign: 'center', width: '100%' }}>{d}</button>);
                          }
                          return cells;
                        })()}
                      </div>
                    </div>
                  )}
                </div>
                {CI({ label: 'Qty', name: 'quantity', r: qtyRef })}
                <div style={{ minWidth: 0 }}>
                  <div style={fieldLabelStyle('green')}>Particulars</div>
                  <AutoCompleteInput field="particulars" value={form.particulars} onChange={v => set('particulars', v)} onEnter={handleAdd} style={fieldBoxStyle('green')} />
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,3fr) minmax(0,0.55fr)', gap: 14 }}>
            <div style={groupStyle('orange', true)}>
              <div style={legendStyle('orange')}>Amount ₹</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                {CI({ label: 'ToPay', name: 'toPay', r: toPayRef, theme: 'orange' })}
                {CI({ label: 'Paid', name: 'paid', r: paidRef, theme: 'orange' })}
              </div>
            </div>

            <div style={groupStyle('orange', true)}>
              <div style={legendStyle('orange')}>Charges (from Charges Rules)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,0.6fr)', gap: 8 }}>
                {MI({ label: 'G.Bhada', name: 'godownBhada' })}
                {MI({ label: 'D.Chrgs (Local)', name: 'deliveryCharges' })}
                {MI({ label: 'GDN insu', name: 'godownInsurance' })}
                {MI({ label: 'Hamali', name: 'hamali', r: hamaliRef })}
                {CI({ label: 'PF', name: 'pf', small: true, theme: 'orange' })}
              </div>
              {autoHints.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: ORANGE_DARK }}>{autoHints.join('  ·  ')}</div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={handleAdd}
                style={{ width: '100%', justifyContent: 'center', padding: '12px 6px', fontSize: 16, fontWeight: 700, minHeight: 64, borderRadius: 10, border: `2px solid ${ORANGE_DARK}`, background: ORANGE_MID }}>
                {editId
                  ? <><Check size={18} /> Update</>
                  : <><Plus size={18} /> {addAnim ? 'Added ✓' : 'Add'}</>}
              </button>
            </div>
          </div>

          {/* This PC's keys — live legend from the per-seat configuration */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, fontSize: 12, fontWeight: 700, color: GREEN_DARK, flexWrap: 'wrap' }}>
            <span>This PC's keys:</span>
            <span><kbd style={{ background: '#fff', border: `1px solid ${GREEN_DARK}`, borderRadius: 4, padding: '1px 7px' }}>Enter</kbd> add</span>
            <span><kbd style={{ background: '#fff', border: `1px solid ${GREEN_DARK}`, borderRadius: 4, padding: '1px 7px' }}>Esc</kbd> clear</span>
            {shortcuts.map(s => (
              <span key={s.key}><kbd style={{ background: '#fff', border: `1px solid ${GREEN_DARK}`, borderRadius: 4, padding: '1px 7px' }}>{s.key}</kbd> {ACTION_LABELS[s.action].replace('Jump to ', '')}</span>
            ))}
          </div>
        </div>
      )}

      {/* ── Entries table — newest first, scrolls inside, page never moves ── */}
      <div style={{ flex: 1, minHeight: 0, border: `2px solid ${GREEN_DARK}`, borderRadius: 10, background: '#fff', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {sortedEntries.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: GREEN_DARK }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>📋</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>No entries yet</div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Fill the form above and press Enter</div>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: GREEN_DARK, fontSize: 14, fontWeight: 600 }}>
            No entries match that search.
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>
            <table className="data-table table-compact" style={{ width: '100%', fontWeight: 600, tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '5%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '5%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                <col style={{ width: '8%' }} />
                {!isSaved && <col style={{ width: '6%' }} />}
              </colgroup>
              <thead style={{ position: 'sticky', top: 0, zIndex: 5, background: GREEN_DARK, color: GREEN_PALE }}>
                <tr>
                  <th style={{ textAlign: 'center', color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>Sr</th>
                  <th style={{ color: GREEN_PALE, fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>LR no</th>
                  <th style={{ color: GREEN_PALE, fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>Consignor</th>
                  <th style={{ color: GREEN_PALE, fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>Consignee</th>
                  <th style={{ color: GREEN_PALE, fontWeight: 700, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>Particulars</th>
                  <th style={{ textAlign: 'right', color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>Qty</th>
                  <th style={{ textAlign: 'right', color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>ToPay</th>
                  <th style={{ textAlign: 'right', color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>Paid</th>
                  <th style={{ textAlign: 'right', color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>Extras</th>
                  <th style={{ textAlign: 'right', color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>Total</th>
                  <th style={{ color: GREEN_PALE, fontWeight: 700, fontSize: 13.5 }}>Mode</th>
                  {!isSaved && <th></th>}
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((e, idx) => {
                  // Extras = total minus the freight that's IN the total. Only
                  // ToPay freight is in the total now (Paid freight is excluded),
                  // so subtract toPay only — a Paid row's extras = its charges.
                  const extras = e.total - (e.toPay || 0);
                  // Compares against the full unfiltered list, not idx 0 of the
                  // filtered view — the "newest entry" highlight must stay on the
                  // actual newest row even when a search hides it from position 0.
                  const isTop = !isSaved && sortedEntries.length > 0 && e.id === sortedEntries[0].id;
                  return (
                    <tr key={e.id} className={e.id === newRowId ? 'row-new' : ''}
                      style={{
                        background: isTop ? '#C0DD97' : (idx % 2 === 0 ? '#fff' : GREEN_PALE),
                        borderLeft: isTop ? `4px solid ${GREEN_MID}` : undefined,
                        fontSize: 14, color: GREEN_DARK,
                      }}>
                      <td style={{ fontWeight: 700, textAlign: 'center' }}>{e.srNo}</td>
                      <td style={{ fontWeight: 700, wordBreak: 'break-word' }}>{e.lrNumber}</td>
                      <td style={{ wordBreak: 'break-word' }}>{e.consignor}</td>
                      <td style={{ fontWeight: 700, wordBreak: 'break-word' }}>{e.consignee}</td>
                      <td style={{ wordBreak: 'break-word' }}>{e.particulars}</td>
                      <td style={{ textAlign: 'right' }}>{e.quantity || ''}</td>
                      <td style={{ textAlign: 'right' }}>{e.toPay > 0 ? formatINR(e.toPay) : ''}</td>
                      <td style={{ textAlign: 'right' }}>{e.paid > 0 ? formatINR(e.paid) : ''}</td>
                      <td style={{ textAlign: 'right' }} title="Charges net of freight (g.bhada, d.chrgs, gdn insu, hamali, PF)">{extras !== 0 ? formatINR(extras) : ''}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: ORANGE_DARK }}>{formatINR(e.total)}</td>
                      <td><PaymentModeBadge mode={e.paymentMode} /></td>
                      {!isSaved && (
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button title="Edit" className="btn-icon btn-icon-edit" onClick={() => handleEdit(e)}><Edit size={13} /></button>
                            <button title="Delete" className="btn-icon btn-icon-delete" onClick={() => setDeleteTarget(e)}><Trash2 size={13} /></button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Pinned bottom bar: totals + actions ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, padding: '11px 16px', background: GREEN_DARK, color: GREEN_PALE, borderRadius: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, paddingRight: 16 }}>Entries <b style={{ color: '#fff' }}>{entries.length}</b></span>
        <span style={{ fontSize: 14, fontWeight: 700, borderLeft: `1px solid ${GREEN_MID}`, padding: '0 16px' }}>ToPay <b style={{ color: '#fff' }}>{formatINR(totalToPay)}</b></span>
        <span style={{ fontSize: 14, fontWeight: 700, borderLeft: `1px solid ${GREEN_MID}`, padding: '0 16px' }}>Paid <b style={{ color: '#fff' }}>{formatINR(totalPaid)}</b></span>
        <span style={{ fontSize: 14, fontWeight: 700, borderLeft: `1px solid ${GREEN_MID}`, padding: '0 16px' }}>Grand total <b style={{ color: '#fff' }}>{formatINR(grandTotal)}</b></span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
          {!isSaved && <button className="btn btn-ghost btn-sm" style={{ color: GREEN_PALE, fontWeight: 700 }} onClick={() => navigate('/challan')}>Exit</button>}
          {!isSaved && entries.length > 0 && (
            <button className="btn btn-sm" style={{ fontSize: 15, fontWeight: 700, padding: '9px 22px', borderRadius: 8, border: `2px solid ${ORANGE_DARK}`, background: ORANGE_MID, color: '#fff' }} onClick={() => setSaveMemoConfirm(true)}>
              Save memo ({entries.length})
            </button>
          )}
          {isSaved && <button className="btn btn-sm" style={{ fontWeight: 700, border: `2px solid ${ORANGE_DARK}`, background: ORANGE_MID, color: '#fff' }} onClick={() => navigate(`/drs?q=${encodeURIComponent(challan?.challanNumber || '')}`)}>Print DRs 🖨</button>}
          {isSaved && <button className="btn btn-ghost btn-sm" style={{ color: GREEN_PALE, fontWeight: 700 }} onClick={() => navigate('/memos')}>View saved memos</button>}
        </span>
      </div>

      {/* ── Shortcut editor (per-PC) ── */}
      {scOpen && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setScOpen(false); }}>
          <div className="confirm-modal" style={{ width: 440 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div className="confirm-title" style={{ marginBottom: 0 }}>Keyboard shortcuts — this PC</div>
              <button className="btn-icon" onClick={() => setScOpen(false)} aria-label="Close"><X size={16} /></button>
            </div>
            <div className="confirm-body">
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                Saved on this PC only — every seat can keep its own keys. Enter and Esc are fixed.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr 30px', gap: 8, alignItems: 'center', marginBottom: 6, opacity: 0.65 }}>
                <span style={{ border: '0.5px solid var(--border)', borderRadius: 6, padding: '5px 0', textAlign: 'center', fontWeight: 600, fontSize: 12 }}>Enter</span>
                <span style={{ border: '0.5px solid var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>Add entry</span>
                <Lock size={13} style={{ color: 'var(--text-muted)' }} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '86px 1fr 30px', gap: 8, alignItems: 'center', marginBottom: 12, opacity: 0.65 }}>
                <span style={{ border: '0.5px solid var(--border)', borderRadius: 6, padding: '5px 0', textAlign: 'center', fontWeight: 600, fontSize: 12 }}>Esc</span>
                <span style={{ border: '0.5px solid var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 12, color: 'var(--text-secondary)' }}>Clear form</span>
                <Lock size={13} style={{ color: 'var(--text-muted)' }} />
              </div>

              {scDraft.map((s, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '86px 1fr 30px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <select className="form-input" style={{ padding: '5px 6px', fontSize: 12, minHeight: 0, height: 32 }}
                    value={s.key}
                    onChange={e => setScDraft(d => d.map((x, xi) => xi === i ? { ...x, key: e.target.value } : x))}>
                    {SHORTCUT_KEYS.filter(k => k === s.key || !scDraft.some(x => x.key === k)).map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <select className="form-input" style={{ padding: '5px 6px', fontSize: 12, minHeight: 0, height: 32 }}
                    value={s.action}
                    onChange={e => setScDraft(d => d.map((x, xi) => xi === i ? { ...x, action: e.target.value as ShortcutAction } : x))}>
                    {(Object.keys(ACTION_LABELS) as ShortcutAction[]).map(a => <option key={a} value={a}>{ACTION_LABELS[a]}</option>)}
                  </select>
                  <button className="btn-icon btn-icon-delete" onClick={() => setScDraft(d => d.filter((_, xi) => xi !== i))} aria-label="Remove shortcut"><Trash2 size={13} /></button>
                </div>
              ))}

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-outline btn-sm"
                  disabled={scDraft.length >= SHORTCUT_KEYS.length}
                  onClick={() => {
                    const free = SHORTCUT_KEYS.find(k => !scDraft.some(x => x.key === k));
                    if (free) setScDraft(d => [...d, { key: free, action: 'focus-consignor' }]);
                  }}>
                  <Plus size={13} /> Add shortcut
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setScDraft(DEFAULT_SHORTCUTS.map(s => ({ ...s })))}>Reset to defaults</button>
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setScOpen(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={saveScEditor}>Save for this PC</button>
            </div>
          </div>
        </div>
      )}

      {/* Consignor/consignee spelling check — only appears when something needs a decision */}
      {nameCheck && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setNameCheck(null); }}>
          <div className="confirm-modal" style={{ width: 440 }}>
            <div className="confirm-title">{nameCheck.some(d => d.match) ? 'Similar name found' : 'New name'}</div>
            <div className="confirm-body">
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
                One quick check before saving, so nothing gets added twice under two different spellings.
              </div>
              {nameCheck.map((d, i) => (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12, marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
                    {d.field === 'consignor' ? 'Consignor' : d.field === 'consignee' ? 'Consignee' : 'From station'} — you typed: <b style={{ color: 'var(--text-primary)' }}>{d.typed}</b>
                  </div>
                  {d.match ? (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => resolveNameCheck(d.field, d.match!.value)} style={{ flex: 1, justifyContent: 'center' }}>
                        Use this: {d.match.value}
                      </button>
                      <button className="btn btn-outline btn-sm" onClick={() => resolveNameCheck(d.field, null)} style={{ flex: 1, justifyContent: 'center' }}>
                        Keep as typed
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Nothing similar on file — this will be saved as a new name.</div>
                  )}
                </div>
              ))}
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setNameCheck(null)}>Go back</button>
              <button className="btn btn-primary btn-sm" onClick={confirmNameCheck}>Confirm & add entry</button>
            </div>
          </div>
        </div>
      )}

      {/* LR duplicate warning — informational only, never blocks; BS allocation is untouched */}
      {lrDupTarget && (
        <ConfirmModal
          title="LR already used this year"
          body={<>LR <b>{form.lrNumber}</b> was already entered this year — Consignee: <b>{lrDupTarget.consignee}</b> ({lrDupTarget.locationLabel}).<br /><br />Add this entry anyway?</>}
          confirmLabel="Add anyway"
          cancelLabel="Cancel"
          onConfirm={confirmLrDuplicate}
          onCancel={() => setLrDupTarget(null)}
        />
      )}

      {/* Charges default popup — appears after first entry if the pill wasn't used */}
      {showCartageDefaultPopup && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowCartageDefaultPopup(false); }}>
          <div className="confirm-modal" style={{ width: 380 }}>
            <div className="confirm-title">Charges default — for this memo</div>
            <div className="confirm-body">
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
                Which charges option should apply to all further entries of this memo? You can change it any time from the Charges pill in the top bar.
              </div>
              <div className="radio-group" style={{ justifyContent: 'center', gap: 8 }}>
                {(['option1', 'option2', 'blank'] as const).map(o => (
                  <button
                    key={o}
                    type="button"
                    className={`radio-opt ${popupChoice === o ? 'selected' : ''}`}
                    onClick={() => setPopupChoice(o)}
                    style={{ cursor: 'pointer', font: 'inherit', minWidth: 80, justifyContent: 'center' }}
                  >
                    {optLabel(o)}
                  </button>
                ))}
              </div>
            </div>
            <div className="confirm-actions">
              <button className="btn btn-primary btn-sm" style={{ width: '100%', justifyContent: 'center' }} onClick={confirmMemoDefault}>
                Confirm default
              </button>
            </div>
          </div>
        </div>
      )}

      {saveMemoConfirm && challan && (
        <ConfirmModal
          title="Save this memo?"
          body={
            <div>
              <div style={{ background: 'var(--border-light)', borderRadius: 'var(--r-md)', padding: '12px', marginBottom: 12, fontSize: 13 }}>
                <div><b>Firm:</b> {challan.firmName}</div>
                <div><b>Challan:</b> #{challan.challanNumber} · <b>Truck:</b> {challan.truckNumber}</div>
                <div><b>Entries:</b> {entries.length}</div>
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '0.5px solid var(--border)' }}>
                  <b>ToPay:</b> {formatINR(totalToPay)} · <b>Paid:</b> {formatINR(totalPaid)}
                </div>
              </div>
              All correct? The header locks after saving.
            </div>
          }
          confirmLabel={savingMemo ? 'Saving...' : 'Yes, save ✓'}
          cancelLabel="Go back"
          onConfirm={handleSaveMemo}
          onCancel={() => setSaveMemoConfirm(false)}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete this entry?"
          body={<>LR <b>{deleteTarget.lrNumber}</b> will be deleted permanently.</>}
          confirmLabel="Yes, delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          danger
        />
      )}

      {draftOffer && (
        <ConfirmModal
          title="Unfinished entry found"
          body={<>Last time an entry was left unfinished{draftOffer.lrNumber ? <> (LR <b>{draftOffer.lrNumber}</b>)</> : ''}. Recover it?</>}
          confirmLabel="Yes, recover"
          cancelLabel="No, start fresh"
          onConfirm={acceptDraft}
          onCancel={discardDraft}
        />
      )}

      {/* Mid-memo date change confirmation — form state only, no DB writes */}
      {dateChangeConfirm && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setDateChangeConfirm(null); }}>
          <div className="confirm-modal" style={{ width: 400 }}>
            <div className="confirm-title">Change booking date?</div>
            <div className="confirm-body">
              Entries in this memo are dated <b>{isoToDMY(memoDefaultBookingDate)}</b>. Use <b>{isoToDMY(dateChangeConfirm.newISO)}</b> instead?
            </div>
            <div className="confirm-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => setDateChangeConfirm(null)}>
                Keep {isoToDMY(memoDefaultBookingDate)}
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => { set('bookingDate', dateChangeConfirm.newISO); setDateChangeConfirm(null); }}>
                Use {isoToDMY(dateChangeConfirm.newISO)}
              </button>
            </div>
          </div>
        </div>
      )}

      {saveError && (
        <SaveFailedModal detail={saveError.detail} onRetry={() => { const retry = saveError.retry; setSaveError(null); retry(); }} />
      )}

      {savedSuccess && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(22,163,74,0.9)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 9999, animation: 'fadeIn 0.2s ease' }}>
          <CheckCircle size={64} color="white" style={{ marginBottom: 16 }} />
          <div style={{ fontSize: 22, fontWeight: 700, color: 'white', marginBottom: 8 }}>Memo saved!</div>
          <div style={{ fontSize: 16, color: 'rgba(255,255,255,0.85)' }}>{entries.length} DRs created</div>
        </div>
      )}
    </div>
  );
}
