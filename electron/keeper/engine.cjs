/**
 * engine.cjs — the database engine for the keeper.
 *
 * This is the SAME logic that used to live in db-host.cjs / sql.js engine.cjs,
 * now backed by better-sqlite3 (native, synchronous), with ZERO Electron
 * dependency so it can run inside the standalone keeper process. It owns ONE
 * database and exposes plain functions (all/get/add/put/update/...). The
 * keeper server wraps these as HTTP routes; nothing here knows about HTTP.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const safeguard = require('./safeguard.cjs');

const TABLE_KEYS = {
  challans: 'id', lrEntries: 'id', drs: 'id', wasuli: 'id', firmLedger: 'id',
  operators: 'id', masterData: 'id', settings: 'key', drafts: 'challanId',
  auditLog: 'id',
};
const AUTO_INC = new Set(['challans', 'lrEntries', 'drs', 'wasuli', 'firmLedger', 'operators', 'masterData', 'auditLog']);

let db = null;
let dbFilePath = '';
let dataRootPath = '';   // the shared root folder (holds db/, backups/, config/)
let writeQueue = Promise.resolve();
// Bumped whenever the WHOLE database is replaced (restore or import). Seats poll
// this lightweight number periodically; when it changes, they know a restore/
// import happened somewhere (possibly on a different seat) and reload themselves.
// This is what makes restore/import visible to all seats, not just the one that
// performed it — see getGeneration() and the /generation route.
let dataGeneration = 0;
function getGeneration() { return dataGeneration; }

// Set by the blank-DB guard in initDb. When active, the app should open the
// restore/safe-mode screen instead of normal operation. Includes the counts we
// last had (from the marker) and what we opened with (0), for the screen to show.
let safeModeState = { active: false };
function getSafeMode() { return safeModeState; }
// Record counts of the CURRENTLY open db — used by the audit log on close and by
// any UI that wants to show "you have N records".
function getRecordCounts() { return safeguard.countBusinessRows(db); }

// targetDb defaults to the live module db; also used to prep a candidate restore
// file (which may predate a schema change) before reading it for the confirm-summary.
function ensureSchema(targetDb) {
  const d = targetDb || db;
  for (const [table, key] of Object.entries(TABLE_KEYS)) {
    if (key === 'id') {
      d.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL)`);
    } else {
      const keyType = table === 'drafts' ? 'INTEGER' : 'TEXT';
      d.exec(`CREATE TABLE IF NOT EXISTS ${table} (${key} ${keyType} PRIMARY KEY, json TEXT NOT NULL)`);
    }
  }

  // Create SQLite expression indexes to ensure fast search scaling to large volumes of data
  try {
    d.exec(`CREATE INDEX IF NOT EXISTS idx_drs_lrEntryId ON drs(json_extract(json, '$.lrEntryId'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_wasuli_drId ON wasuli(json_extract(json, '$.drId'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_firmLedger_firmName ON firmLedger(json_extract(json, '$.firmName'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lrEntries_lrNumber ON lrEntries(json_extract(json, '$.lrNumber'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lrEntries_challanId ON lrEntries(json_extract(json, '$.challanId'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_drs_bookingDate ON drs(json_extract(json, '$.bookingDate'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_drs_status ON drs(json_extract(json, '$.status'))`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_drs_firmName ON drs(json_extract(json, '$.firmName'))`);
  } catch (e) {
    console.error('[keeper] Index creation warning:', e);
  }
}

// One-time idempotent schema migration to align wasuli consignee fields
function alignWasuliConsigneeKeysSync(targetDb) {
  const d = targetDb || db;
  try {
    const rows = d.prepare(`SELECT id, json FROM wasuli`).all();
    let migratedCount = 0;
    d.transaction(() => {
      for (const r of rows) {
        const o = JSON.parse(r.json);
        if (o.firmName !== undefined) {
          o.consigneeName = o.firmName;
          delete o.firmName;
          d.prepare(`UPDATE wasuli SET json = ? WHERE id = ?`).run(JSON.stringify(o), r.id);
          migratedCount++;
        }
      }
    })();
    if (migratedCount > 0) {
      safeguard.audit('wasuli-schema-migration', { migratedCount });
      console.log(`[keeper] Wasuli schema migration: aligned ${migratedCount} rows to consigneeName.`);
    }
  } catch (e) {
    console.error('[keeper] Wasuli schema migration error:', e);
  }
}

// Checkpoints the WAL sidecar into the main db file. better-sqlite3 writes are
// already durable to the WAL on every statement — this just consolidates, which
// backups and shutdown both need (a plain file copy of dbFilePath would miss
// whatever's still sitting in -wal).
function flushNow() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    return { ok: true };
  } catch (e) {
    console.error('[keeper] flush failed:', e);
    safeguard.audit('save-failed', { error: String((e && e.message) || e), path: dbFilePath });
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function initDb(rootPath) {
  dataRootPath = rootPath;
  dbFilePath = path.join(dataRootPath, 'db', 'delivery.db');
  ensureRootFolders(); // create/verify db, backups, PDF, CSV, config under the root
  const fileExisted = fs.existsSync(dbFilePath);

  // Open with short-backoff retries for a transient lock (e.g. antivirus or a
  // not-yet-exited previous keeper still holding the file). No silent
  // fallback on final failure — log the REAL exception (EBUSY vs
  // SQLITE_CORRUPT vs disk-full all need a different fix on-site) and exit
  // loud so launcher.cjs can respawn, same as the restore reopen-failure path.
  const OPEN_ATTEMPTS = 3; // 1 initial + 2 retries
  let openErr = null;
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt++) {
    try {
      db = new Database(dbFilePath);
      openErr = null;
      break;
    } catch (e) {
      openErr = e;
      if (attempt < OPEN_ATTEMPTS) await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (openErr) {
    const msg = String((openErr && openErr.message) || openErr);
    console.error('[keeper] FATAL: could not open database:', msg);
    safeguard.audit('db-open-failed', { root: dataRootPath, dbFilePath, error: msg });
    process.exit(1);
  }

  db.pragma('journal_mode = WAL');
  ensureSchema();
  alignWasuliConsigneeKeysSync();

  // Fold any pending -wal/-shm into the main file BEFORE the blank-DB guard counts
  // rows. Without this, a coherent .db paired with stale/orphaned WAL siblings
  // (e.g. from a fresh-install-then-paste swap) can read as 0 rows even though the
  // .db itself has real data — falsely tripping safe mode. TRUNCATE merges any
  // genuinely pending writes in and empties the WAL, so it never discards data.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    safeguard.audit('db-open-checkpoint-failed', { root: dataRootPath, dbFilePath, error: String((e && e.message) || e) });
  }

  // ── Blank-DB guard ──────────────────────────────────────────────────────────
  // Decide whether this open is suspicious (empty now, but we had data before).
  // If so, enter safe mode and let the app show the restore screen instead of
  // proceeding blank. Unlike the old sql.js logic, there's no separate "flush the
  // in-memory db to disk" step to skip here — better-sqlite3 writes straight to
  // the file, so simply not writing anything further is enough to leave it untouched.
  const verdict = safeguard.evaluate(db, fileExisted, dataRootPath);
  safeModeState = verdict.safeMode ? { active: true, ...verdict } : { active: false };
  if (verdict.safeMode) {
    return;
  }

  backupOnStart(); // auto-backup if the interval has elapsed
  const purged = await serializeWrite(() => purgeOldDeleted()); // 90-day purge of old soft-deletes
  await serializeWrite(() => repairAllFirmLedgersOnce()); // one-time running-balance repair (self-audits when it actually runs)
  const pfAdjustmentsMigrated = await serializeWrite(() => firmLedgerMod.migratePfAdjustmentsSync(firmLedgerEngineApi)); // self-healing PF cleanup, every startup
  const crossingWasuliBackfilled = await serializeWrite(() => memoSaveMod.backfillCrossingWasuliSync(memoEngineApi));
  safeguard.audit('app-open', { root: dataRootPath, keeperVersion: true });
  safeguard.audit('startup-self-heal', { root: dataRootPath, purged, pfAdjustmentsMigrated: pfAdjustmentsMigrated || 0, crossingWasuliBackfilled: crossingWasuliBackfilled || 0 });
}

// Create (or recreate if missing) the standard subfolders under the data root.
// Runs on every launch, so a folder a user deleted is restored. db/ and backups/
// hold database files; PDF/ and CSV/ hold exported reports. Returns nothing.
function ensureRootFolders() {
  for (const sub of ['db', 'backups', 'PDF', 'CSV', 'config']) {
    try {
      const p = path.join(dataRootPath, sub);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    } catch (e) {
      console.error('[keeper] could not create folder', sub, e);
    }
  }
}
function getRootFolder(sub) { return path.join(dataRootPath, sub); }

// ponytail: PDF and CSV output ALWAYS live at <root>\PDF and <root>\CSV — no
// stored override, so they can never diverge from the root.
function getExportFolder(kind) { return getRootFolder(kind === 'pdf' ? 'PDF' : 'CSV'); }

// Save an export file. kind 'pdf' expects base64 content; 'csv' expects text.
// Writes into the configured (or default) folder for that kind. Returns the path
// written, or null on failure. Never throws.
function saveExport(kind, fileName, content) {
  try {
    const dir = getExportFolder(kind);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = String(fileName || `export-${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const dest = path.join(dir, safe);
    const tmp = dest + '.tmp';
    if (kind === 'pdf') fs.writeFileSync(tmp, Buffer.from(content, 'base64'));
    else fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, dest);
    return dest;
  } catch (e) {
    console.error('[keeper] saveExport failed:', e);
    return null;
  }
}

// targetDb defaults to the live module db; pass a candidate db (e.g. a restore
// file opened for preview) to read from THAT instead, without touching the live one.
function all(table, targetDb) {
  const key = TABLE_KEYS[table];
  const rows = (targetDb || db).prepare(`SELECT ${key}, json FROM ${table}`).all();
  return rows.map((r) => { const o = JSON.parse(r.json); o[key] = r[key]; return o; });
}
function get(table, kv) {
  const key = TABLE_KEYS[table];
  const row = db.prepare(`SELECT ${key}, json FROM ${table} WHERE ${key} = ?`).get(kv);
  if (!row) return undefined;
  const o = JSON.parse(row.json);
  o[key] = row[key];
  return o;
}
function add(table, obj) {
  const key = TABLE_KEYS[table];
  if (AUTO_INC.has(table)) {
    const s = { ...obj }; delete s.id;
    const info = db.prepare(`INSERT INTO ${table} (json) VALUES (?)`).run(JSON.stringify(s));
    return info.lastInsertRowid;
  } else {
    db.prepare(`INSERT OR REPLACE INTO ${table} (${key}, json) VALUES (?, ?)`).run(obj[key], JSON.stringify(obj));
    return obj[key];
  }
}

// Atomically assigns the next sequential number for `field` in `table` AND
// inserts the row with that number, as ONE synchronous operation. Unlike calling
// nextNumber() and add() as two separate requests (which leaves a gap where two
// seats could both be told the same next number before either saves), this never
// yields control between computing the number and reserving it — combined with
// being run inside serializeWrite (see the server route), no other write of any
// kind, on any seat, can land in between. This is what generateDRs uses for BS
// numbers, so two seats can never end up with the same DR number.
function addWithNumber(table, obj, field, prefix, scope) {
  const n = nextNumber(table, field, prefix, scope);
  // Full stored number = prefix + 6-digit counter, e.g. "26-000047". The prefix is
  // the two-digit year set by the caller (generateDRs) — workers never type it.
  const numberStr = (prefix || '') + String(n).padStart(6, '0');
  const row = { ...obj, [field]: numberStr };
  const id = add(table, row);
  return { id, [field]: numberStr };
}
function put(table, obj) {
  const key = TABLE_KEYS[table];
  if (obj[key] == null && AUTO_INC.has(table)) return add(table, obj);
  db.prepare(`INSERT OR REPLACE INTO ${table} (${key}, json) VALUES (?, ?)`).run(obj[key], JSON.stringify(obj));
  return obj[key];
}
function update(table, kv, changes) {
  const ex = get(table, kv);
  if (!ex) return 0;
  const key = TABLE_KEYS[table];
  const m = { ...ex, ...changes };
  // A field set to null means "clear it" — JSON drops `undefined` over IPC, so
  // callers send null to remove a field (e.g. restoring a soft-deleted row clears
  // deletedAt). Strip any null-valued keys so the field becomes truly absent.
  for (const k of Object.keys(changes)) { if (changes[k] === null) delete m[k]; }
  delete m[key];
  db.prepare(`UPDATE ${table} SET json = ? WHERE ${key} = ?`).run(JSON.stringify(m), kv);
  return 1;
}
function del(table, kv) {
  const key = TABLE_KEYS[table];
  db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(kv);
}
function query(table, opts) {
  const key = TABLE_KEYS[table];
  let sql = `SELECT ${key}, json FROM ${table}`;
  const params = [];
  const clauses = [];

  if (opts.whereCol != null) {
    const isPrimaryKey = (opts.whereCol === key);
    if (opts.anyOf) {
      if (opts.anyOf.length === 0) return [];
      if (isPrimaryKey) {
        clauses.push(`${key} IN (${opts.anyOf.map(() => '?').join(',')})`);
        params.push(...opts.anyOf);
      } else {
        clauses.push(`json_extract(json, ?) IN (${opts.anyOf.map(() => '?').join(',')})`);
        params.push('$.' + opts.whereCol, ...opts.anyOf);
      }
    } else if (opts.equals !== undefined) {
      if (isPrimaryKey) {
        clauses.push(`${key} = ?`);
        params.push(opts.equals);
      } else {
        clauses.push(`json_extract(json, ?) = ?`);
        params.push('$.' + opts.whereCol, opts.equals);
      }
    }
  }

  if (opts.whereObj) {
    for (const [k, v] of Object.entries(opts.whereObj)) {
      if (k === key) {
        clauses.push(`${key} = ?`);
        params.push(v);
      } else {
        clauses.push(`json_extract(json, ?) = ?`);
        params.push('$.' + k, v);
      }
    }
  }

  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ');
  }

  const sk = opts.orderBy || opts.sortBy;
  if (sk) {
    if (sk === key) {
      sql += ` ORDER BY ${key} ${opts.reverse ? 'DESC' : 'ASC'}`;
    } else {
      sql += ` ORDER BY json_extract(json, ?) ${opts.reverse ? 'DESC' : 'ASC'}`;
      params.push('$.' + sk);
    }
  }

  if (opts.limit != null) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params);
  const result = rows.map((r) => {
    const o = JSON.parse(r.json);
    o[key] = r[key];
    return o;
  });

  if (opts.reverse && !sk) {
    result.reverse();
  }

  return result;
}
function nextNumber(table, field, prefix, scope) {
  // scope narrows the max-scan to one parent's rows (e.g. { field: 'challanId',
  // value: 123 }) — what a per-parent series like Sr No needs, instead of
  // overloading the year-prefix argument. BS/DR numbers pass no scope and keep
  // scanning the whole table exactly as before.
  //
  // The WHERE clauses below only pick which rows get loaded from disk — they
  // are deliberately a SUPERSET of what the JS logic further down would count,
  // never a subset, so they can only make this faster, never change the answer:
  //   - LIKE prefix+'%' case-folds and treats stray '%'/'_' in prefix as
  //     wildcards, so it matches at least everything startsWith(prefix) would,
  //     plus possibly more (harmless — the real startsWith check below is still
  //     what decides membership).
  //   - the scope `=` mirrors the `===` filter that used to run in JS; that
  //     same JS filter still runs below on whatever SQL returns, so even a
  //     hypothetical SQL/JS mismatch could only over-fetch, never mis-select.
  const key = TABLE_KEYS[table];
  const clauses = [];
  const params = [];
  if (scope) { clauses.push(`json_extract(json, ?) = ?`); params.push('$.' + scope.field, scope.value); }
  if (prefix) { clauses.push(`json_extract(json, ?) LIKE ?`); params.push('$.' + field, prefix + '%'); }
  const sql = `SELECT ${key} AS k, json FROM ${table}` + (clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '');
  let rows = db.prepare(sql).all(...params).map(({ k, json }) => { const o = JSON.parse(json); o[key] = k; return o; });
  if (scope) rows = rows.filter(r => r[scope.field] === scope.value);
  let max = 0;
  for (const r of rows) {
    const v = r[field];
    if (prefix) {
      // Prefix mode (year series like "26-"): ONLY rows carrying this exact prefix
      // count toward the max. Rows from other years ("25-...") and legacy plain
      // numbers ("00047") are ignored — that is precisely what makes the series
      // restart at 00001 the moment the year (and therefore the prefix) changes,
      // with no scheduled reset step needed.
      if (typeof v === 'string' && v.startsWith(prefix)) {
        const n = parseInt(v.slice(prefix.length), 10);
        if (!isNaN(n) && n > max) max = n;
      }
    } else {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max + 1;
}

// Serialize a write: run after the previous write finishes. better-sqlite3 is
// synchronous and durable per-statement, so this no longer batches a disk flush —
// it only preserves FIFO ordering across writes queued from concurrent HTTP
// requests. The queue continues even if one write throws, so a single bad op
// can't permanently stall all future writes.
function serializeWrite(fn) {
  // Guard covers all write routes in one place — never queue (or run) a write
  // while safe mode is active (db opened blank but had prior data); the app
  // should be on the restore screen, not writing into a suspicious blank db.
  if (safeModeState.active) {
    return Promise.reject(new Error('Refusing write: safe mode active — database opened blank but had prior data'));
  }
  const run = writeQueue.then(fn);
  writeQueue = run.then(() => {}, () => {});
  return run;
}

function exportBytes() {
  flushNow(); // checkpoint WAL so the exported file bytes are complete
  return Array.from(fs.readFileSync(dbFilePath));
}

// ── Backups & restore (moved from db-host.cjs; now rooted under the data root) ──
// Backup config: the folder (default backups/ under root, changeable e.g. to a
// pendrive) AND the auto-backup interval in days (2, 7, 14, or 0 = off).
function configPath() { return path.join(dataRootPath, 'config', 'backup-config.json'); }
function defaultBackupDir() { return path.join(dataRootPath, 'backups'); }

function readBackupConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return {
      intervalDays: (cfg && typeof cfg.intervalDays === 'number') ? cfg.intervalDays : 2,
      extraTargets: (cfg && Array.isArray(cfg.extraTargets)) ? cfg.extraTargets : [],
      lastAutoFingerprint: (cfg && cfg.lastAutoFingerprint) || '',
    };
  } catch { return { intervalDays: 2, extraTargets: [], lastAutoFingerprint: '' }; } // default: every 2 days
}
function writeBackupConfig(patch) {
  try {
    const cur = readBackupConfig();
    const next = { ...cur, ...patch };
    const cfgDir = path.dirname(configPath());
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next));
    return true;
  } catch (e) {
    console.error('[keeper] could not save backup config:', e);
    return false;
  }
}

// ponytail: the PRIMARY backup folder is always <root>\backups — no stored
// override, so it can never diverge from the root (see extraTargets below for
// the one legitimate way to add an ADDITIONAL backup destination).
function getBackupFolder() { return defaultBackupDir(); }
function getBackupInterval() { return readBackupConfig().intervalDays; }
function setBackupInterval(days) { return writeBackupConfig({ intervalDays: Number(days) || 0 }); }

// Optional EXTRA backup folders (e.g. a pendrive or a second drive). Empty by
// default — the app assumes NO drive letter and works fine if none are set. The
// customer adds whatever path they want at their site. Each is written to in
// addition to the primary folder, and is tolerant: a missing target (pendrive
// unplugged) is skipped, never an error.
function getExtraTargets() {
  const t = readBackupConfig().extraTargets;
  return Array.isArray(t) ? t.filter(Boolean) : [];
}
function setExtraTargets(list) {
  const clean = Array.isArray(list) ? [...new Set(list.filter(f => typeof f === 'string' && f.trim()))] : [];
  return writeBackupConfig({ extraTargets: clean });
}
// All folders a backup should be written to / listed from: primary first, then
// any extras. Deduped so the same folder isn't hit twice.
function allBackupDirs() {
  return [...new Set([getBackupFolder(), ...getExtraTargets()])];
}

// Writes a snapshot. label 'auto' rotates by AGE (delete auto- files older than
// 14 days); 'manual'/'prerestore' are permanent (never auto-deleted). Checkpoints
// the WAL first (a plain file copy would miss whatever's still in -wal), then
// copies to a .tmp file and renames — the rename is atomic, so a reader never
// sees a half-written backup.
function writeBackupTo(dir, label) {
  try {
    if (!fs.existsSync(dbFilePath)) return null;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    flushNow();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dest = path.join(dir, `delivery-${label}-${stamp}.db`);
    const tmp = dest + '.tmp';
    fs.copyFileSync(dbFilePath, tmp);
    fs.renameSync(tmp, dest); // atomic — a reader never sees a half-written backup
    if (label === 'auto') trimAutoBackups(dir);
    safeguard.audit('backup-written', { root: dataRootPath, label, path: dest });
    return dest;
  } catch (e) {
    console.error('[keeper] backup write failed:', e);
    safeguard.audit('backup-write-failed', { root: dataRootPath, dir, label, error: String((e && e.message) || e) });
    return null;
  }
}

// Write a snapshot to the primary folder AND every extra target (pendrive, second
// drive — whatever the customer configured; empty by default). Returns the list
// of folders written to and the list that failed (e.g. pendrive unplugged), so
// callers can warn without treating a missing removable drive as a hard error.
//
// ponytail: written[] holds the DIRECTORY, not the file path writeBackupTo()
// returns. Pre-existing, harmless (renderer only reads res.ok). Left as-is —
// out of scope for this migration.
function writeBackupAll(label) {
  const written = [], failed = [];
  for (const dir of allBackupDirs()) {
    const r = writeBackupTo(dir, label);
    if (r) written.push(dir); else failed.push(dir);
  }
  // Last-ditch fallback: if NOTHING got written (e.g. the only configured folder
  // is unreachable), try the default folder under the data root.
  if (!written.length) {
    const r = writeBackupTo(defaultBackupDir(), label);
    if (r) written.push(defaultBackupDir());
  }
  return { written, failed };
}

// Cheap content check for dedup: size + mtime of the live db. If unchanged since
// the last auto-backup, skip writing an identical file (stops file bloat when the
// office is open but idle).
function dbFingerprint() {
  try { const st = fs.statSync(dbFilePath); return `${st.size}:${Math.floor(st.mtimeMs)}`; }
  catch { return ''; }
}

// Delete auto- backups older than 4 days (rolling 4-day window). Backups are
// made daily, so this always leaves the last ~4 daily snapshots. Manual and
// prerestore snapshots are NEVER touched here. Do not set this below the daily
// cadence, or a day could pass with its only backup already deleted.
const AUTO_RETENTION_DAYS = 4;
function trimAutoBackups(dir) {
  try {
    const now = Date.now();
    const cutoff = now - AUTO_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('delivery-auto-') || !f.endsWith('.db')) continue;
      const full = path.join(dir, f);
      try {
        const mtimeMs = fs.statSync(full).mtimeMs;
        // File's mtime is "in the future" relative to now — the clock went
        // backward since it was written. Never delete on that evidence.
        if (mtimeMs > now) continue;
        if (mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* ignore one bad file */ }
    }
  } catch (e) { console.error('[keeper] trim failed:', e); }
}

