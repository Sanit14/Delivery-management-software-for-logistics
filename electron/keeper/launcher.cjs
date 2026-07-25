/**
 * launcher.cjs — runs in the Electron MAIN process of each app seat at startup.
 *
 * Ensures exactly ONE keeper is running on this server, then connects to it:
 *   1. Ping the keeper port. If a keeper answers → connect, done.
 *   2. If not → spawn the keeper DETACHED so it outlives this seat, then wait
 *      until it answers.
 *   3. The keeper's own single-instance guard (port already in use → exit 0)
 *      means that even if two seats spawn at the same instant, only one keeper
 *      survives and the other connects to it.
 *   4. If the keeper never becomes reachable → throw, so the app can show a clear
 *      error. We NEVER silently fall back to a local database.
 *
 * Spawning Node on the user's machine: there is no standalone `node` installed.
 * We relaunch the Electron executable (process.execPath) with ELECTRON_RUN_AS_NODE=1,
 * which makes it behave as a plain Node runtime to run server.cjs.
 */

const { spawn } = require('child_process');
const path = require('path');
const client = require('./client.cjs');

// Fixed local port for the keeper. 127.0.0.1 only — not reachable off this machine.
const KEEPER_PORT = 47615;

function spawnKeeperDetached(dataRoot) {
  const serverPath = path.join(__dirname, 'server.cjs');
  const args = [serverPath, dataRoot, String(KEEPER_PORT)];

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    // ELECTRON_RUN_AS_NODE makes the Electron exe run as plain Node (no window).
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  child.unref(); // let this seat exit without killing the keeper
  return child;
}

// The keeper version this app build expects. Must match KEEPER_VERSION in
// server.cjs. If a running keeper reports an older version, it predates a schema
// change (e.g. the auditLog table) — or, at version 10, still runs the old sql.js
// engine — and is replaced with a fresh one.
const EXPECTED_KEEPER_VERSION = 12;

// Ensure a keeper is up AND current, and the client is pointed at it. Returns when
// ready. Throws if the keeper cannot be reached after spawning + waiting.
async function ensureKeeper(dataRoot) {
  client.setPort(KEEPER_PORT);

  // Already running? (another seat started it earlier)
  if (await client.ping()) {
    // It's alive — but is it current? A keeper started before a schema change
    // won't know new tables. If stale, ask it to shut down and start a fresh one.
    const running = await client.getVersion();
    if (running >= EXPECTED_KEEPER_VERSION) return; // up to date → use it
    await client.shutdown();
    // wait for the port to free up before spawning the replacement
    for (let i = 0; i < 20; i++) {
      if (!(await client.ping())) break;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Not running (or just shut down a stale one) — start a fresh keeper. If two
  // seats race here, the keeper's port guard ensures only one survives.
  spawnKeeperDetached(dataRoot);

  const ready = await client.waitUntilReady({ maxWaitMs: 12000, intervalMs: 250 });
  if (!ready) {
    throw new Error('Database service (keeper) could not be started. ' +
      'Please contact the administrator — do not enter data until this is fixed.');
  }
}

module.exports = { ensureKeeper, KEEPER_PORT };
