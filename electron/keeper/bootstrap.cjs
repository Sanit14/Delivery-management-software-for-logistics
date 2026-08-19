/**
 * bootstrap.cjs — runs in the Electron MAIN process, BEFORE the keeper starts.
 *
 * The data root (where the shared database lives) must be decided ONCE and read
 * IDENTICALLY by all six seats. We cannot store that pointer under the data root
 * itself (we don't know the root yet — that's the whole point), and we cannot use
 * per-user AppData (each seat has its own → the isolation bug returns).
 *
 * So the pointer lives in a per-MACHINE location shared by all Windows users on
 * this one server: %ProgramData%\DeliveryManager\root.json (Windows). Every seat
 * reads the same file, so every seat uses the same data root.
 *
 * Flow:
 *   - getConfiguredRoot(): returns the saved root, or '' if not set up yet.
 *   - saveRoot(folder): writes the pointer (called once, from the setup dialog).
 *   - An env override (DELIVERY_DATA_ROOT) wins, for testing on the server.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const safeguard = require('./safeguard.cjs');

// The one shared location for the pointer file.
function bootstrapConfigPath() {
  // Windows: %ProgramData% (e.g. C:\ProgramData) is shared across all users.
  // Other OS (dev/test): fall back to a fixed /tmp-style shared dir.
  const base = process.env.PROGRAMDATA
    || (process.platform === 'win32' ? path.join('C:\\', 'ProgramData') : path.join(os.tmpdir(), 'shared-programdata'));
  return path.join(base, 'DeliveryManager', 'root.json');
}

// Returns the configured data root, or '' if not configured yet.
// An explicit env override always wins (handy for the server bring-up test).
function getConfiguredRoot() {
  if (process.env.DELIVERY_DATA_ROOT) return process.env.DELIVERY_DATA_ROOT;
  try {
    const cfg = JSON.parse(fs.readFileSync(bootstrapConfigPath(), 'utf8'));
    if (cfg && typeof cfg.root === 'string' && cfg.root) return cfg.root;
  } catch { /* not set up yet */ }
  return '';
}

// Persist the chosen root to the shared pointer file. Returns { ok, error }.
function saveRoot(folder) {
  if (!folder || typeof folder !== 'string') return { ok: false, error: 'No folder was selected' };
  try {
    const cfgPath = bootstrapConfigPath();
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ root: folder }, null, 2));
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: 'Setting could not be saved: ' + ((e && e.message) || e) };
  }
}

// A bare drive/filesystem root (e.g. "C:\", "D:\") has no folder name of its
// own — mkdir/write against it is unpredictable (EPERM) and it can never be a
// data folder. This is what let a plain "D:\" get saved and crash-loop.
function isBareDriveRoot(folder) {
  try {
    const resolved = path.resolve(folder);
    return path.parse(resolved).root === resolved;
  } catch {
    return false;
  }
}

// Validate that a chosen root is usable: it must be a named folder (not a bare
// drive root), and it (or its parent) must be writable, so the keeper can
// create db/ and backups/ there.
function validateRoot(folder) {
  if (isBareDriveRoot(folder)) {
    const error = 'Choose a named folder on the drive, not the drive itself — e.g. ' +
      path.join(folder, 'DeliveryManagerData') + ' instead of ' + folder;
    safeguard.audit('root-rejected', { path: folder, reason: 'bare-drive-root' });
    return { ok: false, error };
  }
  try {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    const probe = path.join(folder, '.write-test-' + Date.now());
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, error: '' };
  } catch (e) {
    const error = 'Cannot write to this folder: ' + ((e && e.message) || e);
    safeguard.audit('root-rejected', { path: folder, reason: error });
    return { ok: false, error };
  }
}

// Remove the saved pointer (e.g. when the saved root turned out to be unusable),
// so the next launch shows the first-run picker again. Never throws.
function clearConfiguredRoot() {
  try { fs.unlinkSync(bootstrapConfigPath()); } catch { /* nothing to clear */ }
}

// A safe, writable-by-everyone default: a plain folder directly on the system
// drive (e.g. C:\DeliveryManagerData) — NOT inside any specific Windows user's
// profile and NOT inside Program Files.
//
// This matters because on a multi-seat setup (NComputing etc.) every seat logs
// in as a DIFFERENT Windows user. A folder under one user's profile — Documents,
// Desktop, AppData, anything under C:\Users\<name>\... — is normally locked to
// that one account. Whoever runs the first-run picker (often an admin on the
// server) CAN write there, so it looks fine... until every other seat hits
// "Cannot write to this folder: EPERM" the moment they try. This suggestion
// exists specifically so that failure mode doesn't happen again.
function suggestedRoot() {
  if (process.platform === 'win32') {
    const drive = (process.env.SystemDrive || 'C:') + '\\';
    return path.join(drive, 'DeliveryManagerData');
  }
  return path.join(os.tmpdir(), 'DeliveryManagerData');
}

// Flags folders likely to reproduce the "works on this seat, EPERM on the others"
// problem: anywhere inside a specific Windows user's profile, or inside Program
// Files (also commonly write-restricted for non-admin accounts). This is a WARNING
// signal only — validateRoot() above is the actual (and authoritative) write test.
function isRiskyPath(folder) {
  try {
    const norm = path.resolve(folder).toLowerCase();
    const usersDir = process.platform === 'win32'
      ? path.join(process.env.SystemDrive || 'C:\\', 'Users').toLowerCase()
      : '';
    const programFilesDirs = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    if (usersDir && (norm === usersDir || norm.startsWith(usersDir + path.sep))) return true;
    if (programFilesDirs.some((pf) => norm === pf || norm.startsWith(pf + path.sep))) return true;
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  getConfiguredRoot, saveRoot, validateRoot, clearConfiguredRoot, bootstrapConfigPath,
  suggestedRoot, isRiskyPath,
};
