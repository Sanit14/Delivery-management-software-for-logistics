// ── Firm-ledger running-balance writes ──────────────────────────────────────
// Every write that touches a firm's runningBalance chain, ported into the
// keeper as plain synchronous functions — same shape as memoSave.cjs and
// masterDataLearn.cjs. No `await`, no IPC between steps. The caller wraps
// each of these in serializeWrite (see the server routes), so what used to be
// a read → compute → write spread across several separate round trips (which
// a second seat's write could land inside of) now happens in ONE atomic turn.
//
// recomputeFirmLedgerSync is the primitive every other function here ends
// with. It rebuilds a firm's whole balance chain from its rows, chronologically,
// writing only the rows whose stored balance actually differs — which makes it
// self-healing: any balance already wrong (from before this fix, or from a
// write that raced under the old two-step code) is corrected the moment
// anything next touches this firm, not just going forward.

// Exact port of src/db/database.ts recomputeFirmLedger. A reopened/edited memo
// keeps its original entryDate — sort chronologically so a backdated save
// doesn't get appended to the END of the balance chain just because it was
// inserted last. id is the tiebreak for same-day rows.
// Returns the firm's true final balance (the running balance after the last
// chronological row) — callers that need "the current balance" should read it
// from here rather than guessing which row is "last" some other way.
function recomputeFirmLedgerSync(engine, firmName) {
  const rows = engine.query('firmLedger', { whereCol: 'firmName', equals: firmName })
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate) || (a.id - b.id));
  let bal = 0;
  // Wrapped so the N-row update loop lands atomically — a crash mid-loop
  // previously could leave some rows recomputed and others stale.
  engine.transaction(() => {
    for (const r of rows) {
      bal += r.type === 'debit' ? r.amount : -r.amount;
      if (r.runningBalance !== bal) engine.update('firmLedger', r.id, { runningBalance: bal });
    }
  })();
  return bal;
}

// The ONE place freight + delivery charge are computed — every write path
// (memo save, DR-edit, challan restore) goes through this via
// createLedgerEntriesSync/createLedgerEntriesForChallanSync below, so the two
// can never drift apart again.
//
// An entry is EITHER ToPay OR Paid, never both (confirmed with the owner — a
// mixed row is an invalid state; see ChallanDetail validate()), so
// `(e.toPay || e.paid)` is correct, not `toPay + paid`. Amounts are stored as
// rupees (a plain JS number), precise to 2 decimal places — the paise is just
// the fractional part of that number, there's no separate integer-paise
// column. DC is computed by converting to integer paise, applying the
// percentage, and Math.round()-ing to the nearest paisa there, then dividing
// back down to rupees — so the percentage math itself never touches
// floating-point cents, instead of trusting toFixed(2) string-rounding on a
// float that may already have drifted.
function computeFreightAndDC(challan, entries) {
  const freightTotal = entries
    .filter(e => e.paymentMode === 'topay' || e.paymentMode === 'paid')
    .reduce((s, e) => s + (e.toPay || e.paid), 0);
  const freightToPay = entries
    .filter(e => e.paymentMode === 'topay')
    .reduce((s, e) => s + (e.toPay || 0), 0);
  const deliveryChargesTotal = challan.deliveryChargesType === 'percent'
    ? Math.round(Math.round(freightTotal * 100) * (challan.deliveryCharges || 0) / 100) / 100
    : (challan.deliveryCharges || 0) * entries.length;
  return { freight: freightTotal, freightToPay, deliveryChargesTotal };
}

