// Atomic "learn a master-data value" — mirrors src/utils/masterData.ts's
// learnValues, but executed keeper-side inside ONE serializeWrite turn (see the
// server route) so two seats learning the same brand-new firm/station/plain
// value at the same moment can never compute the same next code, or insert two
// rows for the same value. Same pattern as memoSave.cjs's atomic Save Memo.

function codeTypeOf(field) {
  if (field === 'firmName') return 'firm';
  if (field === 'loadingStation' || field === 'fromStation') return 'station';
  return null;
}
function canonicalField(codeType) { return codeType === 'firm' ? 'firmName' : 'loadingStation'; }

function findCoded(engine, codeType, value) {
  const field = canonicalField(codeType);
  const v = value.trim().toLowerCase();
  return engine.all('masterData').find(r => r.field === field && r.value.trim().toLowerCase() === v) || null;
}

function nextCode(engine, codeType) {
  const field = canonicalField(codeType);
  const rows = engine.all('masterData').filter(r => r.field === field);
  return rows.reduce((m, r) => Math.max(m, r.code || 0), 0) + 1;
}

// One { field, value } pair — same rules as learnValues() in masterData.ts.
function learnOne(engine, field, value) {
  if (!value || !value.trim()) return;
  const trimmed = value.trim();
  const codeType = codeTypeOf(field);

  if (codeType) {
    const canon = canonicalField(codeType);
    const existing = findCoded(engine, codeType, trimmed);
    if (existing) {
      engine.update('masterData', existing.id, { useCount: (existing.useCount || 0) + 1 });
    } else {
      const code = nextCode(engine, codeType);
      engine.add('masterData', { field: canon, value: trimmed, useCount: 1, code });
    }
  } else {
    const existing = engine.all('masterData').find(r => r.field === field && r.value === trimmed) || null;
    if (existing) {
      engine.update('masterData', existing.id, { useCount: (existing.useCount || 0) + 1 });
    } else {
      engine.add('masterData', { field, value: trimmed, useCount: 1 });
    }
  }
}

// `pairs`: [{ field, value }, ...] — same shape learnValues() takes. Runs the
// whole batch as one synchronous pass; the caller wraps this in serializeWrite
// (see the server route) so no other write, including another learn call from a
// different seat, can land mid-batch.
function learn(engine, pairs) {
  for (const { field, value } of (pairs || [])) learnOne(engine, field, value);
  return true;
}

// Manually add a coded entity (firm/station) — the Master Data admin "Add"
// form's atomic counterpart to learnOne. Same field-scoped code sequence
// (reuses findCoded/nextCode), but REFUSES (returns null, touches nothing)
// instead of bumping useCount when the name already exists, and starts
// useCount at 0 — a manual add, not a learned-from-typing use — while
// forwarding the optional `details` field learnOne doesn't carry. Runs inside
// the caller's serializeWrite turn, so two seats adding two different new
// firms/stations at once can never land on the same code.
function addCoded(engine, field, value, details) {
  const codeType = codeTypeOf(field);
  if (!codeType) return null;
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (findCoded(engine, codeType, trimmed)) return null; // already exists
  const canon = canonicalField(codeType);
  const code = nextCode(engine, codeType);
  const id = engine.add('masterData', { field: canon, value: trimmed, useCount: 0, code, details });
  return { id, code };
}

module.exports = { learn, addCoded };
