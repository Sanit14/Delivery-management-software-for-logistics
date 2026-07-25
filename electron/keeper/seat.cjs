/**
 * seat.cjs — this seat's identity (e.g. "PC-01").
 *
 * UNLIKE the data root (which is SHARED so all seats use one database), the seat
 * name is stored PER-SEAT in this session's own userData. That's the whole point:
 * every seat must have a DIFFERENT name so the audit log can show who did what.
 *
 * No Windows internals, no session IDs — just a name a human typed once on first
 * run, then stamped onto every action that seat performs.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function seatConfigPath() {
  // Per-seat: app.getPath('userData') is unique to this Windows session/user.
  return path.join(app.getPath('userData'), 'seat.json');
}

// Returns this seat's saved name, or '' if not named yet.
function getSeatName() {
  try {
    const cfg = JSON.parse(fs.readFileSync(seatConfigPath(), 'utf8'));
    if (cfg && typeof cfg.name === 'string' && cfg.name.trim()) return cfg.name.trim();
  } catch { /* not named yet */ }
  return '';
}

// Save this seat's name. Returns { ok, error }.
function setSeatName(name) {
  const clean = (name || '').trim();
  if (!clean) return { ok: false, error: 'Name cannot be empty' };
  try {
    fs.writeFileSync(seatConfigPath(), JSON.stringify({ name: clean }, null, 2));
    return { ok: true, error: '' };
  } catch (e) {
    return { ok: false, error: 'Name could not be saved: ' + ((e && e.message) || e) };
  }
}

module.exports = { getSeatName, setSeatName };
