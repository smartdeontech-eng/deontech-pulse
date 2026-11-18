// People (user accounts) and the per-app monitoring switch, through Express.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-people-'));
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

test('only the owner can see or manage people', async () => {
  const o = await signIn('owner@example.com');
  const r = await call('/api/users', { cookie: o });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.roles.map((x) => x.key), ['owner', 'admin', 'viewer']);
  for (const who of ['admin@example.com', 'viewer@example.com']) {
    const c = await signIn(who);
    assert.strictEqual((await call('/api/users', { cookie: c })).status, 403, who);
    assert.strictEqual((await call('/api/users', { method: 'POST', cookie: c, body: { email: 'x@example.com', role: 'owner', code: code() } })).status, 403, who);
  }
});

test('adding someone needs a fresh code, gives a one-time password, and raises an alert', async () => {
  const o = await signIn('owner@example.com');
  assert.strictEqual((await call('/api/users', { method: 'POST', cookie: o, body: { email: 'new@example.com', name: 'New Person', role: 'viewer' } })).status, 403);
  const r = await call('/api/users', { method: 'POST', cookie: o, body: { email: 'New@Example.com', name: 'New Person', role: 'viewer', code: code() } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.tempPassword, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
  assert.strictEqual(r.json.user.email, 'new@example.com');
  assert.ok(monitor.alerts.list().some((a) => a.title.includes('New Pulse login: new@example.com')));
  // Duplicate refused.
  assert.strictEqual((await call('/api/users', { method: 'POST', cookie: o, body: { email: 'new@example.com', role: 'viewer', code: code() } })).status, 409);
  // The one-time password works only to set a new one.
  const s = await signIn('new@example.com', r.json.tempPassword);
  assert.ok(s.must, 'must change password first');
  const stored = db.findOne('users', (u) => u.email === 'new@example.com');
  assert.strictEqual(stored.passwordHash.includes(r.json.tempPassword), false);
});

test('roles: an admin can switch apps but not touch people or alert destinations', async () => {
  const c = await signIn('admin@example.com');
  assert.strictEqual((await call('/api/settings', { method: 'PUT', cookie: c, body: { code: code(), ownerPhone: '+233200000000' } })).status, 403);
  assert.strictEqual((await call('/api/maintenance', { method: 'POST', cookie: c, body: { minutes: 30 } })).status, 200);
  await call('/api/maintenance', { method: 'DELETE', cookie: c });
});

test('switching an account off: reason needed, sessions end, sign-in refused; on again needs a code', async () => {
  const o = await signIn('owner@example.com');
  const a = await signIn('admin@example.com');
  assert.strictEqual((await call('/api/overview', { cookie: a })).status, 200);
  assert.strictEqual((await call(`/api/users/${admin.id}/status`, { method: 'POST', cookie: o, body: { enabled: false } })).status, 400);
  const off = await call(`/api/users/${admin.id}/status`, { method: 'POST', cookie: o, body: { enabled: false, reason: 'left the company' } });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.json.user.disabledReason, 'left the company');
  // The open session stops on its next request.
  assert.strictEqual((await call('/api/overview', { cookie: a })).status, 401);
  // Sign-in refused only after a correct password; a wrong one gets the usual answer.
  const right = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: PW } });
  assert.strictEqual(right.status, 403);
  const wrong = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'nope' } });
  assert.strictEqual(wrong.status, 401);
  // On again: needs a code.
  assert.strictEqual((await call(`/api/users/${admin.id}/status`, { method: 'POST', cookie: o, body: { enabled: true } })).status, 403);
  assert.strictEqual((await call(`/api/users/${admin.id}/status`, { method: 'POST', cookie: o, body: { enabled: true, code: code() } })).status, 200);
  assert.strictEqual(typeof await signIn('admin@example.com'), 'string');
});

test('guards: not yourself, never the last owner', async () => {
  const o = await signIn('owner@example.com');
  assert.strictEqual((await call(`/api/users/${owner.id}/status`, { method: 'POST', cookie: o, body: { enabled: false, reason: 'x' } })).status, 400);
  assert.strictEqual((await call(`/api/users/${owner.id}`, { method: 'PUT', cookie: o, body: { role: 'viewer', code: code() } })).status, 400);
  assert.strictEqual((await call(`/api/users/${owner.id}`, { method: 'DELETE', cookie: o, body: { code: code() } })).status, 400);
  // Removing needs the account switched off first.
  const v = db.findOne('users', (u) => u.email === 'viewer@example.com');
  assert.strictEqual((await call(`/api/users/${v.id}`, { method: 'DELETE', cookie: o, body: { code: code() } })).status, 400);
});

test('a role change signs the person out and takes effect', async () => {
  const o = await signIn('owner@example.com');
  const v = db.findOne('users', (u) => u.email === 'viewer@example.com');
  const vc = await signIn('viewer@example.com');
  const r = await call(`/api/users/${v.id}`, { method: 'PUT', cookie: o, body: { role: 'admin', code: code() } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.user.role, 'admin');
  assert.strictEqual((await call('/api/overview', { cookie: vc })).status, 401);
  assert.deepStrictEqual(db.findById('users', v.id).permissions, ['monitor.view', 'monitor.manage']);
});

test('per-app monitoring switch: off = no checks, no alerts, out of the health score; on again', async () => {
  monitor.state.apps = [{ id: 'demo', name: 'Demo', kind: 'app', domains: [], ports: [59999], lines: [], units: [], listening: [], checkPort: 59999, healthPaths: [] }];
  updateSettings({ appOverrides: { demo: {} } });
  const realDiscover = monitor.discover;
  // Discovery reads the real server; here it just re-applies the override.
  const { getSettings } = require('../utils/settings');
  monitor.discover = async () => { const ov = getSettings().appOverrides.demo || {}; const a = monitor.state.apps[0]; a.watched = ov.watch !== false; a.watchOff = a.watched ? undefined : { note: ov.watchNote }; };
  try {
    const a = await signIn('admin@example.com');
    monitor.alerts.raise({ key: 'health:demo', rule: 'health', severity: 'critical', app: 'demo', title: 'Demo is down' });
    const off = await call('/api/apps/demo', { method: 'PUT', cookie: a, body: { watch: false, note: 'not live yet' } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.json));
    assert.strictEqual(monitor.state.checks.demo.status, 'off');
    assert.ok(!monitor.alerts.list().some((x) => x.key === 'health:demo'), 'open alert closed');
    const ov = await call('/api/overview', { cookie: a });
    const demo = ov.json.apps.find((x) => x.id === 'demo');
    assert.strictEqual(demo.watched, false);
    assert.strictEqual(demo.status, 'off');
    assert.ok(!ov.json.health.why.some((w) => /down/.test(w)));
    assert.ok((await call('/api/overview', { cookie: a })).json.events.some((e) => e.title === 'Monitoring switched off for Demo'));
    // A viewer cannot flip it.
    const vv = mk('viewer2@example.com', 'viewer', ['monitor.view']);
    const vc = await signIn(vv.email);
    assert.strictEqual((await call('/api/apps/demo', { method: 'PUT', cookie: vc, body: { watch: true } })).status, 403);
    const on = await call('/api/apps/demo', { method: 'PUT', cookie: a, body: { watch: true } });
    assert.strictEqual(on.status, 200);
    assert.notStrictEqual(monitor.state.checks.demo.status, 'off');
  } finally { monitor.discover = realDiscover; }
});
