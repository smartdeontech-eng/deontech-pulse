// Clocks: home (Accra) always; a second clock only while the owner is away.
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb } = require('./helpers');
const z = require('../core/zones');
const { fmtTimes } = require('../core/channels');

const S = { timezones: ['Africa/Accra'] };
const JAN = Date.UTC(2026, 0, 15, 12, 0);   // London = Accra in winter
const JUL = Date.UTC(2026, 6, 15, 12, 0);   // London = Accra + 1 in summer

function withOwner(tz, at = new Date().toISOString(), extra = {}) {
  const { db } = tmpDb();
  db.insert('users', { email: 'o@example.com', name: 'O', role: 'owner', timezone: tz, timezoneAt: at, ...extra });
  return db;
}

test('at home: only Accra', () => {
  assert.deepStrictEqual(z.displayZones(withOwner('Africa/Accra'), S), ['Africa/Accra']);
  assert.deepStrictEqual(z.displayZones(tmpDb().db, S), ['Africa/Accra'], 'no report yet: home');
});

test('away: Accra and where the owner is', () => {
  assert.deepStrictEqual(z.displayZones(withOwner('America/Toronto'), S), ['Africa/Accra', 'America/Toronto']);
  assert.strictEqual(fmtTimes(Date.UTC(2026, 9, 17, 16, 31), z.displayZones(withOwner('America/Toronto'), S)), '16:31 Accra · 12:31 Toronto');
  assert.strictEqual(fmtTimes(Date.UTC(2026, 9, 17, 16, 31), ['Africa/Accra']), '16:31 Accra');
});

test('a place on the same clock as Accra adds nothing; the same place a season later does', () => {
  const db = withOwner('Europe/London', new Date(JAN).toISOString());
  assert.deepStrictEqual(z.displayZones(db, S, JAN), ['Africa/Accra'], 'London in January reads the same as Accra');
  const db2 = withOwner('Europe/London', new Date(JUL).toISOString());
  assert.deepStrictEqual(z.displayZones(db2, S, JUL), ['Africa/Accra', 'Europe/London']);
});

test('an old report (over 7 days), a switched-off owner, or a non-owner does not count', () => {
  assert.deepStrictEqual(z.displayZones(withOwner('America/Toronto', new Date(Date.now() - 8 * 86400_000).toISOString()), S), ['Africa/Accra']);
  assert.deepStrictEqual(z.displayZones(withOwner('America/Toronto', undefined, { disabled: true }), S), ['Africa/Accra']);
  assert.deepStrictEqual(z.displayZones(withOwner('America/Toronto', undefined, { role: 'viewer' }), S), ['Africa/Accra']);
});

test('the most recent report wins; bad zone names are refused', () => {
  const { db } = tmpDb();
  db.insert('users', { email: 'a@x.com', role: 'owner', timezone: 'America/Toronto', timezoneAt: new Date(Date.now() - 3600_000).toISOString() });
  db.insert('users', { email: 'b@x.com', role: 'owner', timezone: 'Africa/Accra', timezoneAt: new Date().toISOString() });
  assert.deepStrictEqual(z.displayZones(db, S), ['Africa/Accra'], 'back home on the newer device');
  for (const bad of ['Mars/Olympus', '../etc', 'A'.repeat(80), 42, '']) assert.strictEqual(z.validZone(bad), false, String(bad));
  assert.strictEqual(z.homeZone({ timezones: ['Not/AZone'] }), 'Africa/Accra');
  assert.strictEqual(z.zoneLabel('America/Argentina/Buenos_Aires'), 'Buenos Aires');
});

// ---- through the server ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-zones-'));
Object.assign(process.env, {
  DATA_DIR: dir, JWT_SECRET: 'z'.repeat(16) + require('crypto').randomBytes(24).toString('hex'),
  PULSE_AUTHWATCH: 'off', PULSE_LOGS: 'off', PULSE_HOOK_TOKEN: 'h'.repeat(32), PULSE_SCAN_PATH: path.join(dir, 'none.txt'),
});

test('a device reports where it is; the overview and alert messages follow', async () => {
  const { app, monitor } = require('../server');
  const db = require('../utils/db');
  const bcrypt = require('bcryptjs');
  const totp = require('../utils/totp');
  const SECRET = totp.generateSecret();
  db.insert('users', { email: 'owner@example.com', name: 'Owner', role: 'owner', permissions: [], passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [] });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, cookie } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* */ }
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    const a = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'Correct-Horse-9!' } });
    const c = (await call('/api/auth/login/verify-2fa', { method: 'POST', body: { pendingToken: a.json.pendingToken, code: totp.totp(SECRET) } })).cookie;
    let o = await call('/api/overview', { cookie: c });
    assert.deepStrictEqual(o.json.timezones, ['Africa/Accra']);
    assert.strictEqual(o.json.home, 'Africa/Accra');
    assert.strictEqual((await call('/api/me/timezone', { method: 'POST', cookie: c, body: { tz: 'Not/AZone' } })).status, 400);
    const r = await call('/api/me/timezone', { method: 'POST', cookie: c, body: { tz: 'America/Toronto' } });
    assert.deepStrictEqual(r.json.zones, ['Africa/Accra', 'America/Toronto']);
    o = await call('/api/overview', { cookie: c });
    assert.deepStrictEqual(o.json.timezones, ['Africa/Accra', 'America/Toronto']);
    // Back home.
    await call('/api/me/timezone', { method: 'POST', cookie: c, body: { tz: 'Africa/Accra' } });
    o = await call('/api/overview', { cookie: c });
    assert.deepStrictEqual(o.json.timezones, ['Africa/Accra']);
  } finally { server.close(); monitor.stop(); }
});
