// Which clocks to show a time in.
//
// Home is always shown: the first zone in settings (Africa/Accra). A second
// clock appears only while the owner is away, i.e. their phone or computer
// reports a time zone whose clock differs from home. Devices set their zone
// from where they are, so Pulse needs no GPS: each signed-in device tells
// Pulse its zone (POST /api/me/timezone), and messages sent by SMS or email
// use the zone the owner's devices reported most recently (within 7 days).
'use strict';

const DEFAULT_HOME = 'Africa/Accra';
const AWAY_FRESH_MS = 7 * 86400_000;

function validZone(z) {
  if (typeof z !== 'string' || z.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(z)) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return true; } catch { return false; }
}

function homeZone(s) {
  const z = s && Array.isArray(s.timezones) ? s.timezones[0] : null;
  return validZone(z) ? z : DEFAULT_HOME;
}

// Minutes east of UTC for a zone at a moment ("GMT-4" → -240).
function offsetMinutes(zone, ts = Date.now()) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date(ts)).find((p) => p.type === 'timeZoneName');
  const m = String(part ? part.value : 'GMT').match(/GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?/);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// A different zone name with the same clock (London in winter) adds nothing.
function sameClock(a, b, ts = Date.now()) { return a === b || offsetMinutes(a, ts) === offsetMinutes(b, ts); }

// The zone the owner's devices last reported, if recent and not home's clock.
function awayZone(db, s, now = Date.now()) {
  const home = homeZone(s);
  let best = null;
  for (const u of db.findAll('users', (x) => x.role === 'owner' && !x.disabled && x.timezone && x.timezoneAt)) {
    const at = Date.parse(u.timezoneAt) || 0;
    if (now - at > AWAY_FRESH_MS || !validZone(u.timezone)) continue;
    if (!best || at > best.at) best = { zone: u.timezone, at };
  }
  return best && !sameClock(best.zone, home, now) ? best.zone : null;
}

function displayZones(db, s, now = Date.now()) {
  const home = homeZone(s);
  const away = db ? awayZone(db, s, now) : null;
  return away ? [home, away] : [home];
}

// "America/Toronto" → "Toronto", "America/Argentina/Buenos_Aires" → "Buenos Aires".
function zoneLabel(z) { return String(z).split('/').pop().replace(/_/g, ' '); }

module.exports = { homeZone, awayZone, displayZones, zoneLabel, offsetMinutes, sameClock, validZone, DEFAULT_HOME };
