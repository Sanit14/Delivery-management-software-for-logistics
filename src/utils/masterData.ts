import { db, sqlClient } from '../db/database';

// Which master-data fields are "coded" entity types, and their normalized code-type.
// loadingStation + fromStation are the same real-world entity ("station") so they share codes.
export function codeTypeOf(field: string): 'firm' | 'station' | null {
  if (field === 'firmName') return 'firm';
  if (field === 'loadingStation' || field === 'fromStation') return 'station';
  return null;
}

// The canonical field used to store a coded type's records, so a station has ONE code
// regardless of whether it was typed as loadingStation or fromStation.
function canonicalField(codeType: 'firm' | 'station'): string {
  return codeType === 'firm' ? 'firmName' : 'loadingStation';
}

// Find an existing coded record for a value (case-insensitive, trimmed), searching the canonical field.
export async function findCoded(codeType: 'firm' | 'station', value: string) {
  const field = canonicalField(codeType);
  const v = value.trim().toLowerCase();
  const rows = await db.masterData.where('field').equals(field).toArray();
  return rows.find(r => r.value.trim().toLowerCase() === v) || null;
}

// Learn values from entry. Coded types get a code (creating canonical record if new).
// Runs as ONE atomic keeper turn (learnMasterData) so two seats learning the
// same brand-new value at the same moment can't create duplicate rows or
// duplicate codes — same primitive class as addWithNumber for BS/DR numbers.
export async function learnValues(pairs: { field: string; value: string }[]) {
  if (typeof window !== 'undefined' && window.sqlAPI?.learnMasterData) {
    await window.sqlAPI.learnMasterData(pairs);
    return;
  }
}

// Suggestions for autocomplete. For coded types, also matches by code (typing "27" finds code 27).
export async function getSuggestions(field: string, query: string): Promise<{ value: string; code?: number }[]> {
  if (!query?.trim()) return [];
  const q = query.trim().toLowerCase();
  const codeType = codeTypeOf(field);
  const searchField = codeType ? canonicalField(codeType) : field;

  const rows = await db.masterData.where('field').equals(searchField).toArray();
  const qNum = q.replace(/^0+/, '') || q;
  const matches = rows.filter(r => {
    const nameHit = r.value.toLowerCase().startsWith(q);
    const codeHit = !!codeType && r.code != null && String(r.code).startsWith(qNum);
    return nameHit || codeHit;
  });
  matches.sort((a, b) => b.useCount - a.useCount);
  return matches.slice(0, 8).map(r => ({ value: r.value, code: r.code }));
}

// Format a code as a 4-digit padded string (27 -> "0027")
export function fmtCode(code?: number): string {
  return code != null ? String(code).padStart(4, '0') : '';
}

// ── Master Data admin helpers ──────────────────────────────────────────────

export interface MasterEntity {
  id: number;
  name: string;
  code?: number;
  useCount: number;
  details?: string;
}

// List all coded entities of a type, sorted by code
export async function listEntities(codeType: 'firm' | 'station'): Promise<MasterEntity[]> {
  const field = codeType === 'firm' ? 'firmName' : 'loadingStation';
  const rows = await db.masterData.where('field').equals(field).toArray();
  return rows
    .map(r => ({ id: r.id!, name: r.value, code: r.code, useCount: r.useCount, details: r.details }))
    .sort((a, b) => (a.code || 0) - (b.code || 0));
}

// Manually add a coded entity (firm/station). Returns the new code, or null if it already exists.
// Runs as ONE atomic keeper turn (addCodedMasterData) — same primitive class
// as learnMasterData, but field-scoped and REFUSING (instead of bumping
// useCount) on an existing name — so two seats adding two different new
// firms/stations at once can't land on the same code.
export async function addEntity(codeType: 'firm' | 'station', name: string, details?: string): Promise<number | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const existing = await findCoded(codeType, trimmed);
  if (existing) return null; // already exists
  const canon = codeType === 'firm' ? 'firmName' : 'loadingStation';

  const res = await window.sqlAPI!.addCodedMasterData!(canon, trimmed, details);
  return res ? res.code : null;
}

// Edit an entity's name and/or details (code stays the same)
export async function editEntity(id: number, name: string, details?: string): Promise<void> {
  await db.masterData.update(id, { value: name.trim(), details });
}

// Atomically add a new agent/operator with a keeper-assigned code — same
// primitive class as addEntity/BS/DR numbers (addWithNumber), so two seats
// adding an agent at once can never collide on the same code.
export async function addOperator(name: string, phone: string): Promise<number> {
  const trimmed = name.trim();
  const trimmedPhone = phone.trim();

  // addWithNumber always returns a 6-digit zero-padded STRING (same as it
  // does for BS/DR numbers) — parse it back to a plain int and fix the row,
  // exactly like ChallanDetail.tsx already does for srNo.
  const res = await sqlClient!.addWithNumber('operators', { name: trimmed, phone: trimmedPhone, active: true }, 'code', '');
  const code = parseInt(String(res.code), 10);
  await db.operators.update(res.id, { code });
  return code;
}

// Levenshtein edit distance (small strings, fine for names)
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// Near-exact duplicate check for coded types. Returns an existing record if the typed value
// is an EXACT match OR a very-close spelling variant (typo/spacing/case), else null.
// 'exact' flag tells the caller whether it's identical (no popup needed) or near (popup needed).
export interface DuplicateMatch { value: string; code?: number; exact: boolean; }