// Auto-backup on start and on periodic checks. Runs if auto-backup is on and
// EITHER the interval has elapsed OR there is no backup yet today (a guaranteed
// once-a-day snapshot). Skips writing if the db is unchanged since the last
// auto-backup (content-dedup), so an open-but-idle office doesn't pile up
// identical files. Writes to the primary folder plus any extra targets.
function backupOnStart() {
  try {
    if (!fs.existsSync(dbFilePath)) return;
    const interval = getBackupInterval();
    if (!interval || interval <= 0) return; // Off
    const chosen = getBackupFolder();

    // Find the newest auto- backup: its mtime (for the interval) and whether one
    // already exists for today's date (for the daily guarantee).
    let lastMs = 0;
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    let haveToday = false;
    try {
      if (fs.existsSync(chosen)) {
        for (const f of fs.readdirSync(chosen)) {
          if (!f.startsWith('delivery-auto-') || !f.endsWith('.db')) continue;
          const m = fs.statSync(path.join(chosen, f)).mtimeMs;
          if (m > lastMs) lastMs = m;
          if (f.includes(todayStr)) haveToday = true;
        }
      }
    } catch { /* ignore */ }

    const rawElapsedDays = lastMs ? (Date.now() - lastMs) / (24 * 60 * 60 * 1000) : Infinity;
    // Clock rolled backward since the last backup (raw elapsed is negative) — never
    // read that as "recently backed up already"; treat it as maximally overdue.
    const elapsedDays = rawElapsedDays < 0 ? Infinity : rawElapsedDays;
    const due = !haveToday || elapsedDays >= interval;
    if (!due) return;

    // Content-dedup: if the db hasn't changed since the last auto-backup, don't
    // write an identical snapshot. Fingerprint of the last write is stored in
    // config; compare and skip if equal (but always allow the first-of-day if
    // the file genuinely changed).
    const fp = dbFingerprint();
    const lastFp = readBackupConfig().lastAutoFingerprint || '';
    if (fp && fp === lastFp && haveToday) return; // nothing changed and today covered

    const { written } = writeBackupAll('auto');
    if (written.length && fp) writeBackupConfig({ lastAutoFingerprint: fp });
  } catch (e) {
    console.error('[keeper] backupOnStart failed:', e);
  }
}
function backupNow() {
  flushNow();
  const { written, failed } = writeBackupAll('manual');
  return { ok: !!written.length, path: written[0] || '', written, failed };
}
// List backups from the primary folder AND every extra target, merged. A file
// present in more than one folder is shown once (deduped by filename), with all
// the folders it lives in — so no backup is ever invisible just because it
// landed on a different target than the one being browsed. This is the fix for
// the "good backup existed but the restore screen didn't show it" problem.
function listBackups() {
  const byName = new Map();
  for (const dir of allBackupDirs()) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith('delivery-') || !f.endsWith('.db')) continue;
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const kind = f.startsWith('delivery-manual-') ? 'manual'
          : (f.startsWith('delivery-prerestore-') ? 'prerestore' : 'auto');
        const existing = byName.get(f);
        if (existing) {
          existing.locations.push(full);
        } else {
          byName.set(f, { file: f, path: full, kind, size: st.size, mtime: st.mtimeMs, locations: [full] });
        }
      }
    } catch (e) { console.error('[keeper] listBackups scan failed for', dir, e); }
  }
  return [...byName.values()].sort((a, b) => b.mtime - a.mtime);
}

