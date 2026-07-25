/**
 * client.cjs — runs in the Electron MAIN process of each app seat.
 *
 * Replaces the old in-process database. Instead of running add/query/... locally,
 * each app forwards the request to the ONE keeper over http://127.0.0.1:<port>.
 * The preload + renderer are unchanged — window.sqlAPI keeps the same shape; only
 * what happens behind ipcMain.handle changes from "do it here" to "ask the keeper".
 *
 * No silent fallback to a local database: if the keeper can't be reached, calls
 * fail loudly. A silent local DB is exactly what caused the original isolation bug,
 * so we never do that.
 */

const http = require('http');

const HOST = '127.0.0.1';
let PORT = 0;

function setPort(port) { PORT = port; }

// One POST to the keeper. Resolves with the route's `result`, or rejects on a
// transport error or a keeper-reported error.
function call(route, payload, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const req = http.request(
      { host: HOST, port: PORT, path: route, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(data); }
          catch { return reject(new Error('keeper sent bad response')); }
          if (res.statusCode === 200 && parsed.ok) resolve(parsed.result);
          else reject(new Error(parsed.error || ('keeper error ' + res.statusCode)));
        });
      }
    );
    req.on('error', (e) => reject(new Error('keeper unreachable: ' + e.message)));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('keeper timeout')); });
    req.end(body);
  });
}

// Liveness probe — GET /health. Resolves true if a keeper answers, false otherwise.
function ping({ timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: '/health', method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { const p = JSON.parse(data); resolve(!!(res.statusCode === 200 && p.ok)); }
          catch { resolve(false); }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Returns the running keeper's version number (0 if unknown / not answering).
function getVersion({ timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: '/health', method: 'GET' },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { const p = JSON.parse(data); resolve(typeof p.version === 'number' ? p.version : 0); }
          catch { resolve(0); }
        });
      }
    );
    req.on('error', () => resolve(0));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(0); });
    req.end();
  });
}

// Ask a stale keeper to shut down so a fresh one can take its place.
function shutdown({ timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path: '/shutdown', method: 'GET' },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Wait until a keeper answers /health, or give up after maxWaitMs. Used at app
// startup so a seat that opens before the keeper is ready waits rather than failing.
async function waitUntilReady({ maxWaitMs = 10000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    if (await ping()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// The same operations the old db-host exposed, now as keeper calls.
const api = {
  all:        (table) => call('/all', { table }),
  get:        (table, key) => call('/get', { table, key }),
  query:      (table, opts) => call('/query', { table, opts }),
  nextNumber: (table, field, prefix) => call('/nextNumber', { table, field, prefix }),
  addWithNumber: (table, obj, field, prefix, scope) => call('/addWithNumber', { table, obj, field, prefix, scope }),
  getGeneration: () => call('/generation', {}, { timeoutMs: 3000 }),
  exportDb:   () => call('/export', {}),
  add:        (table, obj) => call('/add', { table, obj }),
  put:        (table, obj) => call('/put', { table, obj }),
  update:     (table, key, changes) => call('/update', { table, key, changes }),
  delete:     (table, key) => call('/delete', { table, key }),
  bulkAdd:    (table, objs) => call('/bulkAdd', { table, objs }),
  bulkPut:    (table, objs) => call('/bulkPut', { table, objs }),
  clear:      (table) => call('/clear', { table }),
  vacuum:     () => call('/vacuum', {}, { timeoutMs: 60000 }),
  saveMemo:   (challanId, seat) => call('/saveMemo', { challanId, seat }, { timeoutMs: 30000 }),
  learnMasterData: (pairs) => call('/masterData/learn', { pairs }, { timeoutMs: 15000 }),
  addCodedMasterData: (field, value, details) => call('/masterData/addCoded', { field, value, details }, { timeoutMs: 15000 }),
  createLedgerEntriesForChallan: (challanId) => call('/firmLedger/createForChallan', { challanId }, { timeoutMs: 15000 }),
  recordFirmSettlement: (firmName, amount, note) => call('/firmLedger/settle', { firmName, amount, note }, { timeoutMs: 15000 }),
  saveChallanAdjustments: (challanNumber, firmName, adjustments) => call('/firmLedger/adjustments', { challanNumber, firmName, adjustments }, { timeoutMs: 15000 }),
  addManualLedgerEntry: (firmName, type, category, amount, description, entryDate) => call('/firmLedger/manual', { firmName, type, category, amount, description, entryDate }, { timeoutMs: 15000 }),
  recomputeFirmLedger: (firmName) => call('/firmLedger/recompute', { firmName }, { timeoutMs: 15000 }),
  getDbFileSize: () => call('/dbFileSize', {}),
  cascadeDeleteChallan:  (challanId, confirm) => call('/cascade/deleteChallan', { challanId, confirm }, { timeoutMs: 30000 }),
  cascadeCancelChallan:  (challanId) => call('/cascade/cancelChallan', { challanId }, { timeoutMs: 30000 }),
  cascadeReopenChallan:  (challanId) => call('/cascade/reopenChallan', { challanId }, { timeoutMs: 30000 }),
  restoreChallanCascade: (challanId) => call('/cascade/restoreChallan', { challanId }, { timeoutMs: 30000 }),
  deleteEntryCascade:    (entryId) => call('/cascade/deleteEntry', { entryId }, { timeoutMs: 15000 }),
  updateDRCharges:       (drId, charges, seenTotal) => call('/cascade/updateDRCharges', { drId, charges, seenTotal }, { timeoutMs: 15000 }),
  importBytes:(bytes, force) => call('/import', { bytes, force }, { timeoutMs: 60000 }),
  // backups & restore
  backupGetFolder: () => call('/backup/getFolder', {}),
  backupGetInterval: () => call('/backup/getInterval', {}),
  backupSetInterval: (days) => call('/backup/setInterval', { days }),
  exportGetFolder: (kind) => call('/export/getFolder', { kind }),
  exportSave: (kind, fileName, content) => call('/export/save', { kind, fileName, content }, { timeoutMs: 30000 }),
  backupNow:       () => call('/backup/now', {}, { timeoutMs: 60000 }),
  backupList:      () => call('/backup/list', {}),
  backupGetExtraTargets: () => call('/backup/getExtraTargets', {}),
  backupSetExtraTargets: (list) => call('/backup/setExtraTargets', { list }),
  backupHealth:    () => call('/backup/health', {}),
  safeMode:        () => call('/safeMode', {}),
  recordCounts:    () => call('/recordCounts', {}),
  markDataCleared: () => call('/markDataCleared', {}),
  audit:           (event, detail) => call('/audit', { event, detail }),
  auditGetSecondDir: () => call('/audit/getSecondDir', {}),
  auditSetSecondDir: (dir) => call('/audit/setSecondDir', { dir }),
  backupRestore:   (filePath, force) => call('/backup/restore', { filePath, force }, { timeoutMs: 60000 }),
  mergeImpact:     (field, from) => call('/merge/impact', { field, from }),
  mergeMaster:     (field, from, to) => call('/merge', { field, from, to }, { timeoutMs: 60000 }),
  challanMergeCheck:  (keepId, removeId) => call('/merge/challanCheck', { keepId, removeId }),
  mergeChallansDup:   (keepId, removeId) => call('/merge/challans', { keepId, removeId }, { timeoutMs: 60000 }),
};

module.exports = { setPort, ping, getVersion, shutdown, waitUntilReady, api };
