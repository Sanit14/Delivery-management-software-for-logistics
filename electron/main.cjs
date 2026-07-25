const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { ensureKeeper } = require('./keeper/launcher.cjs');
const { registerForwardingIpc } = require('./keeper/ipc-forward.cjs');
const { getConfiguredRoot, saveRoot, validateRoot, clearConfiguredRoot, suggestedRoot, isRiskyPath } = require('./keeper/bootstrap.cjs');
const { getSeatName, setSeatName } = require('./keeper/seat.cjs');
const safeguard = require('./keeper/safeguard.cjs');

// ── Data root resolution ───────────────────────────────────────────────────────
// The data root holds the ONE shared database (and backups, config, exports). It
// must be the SAME for all six seats. It is chosen ONCE via a first-run dialog and
// stored in a per-machine pointer (see bootstrap.cjs), then read on every launch.
//
// firstRunChooseRoot() shows a native folder picker (the renderer isn't loaded this
// early, so we use Electron's dialog). It loops until the operator picks a writable
// folder or cancels. Returns the chosen root, or '' if they cancelled.
//
// opts.strict (used by the risky-root recovery flow below): a risky choice is
// rejected and re-prompted with NO "use this folder anyway" override — recovering
// from a refused risky root must never be able to land back on another risky one.
// Plain first-run setup (no opts) keeps the existing override unchanged.
function firstRunChooseRoot(opts) {
  const strict = !!(opts && opts.strict);
  // Suggest a reliable, writable-by-everyone default: a plain folder directly on
  // the C: drive — NOT inside Documents/AppData/any per-user profile folder, and
  // NOT inside Program Files. On multi-seat setups (NComputing etc.) each seat is
  // a DIFFERENT Windows user, so a folder inside one user's profile (e.g. their
  // Documents) is usually unwritable from every other seat, even though it looks
  // fine to whoever ran this picker. See isRiskyPath() below for the same check
  // applied if the operator picks a folder manually instead of using this default.
  const suggested = suggestedRoot();

  // Tell the operator what's about to happen.
  dialog.showMessageBoxSync({
    type: 'info',
    title: 'DeliveryManager — First-time Setup',
    message: 'Where should data be stored?',
    detail: 'All DeliveryManager data (database, backups, reports) will be kept in one folder. ' +
            'This must be the same folder for all computers/sessions. ' +
            'On the next screen, choose that folder (or create a new one). Suggestion: ' + suggested,
    buttons: ['OK, choose folder'],
    noLink: true,
  });

  // Loop until a writable folder is chosen or the operator cancels.
  while (true) {
    const res = dialog.showOpenDialogSync({
      title: 'Choose data folder (same for all PCs)',
      defaultPath: suggested,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!res || !res[0]) return ''; // cancelled

    const chosen = res[0];
    const v = validateRoot(chosen);
    if (v.ok) {
      // Write access from THIS account is confirmed, but that alone isn't enough
      // on a multi-seat server — warn if the folder is somewhere other seats'
      // accounts are unlikely to be able to write to.
      if (isRiskyPath(chosen)) {
        if (strict) {
          // Recovery mode: no override. A risky re-choice would put the app
          // right back into the refusal this flow exists to get out of.
          safeguard.audit('root-rejected', { path: chosen, reason: 'risky-path-strict' });
          dialog.showErrorBox(
            'This folder cannot be used',
            'This folder is inside a personal user folder or Program Files, which is unsafe for a ' +
            'multi-seat setup — the same reason the previous folder was refused.\n\n' +
            'Please choose a plain folder directly on the C: or D: drive instead, e.g. C:\\DeliveryManagerData.'
          );
          continue; // back to the folder picker
        }
        const proceed = dialog.showMessageBoxSync({
          type: 'warning',
          title: 'This folder may not work for other computers/seats',
          message: 'This folder is inside a personal user folder or Program Files.',
          detail:
            'On multi-seat setups, each computer/session logs in as a DIFFERENT Windows user. ' +
            'A folder inside one user\'s personal folder (Documents, Desktop, AppData, etc.) or inside ' +
            'Program Files usually cannot be written to by the OTHER seats\' accounts — even though it ' +
            'works here, on this one. That causes a "Cannot write to this folder" error on every other seat.\n\n' +
            'Recommended: choose a plain folder directly on the C: drive instead, e.g. C:\\DeliveryManagerData.',
          buttons: ['Choose a different folder', 'Use this folder anyway'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (proceed === 0) {
          safeguard.audit('root-rejected', { path: chosen, reason: 'risky-path-declined' });
          continue; // back to the folder picker
        }
      }
      return chosen;
    }

    const retry = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Folder cannot be used',
      message: 'Data cannot be saved in this folder.',
      detail: v.error + '\n\nWould you like to choose a different folder?',
      buttons: ['Choose another folder', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (retry !== 0) return '';
  }
}

function resolveDataRoot() {
  // Already configured (or env override)? This is the normal path on every
  // seat after the first. Still run the SAME risky-path check the first-run
  // picker runs below — this seat never saw that interactive warning (only
  // whoever ran setup did), so silently trusting a saved-but-risky root would
  // be exactly the silent failure the safety contract forbids. Refuse rather
  // than open with a root likely to diverge per-seat.
  const existing = getConfiguredRoot();
  if (existing) {
    if (isRiskyPath(existing)) {
      safeguard.audit('risky-root-refused', { root: existing });
      return recoverFromRiskyRoot(existing);
    }
    return existing;
  }

  // Shared config missing/empty (dev box, or a pre-install launch) — fall back
  // to the interactive first-run picker. Never silent: if the installer's job
  // was skipped, every seat could otherwise end up choosing its OWN root,
  // which is the exact per-seat divergence this app exists to prevent.
  console.warn('[app] no shared root.json found — falling back to the first-run picker.');
  safeguard.audit('root-fallback-firstrun', { reason: 'no shared config found' });

  const chosen = firstRunChooseRoot();
  if (!chosen) return ''; // cancelled → caller will exit

  const saved = saveRoot(chosen);
  if (!saved.ok) {
    dialog.showErrorBox('Setup could not be saved', saved.error);
    return '';
  }
  return chosen;
}

// Recovery path for a refused risky root (see resolveDataRoot above): the
// refusal itself must stay — this only gets the operator OUT of it without
// hand-editing root.json. Reuses the same picker first-run setup uses, in
// strict mode (see firstRunChooseRoot's opts.strict) so a risky re-choice is
// rejected and re-prompted, never accepted. Returns the new root to continue
// startup with, or '' if the operator quit instead.
function recoverFromRiskyRoot(oldRoot) {
  safeguard.audit('risky-root-recovery-shown', { root: oldRoot });

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'Data folder is not safe to use',
    message: 'The current data folder is in an unsafe location, so DeliveryManager will not use it — this protects your data.',
    detail: oldRoot +
      '\n\nOn multi-seat setups this usually cannot be written to by every seat. Choose a new, safe folder to ' +
      'continue (a plain folder directly on the C: or D: drive works best, e.g. C:\\DeliveryManagerData).\n\n' +
      'This will NOT move or copy anything from the old folder. If you have existing records there, copy them ' +
      'into the new folder yourself afterwards, or restore from a backup once the app is running.',
    buttons: ['Choose a new folder', 'Exit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (choice !== 0) {
    safeguard.audit('risky-root-recovery-cancelled', { root: oldRoot });
    return '';
  }

  const chosen = firstRunChooseRoot({ strict: true });
  if (!chosen) {
    safeguard.audit('risky-root-recovery-cancelled', { root: oldRoot });
    return '';
  }

  const saved = saveRoot(chosen);
  if (!saved.ok) {
    dialog.showErrorBox('Setting could not be saved', saved.error);
    return '';
  }

  // ponytail: intentionally does NOT move/copy data from the old risky folder
  // — that stays a separate, manual step for the operator. This only
  // re-points root.json at a new (possibly empty) folder; the existing
  // blank-DB guard / first-run behavior applies to it normally from here.
  safeguard.audit('risky-root-recovered', { old: oldRoot, new: chosen });
  return chosen;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800,
    minWidth: 1024, minHeight: 600,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    title: 'DeliveryManager — Sundeep Freight Movers',
    icon: path.join(__dirname, '../build/icon.ico'),
  });
  win.setMenuBarVisibility(false);
  win.maximize();
  win.show();

  // Ctrl+R = full software reload (the "big hammer" refresh). Works even though the
  // menu bar is hidden. The in-app per-page refresh button is the gentler option.
  win.webContents.on('before-input-event', (event, input) => {
    const isReload = (input.control || input.meta) && input.key.toLowerCase() === 'r';
    if (isReload && input.type === 'keyDown') {
      win.webContents.reload();
      event.preventDefault();
    }
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  // 1) Decide the shared data root (first-run dialog, or saved pointer).
  const root = resolveDataRoot();
  if (!root) {
    // Operator cancelled setup — nothing to do without a data location.
    app.quit();
    return;
  }

  // Validate the root is actually usable BEFORE handing it to the keeper. This
  // catches a bad/stale pointer (e.g. a saved D:\ on a machine with no D: drive)
  // and explains it clearly instead of crashing. If it's not usable, clear the
  // saved pointer so the next launch asks again, then exit.
  const rootCheck = validateRoot(root);
  if (!rootCheck.ok) {
    clearConfiguredRoot();
    dialog.showErrorBox(
      'Data folder cannot be used',
      rootCheck.error + '\n\nPlease restart the app and choose a valid folder (one that exists, e.g. on the C: drive).'
    );
    app.quit();
    return;
  }

  // 2) Ensure exactly one keeper is running at that root, and connect.
  try {
    fs.mkdirSync(root, { recursive: true });
    await ensureKeeper(root);
  } catch (e) {
    // No silent fallback to a local DB. Tell the user plainly and exit.
    dialog.showErrorBox(
      'Database service is not running',
      (e && e.message) ? e.message :
        'Database service could not be started. Please contact your administrator. Do not enter data at this time.'
    );
    app.quit();
    return;
  }

  // 3) Wire IPC (forwards to keeper) and open the window.
  registerForwardingIpc();
  // Seat identity IPC — renderer asks for / sets this seat's name (per-seat).
  const { ipcMain } = require('electron');
  ipcMain.handle('seat:get', () => getSeatName());
  ipcMain.handle('seat:set', (_e, name) => setSeatName(name));
  // Data root IPC — lets Settings show the current shared folder and change it
  // (Change Data Folder button) without needing to delete config files by hand.
  const { changeDataRoot } = require('./keeper/root-change.cjs');
  ipcMain.handle('dataRoot:get', () => getConfiguredRoot());
  ipcMain.handle('dataRoot:change', () => changeDataRoot());
  createWindow();
});

app.on('window-all-closed', () => {
  // Log a clean close with final record counts to the external audit log, so the
  // last-known-good state before shutdown is recorded outside the data folder.
  try {
    const { api } = require('./keeper/client.cjs');
    api.recordCounts().then(c => api.audit('app-close', c)).catch(() => {});
  } catch { /* ignore */ }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