// Backup health for the Dashboard badge: when the most recent backup (of any
// kind) was made, and per-target status (present/missing) so a stale or
// unreachable extra target (pendrive unplugged) is visible at a glance.
function getBackupHealth() {
  const all = listBackups();
  const lastMs = all.length ? all[0].mtime : 0;
  const targets = allBackupDirs().map(dir => {
    let exists = false, newestMs = 0;
    try {
      if (fs.existsSync(dir)) {
        exists = true;
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith('delivery-') || !f.endsWith('.db')) continue;
          const m = fs.statSync(path.join(dir, f)).mtimeMs;
          if (m > newestMs) newestMs = m;
        }
      }
    } catch { /* ignore */ }
    return { dir, exists, newestMs };
  });
  return { lastBackupMs: lastMs, intervalDays: getBackupInterval(), targets };
}
// Confirm-before-replace summary: what a candidate db contains, so the operator
// can tell at a glance whether it's the right file before it replaces anything.
// Works on any open db handle (the live one, or a candidate being validated).
function summarizeForRestore(targetDb) {
  const challans = all('challans', targetDb);
  const drs = all('drs', targetDb);
  const firms = all('masterData', targetDb).filter(m => m.field === 'firmName');
  const memos = challans.filter(c => c.status === 'saved');
  const newestDate = challans.reduce((max, c) => (c.entryDate && c.entryDate > max ? c.entryDate : max), '');
  return {
    challans: challans.length,
    memos: memos.length,
    drs: drs.length,
    firms: firms.length,
    newestDate,
    total: safeguard.countBusinessRows(targetDb).total, // ALL business tables — drives the "this backup is EMPTY" warning
  };
}