// Ported from src/db/database.ts createLedgerEntries / buildChallanSummaryRow
// (formula) — now the only place that runs, everything else delegates here.
// Was previously hand-copied into memoSave.cjs, which is exactly how the DC
// rounding drifted: the copy kept Math.round() on the rupee float while the
// original moved to toFixed(2), so the two disagreed on the same input.
// Moved here (the firm-ledger domain file) so there's one function, not an
// original-plus-a-copy — computeFreightAndDC does its own Math.round() again
// now, but on integer paise, and only from this single function, so there's
// nothing left for it to drift apart from.
function createLedgerEntriesSync(engine, challan, entries) {
  // Excludes 'adjustment' rows deliberately: a merge preserves/re-parents
  // adjustment rows onto the winner while deleting its freight/DC/truck-hire/
  // etc. rows (see mergeChallans in merge.cjs), so a winner with a saved
  // adjustment but nothing else would otherwise look "already done" here and
  // silently never get its core ledger rows regenerated on the follow-up save.
  const already = engine.all('firmLedger').filter(r => r.challanId === challan.id && r.category !== 'adjustment').length;
  if (already > 0) return;

  const { freightToPay, deliveryChargesTotal } = computeFreightAndDC(challan, entries);
  const truckHire = challan.truckHire || 0;

  // PF is a firm-settlement adjustment (not collected from the consignee); its
  // sign carries the meaning. Summed from entries, same as freight.
  const pf = entries.reduce((s, e) => s + (e.pf || 0), 0);
  // Crossing/door delivery/refund — matches the Firm Report waterfall
  // (computeFirmSettlement) exactly: same three deductions, same direction.
  const crossing = entries.reduce((s, e) => s + (e.crossing || 0), 0);
  const doorDelivery = entries.reduce((s, e) => s + (e.doorDelivery || 0), 0);
  const refund = entries.reduce((s, e) => s + (e.refund || 0), 0);

  const firmRows = engine.query('firmLedger', { whereCol: 'firmName', equals: challan.firmName });
  // THE FIX: seed from the chronologically-last row (same ordering
  // recomputeFirmLedgerSync uses), not the highest-id row — a backdated
  // challan can have a lower entryDate but a higher id than rows already in
  // the chain, so seeding off id read the wrong starting balance.
  const lastEntry = firmRows.length
    ? firmRows.reduce((a, b) => (b.entryDate > a.entryDate || (b.entryDate === a.entryDate && b.id > a.id)) ? b : a)
    : null;
  let balance = lastEntry ? lastEntry.runningBalance : 0;
  const now = new Date().toISOString();

  const add = (type, category, amount, description) =>
    engine.add('firmLedger', { firmName: challan.firmName, challanId: challan.id, challanNumber: challan.challanNumber, entryDate: challan.entryDate, type, category, amount, description, runningBalance: balance, createdAt: now });

  // Wrapped so up to 4 inserts land atomically. On rollback there are zero rows,
  // so the `already > 0` guard above correctly sees "no entries" and a retry
  // rebuilds cleanly — without the wrap, a crash after 1-3 inserts would leave
  // a permanently half-written ledger, since the guard would then skip it forever.
  engine.transaction(() => {
    if (freightToPay > 0) { balance += freightToPay; add('debit', 'freight', freightToPay, `Freight (ToPay) — Challan ${challan.challanNumber}`); }
    if (deliveryChargesTotal > 0) { balance -= deliveryChargesTotal; add('credit', 'delivery_charges', deliveryChargesTotal, `Delivery charges (our commission) — Challan ${challan.challanNumber}`); }
    if (truckHire > 0) { balance -= truckHire; add('credit', 'truck_hire', truckHire, `Truck hire — Challan ${challan.challanNumber}`); }
    if (pf > 0) { balance += pf; add('debit', 'pf', pf, `PF — Challan ${challan.challanNumber}`); }
    else if (pf < 0) { balance += pf; add('credit', 'pf', -pf, `PF — Challan ${challan.challanNumber}`); }
    if (crossing > 0) { balance -= crossing; add('credit', 'crossing', crossing, `Crossing — Challan ${challan.challanNumber}`); }
    if (doorDelivery > 0) { balance -= doorDelivery; add('credit', 'door_delivery', doorDelivery, `Door delivery — Challan ${challan.challanNumber}`); }
    if (refund > 0) { balance -= refund; add('credit', 'refund', refund, `Refund — Challan ${challan.challanNumber}`); }
  })();

  // THE FIX (self-heal): unlike recordFirmSettlementSync/addManualEntrySync,
  // this path had no trailing recompute — a bad seed (or any backdated entry
  // landing mid-chain) stayed wrong until some other write touched this firm.
  recomputeFirmLedgerSync(engine, challan.firmName);
}

// Same as createLedgerEntriesSync but looks up the challan + its live entries
// itself — for callers (challan restore, DR-charges edit) that only have a
// challanId, not an already-fetched entries array.
function createLedgerEntriesForChallanSync(engine, challanId) {
  const challan = engine.get('challans', challanId);
  if (!challan) return;
  const entries = engine.query('lrEntries', { whereObj: { challanId, status: 'active' } }).filter(e => !e.deletedAt);
  createLedgerEntriesSync(engine, challan, entries);
}

