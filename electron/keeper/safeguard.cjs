/**
 * safeguard.cjs — runs in the keeper (main-side) process.
 *
 * Two jobs, both about surviving the "blank database" incident:
 *
 *  1. EXTERNAL AUDIT LOG — an append-only plain-text log kept OUTSIDE the data
 *     folder (in %ProgramData%\DeliveryManager\audit\, and optionally a second
 *     configured folder). Because it lives outside the data root, it survives a
 *     data-folder wipe/swap — so an incident is still analyzable afterwards.
 *     Records: app open/close, resolved db path, record counts at open, backups,
 *     restores, db-swaps, and every guard trip.
 *
 *  2. BLANK-DB GUARD — remembers the last known good record count (a tiny marker
 *     in ProgramData). If the db opens with 0 business rows but we previously had
 *     data, that's the incident signature: we DON'T overwrite the file and we
 *     signal the app to open in safe mode (restore screen) instead of silently
 *     proceeding with a blank db.
 *
 * No dependencies; plain fs. All functions are defensive (never throw into the
 * launch path — a logging failure must never stop the app).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Business tables whose row counts define "does this db have real data?".
// settings/drafts/auditLog/sqlite_sequence are excluded — a fresh db has those.
const BUSINESS_TABLES = ['challans', 'lrEntries', 'drs', 'wasuli', 'firmLedger', 'masterData', 'operators'];

function programDataBase() {
  const base = process.env.PROGRAMDATA
    || (process.platform === 'win32' ? path.join('C:\\', 'ProgramData') : path.join(os.tmpdir(), 'shared-programdata'));
  return path.join(base, 'DeliveryManager');
}
function auditDir() { return path.join(programDataBase(), 'audit'); }
// One marker PER DATA ROOT — root-change.cjs lets the active root change, and
// different sites run on different drives. A single global marker would compare
// a genuinely-empty first run on a NEW root against the OLD root's nonzero count
// and false-trip safe mode. Hash the root into the filename so each root carries
// its own last-known-good baseline. root='' (not yet known) keeps the old plain name.
function markerPath(root) {
  const suffix = root ? '-' + crypto.createHash('md5').update(String(root)).digest('hex').slice(0, 12) : '';
  return path.join(programDataBase(), `lastGood${suffix}.json`);
}

// Optional second audit folder (e.g. a network/server path). Read from a small
// config so it can be set without a code change; empty = ProgramData only.
function secondAuditDir() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(programDataBase(), 'audit-config.json'), 'utf8'));
    return (cfg && typeof cfg.secondDir === 'string') ? cfg.secondDir : '';
  } catch { return ''; }
}
function setSecondAuditDir(dir) {
  try {
    fs.mkdirSync(programDataBase(), { recursive: true });
    fs.writeFileSync(path.join(programDataBase(), 'audit-config.json'), JSON.stringify({ secondDir: dir || '' }, null, 2));
    return true;
  } catch { return false; }
}

// keeper.log — a SECOND, fixed-location mirror of every audit() line (in
// addition to the dated per-month files under auditDir()). Fixed path means
// support can find it months later without knowing where the app or data
// folder were installed. C:\DeliveryManagerLogs\ is created at install time
// with write access granted to every seat (see build/installer.nsh) — never
// admin-only, so a non-admin seat can still append. Simple append, no
// rotation.
// ponytail: unbounded growth; add a size cap/rotation if a keeper.log is ever
// reported too large to open.
const KEEPER_LOG_DIR = 'C:\\DeliveryManagerLogs';
const KEEPER_LOG_PATH = path.join(KEEPER_LOG_DIR, 'keeper.log');
let warnedKeeperLogFailure = false;
function appendKeeperLog(text) {
  try {
    fs.mkdirSync(KEEPER_LOG_DIR, { recursive: true });
    fs.appendFileSync(KEEPER_LOG_PATH, text);
  } catch (e) {
    // A log that fails silently is worse than no log at all — but only warn
    // ONCE per process so a persistently-unwritable folder (e.g. an
    // un-elevated dev run before the installer ever created the folder)
    // doesn't spam the console on every single audit() call.
    if (!warnedKeeperLogFailure) {
      warnedKeeperLogFailure = true;
      console.error('[keeper] WARNING: could not write keeper.log at', KEEPER_LOG_PATH, '-', (e && e.message) || e);
    }
  }
}
// Written once per keeper launch (see server.cjs main()) so runs are findable
// by scrolling/searching the file.
function keeperLogLaunchSeparator() {
  appendKeeperLog(`\n==== launch ${new Date().toISOString()} ====\n`);
}

// Append one line to the audit log(s). Never throws.
function audit(event, detail) {
  const line = `${new Date().toISOString()}\t${event}\t${detail == null ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail))}\n`;
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  for (const dir of [auditDir(), secondAuditDir()].filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `audit-${month}.log`), line);
    } catch { /* logging must never break the app */ }
  }
  appendKeeperLog(line); // fixed-location mirror — see keeper.log block above
}

// Count business rows in an open better-sqlite3 db. Returns { total, counts }.
function countBusinessRows(db) {
  const counts = {};
  let total = 0;
  for (const t of BUSINESS_TABLES) {
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM ${t}`).get();
      const n = row ? Number(row.n) : 0;
      counts[t] = n; total += n;
    } catch { counts[t] = 0; }
  }
  return { total, counts };
}

// Read / write the last-known-good marker (how the guard knows we HAD data).
// Scoped to `root` — see markerPath() above.
function readLastGood(root) {
  try { return JSON.parse(fs.readFileSync(markerPath(root), 'utf8')); } catch { return null; }
}
function writeLastGood(total, counts, root) {
  try {
    fs.mkdirSync(programDataBase(), { recursive: true });
    fs.writeFileSync(markerPath(root), JSON.stringify({ total, counts, root, at: new Date().toISOString() }, null, 2));
  } catch { /* ignore */ }
}

// The guard decision, given the freshly-opened db and whether the file existed.
// Returns { safeMode, reason, opened, lastGood }:
//   safeMode=true  → db is blank/empty but we previously had data → DON'T proceed
//                    normally; app should show the restore screen.
//   safeMode=false → normal open (real data, or a genuine first-ever run).
function evaluate(db, fileExisted, root) {
  const opened = countBusinessRows(db);
  const lastGood = readLastGood(root);
  const hadDataBefore = !!(lastGood && lastGood.total > 0);

  if (opened.total > 0) {
    // Healthy open — refresh the marker so next launch knows our baseline.
    writeLastGood(opened.total, opened.counts, root);
    audit('db-open-ok', { root, ...opened });
    return { safeMode: false, reason: '', opened, lastGood };
  }

  // Opened empty. Is that suspicious?
  if (hadDataBefore) {
    // The incident signature: empty now, but we had data before. Do NOT let the
    // caller overwrite the file; signal safe mode.
    audit('db-blank-detected', { root, openedTotal: 0, lastGoodTotal: lastGood.total, lastGoodAt: lastGood.at, fileExisted });
    return { safeMode: true, reason: 'blank-but-had-data', opened, lastGood };
  }

  // Genuine first run (no prior data, no marker) — a blank db is expected.
  audit('db-first-run', { root, fileExisted });
  return { safeMode: false, reason: 'first-run', opened, lastGood };
}

module.exports = {
  audit, countBusinessRows, evaluate, readLastGood, writeLastGood,
  secondAuditDir, setSecondAuditDir, auditDir, BUSINESS_TABLES,
  keeperLogLaunchSeparator, KEEPER_LOG_PATH,
};
