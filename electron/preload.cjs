/**
 * preload.cjs — runs in the isolated preload context with access to ipcRenderer.
 * Exposes a safe `window.sqlAPI` the renderer uses to talk to the main-process DB host.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sqlAPI', {
  all:        (table) => ipcRenderer.invoke('db:all', table),
  get:        (table, key) => ipcRenderer.invoke('db:get', table, key),
  query:      (table, opts) => ipcRenderer.invoke('db:query', table, opts),
  add:        (table, obj) => ipcRenderer.invoke('db:add', table, obj),
  put:        (table, obj) => ipcRenderer.invoke('db:put', table, obj),
  update:     (table, key, changes) => ipcRenderer.invoke('db:update', table, key, changes),
  delete:     (table, key) => ipcRenderer.invoke('db:delete', table, key),
  bulkAdd:    (table, objs) => ipcRenderer.invoke('db:bulkAdd', table, objs),
  bulkPut:    (table, objs) => ipcRenderer.invoke('db:bulkPut', table, objs),
  clear:      (table) => ipcRenderer.invoke('db:clear', table),
  vacuum:     () => ipcRenderer.invoke('db:vacuum'),
  saveMemo:   (challanId, seat) => ipcRenderer.invoke('memo:save', challanId, seat),
  learnMasterData: (pairs) => ipcRenderer.invoke('masterData:learn', pairs),
  addCodedMasterData: (field, value, details) => ipcRenderer.invoke('masterData:addCoded', field, value, details),
  createLedgerEntriesForChallan: (challanId) => ipcRenderer.invoke('firmLedger:createForChallan', challanId),
  recordFirmSettlement: (firmName, amount, note) => ipcRenderer.invoke('firmLedger:settle', firmName, amount, note),
  saveChallanAdjustments: (challanNumber, firmName, adjustments) => ipcRenderer.invoke('firmLedger:adjustments', challanNumber, firmName, adjustments),
  addManualLedgerEntry: (firmName, type, category, amount, description, entryDate) => ipcRenderer.invoke('firmLedger:manual', firmName, type, category, amount, description, entryDate),
  recomputeFirmLedger: (firmName) => ipcRenderer.invoke('firmLedger:recompute', firmName),
  getDbFileSize: () => ipcRenderer.invoke('db:getDbFileSize'),
  cascadeDeleteChallan:  (challanId, confirm) => ipcRenderer.invoke('cascade:deleteChallan', challanId, confirm),
  cascadeCancelChallan:  (challanId) => ipcRenderer.invoke('cascade:cancelChallan', challanId),
  cascadeReopenChallan:  (challanId) => ipcRenderer.invoke('cascade:reopenChallan', challanId),
  restoreChallanCascade: (challanId) => ipcRenderer.invoke('cascade:restoreChallan', challanId),
  deleteEntryCascade:    (entryId) => ipcRenderer.invoke('cascade:deleteEntry', entryId),
  updateDRCharges:       (drId, charges, seenTotal) => ipcRenderer.invoke('cascade:updateDRCharges', drId, charges, seenTotal),
  nextNumber: (table, field, prefix) => ipcRenderer.invoke('db:nextNumber', table, field, prefix),
  addWithNumber: (table, obj, field, prefix, scope) => ipcRenderer.invoke('db:addWithNumber', table, obj, field, prefix, scope),
  getGeneration: () => ipcRenderer.invoke('db:getGeneration'),
  exportDb:   () => ipcRenderer.invoke('db:export'),
  importDb:   (bytes, force) => ipcRenderer.invoke('db:import', bytes, force),
  // Backup / export folders — both are root-derived only (no stored override,
  // no picker; see engine.cjs getBackupFolder/getExportFolder).
  getBackupFolder:  () => ipcRenderer.invoke('backup:getFolder'),
  getBackupInterval: () => ipcRenderer.invoke('backup:getInterval'),
  setBackupInterval: (days) => ipcRenderer.invoke('backup:setInterval', days),
  getExportFolder: (kind) => ipcRenderer.invoke('export:getFolder', kind),
  saveExport: (kind, fileName, content) => ipcRenderer.invoke('export:save', kind, fileName, content),
  backupNow:        () => ipcRenderer.invoke('backup:now'),
  listBackups:      () => ipcRenderer.invoke('backup:list'),
  getExtraTargets:  () => ipcRenderer.invoke('backup:getExtraTargets'),
  setExtraTargets:  (list) => ipcRenderer.invoke('backup:setExtraTargets', list),
  pickExtraTarget:  () => ipcRenderer.invoke('backup:pickExtraTarget'),
  backupHealth:     () => ipcRenderer.invoke('backup:health'),
  safeMode:         () => ipcRenderer.invoke('safe:mode'),
  recordCounts:     () => ipcRenderer.invoke('db:recordCounts'),
  markDataCleared:  () => ipcRenderer.invoke('data:markCleared'),
  auditEvent:       (event, detail) => ipcRenderer.invoke('audit:log', event, detail),
  getSecondAuditDir:() => ipcRenderer.invoke('audit:getSecondDir'),
  pickSecondAuditDir:() => ipcRenderer.invoke('audit:pickSecondDir'),
  pickRestoreFile:  () => ipcRenderer.invoke('backup:pickRestoreFile'),
  restoreBackup:    (filePath, force) => ipcRenderer.invoke('backup:restore', filePath, force),
  mergeImpact:      (field, from) => ipcRenderer.invoke('merge:impact', field, from),
  mergeMaster:      (field, from, to) => ipcRenderer.invoke('merge:run', field, from, to),
  challanMergeCheck:  (keepId, removeId) => ipcRenderer.invoke('merge:challanCheck', keepId, removeId),
  mergeChallansDup:   (keepId, removeId) => ipcRenderer.invoke('merge:challans', keepId, removeId),
  // Fired after a restore/import changes the shared database for everyone.
  // The renderer can subscribe to refresh its views. Returns an unsubscribe fn.
  onDbChanged:      (cb) => {
    const handler = () => { try { cb(); } catch { /* ignore */ } };
    ipcRenderer.on('db:changed', handler);
    return () => ipcRenderer.removeListener('db:changed', handler);
  },
  // This seat's name (per-seat, e.g. "PC-01"). Used to stamp the audit log.
  getSeatName:      () => ipcRenderer.invoke('seat:get'),
  setSeatName:      (name) => ipcRenderer.invoke('seat:set', name),
  // Shared data-root folder (holds db/backups/PDF/CSV/config for ALL seats).
  // changeDataRoot() shows the folder picker, migrates existing data, and
  // restarts this seat — the promise only resolves early if cancelled/failed.
  getDataRoot:      () => ipcRenderer.invoke('dataRoot:get'),
  changeDataRoot:   () => ipcRenderer.invoke('dataRoot:change'),
});