// Restore/import a .db file: validate it opens as SQLite, then — unless `force`
// is set — stop and return a summary of what the file contains vs. what's live,
// so the caller can show the operator before anything is replaced. Only when
// called again with force=true does it take the prerestore safety snapshot and
// swap the live db. Runs through the write queue so it can't collide with
// in-flight writes. Returns { ok, error } or { ok:false, needsConfirm:true, incoming, live }.
//
// Construct-then-swap: the incoming bytes are staged to a sidecar file and
// opened + validated THERE, entirely separate from the live db. The live handle
// is only closed once validation (and, on a real restore, the empty-backup
// check) has passed — a bad or corrupt incoming file never touches the live db.
function restoreFromBytes(bytes, force) {
  const tmpPath = dbFilePath + '.restore-tmp';
  let testDb;
  try {
    fs.writeFileSync(tmpPath, Buffer.from(bytes));
    try {
      testDb = new Database(tmpPath);
      testDb.exec('SELECT name FROM sqlite_master LIMIT 1');
    } catch {
      try { testDb && testDb.close(); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, error: 'This is not a valid backup file (corrupted or wrong file)' };
    }

    if (!force) {
      // The file may predate a schema change (missing tables) — fill those in on
      // this candidate db only, purely so the summary query doesn't throw.
      ensureSchema(testDb);
      const incoming = summarizeForRestore(testDb);
      const live = summarizeForRestore(db);
      testDb.close();
      fs.unlinkSync(tmpPath);
      return { ok: false, needsConfirm: true, incoming, live };
    }

    // force alone is not enough to blank the live database. Reuse the SAME row
    // counter the startup blank-DB guard and getRecordCounts() use — one
    // definition of "does this db have real data?" everywhere. An incoming
    // backup with zero business rows needs the distinct 'CONFIRM_EMPTY' signal
    // instead of plain force:true, so replacing live data with blank can never
    // happen from the same click/muscle-memory as a normal restore.
    if (safeguard.countBusinessRows(testDb).total === 0 && force !== 'CONFIRM_EMPTY') {
      testDb.close();
      fs.unlinkSync(tmpPath);
      return { ok: false, error: 'This backup is empty (no challans/memos/DRs) — restore stopped to prevent data loss.' };
    }

    safeguard.audit('restore-staged-validated', { root: dataRootPath, tmpPath });

    // Never proceed without a good safety copy — if the prerestore backup
    // failed (disk full, folder unreachable), abort before touching the live db.
    const prerestoreBackupPath = writeBackupTo(getBackupFolder(), 'prerestore');
    if (!prerestoreBackupPath) {
      safeguard.audit('restore-aborted-no-backup', { root: dataRootPath, tmpPath });
      testDb.close();
      fs.unlinkSync(tmpPath);
      return { ok: false, error: 'Restore stopped: could not write a safety backup before replacing the database.' };
    }

    testDb.close();
    db.close();
    try {
      fs.renameSync(tmpPath, dbFilePath);
    } catch (e) {
      // db is now CLOSED and the swap never completed (same-volume rename is
      // all-or-nothing, so dbFilePath — the ORIGINAL — is still intact). Never
      // leave the keeper running with a closed db handle: reopen the original
      // file so normal operation can continue, or exit for launcher.cjs to
      // respawn if even that fails (same fail-loud pattern as below).
      console.error('[keeper] restore swap rename failed, reopening original db:', e);
      safeguard.audit('restore-swap-rename-failed', { root: dataRootPath, error: String((e && e.message) || e) });
      try {
        db = new Database(dbFilePath);
        db.pragma('journal_mode = WAL');
        ensureSchema();
      } catch (e2) {
        console.error('[keeper] FATAL: could not reopen original db after failed restore swap:', e2);
        safeguard.audit('restore-reopen-failed', { root: dataRootPath, error: String((e2 && e2.message) || e2) });
        process.exit(1);
      }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      return { ok: false, error: 'Restore ran into a problem — the original database was kept.' };
    }
    for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(dbFilePath + ext); } catch { /* ignore */ } }
    safeguard.audit('restore-swapped', { root: dataRootPath, dbFilePath });

    try {
      db = new Database(dbFilePath);
      db.pragma('journal_mode = WAL');
      ensureSchema();
    } catch (e) {
      // Near-impossible — same bytes just validated as testDb — but if the
      // reopen fails there is no live db left to serve. Exit rather than keep
      // an alive-but-broken keeper running; launcher.cjs respawns it.
      console.error('[keeper] FATAL: could not reopen db after restore swap:', e);
      safeguard.audit('restore-reopen-failed', { root: dataRootPath, error: String((e && e.message) || e) });
      process.exit(1);
    }

    dataGeneration++; // tell every seat (via polling) that the whole DB just changed
    // A restore/import replaces the whole db — clear safe mode and refresh the
    // last-known-good marker + audit the swap (survives a later data wipe).
    safeModeState = { active: false };
    try {
      const c = safeguard.countBusinessRows(db);
      safeguard.writeLastGood(c.total, c.counts, dataRootPath);
      safeguard.audit('db-restore', { root: dataRootPath, ...c });
    } catch { /* ignore */ }

    // Re-run the startup self-healing passes on the newly-swapped-in data (it may
    // be an old backup predating one of them). Called directly, not through
    // serializeWrite — restoreFromBytes already runs inside one (see the /import
    // route), and re-entering the queue from within itself would deadlock.
    const purged = purgeOldDeleted();
    repairAllFirmLedgersOnce();
    const pfAdjustmentsMigrated = firmLedgerMod.migratePfAdjustmentsSync(firmLedgerEngineApi);
    safeguard.audit('restore-heal-rerun', { root: dataRootPath, purged, pfAdjustmentsMigrated: pfAdjustmentsMigrated || 0 });

    return { ok: true, error: '' };
  } catch (e) {
    console.error('[keeper] restore failed:', e);
    try { testDb && testDb.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, error: 'Restore ran into a problem' };
  }
}
function restoreFromFile(filePath, force) {
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'File not found' };
  let bytes;
  try { bytes = fs.readFileSync(filePath); }
  catch { return { ok: false, error: 'Could not read the file' }; }
  return restoreFromBytes(bytes, force);
}
// ── Master-data merge ─────────────────────────────────────────────────────────
// countMergeImpact is read-only (drives the confirm popup). mergeMaster performs
// the merge: takes a prerestore snapshot first (recoverable if wrong), rewrites
// references + folds the master row, then bumps the generation so every seat
// reloads — same safety model as restore. Caller runs mergeMaster via
// serializeWrite (see the server route) so no other write lands mid-merge.
const unifiedEngineApi = {
  all, get, add, update, del, query, put, addWithNumber,
  recomputeFirmLedger: (firmName) => firmLedgerMod.recomputeFirmLedgerSync(unifiedEngineApi, firmName),
  transaction: (fn) => db.transaction(fn),
};

