// A second phone on the same account: added with a current code, works for
// sign-in and for fresh-code checks, raises alerts, and is cleared by a reset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-auth2-'));
Object.assign(process.env, {
  DATA_DIR: dir, JWT_SECRET: 'p'.repeat(16) + require('crypto').randomBytes(24).toString('hex'),
  PULSE_AUTHWATCH: 'off', PULSE_LOGS: 'off', PULSE_HOOK_TOKEN: 'h'.repeat(32), PULSE_SCAN_PATH: path.join(dir, 'none.txt'),
});
const { app, monitor } = require('../server');
const db = require('../utils/db');
const bcrypt = require('bcryptjs');
const totp = require('../utils/totp');
const { _resetFailures } = require('../utils/freshCode');
const { updateSettings } = require('../utils/settings');

const SECRET = totp.generateSecret();
const PW = 'Correct-Horse-9!';
const mk = (email, role, perms) => db.insert('users', { email, name: email.split('@')[0], role, permissions: perms, passwordHash: bcrypt.hashSync(PW, 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [] });
const owner = mk('owner@example.com', 'owner', []);
const admin = mk('admin@example.com', 'admin', ['monitor.view', 'monitor.manage']);
mk('viewer@example.com', 'viewer', ['monitor.view']);

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); monitor.stop(); });
test.beforeEach(() => _resetFailures());

async function call(p, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function signIn(email, password = PW) {
  const a = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  if (a.status !== 200) return { status: a.status, json: a.json };
  if (a.json.mustChangePassword) return { must: a.json.pendingToken };
  const b = await call('/api/auth/login/verify-2fa', { method: 'POST', body: { pendingToken: a.json.pendingToken, code: totp.totp(SECRET) } });
  return b.cookie;
}
const code = () => totp.totp(SECRET);


test('add another phone, use it, take the first one off', async () => {
  const o = await signIn('owner@example.com');
  // Without a current code: no.
  assert.notStrictEqual((await call('/api/auth/2fa/authenticators/setup', { method: 'POST', cookie: o, body: { code: '000000' } })).status, 200);
  const s = await call('/api/auth/2fa/authenticators/setup', { method: 'POST', cookie: o, body: { code: code() } });
  assert.strictEqual(s.status, 200, JSON.stringify(s.json));
  assert.ok(s.json.secret && s.json.qrCodeDataUrl);
  const PHONE2 = s.json.secret;
  const e = await call('/api/auth/2fa/authenticators/enable', { method: 'POST', cookie: o, body: { token: totp.totp(PHONE2), name: 'Work iPhone' } });
  assert.strictEqual(e.status, 200, JSON.stringify(e.json));
  assert.ok(monitor.alerts.list().some((a) => a.title.includes('Authenticator added to owner@example.com (Work iPhone)')), 'alert raised');

  const me = await call('/api/auth/me', { cookie: o });
  assert.deepStrictEqual(me.json.authenticators.map((a) => a.name), ['First authenticator', 'Work iPhone']);
  assert.ok(!JSON.stringify(me.json).includes(PHONE2), 'secret never leaves the server');

  // The second phone signs in.
  const a = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: PW } });
  const b = await call('/api/auth/login/verify-2fa', { method: 'POST', body: { pendingToken: a.json.pendingToken, code: totp.totp(PHONE2) } });
  assert.strictEqual(b.status, 200, JSON.stringify(b.json));

  // …and its code counts as "prove it's still you" (changing where alerts go).
  const put = await call('/api/settings', { method: 'PUT', cookie: o, body: { code: totp.totp(PHONE2), ownerEmail: 'owner@example.com' } });
  assert.strictEqual(put.status, 200, JSON.stringify(put.json));

  // Lose the first phone: take it off with a code from the second.
  const r = await call('/api/auth/2fa/authenticators/main/remove', { method: 'POST', cookie: o, body: { code: totp.totp(PHONE2) } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok(monitor.alerts.list().some((x) => x.title.includes('Authenticator removed from owner@example.com')));
  const after = await call('/api/auth/me', { cookie: o });
  assert.deepStrictEqual(after.json.authenticators.map((x) => x.name), ['Work iPhone']);
  // The old phone's code no longer works; the last one cannot be removed.
  assert.strictEqual((await call('/api/settings', { method: 'PUT', cookie: o, body: { code: code(), ownerEmail: 'owner@example.com' } })).status, 403);
  assert.strictEqual((await call('/api/auth/2fa/authenticators/main/remove', { method: 'POST', cookie: o, body: { code: totp.totp(PHONE2) } })).status, 400);
});

test("an owner's reset clears every phone", async () => {
  const u = db.insert('users', { email: 'two@example.com', name: 'two', role: 'viewer', permissions: ['monitor.view'], passwordHash: bcrypt.hashSync(PW, 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, twoFactorDevices: [{ id: 'd1', name: 'iPad', secret: totp.generateSecret(), createdAt: new Date().toISOString(), lastUsedAt: null }], backupCodeHashes: [] });
  db.update('users', owner.id, { twoFactorSecret: SECRET, twoFactorDevices: [] });
  const o = await signIn('owner@example.com');
  const r = await call(`/api/users/${u.id}/reset`, { method: 'POST', cookie: o, body: { code: code(), reset2fa: true } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const fresh = db.findById('users', u.id);
  assert.strictEqual(fresh.twoFactorEnabled, false);
  assert.deepStrictEqual(fresh.twoFactorDevices, []);
});