// Exact port of src/db/database.ts recordFirmSettlement.
// THE FIX: this used to read the balance off the highest-id row. But
// recomputeFirmLedgerSync orders the chain by entryDate, so a backdated manual
// entry — highest id, sitting mid-chain — was being read as "the balance",
// which could even invert the settlement direction below. Recompute FIRST
// (same treatment addManualEntrySync already gets for the same class of bug)
// and take the balance recomputeFirmLedgerSync returns — the true
// chronologically-last balance — instead of re-deriving "last" a second way.
function recordFirmSettlementSync(engine, firmName, amount, note) {
  const balance = recomputeFirmLedgerSync(engine, firmName);
  const now = new Date().toISOString();
  // If we owe firm (balance>0), paying them is a 'credit' (reduces balance toward 0).
  // If firm owes us (balance<0), receiving is a 'debit' (raises balance toward 0).
  const type = balance >= 0 ? 'credit' : 'debit';
  const newBalance = type === 'credit' ? balance - amount : balance + amount;
  // Wrapped so the insert + recompute land atomically — a crash between them
  // previously could leave the settlement row on a stale/pre-recompute balance.
  engine.transaction(() => {
    engine.add('firmLedger', {
      firmName, challanId: 0, challanNumber: '—', entryDate: now.split('T')[0],
      type, category: 'settlement', amount,
      description: note || (balance >= 0 ? 'Paid to firm' : 'Received from firm'),
      runningBalance: newBalance, createdAt: now,
    });
    // THE FIX: the old code stopped here. Recomputing means this settlement (and
    // anything that raced against it) always lands on the true chronological balance.
    recomputeFirmLedgerSync(engine, firmName);
  })();
}

// Exact port of src/db/database.ts saveChallanAdjustments. Replace-all
// semantics preserved exactly: delete this challan's existing 'adjustment'
// rows, add the current set, recompute. 'pf' rows are never touched here —
// PF is derived-only now (see migratePfAdjustmentsSync below and
// createLedgerEntriesSync above). Returns { challanId, oldTotal,
// newTotal } so the caller (renderer) can still write its own History line —
// logAudit stays out of the keeper, per the existing saveMemo/mergeMaster
// convention (audit is a renderer-attributed action, not engine business logic).
function saveChallanAdjustmentsSync(engine, challanNumber, firmName, adjustments) {
  const challan = engine.all('challans').find(c => c.challanNumber === challanNumber) || null;
  const challanId = challan ? challan.id : 0;
  const now = new Date().toISOString();

  const existing = engine.all('firmLedger').filter(r => r.challanId === challanId && r.category === 'adjustment');
  const oldTotal = existing.reduce((s, r) => s + (r.type === 'debit' ? 1 : -1) * r.amount, 0);

  for (const e of existing) engine.del('firmLedger', e.id);
  for (const a of (adjustments || [])) {
    if (!a.amount) continue;
    engine.add('firmLedger', {
      firmName, challanId, challanNumber, entryDate: now.split('T')[0],
      type: a.sign > 0 ? 'debit' : 'credit', category: 'adjustment', amount: Math.abs(a.amount),
      description: a.label || 'Adjustment', runningBalance: 0, createdAt: now,
    });
  }

  // THE FIX: the old code called this same recompute, but as a SEPARATE round
  // trip after the delete/add loop above — a second seat's write could land
  // in the gap. Now the whole replace-all-then-recompute is one atomic turn.
  recomputeFirmLedgerSync(engine, firmName);

  const newTotal = (adjustments || []).reduce((s, a) => s + a.sign * a.amount, 0);
  return { challanId, oldTotal, newTotal };
}

