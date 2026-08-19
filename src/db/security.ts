import { db } from './database';

/**
 * Security model
 * ──────────────
 * SYSTEM PIN — everyday key (settings.adminPin). Opens locked pages, Settings,
 *   and admin actions. Owner-changeable, but only the Master PIN can change it
 *   — so a leaked System PIN can never be used to change itself.
 *
 * MASTER PIN — recovery key (settings.masterPin). Opens the Security page, and
 *   is the ONLY thing that can change the System PIN or remove a page lock.
 *   Owner-changeable too (it changes itself: current master → new → confirm —
 *   it's the root of trust, nothing sits above it). Seeded from MASTER_SEED on
 *   first run; isMasterDefault() tells the UI whether it still is.
 *
 * Both PINs live in delivery.db, same as everything else this app stores —
 * not a secret vault, but not compiled into the shipped bundle either, so a
 * leak is fixable in the field without a rebuild.
 *
 * PAGE PROTECTION — a list of page keys that require the System PIN, stored in
 *   settings.protectedPages. Toggled on/off from the Security page. Settings and
 *   Security themselves are ALWAYS protected and never appear in the toggle list.
 */

// Factory-reset path only — if both PINs are ever forgotten and the app is
// reinstalled, this is what a fresh install starts from. Not the live master
// key; see getMasterPin/isMasterDefault below.
const MASTER_SEED = '9119';

// Pages that can be individually PIN-toggled (Settings/Security are always
// locked and deliberately excluded). 'delivery' removed — no route uses that
// pageKey, so the toggle was a no-op.
export const TOGGLEABLE_PAGES: { key: string; label: string }[] = [
  { key: 'wasuli',      label: 'Wasuli' },
  { key: 'reports',     label: 'Reports' },
  { key: 'memos',       label: 'Saved Memos' },
  { key: 'drs',         label: 'Saved DRs' },
  { key: 'masterData',  label: 'Master Data' },
  { key: 'history',     label: 'History' },
];

// Always-protected routes (never togglable). Used internally by isPageProtected.
const ALWAYS_PROTECTED = new Set(['settings', 'security']);

export async function getMasterPin(): Promise<string> {
  const s = await db.settings.get('masterPin');
  return s?.value || MASTER_SEED;
}

// True while the owner has never set a real Master PIN — drives the "factory
// default" warning on the Security page.
export async function isMasterDefault(): Promise<boolean> {
  const s = await db.settings.get('masterPin');
  return !s?.value;
}

export async function checkMasterPin(pin: string): Promise<boolean> {
  return pin === (await getMasterPin());
}

export async function setMasterPin(newPin: string): Promise<void> {
  await db.settings.put({ key: 'masterPin', value: newPin });
}

async function getSystemPin(): Promise<string> {
  const s = await db.settings.get('adminPin');
  return s?.value || '1234';
}

// True if pin matches the System PIN OR the Master PIN (master is a universal override).
export async function checkPin(pin: string): Promise<boolean> {
  if (await checkMasterPin(pin)) return true;
  return pin === (await getSystemPin());
}

export async function setSystemPin(newPin: string): Promise<void> {
  await db.settings.put({ key: 'adminPin', value: newPin });
}

// ── Per-page protection ──
// Default protection (used until the owner customises it in Security): the pages
// that were admin-locked before this feature existed, so behaviour is unchanged
// out of the box. The owner can toggle any of these off, or protect more.
const DEFAULT_PROTECTED = ['wasuli', 'reports', 'masterData', 'history'];

export async function getProtectedPages(): Promise<string[]> {
  const s = await db.settings.get('protectedPages');
  if (!s?.value) return [...DEFAULT_PROTECTED];
  try { return JSON.parse(s.value); } catch { return [...DEFAULT_PROTECTED]; }
}
export async function isPageProtected(pageKey: string): Promise<boolean> {
  if (ALWAYS_PROTECTED.has(pageKey)) return true;
  return (await getProtectedPages()).includes(pageKey);
}
export async function setPageProtected(pageKey: string, on: boolean): Promise<void> {
  const cur = new Set(await getProtectedPages());
  if (on) cur.add(pageKey); else cur.delete(pageKey);
  await db.settings.put({ key: 'protectedPages', value: JSON.stringify([...cur]) });
}
