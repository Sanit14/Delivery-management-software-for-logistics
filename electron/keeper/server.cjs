/**
 * server.cjs — the KEEPER process.
 *
 * Runs ONCE on the server. Owns the one shared delivery.db (via engine.cjs) and
 * answers DB requests from all six app seats over a LOCAL HTTP server bound to
 * 127.0.0.1 only (never the network — unreachable from any other machine).
 *
 * Why HTTP and not a named pipe: HTTP already handles message boundaries,
 * request/response pairing, and many simultaneous clients. Far less hand-written
 * plumbing, and you can check the keeper is alive by opening its /health URL.
 *
 * Single-instance guard: the keeper binds a fixed port. If the port is already
 * taken, another keeper is already running — this one exits quietly. That is how
 * a 9am rush (all seats opening at once) still ends up with exactly ONE keeper.
 *
 * Launched detached by the first app seat (see launcher.cjs), so it survives that
 * seat closing and keeps serving the others until the server shuts down.
 *
 * Usage: node server.cjs <dataRoot> <port>
 */

const path = require('path');
const http = require('http');
const engine = require('./engine.cjs');
const bootstrap = require('./bootstrap.cjs');

const HOST = '127.0.0.1';

// Bump this whenever the schema/engine changes in a way a running keeper must pick
// up (e.g. a new table). The app compares it and replaces a stale keeper. The
// auditLog table was added at version 2. Version 8 added the 90-day soft-delete
// purge sweep (previously done — wrongly, as a hard delete — from History.tsx).
// Version 9 added the /masterData/addCoded route. Version 10 added the atomic
// firmLedger routes (settle/adjustments/manual/recompute). Version 11 switched
// the storage engine from sql.js to better-sqlite3 (a running v10 keeper is
// still sql.js-backed and must be replaced, not left serving). Version 12
// added the six /cascade/* routes (challan delete/cancel/reopen/restore, entry
// delete, DR-charges edit) — each now one atomic keeper turn with a
// server-side wasuli-lock gate, replacing the old renderer-side sequential
// round trips.
const KEEPER_VERSION = 12;

// Flushes pending writes before shutdown. flushNow() no longer just fires and
// forgets — it returns { ok, error } from the underlying saveToDisk(), so a
// disk-full/locked-file/dropped-network-drive save failure can be audited
// (distinctly from a normal mid-session save-failed, which already gets its
// own line) and reflected in the exit code, instead of exiting 0 as if the
// final save had succeeded. Returns the process exit code to use.
function flushOrAuditThenExitCode(route) {
  let flushError = null;
  try {
    const result = engine.flushNow();
    if (result && result.ok === false) flushError = result.error;
  } catch (e) {
    flushError = String((e && e.message) || e);
  }
  if (flushError) engine.auditEvent('shutdown-flush-failed', { error: flushError, route });
  return flushError ? 1 : 0;
}