const mergeMod = require('./merge.cjs');
const mergeEngineApi = unifiedEngineApi;
function countMergeImpact(field, from) { return mergeMod.countImpact(mergeEngineApi, field, from); }
function mergeMaster(field, from, to) {
  // Never proceed without a good safety copy — abort before touching anything
  // if the prerestore backup failed.
  const prerestoreBackupPath = writeBackupTo(getBackupFolder(), 'prerestore');
  if (!prerestoreBackupPath) {
    safeguard.audit('merge-aborted-no-backup', { root: dataRootPath, field, from, to });
    throw new Error('Merge stopped: could not write a safety backup first.');
  }
  // Wrapped so a mid-merge failure rolls back cleanly instead of leaving
  // references rewritten but the master row not yet folded (or vice versa).
  const changed = db.transaction(() => mergeMod.mergeMasterValue(mergeEngineApi, field, from, to))();
  dataGeneration++;
  return changed;
}

// Permanently removes soft-deleted challans/lrEntries/drs once they're older
// than the recovery window. Runs automatically (see initDb below and the
// periodic check in server.cjs) — NEVER as a side effect of a screen being
// viewed (History.tsx only loads and displays). Logs what it removed via
// safeguard.audit so a sweep stays traceable after the fact.
const DELETED_RETENTION_DAYS = 90;
function purgeOldDeleted() {
  const cutoff = Date.now() - DELETED_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const counts = {};
  for (const table of ['challans', 'lrEntries', 'drs']) {
    const key = TABLE_KEYS[table];
    let n = 0;
    for (const row of all(table)) {
      if (row.deletedAt && new Date(row.deletedAt).getTime() < cutoff) { del(table, row[key]); n++; }
    }
    if (n) counts[table] = n;
  }
  if (Object.keys(counts).length) safeguard.audit('purge-deleted', counts);
  return counts;
}