// One-off, self-healing migration for the PF redesign: PF used to be
// separately editable at the challan level (a "PF" edit box on the
// Challan-wise Report, saved via saveChallanAdjustmentsSync with
// category:'pf') as well as summed from LR entries — two competing sources
// of truth. Now PF is entry-level ONLY (Σ lrEntries.pf); the 'pf' ledger row
// is purely derived (see createLedgerEntriesSync above). Any
// hand-entered 'pf' row left over from the old UI is an orphan that would
// double-count. For every challan that has any 'pf' row, delete them all and
// rewrite exactly one from its entries — idempotent, so this runs every
// startup rather than being gated behind a one-time flag.
function migratePfAdjustmentsSync(engine) {
  const done = engine.get('settings', 'pfAdjustmentsMigrated');
  if (!done || done.value !== 'true') {
    const challanIds = new Set(engine.query('firmLedger', { whereCol: 'category', equals: 'pf' }).map(r => r.challanId));
    if (challanIds.size > 0) {
      const challanMap = new Map(engine.all('challans').map(c => [c.id, c]));
      const entriesByChallan = new Map();
      for (const e of engine.query('lrEntries', { whereCol: 'status', equals: 'active' }).filter(e => !e.deletedAt)) {
        if (!entriesByChallan.has(e.challanId)) entriesByChallan.set(e.challanId, []);
        entriesByChallan.get(e.challanId).push(e);
      }

      const firmNames = new Set();
      const now = new Date().toISOString();
      for (const challanId of challanIds) {
        engine.transaction(() => {
          for (const row of engine.query('firmLedger', { whereObj: { challanId, category: 'pf' } })) {
            engine.del('firmLedger', row.id);
          }
          const challan = challanMap.get(challanId);
          if (!challan) return;
          firmNames.add(challan.firmName);

          const pf = (entriesByChallan.get(challanId) || []).reduce((s, e) => s + (e.pf || 0), 0);
          if (pf === 0) return;
          engine.add('firmLedger', {
            firmName: challan.firmName, challanId, challanNumber: challan.challanNumber, entryDate: challan.entryDate,
            type: pf > 0 ? 'debit' : 'credit', category: 'pf', amount: Math.abs(pf),
            description: `PF — Challan ${challan.challanNumber}`, runningBalance: 0, createdAt: now,
          });
        })();
      }
      for (const firmName of firmNames) recomputeFirmLedgerSync(engine, firmName);
    }
    engine.put('settings', { key: 'pfAdjustmentsMigrated', value: 'true' });
  }

  migrateFreightToPayOnlySync(engine);
  migrateCrossingDoorRefundSync(engine);
  return 0;
}

// One-off, self-healing migration: Crossing/Door Delivery/Refund were never
// posted to the firm ledger — the Firm Report waterfall (computeFirmSettlement)
// has always deducted them, the ledger simply never had the line items. Scoped
// to challans that already have a 'freight' row (i.e. already went through
// createLedgerEntriesSync) — a challan that was never saved never got a ledger
// chain and shouldn't get one now. Idempotent per category per challan, so a
// re-run (or a challan that already has one of the three) is a no-op.
function migrateCrossingDoorRefundSync(engine) {
  const done = engine.get('settings', 'crossingDoorRefundMigrated');
  if (done && done.value === 'true') return { examined: 0, added: 0 };

  const challanIds = new Set(engine.query('firmLedger', { whereCol: 'category', equals: 'freight' }).map(r => r.challanId));
  const challanMap = new Map(engine.all('challans').map(c => [c.id, c]));
  const entriesByChallan = new Map();
  for (const e of engine.query('lrEntries', { whereCol: 'status', equals: 'active' }).filter(e => !e.deletedAt)) {
    if (!entriesByChallan.has(e.challanId)) entriesByChallan.set(e.challanId, []);
    entriesByChallan.get(e.challanId).push(e);
  }

  let examined = 0;
  let added = 0;
  const firmNames = new Set();
  const now = new Date().toISOString();

  for (const challanId of challanIds) {
    examined++;
    const challan = challanMap.get(challanId);
    if (!challan) continue;
    const existing = new Set(engine.query('firmLedger', { whereCol: 'challanId', equals: challanId }).map(r => r.category));

    const entries = entriesByChallan.get(challanId) || [];
    const crossing = entries.reduce((s, e) => s + (e.crossing || 0), 0);
    const doorDelivery = entries.reduce((s, e) => s + (e.doorDelivery || 0), 0);
    const refund = entries.reduce((s, e) => s + (e.refund || 0), 0);

    const toAdd = [];
    if (crossing > 0 && !existing.has('crossing')) toAdd.push(['crossing', crossing, 'Crossing']);
    if (doorDelivery > 0 && !existing.has('door_delivery')) toAdd.push(['door_delivery', doorDelivery, 'Door delivery']);
    if (refund > 0 && !existing.has('refund')) toAdd.push(['refund', refund, 'Refund']);
    if (toAdd.length === 0) continue;

    engine.transaction(() => {
      for (const [category, amount, label] of toAdd) {
        engine.add('firmLedger', {
          firmName: challan.firmName, challanId, challanNumber: challan.challanNumber, entryDate: challan.entryDate,
          type: 'credit', category, amount, description: `${label} — Challan ${challan.challanNumber}`,
          runningBalance: 0, createdAt: now,
        });
      }
    })();
    added += toAdd.length;
    firmNames.add(challan.firmName);
  }

  for (const firmName of firmNames) recomputeFirmLedgerSync(engine, firmName);

  engine.put('settings', { key: 'crossingDoorRefundMigrated', value: 'true' });
  return { examined, added, recomputedFirms: firmNames.size };
}