export async function checkDuplicate(field: string, value: string): Promise<DuplicateMatch | null> {
  if (!value?.trim()) return null;
  const codeType = codeTypeOf(field);
  // Coded types (firm/station) compare against their canonical field, so a
  // station typed as either loadingStation or fromStation still matches the
  // same master list. Plain fields (consignor, consignee) compare directly
  // against their own field — they were never numbered, but the same fuzzy
  // spelling check still applies to them.
  const lookupField = codeType ? (codeType === 'firm' ? 'firmName' : 'loadingStation') : field;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const target = norm(value);
  const rows = await db.masterData.where('field').equals(lookupField).toArray();

  // exact match first
  const exact = rows.find(r => norm(r.value) === target);
  if (exact) return { value: exact.value, code: exact.code, exact: true };

  // near-exact: edit distance threshold scaled to length (1 for short, 2 for longer names)
  let best: { r: typeof rows[number]; d: number } | null = null;
  for (const r of rows) {
    const d = editDistance(norm(r.value), target);
    const threshold = target.length <= 5 ? 1 : 2;
    if (d > 0 && d <= threshold && (!best || d < best.d)) best = { r, d };
  }
  if (best) return { value: best.r.value, code: best.r.code, exact: false };
  return null;
}

// ── Delete + usage-check helpers for Master Data management ──

// How many live challans reference this firm / station value
export async function countChallanUsage(codeType: 'firm' | 'station', value: string): Promise<number> {
  const v = value.trim().toLowerCase();
  const challans = await db.challans.filter(c => !c.deletedAt).toArray();
  if (codeType === 'firm') return challans.filter(c => c.firmName.trim().toLowerCase() === v).length;
  return challans.filter(c => c.loadingStation.trim().toLowerCase() === v).length;
}

// Delete a coded master entry (firm/station). Returns false if blocked (none currently blocked,
// but kept for symmetry). Challans keep their text value; this only removes the master/autocomplete record.
export async function deleteEntity(id: number): Promise<void> {
  await db.masterData.delete(id);
}

// Delete a truck master entry by value
export async function deleteTruck(value: string): Promise<void> {
  const row = await db.masterData.where('field').equals('truckNumber').filter(r => r.value === value).first();
  if (row?.id) await db.masterData.delete(row.id);
}

// Edit a truck's value (renames the master record)
export async function editTruck(oldValue: string, newValue: string): Promise<void> {
  const row = await db.masterData.where('field').equals('truckNumber').filter(r => r.value === oldValue).first();
  if (row?.id) await db.masterData.update(row.id, { value: newValue.trim() });
}

// How many wasuli records are assigned to an agent (operator) — to guard deletion
export async function countAgentUsage(operatorId: number): Promise<number> {
  return (await db.wasuli.filter(w => w.operatorId === operatorId && !w.deletedAt).toArray()).length;
}

// ── Duplicate cleanup (merge) ──────────────────────────────────────────────
// Mergeable master-data types the cleanup screen offers. 'station' spans
// loadingStation+fromStation (one pool). 'operator' is a real table (id-based).
// Particulars is deliberately NOT here — it can carry per-consignment detail, so
// merging it could overwrite real data.
export type MergeType = 'firmName' | 'station' | 'truckNumber' | 'consignor' | 'consignee' | 'operator';

export const MERGE_TYPE_LABELS: Record<MergeType, string> = {
  firmName: 'Firms', station: 'Stations', truckNumber: 'Trucks',
  consignor: 'Consignors', consignee: 'Consignees', operator: 'Agents',
};

// The merge-engine field name (what the keeper's /merge route expects) for a type.
// For strings it's the type itself; for stations the engine keys on 'station';
// for operators, 'operator' (id-based).
export function mergeFieldFor(t: MergeType): string { return t; }

export interface MergeCandidate {
  // Each candidate is a value + its use count + the raw key to send to the merge
  // engine (string value, or operator id).
  value: string; useCount: number; key: string | number;
}
export interface DuplicateGroup { members: MergeCandidate[]; }

// Read all values of a mergeable type as candidates.
async function readCandidates(t: MergeType): Promise<MergeCandidate[]> {
  if (t === 'operator') {
    const ops = await db.operators.toArray();
    const counts = new Map<number, number>();
    for (const w of await db.wasuli.filter(w => !w.deletedAt).toArray()) {
      counts.set(w.operatorId, (counts.get(w.operatorId) || 0) + 1);
    }
    return ops.map(o => ({ value: o.name, useCount: counts.get(o.id!) || 0, key: o.id! }));
  }
  // station reads its canonical field; others read their own field.
  const field = t === 'station' ? 'loadingStation' : t;
  const rows = await db.masterData.where('field').equals(field).toArray();
  return rows.map(r => ({ value: r.value, useCount: r.useCount || 0, key: r.value }));
}

// Group values that are exact (case/space-insensitive) or near-exact spelling
// variants of each other. Only groups with 2+ members are returned. Reuses the
// same editDistance the entry-time duplicate check uses, so "duplicate" means the
// same thing here as it does when typing.
export async function findDuplicateGroups(t: MergeType): Promise<DuplicateGroup[]> {
  const cands = await readCandidates(t);
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const used = new Set<number>();
  const groups: DuplicateGroup[] = [];
  for (let i = 0; i < cands.length; i++) {
    if (used.has(i)) continue;
    const group = [cands[i]];
    const base = norm(cands[i].value);
    for (let j = i + 1; j < cands.length; j++) {
      if (used.has(j)) continue;
      const other = norm(cands[j].value);
      const threshold = Math.max(base.length, other.length) <= 5 ? 1 : 2;
      if (editDistance(base, other) <= threshold) { group.push(cands[j]); used.add(j); }
    }
    if (group.length > 1) { used.add(i); groups.push({ members: group.sort((a, b) => b.useCount - a.useCount) }); }
  }
  return groups;
}

