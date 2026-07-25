/**
 * ipc-forward.cjs — runs in the Electron MAIN process of each seat.
 *
 * Registers the same ipcMain channels the old db-host.cjs did. DB and backup
 * operations now FORWARD to the keeper over the client. preload.cjs and the
 * renderer are unchanged — window.sqlAPI keeps its shape.
 *
 * Dialogs (folder picker, restore-file picker) MUST run here on the app side —
 * the keeper is a background process with no window to show a dialog on. The app
 * shows the dialog, then sends the chosen path to the keeper.
 *
 * After a successful restore/import the database has changed for EVERYONE, so we
 * broadcast a 'db:changed' event to all windows so each seat can refresh.
 */

const { ipcMain, dialog, BrowserWindow } = require('electron');
const client = require('./client.cjs');

function broadcastDbChanged() {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('db:changed'); } catch { /* ignore */ }
  }
}

function registerForwardingIpc() {
  const api = client.api;

  // reads
  ipcMain.handle('db:all',        (_e, table) => api.all(table));
  ipcMain.handle('db:get',        (_e, table, key) => api.get(table, key));
  ipcMain.handle('db:query',      (_e, table, opts) => api.query(table, opts || {}));
  ipcMain.handle('db:nextNumber', (_e, table, field, prefix) => api.nextNumber(table, field, prefix));
  ipcMain.handle('db:addWithNumber', (_e, table, obj, field, prefix, scope) => api.addWithNumber(table, obj, field, prefix, scope));
  ipcMain.handle('db:getGeneration', () => api.getGeneration());
  ipcMain.handle('db:export',     () => api.exportDb());

  // writes
  ipcMain.handle('db:add',     (_e, table, obj) => api.add(table, obj));
  ipcMain.handle('db:put',     (_e, table, obj) => api.put(table, obj));
  ipcMain.handle('db:update',  (_e, table, key, ch) => api.update(table, key, ch));
  ipcMain.handle('db:delete',  (_e, table, key) => api.delete(table, key));
  ipcMain.handle('db:bulkAdd', (_e, table, objs) => api.bulkAdd(table, objs));
  ipcMain.handle('db:bulkPut', (_e, table, objs) => api.bulkPut(table, objs));
  ipcMain.handle('db:clear',   (_e, table) => api.clear(table));
  ipcMain.handle('db:vacuum',  () => api.vacuum());
  ipcMain.handle('memo:save',  (_e, challanId, seat) => api.saveMemo(challanId, seat));
  ipcMain.handle('masterData:learn', (_e, pairs) => api.learnMasterData(pairs));
  ipcMain.handle('masterData:addCoded', (_e, field, value, details) => api.addCodedMasterData(field, value, details));
  ipcMain.handle('firmLedger:createForChallan', (_e, challanId) => api.createLedgerEntriesForChallan(challanId));
  ipcMain.handle('firmLedger:settle', (_e, firmName, amount, note) => api.recordFirmSettlement(firmName, amount, note));
  ipcMain.handle('firmLedger:adjustments', (_e, challanNumber, firmName, adjustments) => api.saveChallanAdjustments(challanNumber, firmName, adjustments));
  ipcMain.handle('firmLedger:manual', (_e, firmName, type, category, amount, description, entryDate) => api.addManualLedgerEntry(firmName, type, category, amount, description, entryDate));
  ipcMain.handle('firmLedger:recompute', (_e, firmName) => api.recomputeFirmLedger(firmName));
  ipcMain.handle('db:getDbFileSize', () => api.getDbFileSize());
  ipcMain.handle('cascade:deleteChallan', (_e, challanId, confirm) => api.cascadeDeleteChallan(challanId, confirm));
  ipcMain.handle('cascade:cancelChallan', (_e, challanId) => api.cascadeCancelChallan(challanId));
  ipcMain.handle('cascade:reopenChallan', (_e, challanId) => api.cascadeReopenChallan(challanId));
  ipcMain.handle('cascade:restoreChallan', (_e, challanId) => api.restoreChallanCascade(challanId));
  ipcMain.handle('cascade:deleteEntry', (_e, entryId) => api.deleteEntryCascade(entryId));
  ipcMain.handle('cascade:updateDRCharges', (_e, drId, charges, seenTotal) => api.updateDRCharges(drId, charges, seenTotal));

  // import — validated inside the keeper (same path as restore), then broadcast.
  // Without force, resolves to a confirm-summary instead of importing.
  ipcMain.handle('db:import',  async (_e, bytes, force) => {
    const r = await api.importBytes(bytes, force);
    if (r && r.ok) broadcastDbChanged();
    return r;
  });

  // ── backup folder / export folder (read-only: both are root-derived, see
  // engine.cjs getBackupFolder/getExportFolder — no picker, no stored override) ──
  ipcMain.handle('backup:getFolder', () => api.backupGetFolder());
  ipcMain.handle('backup:getInterval', () => api.backupGetInterval());
  ipcMain.handle('backup:setInterval', (_e, days) => api.backupSetInterval(days));
  ipcMain.handle('export:getFolder', (_e, kind) => api.exportGetFolder(kind));
  ipcMain.handle('export:save', (_e, kind, fileName, content) => api.exportSave(kind, fileName, content));
  ipcMain.handle('backup:now',       () => api.backupNow());
  ipcMain.handle('backup:list',      () => api.backupList());
  ipcMain.handle('backup:getExtraTargets', () => api.backupGetExtraTargets());
  ipcMain.handle('backup:setExtraTargets', (_e, list) => api.backupSetExtraTargets(list));
  ipcMain.handle('backup:health',    () => api.backupHealth());
  ipcMain.handle('safe:mode',        () => api.safeMode());
  ipcMain.handle('db:recordCounts',  () => api.recordCounts());
  ipcMain.handle('data:markCleared', () => api.markDataCleared());
  ipcMain.handle('audit:log',        (_e, event, detail) => api.audit(event, detail));
  ipcMain.handle('audit:getSecondDir', () => api.auditGetSecondDir());
  ipcMain.handle('audit:setSecondDir', (_e, dir) => api.auditSetSecondDir(dir));
  ipcMain.handle('audit:pickSecondDir', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a second location for the audit log (server or another drive)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true, folder: '' };
    await api.auditSetSecondDir(res.filePaths[0]);
    return { canceled: false, folder: res.filePaths[0] };
  });
  // Let the customer pick an extra backup folder (pendrive, second drive, etc.).
  // Native dialog runs app-side; no drive letter is assumed anywhere.
  ipcMain.handle('backup:pickExtraTarget', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose an extra backup folder (pendrive or another drive)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true, folder: '' };
    return { canceled: false, folder: res.filePaths[0] };
  });

  // merge:impact is read-only (drives the confirm popup). merge changes the
  // shared DB (like restore), so on success we broadcast so every seat reloads.
  ipcMain.handle('merge:impact', (_e, field, from) => api.mergeImpact(field, from));
  ipcMain.handle('merge:run', async (_e, field, from, to) => {
    const r = await api.mergeMaster(field, from, to);
    broadcastDbChanged();
    return r;
  });

  ipcMain.handle('merge:challanCheck', (_e, keepId, removeId) => api.challanMergeCheck(keepId, removeId));
  ipcMain.handle('merge:challans', async (_e, keepId, removeId) => {
    const r = await api.mergeChallansDup(keepId, removeId);
    if (r && r.ok) broadcastDbChanged();
    return r;
  });

  // restore — keeper validates + takes prerestore snapshot; then broadcast refresh.
  // Without force, resolves to a confirm-summary instead of restoring (see
  // engine.restoreFromBytes); the renderer re-invokes with force:true after the
  // operator confirms what they're about to replace.
  ipcMain.handle('backup:restore', async (_e, filePath, force) => {
    const r = await api.backupRestore(filePath, force);
    if (r && r.ok) broadcastDbChanged();
    return r;
  });

  // dialogs run app-side; chosen path is then sent to the keeper
  ipcMain.handle('backup:pickRestoreFile', async () => {
    const win = BrowserWindow.getFocusedWindow();
    let defaultPath;
    try { defaultPath = await api.backupGetFolder(); } catch { defaultPath = undefined; }
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a backup file to restore',
      defaultPath,
      filters: [{ name: 'Database Backup', extensions: ['db'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true, path: '' };
    return { canceled: false, path: res.filePaths[0] };
  });
}

module.exports = { registerForwardingIpc };
