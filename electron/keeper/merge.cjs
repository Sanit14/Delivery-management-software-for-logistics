// ── Master-data merge ─────────────────────────────────────────────────────────
// Fast typing on the challan page creates near-duplicate master values
// ("nagpur" and "nagp"), each with real transactional rows attached. Merging
// folds one into the other: every transactional row carrying the OLD value is
// rewritten to the KEPT value, then the old master row is removed.
//
// Transactional tables store the master value as a STRING inside the row's json
// (challans.firmName = "nagp"), NOT a foreign key — so a merge is just
// "rewrite the string wherever it appears". No id columns, no migration.
// Operators are the one exception: they are a real table (operators.id) and
// wasuli references operatorId, so that pair rewrites an id, not a string.
//
// This module is pure logic over the engine's own helpers (all/put/del/get).
// The engine wires it into serializeWrite + a prerestore snapshot + generation
// bump, exactly like restore — so a bad merge is recoverable from backup and
// every seat reloads.

// Which transactional tables carry each mergeable field, and under which key in
// their json. Derived directly from the schema in src/db/database.ts.
const FIELD_MAP = {
  firmName:   [['challans', 'firmName'], ['firmLedger', 'firmName'], ['drs', 'firmName']],
  station:    [['challans', 'loadingStation'], ['challans', 'fromStation'],
               ['lrEntries', 'fromStation'], ['drs', 'fromStation']],
  consignor:  [['lrEntries', 'consignor']],
  consignee:  [['lrEntries', 'consignee'], ['drs', 'consignee'], ['wasuli', 'consigneeName']],
  truckNumber:[['challans', 'truckNumber'], ['drs', 'truckNumber']],
};

// masterData.field value that stores each mergeable type, so we can fold the
// master row itself after rewriting references.
const MASTER_FIELD = {
  firmName: 'firmName', station: 'loadingStation',
  consignor: 'consignor', consignee: 'consignee', truckNumber: 'truckNumber',
};

// Count how many rows each table would change — shown in the confirm popup
// BEFORE anything is written. Read-only.
function countImpact(engine, field, from) {
  if (field === 'operator') return countOperatorImpact(engine, from);
  const out = {};
  for (const [table, jsonKey] of (FIELD_MAP[field] || [])) {
    const n = engine.all(table).filter(r => r[jsonKey] === from).length;
    if (n) out[table] = (out[table] || 0) + n;
  }
  return out;
}

function countOperatorImpact(engine, fromId) {
  const n = engine.all('wasuli').filter(r => r.operatorId === fromId).length;
  return n ? { wasuli: n } : {};
}

// Perform the merge. `from`/`to` are string values for firm/station/consignor/
// consignee/truck; for operators they are operator ids. Returns per-table counts
// of what changed. Caller (engine) runs this inside serializeWrite after taking a
// prerestore snapshot, then bumps the generation.
function mergeMasterValue(engine, field, from, to) {
  if (from === to) return {};
  if (field === 'operator') return mergeOperator(engine, from, to);

  const changed = {};
  for (const [table, jsonKey] of (FIELD_MAP[field] || [])) {
    for (const row of engine.all(table)) {
      if (row[jsonKey] !== from) continue;
      engine.put(table, { ...row, [jsonKey]: to });
      changed[table] = (changed[table] || 0) + 1;
    }
  }
  foldMasterRow(engine, MASTER_FIELD[field], from, to);
  return changed;
}

// Move wasuli rows from the old operator id to the kept one, add the old
// operator's useCount-equivalent nowhere (operators have no useCount), then
// delete the old operator row.
function mergeOperator(engine, fromId, toId) {
  let n = 0;
  for (const row of engine.all('wasuli')) {
    if (row.operatorId !== fromId) continue;
    engine.put('wasuli', { ...row, operatorId: toId });
    n += 1;
  }
  const old = engine.get('operators', fromId);
  if (old) engine.del('operators', fromId);
  return n ? { wasuli: n } : {};
}

// Fold the duplicate masterData row into the canonical one: add its useCount to
// the kept row, then delete it. Matches on field + value (case-sensitive, since
// the caller passes the exact stored strings).
function foldMasterRow(engine, masterField, fromVal, toVal) {
  const rows = engine.all('masterData')
    .filter(r => r.field === masterField);
  const fromRow = rows.find(r => r.value === fromVal);
  const toRow   = rows.find(r => r.value === toVal);
  if (!fromRow) return;
  if (toRow) {
    engine.put('masterData', {
      ...toRow,
      useCount: (toRow.useCount || 0) + (fromRow.useCount || 0),
    });
  }
  engine.del('masterData', fromRow.id);
}

// ── Challan duplicate merge ────────────────────────────────────────────────
// Merges two open challans that share firm + challan number.

// ponytail: gate on collected cash, not on the existence of DRs. Reopen preserves
// drs/wasuli by design, so has-drs refused every legitimately reopened challan.
// Pending and assigned both re-parent safely — the DR keeps its BS number, the
// wasuli keeps its operatorId, only challanId moves. Collected is the real line:
// cash is already booked against a challan we're about to fold away.