function migrateFreightToPayOnlySync(engine) {
  const done = engine.get('settings', 'freightToPayOnlyMigrated');
  if (done && done.value === 'true') {
    return { examined: 0, rewritten: 0, recomputedFirms: 0, missingChallanSkipped: 0, entryEditDiffs: 0 };
  }

  const freightRows = engine.query('firmLedger', { whereCol: 'category', equals: 'freight' });
  const challanMap = new Map(engine.all('challans').map(c => [c.id, c]));
  const entriesByChallan = new Map();
  for (const e of engine.query('lrEntries', { whereCol: 'status', equals: 'active' }).filter(e => !e.deletedAt)) {
    if (!entriesByChallan.has(e.challanId)) entriesByChallan.set(e.challanId, []);
    entriesByChallan.get(e.challanId).push(e);
  }

  let examined = 0;
  let rewritten = 0;
  let missingChallanSkipped = 0;
  let entryEditDiffs = 0;
  const firmNames = new Set();

  for (const row of freightRows) {
    examined++;
    const challan = challanMap.get(row.challanId);
    if (!challan) {
      missingChallanSkipped++;
      continue;
    }

    const liveEntries = entriesByChallan.get(row.challanId) || [];
    const newToPayFreight = liveEntries
      .filter(e => e.paymentMode === 'topay')
      .reduce((s, e) => s + (e.toPay || 0), 0);
    const paidFreight = liveEntries
      .filter(e => e.paymentMode === 'paid')
      .reduce((s, e) => s + (e.paid || 0), 0);

    if (row.amount !== (newToPayFreight + paidFreight)) {
      entryEditDiffs++;
    }

    if (row.amount !== newToPayFreight) {
      engine.transaction(() => {
        engine.update('firmLedger', row.id, {
          amount: newToPayFreight,
          description: `Freight (ToPay) — Challan ${row.challanNumber}`,
        });
      })();
      rewritten++;
      firmNames.add(row.firmName);
    }
  }

  for (const firmName of firmNames) {
    recomputeFirmLedgerSync(engine, firmName);
  }

  engine.put('settings', { key: 'freightToPayOnlyMigrated', value: 'true' });

  return {
    examined,
    rewritten,
    recomputedFirms: firmNames.size,
    missingChallanSkipped,
    entryEditDiffs,
  };
}

// Exact port of src/pages/FirmLedgerPage.tsx addManualEntry. THE FIX (both
// bugs at once): the old code anchored off `entries[entries.length-1]` — a
// value read in a PREVIOUS round trip, and not even sorted by entryDate — then
// never recomputed. Here the row is added with a placeholder balance (like
// saveChallanAdjustmentsSync does) and the trailing recompute both closes the
// race window AND fixes the backdating bug for free, since it sorts
// chronologically. Returns the freshly recomputed row so the caller's audit
// log can show the TRUE post-entry balance instead of a stale guess.
function addManualEntrySync(engine, firmName, type, category, amount, description, entryDate) {
  // Wrapped so the insert + recompute land atomically.
  const id = engine.transaction(() => {
    const newId = engine.add('firmLedger', {
      firmName, challanId: 0, challanNumber: '—', entryDate, type, category, amount, description,
      runningBalance: 0, createdAt: new Date().toISOString(),
    });
    recomputeFirmLedgerSync(engine, firmName);
    return newId;
  })();
  const row = engine.get('firmLedger', id);
  return { id, runningBalance: row.runningBalance };
}

module.exports = {
  computeFreightAndDC,
  createLedgerEntriesSync,
  createLedgerEntriesForChallanSync,
  recomputeFirmLedgerSync,
  recordFirmSettlementSync,
  saveChallanAdjustmentsSync,
  migratePfAdjustmentsSync,
  migrateFreightToPayOnlySync,
  migrateCrossingDoorRefundSync,
  addManualEntrySync,
};
