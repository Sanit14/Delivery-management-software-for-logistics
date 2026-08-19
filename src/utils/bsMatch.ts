import { bsYearPrefix } from '../db/database';

/**
 * bsMatch — quick BS-number matching for the year-prefixed series ("26-00047").
 *
 * The rule the office asked for: typing just "47" should find this year's
 * "26-00047" without typing the year (the current year is assumed). Typing a
 * full number with a year ("25-00047") still finds old series exactly, and the
 * legacy plain series from before the year format ("00047") keeps matching too.
 *
 * Used in three places: the Wasuli assign box, the Wasuli collect box, and the
 * dashboard search bar. All share this one matcher so behaviour is identical.
 */

/** The counter part of a BS number: "26-00047" → "00047"; legacy "00047" → "00047". */
const bsNumericPart = (n: string): string => {
  const i = n.lastIndexOf('-');
  return i >= 0 ? n.slice(i + 1) : n;
};

/** Canonical digits for comparing: strips leading zeros ("00047" → "47"). */
const canon = (s: string): string => s.replace(/^0+/, '') || '0';

interface BsCandidate {
  drNumber: string;
  lrNumber?: string;
}

/**
 * Ranks candidates against what the user typed. Returns the best matches first:
 *  1. exact full match of what was typed ("26-00047" typed in full, or an LR
 *     number typed exactly when includeLr is on)
 *  2. current-year match on bare digits ("47" → this year's "26-00047")
 *  3. same digits in another series (older years / legacy plain numbers)
 *  4. substring anywhere (catch-all, e.g. partial typing — also checks the LR
 *     number when includeLr is on)
 *
 * includeLr defaults to false so existing callers (the dashboard search bar
 * already has its own separate, correctly-labeled LR search) are unaffected —
 * only callers that want a single box to accept either identifier turn it on.
 */
export function bsMatches<T extends BsCandidate>(candidates: T[], rawQuery: string, limit = 6, includeLr = false): T[] {
  const q = rawQuery.trim();
  if (!q) return [];
  const cur = bsYearPrefix();
  const qHasYear = q.includes('-');
  const qDigits = canon(bsNumericPart(q));

  const scored: { d: T; score: number }[] = [];
  for (const d of candidates) {
    const n = d.drNumber;
    let score = -1;
    if (n === q) score = 100;
    else if (qHasYear && n.startsWith(q)) score = 80;
    else if (!qHasYear && n.startsWith(cur) && canon(bsNumericPart(n)) === qDigits) score = 90;
    else if (!qHasYear && canon(bsNumericPart(n)) === qDigits) score = 70;
    else if (n.includes(q)) score = 40;
    // LR number has no year-prefix concept of its own — exact match ranks
    // with exact BS match, partial typing with the BS catch-all substring tier.
    if (includeLr && d.lrNumber) {
      if (d.lrNumber === q) score = Math.max(score, 100);
      else if (d.lrNumber.includes(q)) score = Math.max(score, 40);
    }
    if (score >= 0) scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score || b.d.drNumber.localeCompare(a.d.drNumber));
  return scored.slice(0, limit).map(s => s.d);
}

/**
 * Resolves typed input to ONE full BS number for immediate action (Enter key):
 * an exact full match wins outright; otherwise, if the ranked matches contain a
 * single clear numeric match (score ≥ 70 tier — current-year or same-digits),
 * that one is used. Returns null when nothing matches or it's ambiguous, in
 * which case the caller shows the dropdown / not-found message instead.
 *
 * With includeLr on, an exact LR match resolves the same way — but only when
 * it's unambiguous. LR numbers aren't guaranteed unique (Task 2 only warns on
 * a duplicate, never blocks it), so two DRs sharing an LR correctly fall
 * through to null here — the caller shows the dropdown so the office picks
 * the right one instead of the wrong one being silently assigned.
 */
export function resolveBs<T extends BsCandidate>(candidates: T[], rawQuery: string, includeLr = false): T | null {
  const q = rawQuery.trim();
  if (!q) return null;
  const exact = candidates.find(d => d.drNumber === q);
  if (exact) return exact;
  if (includeLr) {
    const lrExact = candidates.filter(d => d.lrNumber === q);
    if (lrExact.length === 1) return lrExact[0];
    if (lrExact.length > 1) return null; // ambiguous LR — let the dropdown disambiguate
  }
  const cur = bsYearPrefix();
  const qDigits = canon(bsNumericPart(q));
  if (q.includes('-')) return null; // year typed but no exact match — don't guess
  const currentYear = candidates.filter(d => d.drNumber.startsWith(cur) && canon(bsNumericPart(d.drNumber)) === qDigits);
  if (currentYear.length === 1) return currentYear[0];
  if (currentYear.length > 1) return null; // ambiguous within the year (shouldn't happen)
  const anySeries = candidates.filter(d => canon(bsNumericPart(d.drNumber)) === qDigits);
  return anySeries.length === 1 ? anySeries[0] : null;
}
