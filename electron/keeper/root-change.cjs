/**
 * root-change.cjs — lets an admin change the shared data root FROM WITHIN the app
 * (Settings → Data Storage Location), instead of needing to delete config files by
 * hand. Runs in the Electron MAIN process.
 *
 * What it does, in order:
 *   1. Show a folder picker (defaulting to the current root).
 *   2. Validate the new folder is actually writable (validateRoot).
 *   3. Warn if the folder looks "risky" for a multi-seat setup (isRiskyPath) — same
 *      check used on first-run setup, so this failure mode can't recur silently.
 *   4. Confirm with the operator (this affects every seat).
 *   5. Stop the keeper so nothing writes to the old location mid-copy.
 *   6. Copy db/, backups/, PDF/, CSV/, config/ from the old root into the new one —
 *      never overwriting anything already present at the destination.
 *   7. Save the new root as the shared pointer (%ProgramData%\DeliveryManager\root.json).
 *   8. Relaunch this seat so it (and a freshly spawned keeper) picks up the new root.
 *
 * Note: only THIS seat restarts automatically. Every other seat is still pointed at
 * the new root (the pointer file is shared), but each of those seats' own app window
 * needs a manual restart to reconnect to the new keeper/location — the confirmation
 * dialog says so explicitly.
 */

const fs = require('fs');
const path = require('path');
const { dialog, app, BrowserWindow } = require('electron');
const client = require('./client.cjs');
const { getConfiguredRoot, saveRoot, validateRoot, isRiskyPath, suggestedRoot } = require('./bootstrap.cjs');

const ROOT_SUBFOLDERS = ['db', 'backups', 'PDF', 'CSV', 'config'];

// Copies each known subfolder from the old root into the new root. force:false +
// errorOnExist:false means: never clobber a file that already exists at the
// destination — safest behavior if the operator points at a folder that already
// has some data in it.
function copyRootContents(fromRoot, toRoot) {
  for (const sub of ROOT_SUBFOLDERS) {
    const src = path.join(fromRoot, sub);
    const dest = path.join(toRoot, sub);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: false, errorOnExist: false });
  }
}

async function changeDataRoot() {
  const win = BrowserWindow.getFocusedWindow();
  const currentRoot = getConfiguredRoot();

  const picked = dialog.showOpenDialogSync(win, {
    title: 'Choose new data folder (applies to ALL seats)',
    defaultPath: currentRoot || suggestedRoot(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!picked || !picked[0]) return { ok: false, canceled: true };

  const chosen = picked[0];

  if (currentRoot && path.resolve(chosen) === path.resolve(currentRoot)) {
    return { ok: false, error: 'That is already the current data folder.' };
  }

  const v = validateRoot(chosen);
  if (!v.ok) {
    dialog.showErrorBox('Folder cannot be used', v.error);
    return { ok: false, error: v.error };
  }

  if (isRiskyPath(chosen)) {
    const proceed = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'This folder may not work for other computers/seats',
      message: 'This folder is inside a personal user folder or Program Files.',
      detail:
        'On multi-seat setups, each computer/session logs in as a DIFFERENT Windows user. ' +
        'A folder inside one user\'s personal folder (Documents, Desktop, AppData, etc.) or inside ' +
        'Program Files usually cannot be written to by the OTHER seats\' accounts — even though it ' +
        'works here, on this one.\n\n' +
        'Recommended: choose a plain folder directly on the C: drive instead, e.g. C:\\DeliveryManagerData.',
      buttons: ['Choose a different folder', 'Use this folder anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (proceed === 0) return { ok: false, canceled: true };
  }

  const confirm = dialog.showMessageBoxSync(win, {
    type: 'question',
    title: 'Change data folder?',
    message: 'Move DeliveryManager data to the new folder?',
    detail:
      `From:\n${currentRoot || '(not set)'}\n\nTo:\n${chosen}\n\n` +
      'The existing database, backups, PDF and CSV files will be copied to the new folder. ' +
      'This app will then restart to use the new location.\n\n' +
      'Important: every OTHER seat/computer must also be closed and reopened afterwards to ' +
      'pick up the new location — they will not switch over automatically.\n\n' +
      'Make sure no one is actively entering data right now.',
    buttons: ['Cancel', 'Move & Restart'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (confirm !== 1) return { ok: false, canceled: true };

  // Stop the keeper so nothing writes to the old location mid-copy.
  try { await client.shutdown(); } catch { /* ignore — may not be running */ }
  await new Promise((r) => setTimeout(r, 400)); // let the port/files release

  // Best-effort copy of existing data. If this fails, the old data is untouched
  // and still safe at currentRoot — tell the operator plainly rather than
  // silently starting fresh in the new folder.
  try {
    if (currentRoot && fs.existsSync(currentRoot)) {
      copyRootContents(currentRoot, chosen);
    }
  } catch (e) {
    dialog.showErrorBox(
      'Could not copy existing data',
      'The new folder was set, but copying old data failed: ' + ((e && e.message) || e) +
      '\n\nYour old data is still safe at:\n' + currentRoot +
      '\n\nYou can copy it into the new folder manually, then restart the app.'
    );
    // fall through — still point at the new root so the operator can retry the
    // copy manually rather than getting stuck with no path forward.
  }

  const saved = saveRoot(chosen);
  if (!saved.ok) {
    dialog.showErrorBox('Could not save new location', saved.error);
    return { ok: false, error: saved.error };
  }

  app.relaunch();
  app.exit(0);
  return { ok: true };
}

module.exports = { changeDataRoot };