const memoSaveMod = require('./memoSave.cjs');
const memoEngineApi = unifiedEngineApi;
// Wrapped so a mid-save failure (multiple tables touched) rolls back cleanly.
function saveMemo(challanId, seat) { return db.transaction(() => memoSaveMod.saveMemo(memoEngineApi, challanId, seat))(); }

const masterDataLearnMod = require('./masterDataLearn.cjs');
const masterDataLearnEngineApi = unifiedEngineApi;
function learnMasterData(pairs) { return masterDataLearnMod.learn(masterDataLearnEngineApi, pairs); }
function addCodedMasterData(field, value, details) { return masterDataLearnMod.addCoded(masterDataLearnEngineApi, field, value, details); }

// ── Firm ledger — every write that touches runningBalance, atomic keeper-side ──
// See firmLedger.cjs for why: read-then-write across separate round trips is
// exactly the class of bug that made saveMemo need this same treatment.
const firmLedgerMod = require('./firmLedger.cjs');
const firmLedgerEngineApi = unifiedEngineApi;
function createLedgerEntriesForChallan(challanId) { return firmLedgerMod.createLedgerEntriesForChallanSync(firmLedgerEngineApi, challanId); }
function recomputeFirmLedger(firmName) { return firmLedgerMod.recomputeFirmLedgerSync(firmLedgerEngineApi, firmName); }
function recordFirmSettlement(firmName, amount, note) { return firmLedgerMod.recordFirmSettlementSync(firmLedgerEngineApi, firmName, amount, note); }
// Wrapped so a mid-write failure (adjustments + ledger rows) rolls back cleanly.
function saveChallanAdjustments(challanNumber, firmName, adjustments) {
  return db.transaction(() => firmLedgerMod.saveChallanAdjustmentsSync(firmLedgerEngineApi, challanNumber, firmName, adjustments))();
}
function addManualLedgerEntry(firmName, type, category, amount, description, entryDate) { return firmLedgerMod.addManualEntrySync(firmLedgerEngineApi, firmName, type, category, amount, description, entryDate); }

// ── Challan-lifecycle cascades — ported from src/db/database.ts ────────────────
// Each of the six functions below used to be a renderer-orchestrated sequence of
// N separate keeper round trips (one per row updated) with no shared transaction
// and no server-side wasuli-lock check — see the prior scan. Ported here so the
// whole cascade is ONE keeper turn: gate check first (no changes made if it
// trips), then everything else inside a single db.transaction() so a crash
// mid-cascade rolls back completely instead of leaving partial state.
//
// Gate condition — exact match of src/db/database.ts getDRWasuliLock(): a
// non-deleted wasuli row exists for the target AND (status !== 'pending' OR
// operatorId !== 0). Same condition, applied uniformly to all five bulk
// operations below (this is the fix for the old 2-of-6 inconsistency).
function challanWasuliLockCount(challanId) {
  return all('wasuli').filter(w => w.challanId === challanId && !w.deletedAt && (w.status !== 'pending' || w.operatorId !== 0)).length;
}
function drWasuliLock(drId) {
  const w = all('wasuli').find(x => x.drId === drId && !x.deletedAt) || null;
  return { locked: !!w && (w.status !== 'pending' || w.operatorId !== 0), wasuli: w };
}
function wasuliLockError(n) {
  return `Cannot proceed: ${n} ${n === 1 ? 'entry has' : 'entries have'} assigned/collected wasuli — un-assign them to pending first`;
}

// Delete: graded by wasuli danger, gated by an explicit confirm token so a
// delete of assigned/collected work can NEVER happen without the operator
// having actually seen and confirmed that specific tier's dialog:
//   - no locked wasuli               -> proceeds immediately.
//   - assigned (locked, none collected) -> needs confirm === 'CONFIRM_ASSIGNED'.
//   - any collected                  -> needs confirm === 'CONFIRM_COLLECTED'
//     (this token is required even if assigned rows are ALSO present — collected
//     cash is the more dangerous case and always wins the classification).
// Distinct string tokens (not a boolean force) so an assigned-tier confirm can
// never satisfy a collected-tier delete.
function classifyChallanWasuliForDelete(challanId) {
  const rows = all('wasuli').filter(w => w.challanId === challanId && !w.deletedAt);
  const collected = rows.filter(w => w.status === 'collected');
  const assigned = rows.filter(w => w.status !== 'collected' && (w.status !== 'pending' || w.operatorId !== 0));
  return { collected, assigned };
}
function cascadeDeleteChallanSync(challanId, confirm) {
  const challan = get('challans', challanId);
  if (!challan) return { ok: true };
  const { collected, assigned } = classifyChallanWasuliForDelete(challanId);
  if (collected.length > 0) {
    if (confirm !== 'CONFIRM_COLLECTED') {
      const collectedAmount = collected.reduce((s, w) => s + (w.collectedAmount || 0), 0);
      return { ok: false, needsConfirm: 'collected', counts: { collected: collected.length, collectedAmount } };
    }
  } else if (assigned.length > 0) {
    if (confirm !== 'CONFIRM_ASSIGNED') {
      return { ok: false, needsConfirm: 'assigned', counts: { assigned: assigned.length } };
    }
  }

  db.transaction(() => {
    const now = new Date().toISOString();
    update('challans', challanId, { deletedAt: now });
    for (const e of all('lrEntries').filter(r => r.challanId === challanId)) {
      if (!e.deletedAt) update('lrEntries', e.id, { deletedAt: now });
    }
    for (const d of all('drs').filter(r => r.challanId === challanId)) {
      if (!d.deletedAt) update('drs', d.id, { deletedAt: now });
    }
    for (const w of all('wasuli').filter(r => r.challanId === challanId)) {
      if (!w.deletedAt) update('wasuli', w.id, { deletedAt: now });
    }
    for (const r of all('firmLedger').filter(r => r.challanId === challanId)) del('firmLedger', r.id);
    firmLedgerMod.recomputeFirmLedgerSync(firmLedgerEngineApi, challan.firmName);
  })();
  return { ok: true };
}

// Cancel: the safe alternative to delete — always succeeds regardless of
// wasuli state (NO lock gate; that is the whole point of cancel existing).
// Only PENDING, unassigned wasuli rows are soft-deleted; a locked (assigned or
// collected) row is left completely untouched so it stays live in every
// collection/cash report — cancelling keeps the cash on the books.
function cascadeCancelChallanSync(challanId) {
  const challan = get('challans', challanId);
  if (!challan) return { ok: true };

  db.transaction(() => {
    const now = new Date().toISOString();
    update('challans', challanId, { status: 'cancelled', deletedAt: now });
    for (const e of all('lrEntries').filter(r => r.challanId === challanId)) {
      if (!e.deletedAt) update('lrEntries', e.id, { deletedAt: now });
    }
    for (const d of all('drs').filter(r => r.challanId === challanId)) {
      if (!d.deletedAt) update('drs', d.id, { deletedAt: now });
    }
    for (const w of all('wasuli').filter(r => r.challanId === challanId)) {
      if (w.deletedAt) continue;
      const locked = w.status !== 'pending' || w.operatorId !== 0;
      if (!locked) update('wasuli', w.id, { deletedAt: now });
    }
    for (const r of all('firmLedger').filter(r => r.challanId === challanId)) del('firmLedger', r.id);
    firmLedgerMod.recomputeFirmLedgerSync(firmLedgerEngineApi, challan.firmName);
  })();
  return { ok: true };
}