function challanMergeEligibility(engine, primaryId, secondaryId) {
  if (primaryId === secondaryId) return { ok: false, reason: 'same-challan' };
  const primary   = engine.get('challans', primaryId);
  const secondary = engine.get('challans', secondaryId);
  if (!primary || !secondary) return { ok: false, reason: 'not-found' };
  if (primary.deletedAt || secondary.deletedAt) return { ok: false, reason: 'deleted' };
  if (primary.status !== 'open' || secondary.status !== 'open') return { ok: false, reason: 'not-open' };
  if (primary.firmName.trim().toLowerCase() !== secondary.firmName.trim().toLowerCase())
    return { ok: false, reason: 'firm-mismatch' };
  if (primary.challanNumber.trim() !== secondary.challanNumber.trim())
    return { ok: false, reason: 'number-mismatch' };

  if (engine.all('wasuli').some(w => (w.challanId === primaryId || w.challanId === secondaryId) && !w.deletedAt && w.status === 'collected'))
    return { ok: false, reason: 'has-collected' };

  const primaryEntries   = engine.all('lrEntries').filter(e => e.challanId === primaryId   && !e.deletedAt && e.status === 'active');
  const secondaryEntries = engine.all('lrEntries').filter(e => e.challanId === secondaryId && !e.deletedAt && e.status === 'active');
  const primaryMax  = primaryEntries.length   ? Math.max(...primaryEntries.map(e => e.srNo))   : 0;
  const primaryMin  = primaryEntries.length   ? Math.min(...primaryEntries.map(e => e.srNo))   : null;

  const secondaryWasuli = engine.all('wasuli').filter(w => w.challanId === secondaryId && !w.deletedAt);
  const secondaryPendingWasuli = secondaryWasuli.filter(w => w.status === 'pending' && (w.operatorId === 0 || !w.operatorId)).length;
  const secondaryAssignedWasuli = secondaryWasuli.filter(w => w.status !== 'collected' && w.operatorId !== 0).length;
  const secondaryDrCount = engine.all('drs').filter(d => d.challanId === secondaryId && !d.deletedAt).length;

  const total = primaryEntries.length + secondaryEntries.length;
  const resultSrMax = primaryEntries.length ? primaryMax + secondaryEntries.length : (secondaryEntries.length || null);
  const isContiguous = (primaryEntries.length === 0) || (primaryMin === 1 && primaryMax === primaryEntries.length);

  return {
    ok: true,
    primaryCount: primaryEntries.length, primarySrMin: primaryMin, primarySrMax: primaryMax,
    secondaryCount: secondaryEntries.length,
    secondaryDrCount,
    secondaryPendingWasuli,
    secondaryAssignedWasuli,
    total, resultSrMin: primaryEntries.length ? primaryMin : 1, resultSrMax, isContiguous,
    keepCount: primaryEntries.length, keepSrMin: primaryMin, keepSrMax: primaryMax,
    removeCount: secondaryEntries.length,
  };
}

// Performs the merge inside a transaction (caller wraps this). Re-runs eligibility
// as the authoritative gate — never trusts the caller's prior check.
function mergeChallans(engine, primaryId, secondaryId) {
  const eligibility = challanMergeEligibility(engine, primaryId, secondaryId);
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };

  const primary   = engine.get('challans', primaryId);
  const secondary = engine.get('challans', secondaryId);
  if (!primary || !secondary) return { ok: false, reason: 'not-found' };

  // Winner's entries keep their srNo. Loser's live entries, sorted by srNo, are
  // appended starting at max(winner srNo) + 1. Soft-deleted entries are re-parented
  // but do not consume a new srNo (they keep a srNo of 0 so nothing references them).
  const primaryEntries = engine.all('lrEntries').filter(e => e.challanId === primaryId);
  const liveSrNos      = primaryEntries.filter(e => !e.deletedAt && e.status === 'active').map(e => e.srNo);
  let nextSr           = liveSrNos.length ? Math.max(...liveSrNos) + 1 : 1;

  const secondaryEntries = engine.all('lrEntries')
    .filter(e => e.challanId === secondaryId)
    .sort((a, b) => a.srNo - b.srNo);

  for (const e of secondaryEntries) {
    const isLive = !e.deletedAt && e.status === 'active';
    const newSr  = isLive ? nextSr++ : 0;
    engine.put('lrEntries', { ...e, challanId: primaryId, challanNumber: primary.challanNumber, srNo: newSr });
  }

  // Move DRs where challanId === secondaryId: update challanId, challanNumber, truckNumber, firmName
  for (const d of engine.all('drs')) {
    if (d.challanId === secondaryId) {
      engine.put('drs', {
        ...d,
        challanId: primaryId,
        challanNumber: primary.challanNumber,
        truckNumber: primary.truckNumber,
        firmName: primary.firmName,
      });
    }
  }

  // Move wasuli where challanId === secondaryId: set challanId to primaryId
  for (const w of engine.all('wasuli')) {
    if (w.challanId === secondaryId) {
      engine.put('wasuli', { ...w, challanId: primaryId });
    }
  }

  // Hard-delete every firmLedger row for both challans where category !== 'adjustment'
  for (const r of engine.all('firmLedger')) {
    if ((r.challanId === primaryId || r.challanId === secondaryId) && r.category !== 'adjustment') {
      engine.del('firmLedger', r.id);
    }
  }

  // Re-parent secondary adjustment rows to primary
  for (const r of engine.all('firmLedger')) {
    if (r.challanId === secondaryId && r.category === 'adjustment') {
      engine.put('firmLedger', { ...r, challanId: primaryId, challanNumber: primary.challanNumber });
    }
  }

  // Recompute firm ledger running balance
  if (typeof engine.recomputeFirmLedger === 'function') {
    engine.recomputeFirmLedger(primary.firmName);
  }

  // Soft-delete the loser challan row
  engine.put('challans', { ...secondary, deletedAt: new Date().toISOString(), status: 'cancelled' });

  return { ok: true, moved: secondaryEntries.length };
}

module.exports = { countImpact, mergeMasterValue, FIELD_MAP, challanMergeEligibility, mergeChallans };
