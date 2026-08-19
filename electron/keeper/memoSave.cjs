// Atomic memo-save: status check -> challan update -> DR generation -> firm-ledger
// creation, all inside ONE serializeWrite turn so two seats racing "Save Memo" on
// the same memo can never both pass the checks and double the ledger / duplicate
// the DRs. Ported from src/db/database.ts's generateDRs/createLedgerEntries to run
// synchronously against the engine's in-process functions (no IPC between steps)
// — same math, same rules, just executed keeper-side in one turn instead of N.

const safeguard = require('./safeguard.cjs');

function drFreight(entry) { return entry.toPay > 0 ? entry.toPay : 0; }
function collectibleAmount(entry) { return Math.max(0, entry.total || 0); }
const bsYearPrefix = () => `${String(new Date().getFullYear()).slice(2)}-`;

function generateDRsSync(engine, challan, entries) {
  for (const entry of entries) {
    const existing = engine.all('drs').filter(d => d.lrEntryId === entry.id && !d.deletedAt)[0] || null;

    if (existing) {
      // Same freeze rule as updateDRCharges: once a DR's wasuli is assigned to an
      // agent or collected, its amounts are never silently rewritten by a re-save.
      const w = engine.all('wasuli').filter(x => x.drId === existing.id && !x.deletedAt)[0] || null;
      const wasuliLocked = !!w && (w.status !== 'pending' || w.operatorId !== 0);
      if (!wasuliLocked) {
        engine.update('drs', existing.id, {
          consignor: entry.consignor, consignee: entry.consignee, fromStation: entry.fromStation,
          lrNumber: entry.lrNumber, particulars: entry.particulars, quantity: entry.quantity,
          bookingDate: entry.bookingDate,
          freight: drFreight(entry),
          cartage: entry.cartage, hamali: entry.hamali, godownBhada: entry.godownBhada,
          godownInsurance: entry.otherCharges, deliveryCharges: entry.deliveryCharges,
          pf: entry.pf,
          total: collectibleAmount(entry),
        });
        const collectible = collectibleAmount(entry);
        if (w) {
          engine.update('wasuli', w.id, { amountToCollect: collectible, consigneeName: entry.consignee });
        } else {
          engine.add('wasuli', {
            lrEntryId: entry.id, challanId: challan.id, drId: existing.id,
            operatorId: 0, consigneeName: entry.consignee, amountToCollect: collectible,
            assignedDate: '', status: 'pending', notes: '',
          });
        }
      }
      continue;
    }

    const d = new Date();
    const drData = {
      lrEntryId: entry.id, challanId: challan.id, challanNumber: challan.challanNumber,
      firmName: challan.firmName, consignor: entry.consignor,
      consignee: entry.consignee, fromStation: entry.fromStation, truckNumber: challan.truckNumber, lrNumber: entry.lrNumber,
      particulars: entry.particulars, quantity: entry.quantity,
      bookingDate: entry.bookingDate,
      deliveryDate: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      freight: drFreight(entry),
      cartage: entry.cartage, hamali: entry.hamali, godownBhada: entry.godownBhada,
      godownInsurance: entry.otherCharges,
      deliveryCharges: entry.deliveryCharges,
      pf: entry.pf,
      otherCharges: 0, total: collectibleAmount(entry), status: 'pending',
    };
    // Atomic compute+insert — same primitive that already guarantees BS numbers
    // never collide across seats.
    const res = engine.addWithNumber('drs', drData, 'drNumber', bsYearPrefix());
    const drId = res.id;
    const collectible = collectibleAmount(entry);
    // Crossing DRs (paid at origin by another firm) collect nothing but still need
    // a delivery receipt, an assigned agent, and proof of delivery back. Every DR
    // gets a wasuli row; amountToCollect just happens to be 0 for these. Never
    // delete a wasuli row because its amount fell to zero — that erases the
    // assignment record along with it.
    engine.add('wasuli', {
      lrEntryId: entry.id, challanId: challan.id, drId,
      operatorId: 0, consigneeName: entry.consignee, amountToCollect: collectible,
      assignedDate: '', status: 'pending', notes: '',
    });
  }
}

// Freight + DC computation and ledger-row creation now live in firmLedger.cjs
// (createLedgerEntriesSync) — the one function every write path shares, so this
// file can no longer drift into a second, silently-diverging copy of it.
const { createLedgerEntriesSync } = require('./firmLedger.cjs');

// Whole "Save Memo" sequence in one synchronous pass. MUST be called by the
// caller inside serializeWrite so no other write — including a second seat's
// saveMemo call for the SAME memo — can land between the status check and the
// writes below.
function saveMemo(engine, challanId, seat) {
  const challan = engine.get('challans', challanId);
  if (!challan) return { ok: false, reason: 'not-found' };
  if (challan.status === 'saved') return { ok: false, reason: 'already-saved' };

  // Sorted by srNo — the order the operator sees on the challan screen — not id
  // (insertion) order, which engine.all() returns bare with no ORDER BY. Without
  // this, generateDRsSync below allocates BS numbers in whatever order two
  // racing seats' INSERTs landed in, not the order the memo displays.
  const liveEntries = engine.all('lrEntries')
    .filter(e => e.challanId === challanId && e.status === 'active' && !e.deletedAt)
    .sort((a, b) => a.srNo - b.srNo);
  if (liveEntries.length === 0) return { ok: false, reason: 'no-entries' };

  const totalToPay = liveEntries.filter(e => e.paymentMode === 'topay').reduce((s, e) => s + e.toPay, 0);
  const totalPaid = liveEntries.filter(e => e.paymentMode === 'paid').reduce((s, e) => s + e.paid, 0);

  engine.update('challans', challanId, {
    status: 'saved', totalToPay, totalPaid, totalEntries: liveEntries.length,
    updatedAt: new Date().toISOString(), savedSeat: seat || '',
  });

  generateDRsSync(engine, challan, liveEntries);
  createLedgerEntriesSync(engine, challan, liveEntries);

  return { ok: true, totalToPay, totalPaid, totalEntries: liveEntries.length };
}

// One-time migration to backfill wasuli rows for existing historical crossing DRs
// that were saved before wasuli creation was made unconditional.
function backfillCrossingWasuliSync(engine) {
  const done = engine.get('settings', 'crossingWasuliBackfilled');
  if (done && done.value === 'true') return 0;

  const drs = engine.all('drs').filter(d => !d.deletedAt);
  const wasuliDrIds = new Set(engine.all('wasuli').filter(w => !w.deletedAt).map(w => w.drId));

  let createdCount = 0;
  for (const dr of drs) {
    if (!wasuliDrIds.has(dr.id)) {
      engine.transaction(() => {
        engine.add('wasuli', {
          lrEntryId: dr.lrEntryId,
          challanId: dr.challanId,
          drId: dr.id,
          operatorId: 0,
          consigneeName: dr.consignee || '',
          amountToCollect: 0,
          assignedDate: '',
          status: 'pending',
          notes: '',
        });
      })();
      createdCount++;
    }
  }

  engine.put('settings', { key: 'crossingWasuliBackfilled', value: 'true' });
  if (createdCount > 0) {
    safeguard.audit('crossing-wasuli-backfill', { createdCount });
    console.log(`[keeper] Crossing wasuli backfill: created ${createdCount} missing wasuli rows.`);
  }
  return createdCount;
}

module.exports = { saveMemo, backfillCrossingWasuliSync };