// Reopen: status back to 'open', entries back to 'active'. DRs/wasuli are
// deliberately left untouched — a BS number, once issued, is permanent;
// regeneration is deferred to the next saveMemo. Firm ledger is cleared +
// recomputed so a re-save regenerates it with the latest amounts.
function cascadeReopenChallanSync(challanId) {
  const challan = get('challans', challanId);
  if (!challan) return { ok: true };
  // ponytail: no wasuli gate. Reopen mutates only challans.status, lrEntries.status
  // and firmLedger — never a DR or wasuli row. Assigned/collected entries are
  // protected per-entry on the way back out: generateDRsSync (memoSave.cjs) skips
  // any DR whose wasuli is assigned or collected, and deleteEntryCascadeSync still
  // refuses to delete one. Reinstate a gate here only if reopen itself starts
  // writing to drs/wasuli.
  db.transaction(() => {
    update('challans', challanId, { status: 'open' });
    for (const e of all('lrEntries').filter(r => r.challanId === challanId)) update('lrEntries', e.id, { status: 'active' });
    for (const r of query('firmLedger', { whereCol: 'challanId', equals: challanId }).filter(r => r.category !== 'adjustment')) del('firmLedger', r.id);
    firmLedgerMod.recomputeFirmLedgerSync(firmLedgerEngineApi, challan.firmName);
  })();
  return { ok: true };
}

// Restore: the exact reverse of delete — an UNCONDITIONAL undo, never gated by
// wasuli lock state. Delete is the dangerous direction (removing live work/cash
// in progress) and is what the lock check protects; bringing it all back can
// never be the dangerous direction, so no lock check runs here. Clears
// deletedAt on the challan + every entry/DR/wasuli row stamped with the SAME
// deletedAt (so an unrelated, independently-deleted row is never resurrected by
// this cascade) — each wasuli's status/operatorId is untouched by this update,
// so pending/assigned/collected all come back exactly as they were at delete
// time. A restored cancelled memo comes back as 'saved'. Ledger isn't
// restorable (it was hard-deleted) — regenerate it fresh via
// createLedgerEntriesForChallanSync, same as the original createLedgerEntries call.
function restoreChallanCascadeSync(challanId) {
  const challan = get('challans', challanId);
  if (!challan || !challan.deletedAt) return { ok: true };

  const stamp = challan.deletedAt;
  const wasStatus = challan.status;
  db.transaction(() => {
    update('challans', challanId, wasStatus === 'cancelled' ? { deletedAt: null, status: 'saved' } : { deletedAt: null });
    for (const e of all('lrEntries').filter(r => r.challanId === challanId)) {
      if (e.deletedAt === stamp) update('lrEntries', e.id, { deletedAt: null });
    }
    for (const d of all('drs').filter(r => r.challanId === challanId)) {
      if (d.deletedAt === stamp) update('drs', d.id, { deletedAt: null });
    }
    for (const w of all('wasuli').filter(r => r.challanId === challanId)) {
      if (w.deletedAt === stamp) update('wasuli', w.id, { deletedAt: null });
    }
    if (wasStatus === 'saved' || wasStatus === 'cancelled') {
      firmLedgerMod.createLedgerEntriesForChallanSync(firmLedgerEngineApi, challanId);
    }
  })();
  return { ok: true };
}

// Deletes an LR entry, and — if it already has a DR — cancels that DR and hard-
// deletes its wasuli row too (same as the original: a DR row is soft-deleted,
// but its wasuli is a true delete). Refuses if collection has already started.
function deleteEntryCascadeSync(entryId) {
  const dr = all('drs').find(d => d.lrEntryId === entryId && !d.deletedAt) || null;
  let w = null;
  if (dr) {
    const lock = drWasuliLock(dr.id);
    if (lock.locked) return { ok: false, lockedByAgent: true, error: "Cannot proceed: this entry's wasuli is already assigned/collected — un-assign it to pending first" };
    w = lock.wasuli;
  }

  db.transaction(() => {
    const now = new Date().toISOString();
    if (dr) {
      update('drs', dr.id, { deletedAt: now });
      if (w) del('wasuli', w.id);
    }
    update('lrEntries', entryId, { status: 'cancelled', deletedAt: now });
  })();
  return { ok: true, lockedByAgent: false };
}

// Edit a saved DR's charges. Same six-write sequence as the original
// updateDRCharges, now one transaction with the wasuli-lock + stale-conflict
// checks run first (no changes made if either trips). logAudit stays out of the
// keeper (renderer-attributed action, same convention as saveChallanAdjustments/
// mergeMaster) — the caller gets back enough info (drNumber/consignee/total/
// changesSummary) to log it itself.
function updateDRChargesSync(drId, charges, seenTotal) {
  const dr = get('drs', drId);
  if (!dr) return { ok: false, lockedByAgent: false, staleConflict: false };

  if (seenTotal != null && dr.total !== seenTotal) {
    return { ok: false, lockedByAgent: false, staleConflict: true };
  }

  const { locked: wasuliLocked, wasuli: w } = drWasuliLock(drId);
  if (wasuliLocked) {
    return { ok: false, lockedByAgent: true, staleConflict: false };
  }

  const total = charges.freight + charges.cartage + charges.hamali + charges.godownBhada + charges.godownInsurance + charges.deliveryCharges + charges.pf + (dr.otherCharges || 0);

  const before = { freight: dr.freight, cartage: dr.cartage, hamali: dr.hamali, godownBhada: dr.godownBhada, godownInsurance: dr.godownInsurance, deliveryCharges: dr.deliveryCharges, pf: dr.pf };
  const labels = { freight: 'Freight', cartage: 'Cartage', hamali: 'Hamali', godownBhada: 'G.Bhada', godownInsurance: 'GDN insu', deliveryCharges: 'D.Chrgs (Local)', pf: 'PF' };
  const changes = Object.keys(labels)
    .filter(k => (before[k] || 0) !== (charges[k] || 0))
    .map(k => `${labels[k]} ${before[k] || 0}→${charges[k] || 0}`);

  db.transaction(() => {
    update('drs', drId, { ...charges, total });

    if (dr.lrEntryId) {
      const entry = get('lrEntries', dr.lrEntryId);
      if (entry) {
        const upd = {
          cartage: charges.cartage, hamali: charges.hamali,
          godownBhada: charges.godownBhada, otherCharges: charges.godownInsurance,
          deliveryCharges: charges.deliveryCharges, pf: charges.pf, total,
        };
        if (entry.paymentMode === 'topay') upd.toPay = charges.freight;
        else if (entry.paymentMode === 'paid') upd.paid = charges.freight;
        update('lrEntries', entry.id, upd);
      }
    }

    const collectible = Math.max(0, total);
    if (w) {
      update('wasuli', w.id, { amountToCollect: collectible });
    } else {
      add('wasuli', {
        lrEntryId: dr.lrEntryId, challanId: dr.challanId, drId: dr.id,
        operatorId: 0, consigneeName: dr.consignee, amountToCollect: collectible,
        assignedDate: '', status: 'pending', notes: '',
      });
    }

    if (dr.firmName) {
      for (const r of query('firmLedger', { whereCol: 'challanId', equals: dr.challanId }).filter(r => r.category !== 'adjustment')) del('firmLedger', r.id);
      firmLedgerMod.recomputeFirmLedgerSync(firmLedgerEngineApi, dr.firmName);
      firmLedgerMod.createLedgerEntriesForChallanSync(firmLedgerEngineApi, dr.challanId);
    }

    // Same formula as src/db/database.ts syncChallanTotals — duplicated here
    // since keeper .cjs code can't import the renderer TS module. That
    // function stays exported in database.ts too; Reports.tsx calls it
    // independently, unrelated to this cascade.
    const liveEntries = all('lrEntries').filter(e => e.challanId === dr.challanId && e.status === 'active' && !e.deletedAt);
    const newTP = liveEntries.filter(e => e.paymentMode === 'topay').reduce((s, e) => s + e.toPay, 0);
    const newP = liveEntries.filter(e => e.paymentMode === 'paid').reduce((s, e) => s + e.paid, 0);
    update('challans', dr.challanId, { totalToPay: newTP, totalPaid: newP });
  })();

  return {
    ok: true, lockedByAgent: false, staleConflict: false,
    drNumber: dr.drNumber, consignee: dr.consignee, total,
    changesSummary: changes.join(', '),
  };
}