function send(res, code, payloadObj) {
  const body = JSON.stringify(payloadObj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = (req.url || '').split('?')[0];

  // Liveness check — used by the launcher to detect an already-running keeper,
  // and handy for a human to open in a browser on the server.
  if (url === '/health') return send(res, 200, { ok: true, keeper: true, version: KEEPER_VERSION });
  if (url === '/shutdown') {
    // Allow a newer app to replace a stale keeper. Flush pending writes to disk
    // FIRST, synchronously (same as the SIGINT/SIGTERM handler below) — not on a
    // timer, which used to be shorter than the save window and could drop a
    // write landing in the gap. Everything from here to process.exit() runs
    // synchronously (no await, no setTimeout), so no other request can be
    // processed in between and nothing can land after the flush unflushed.
    const exitCode = flushOrAuditThenExitCode('/shutdown');
    send(res, 200, { ok: true, bye: true });
    process.exit(exitCode);
    return;
  }

  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });

  let body;
  try { body = await readBody(req); }
  catch { return send(res, 400, { ok: false, error: 'bad request body' }); }

  try {
    switch (url) {
      // ── reads (no queue) ──
      case '/all':        return send(res, 200, { ok: true, result: engine.all(body.table) });
      case '/generation': return send(res, 200, { ok: true, result: engine.getGeneration() });
      case '/get':        return send(res, 200, { ok: true, result: engine.get(body.table, body.key) });
      case '/query':      return send(res, 200, { ok: true, result: engine.query(body.table, body.opts || {}) });
      case '/nextNumber': return send(res, 200, { ok: true, result: engine.nextNumber(body.table, body.field, body.prefix) });
      case '/export':     return send(res, 200, { ok: true, result: engine.exportBytes() });

      // ── writes (serialized through the engine's queue) ──
      case '/add':     return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.add(body.table, body.obj)) });
      case '/addWithNumber': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.addWithNumber(body.table, body.obj, body.field, body.prefix, body.scope)) });
      case '/put':     return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.put(body.table, body.obj)) });
      case '/update':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.update(body.table, body.key, body.changes)) });
      case '/delete':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.del(body.table, body.key)) });
      case '/bulkAdd': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => { for (const o of body.objs) engine.add(body.table, o); }) });
      case '/bulkPut': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => { for (const o of body.objs) engine.put(body.table, o); }) });
      case '/clear':   return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.clearTable(body.table)) });
      case '/vacuum':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.vacuum()) });
      case '/saveMemo': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.saveMemo(body.challanId, body.seat)) });
      case '/masterData/learn': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.learnMasterData(body.pairs)) });
      case '/masterData/addCoded': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.addCodedMasterData(body.field, body.value, body.details)) });
      case '/firmLedger/createForChallan': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.createLedgerEntriesForChallan(body.challanId)) });
      case '/firmLedger/settle':     return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.recordFirmSettlement(body.firmName, body.amount, body.note)) });
      case '/firmLedger/adjustments': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.saveChallanAdjustments(body.challanNumber, body.firmName, body.adjustments)) });
      case '/firmLedger/manual':     return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.addManualLedgerEntry(body.firmName, body.type, body.category, body.amount, body.description, body.entryDate)) });
      case '/firmLedger/recompute':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.recomputeFirmLedger(body.firmName)) });
      case '/dbFileSize': return send(res, 200, { ok: true, result: engine.getDbFileSize() });

      // ── challan-lifecycle cascades — each one atomic keeper turn, gated by a
      // server-side wasuli-lock check (see engine.cjs challanWasuliLockCount/
      // drWasuliLock) run before the transaction opens ──
      case '/cascade/deleteChallan':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.cascadeDeleteChallanSync(body.challanId, body.confirm)) });
      case '/cascade/cancelChallan':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.cascadeCancelChallanSync(body.challanId)) });
      case '/cascade/reopenChallan':  return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.cascadeReopenChallanSync(body.challanId)) });
      case '/cascade/restoreChallan': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.restoreChallanCascadeSync(body.challanId)) });
      case '/cascade/deleteEntry':    return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.deleteEntryCascadeSync(body.entryId)) });
      case '/cascade/updateDRCharges': return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.updateDRChargesSync(body.drId, body.charges, body.seenTotal)) });

      // ── backups & restore ──
      case '/backup/getFolder': return send(res, 200, { ok: true, result: engine.getBackupFolder() });
      case '/backup/getInterval': return send(res, 200, { ok: true, result: engine.getBackupInterval() });
      case '/backup/setInterval': return send(res, 200, { ok: true, result: engine.setBackupInterval(body.days) });
      case '/export/getFolder': return send(res, 200, { ok: true, result: engine.getExportFolder(body.kind) });
      case '/export/save':      return send(res, 200, { ok: true, result: engine.saveExport(body.kind, body.fileName, body.content) });
      case '/backup/now':       return send(res, 200, { ok: true, result: engine.backupNow() });
      case '/backup/list':      return send(res, 200, { ok: true, result: engine.listBackups() });
      case '/backup/getExtraTargets': return send(res, 200, { ok: true, result: engine.getExtraTargets() });
      case '/backup/setExtraTargets': return send(res, 200, { ok: true, result: engine.setExtraTargets(body.list) });
      case '/backup/health':    return send(res, 200, { ok: true, result: engine.getBackupHealth() });
      case '/safeMode':         return send(res, 200, { ok: true, result: engine.getSafeMode() });
      case '/recordCounts':     return send(res, 200, { ok: true, result: engine.getRecordCounts() });
      case '/markDataCleared':  return send(res, 200, { ok: true, result: engine.markDataCleared() });
      case '/audit':            return send(res, 200, { ok: true, result: (engine.auditEvent(body.event, body.detail), true) });
      case '/audit/getSecondDir': return send(res, 200, { ok: true, result: engine.getSecondAuditDir() });
      case '/audit/setSecondDir': return send(res, 200, { ok: true, result: engine.setSecondAuditDir(body.dir) });
      // restore/import go through the write queue so they can't collide with writes.
      // Without body.force, these return a confirm-summary instead of restoring
      // (see engine.restoreFromBytes) — the caller re-sends with force:true after
      // the operator confirms.
      case '/backup/restore':   return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.restoreFromFile(body.filePath, body.force)) });
      case '/import':           return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.restoreFromBytes(body.bytes, body.force)) });
      case '/merge/impact':     return send(res, 200, { ok: true, result: engine.countMergeImpact(body.field, body.from) });
      case '/merge':            return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.mergeMaster(body.field, body.from, body.to)) });
      case '/merge/challanCheck': return send(res, 200, { ok: true, result: engine.challanMergeCheck(body.keepId, body.removeId) });
      case '/merge/challans':     return send(res, 200, { ok: true, result: await engine.serializeWrite(() => engine.mergeChallansWrite(body.keepId, body.removeId, body.seat)) });

      default: return send(res, 404, { ok: false, error: 'unknown route: ' + url });
    }
  } catch (e) {
    console.error('[keeper] route error', url, e);
    return send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

async function main() {
  const dataRoot = process.argv[2];
  const port = parseInt(process.argv[3], 10);

  if (!dataRoot || !port) {
    console.error('[keeper] usage: node server.cjs <dataRoot> <port>');
    process.exit(1);
  }

  // keeper.log: a launch separator first, then one line covering everything a
  // months-later diagnosis needs about how this launch resolved its root.
  // "shared-config" vs "fallback" is determined by comparing against what
  // bootstrap.cjs's getConfiguredRoot() would return right now, rather than
  // passing a 3rd argv flag — reuses the existing resolver instead of
  // widening the `node server.cjs <dataRoot> <port>` usage contract.
  engine.keeperLogLaunchSeparator();
  const configuredRoot = bootstrap.getConfiguredRoot();
  const rootSource = (configuredRoot && path.resolve(configuredRoot) === path.resolve(dataRoot)) ? 'shared-config' : 'fallback';
  const risky = bootstrap.isRiskyPath(dataRoot);
  engine.auditEvent('keeper-launch', { version: KEEPER_VERSION, root: dataRoot, rootSource, risky });
  if (rootSource === 'fallback') {
    console.warn('[keeper] using a FALLBACK data root (not the shared config):', dataRoot);
  }

  // TODO: initDb() is awaited to completion before server.listen() below starts
  // accepting requests, so there's no request-queuing gap today. If that ordering
  // ever changes (e.g. listening starts before initDb resolves), requests could
  // race a not-yet-open db. Spotted during the better-sqlite3 migration but out
  // of scope for it — separate architectural change, not fixed here.
  await engine.initDb(dataRoot);

  const server = http.createServer((req, res) => { handle(req, res); });

  // Single-instance guard: if the port is already in use, a keeper is already
  // running. Exit quietly — the app will connect to the existing one.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('[keeper] port in use — another keeper is already running. Exiting.');
      process.exit(0);
    }
    console.error('[keeper] server error:', err);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.error(`[keeper] listening on http://${HOST}:${port}  root=${dataRoot}`);
    engine.auditEvent('keeper-listening', { host: HOST, port });
  });

  // Backstop for offices that never close the app: re-check every 6 hours whether
  // an auto-backup is due. backupOnStart() only writes if the interval has elapsed,
  // so this is cheap and idempotent. Same interval also sweeps old soft-deleted
  // rows (90-day retention) — a background job, never a side effect of a screen
  // being viewed.
  setInterval(() => {
    try { engine.backupOnStart(); } catch { /* ignore */ }
    engine.serializeWrite(() => engine.purgeOldDeleted()).catch(() => {});
  }, 6 * 60 * 60 * 1000);

  // Save any pending data on shutdown so nothing is lost.
  const shutdown = () => process.exit(flushOrAuditThenExitCode('signal'));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