// One-time repair: recompute EVERY firm's ledger once, so any balance already
// wrong in the live db (from the pre-fix race, the backdating bug, or the
// createLedgerEntriesSync bad-seed bug) self-heals immediately instead of
// waiting for the next write to that particular firm. Idempotent
// (recomputeFirmLedgerSync only writes rows whose stored balance differs) and
// gated behind a settings flag (v2 — distinct from the older
// firmLedgerRepairDone flag some installs already have set) so it only ever
// runs once but is GUARANTEED to run at least once post-fix even on installs
// where the old repair already ran. Takes a full backup FIRST — never
// recomputes without one — and logs a complete before/after dump per firm.
const FIRM_LEDGER_HEAL_V2_FLAG = 'firmLedgerBalanceHealV2Done';
function repairAllFirmLedgersOnce() {
  const done = get('settings', FIRM_LEDGER_HEAL_V2_FLAG);
  if (done && done.value === 'true') return;

  const backupPath = writeBackupTo(getBackupFolder(), 'prerestore');
  if (!backupPath) {
    console.error('[keeper] firm-ledger heal ABORTED: prerestore backup failed');
    safeguard.audit('firm-ledger-heal-v2-aborted', { root: dataRootPath, reason: 'backup-failed' });
    return; // do NOT recompute without a safety copy; retried on next boot
  }

  // Old stored balance per firm = the runningBalance of its chronologically
  // last row (same ordering recomputeFirmLedgerSync itself uses).
  const rows = all('firmLedger');
  const lastRowByFirm = new Map();
  for (const r of rows) {
    const cur = lastRowByFirm.get(r.firmName);
    if (!cur || r.entryDate > cur.entryDate || (r.entryDate === cur.entryDate && r.id > cur.id)) {
      lastRowByFirm.set(r.firmName, r);
    }
  }
  const firmNames = new Set(rows.map(r => r.firmName));

  for (const firmName of firmNames) {
    const oldBalance = (lastRowByFirm.get(firmName) || {}).runningBalance || 0;
    const newBalance = firmLedgerMod.recomputeFirmLedgerSync(firmLedgerEngineApi, firmName);
    const diff = newBalance - oldBalance;
    safeguard.audit('firm-ledger-heal-v2-firm', { root: dataRootPath, firmName, oldBalance, newBalance, diff });
  }
  put('settings', { key: FIRM_LEDGER_HEAL_V2_FLAG, value: 'true' });
  safeguard.audit('firm-ledger-heal-v2-done', { root: dataRootPath, firmCount: firmNames.size, backupPath });
}

function clearTable(table) { db.prepare(`DELETE FROM ${table}`).run(); }
function vacuum() { db.exec('VACUUM'); }

// Current size of the live database on disk, in bytes. Sums the main file plus
// the -wal/-shm sidecars — WAL mode means recent writes live there until the
// next checkpoint, so the main file alone would undercount. Used by the
// Settings maintenance card so the office can see the benefit of compacting.
// Returns 0 if the file doesn't exist yet (fresh install).
function getDbFileSize() {
  let total = 0;
  for (const ext of ['', '-wal', '-shm']) {
    try { total += fs.statSync(dbFilePath + ext).size; } catch { /* sidecar may not exist */ }
  }
  return total;
}

// Called after a deliberate full data wipe (Settings → Clear All). Refreshes the
// last-known-good marker to the current (zero) counts so the blank-DB guard
// doesn't mistake this reset for the data-loss incident it exists to catch.
function markDataCleared() {
  const c = safeguard.countBusinessRows(db);
  safeguard.writeLastGood(c.total, c.counts, dataRootPath);
  safeguard.audit('data-cleared', { root: dataRootPath, ...c });
  return true;
}

// ── Challan duplicate merge ────────────────────────────────────────────────
// challanMergeCheck is read-only (drives the confirm popup, same role as
// countMergeImpact). mergeChallansWrite takes a prerestore snapshot first
// (same safety model as mergeMaster), then runs inside one db.transaction.
function challanMergeCheck(keepId, removeId) {
  return mergeMod.challanMergeEligibility(mergeEngineApi, keepId, removeId);
}
function mergeChallansWrite(keepId, removeId) {
  const prerestoreBackupPath = writeBackupTo(getBackupFolder(), 'prerestore');
  if (!prerestoreBackupPath) {
    safeguard.audit('challan-merge-aborted-no-backup', { root: dataRootPath, keepId, removeId });
    throw new Error('Merge stopped: could not write a safety backup first.');
  }
  const result = db.transaction(() => mergeMod.mergeChallans(mergeEngineApi, keepId, removeId))();
  dataGeneration++;
  return result;
}

module.exports = {
  initDb, flushNow, getGeneration,
  all, get, query, nextNumber, addWithNumber,
  add, put, update, del,
  serializeWrite, exportBytes,
  getBackupFolder, backupNow, listBackups,
  getBackupInterval, setBackupInterval, getRootFolder, backupOnStart,
  getExtraTargets, setExtraTargets, getBackupHealth,
  getSafeMode, getRecordCounts,
  auditEvent: safeguard.audit, setSecondAuditDir: safeguard.setSecondAuditDir, getSecondAuditDir: safeguard.secondAuditDir,
  keeperLogLaunchSeparator: safeguard.keeperLogLaunchSeparator,
  getExportFolder, saveExport,
  restoreFromFile, restoreFromBytes, clearTable, vacuum, getDbFileSize,
  countMergeImpact, mergeMaster,
  challanMergeCheck, mergeChallansWrite,
  markDataCleared, purgeOldDeleted,
  saveMemo,
  learnMasterData, addCodedMasterData,
  createLedgerEntriesForChallan,
  recomputeFirmLedger, recordFirmSettlement, saveChallanAdjustments, addManualLedgerEntry,
  cascadeDeleteChallanSync, cascadeCancelChallanSync, cascadeReopenChallanSync,
  restoreChallanCascadeSync, deleteEntryCascadeSync, updateDRChargesSync,
  _tableKeys: TABLE_KEYS,
};
