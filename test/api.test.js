// End-to-end through Express: sign-in, the 2FA requirement, and the guards
// around the things that matter (trusted list, push buttons, deploy hook).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-api-'));
Object.assign(process.env, {
  DATA_DIR: dir, JWT_SECRET: 'x'.repeat(16) + require('crypto').randomBytes(24).toString('hex'),
  PULSE_AUTHWATCH: 'off', PULSE_HOOK_TOKEN: 'h'.repeat(32), PULSE_SCAN_PATH: path.join(dir, 'none.txt'),
});
const { app, monitor } = require('../server');
const db = require('../utils/db');
const bcrypt = require('bcryptjs');
const totp = require('../utils/totp');
const { actionToken } = require('../core/channels');

const SECRET = totp.generateSecret();
db.insert('users', { email: 'owner@example.com', name: 'Owner', role: 'owner', permissions: [], passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [] });
db.insert('users', { email: 'no2fa@example.com', name: 'New', role: 'owner', permissions: [], passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4), sessionVersion: 0, twoFactorEnabled: false });
db.insert('users', { email: 'viewer@example.com', name: 'Viewer', role: 'viewer', permissions: ['monitor.view'], passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [] });

let server, base;
test.before(async () => { await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); }); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => { server.close(); monitor.stop(); });

async function call(p, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

async function signIn(email) {
  const a = await call('/api/auth/login', { method: 'POST', body: { email, password: 'Correct-Horse-9!' } });
  if (!a.json.twoFactorRequired) return a.cookie;
  const b = await call('/api/auth/login/verify-2fa', { method: 'POST', body: { pendingToken: a.json.pendingToken, code: totp.totp(SECRET) } });
  assert.strictEqual(b.status, 200, JSON.stringify(b.json));
  return b.cookie;
}

test('nothing is readable without signing in', async () => {
  for (const p of ['/api/overview', '/api/access', '/api/alerts', '/api/inventory', '/api/settings', '/api/stream']) {
    assert.strictEqual((await call(p)).status, 401, p);
  }
});

test('/healthz is public and read-only', async () => {
  const r = await call('/healthz');
  assert.ok([200, 503].includes(r.status));
  assert.ok('sampleAgeMs' in r.json);
});

test('wrong password: same message, no hint', async () => {
  const a = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'nope' } });
  const b = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'nope' } });
  assert.strictEqual(a.status, 401);
  assert.strictEqual(a.json.error, b.json.error);
});

test('2FA is required: an account without it can reach nothing but setup', async () => {
  const c = await signIn('no2fa@example.com');
  const r = await call('/api/overview', { cookie: c });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.json.needs2fa, true);
  assert.strictEqual((await call('/api/auth/me', { cookie: c })).status, 200);
});

test('owner with 2FA sees the overview', async () => {
  const c = await signIn('owner@example.com');
  const r = await call('/api/overview', { cookie: c });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.apps));
  assert.ok('health' in r.json);
});

test('a viewer can look but not change anything', async () => {
  const c = await signIn('viewer@example.com');
  assert.strictEqual((await call('/api/overview', { cookie: c })).status, 200);
  assert.strictEqual((await call('/api/maintenance', { method: 'POST', body: { minutes: 30 }, cookie: c })).status, 403);
  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { ownerPhone: '+233200000000' }, cookie: c })).status, 403);
  const a = monitor.alerts.raise({ key: 'v', rule: 'health', severity: 'warning', title: 'x' });
  assert.strictEqual((await call(`/api/alerts/${a.id}/ack`, { method: 'POST', body: {}, cookie: c })).status, 403);
});

test('the trusted list needs a fresh 2FA code, and changing it raises an alert', async () => {
  const c = await signIn('owner@example.com');
  const body = { kind: 'network', label: 'Home', value: '173.177.203.145' };
  const no = await call('/api/trusted', { method: 'POST', body, cookie: c });
  assert.strictEqual(no.status, 403);
  assert.strictEqual(no.json.needsCode, true);
  const yes = await call('/api/trusted', { method: 'POST', body: { ...body, code: totp.totp(SECRET) }, cookie: c });
  assert.strictEqual(yes.status, 200);
  const src = db.sql.get('SELECT * FROM trusted_sources WHERE id = ?', yes.json.id);
  assert.strictEqual(src.value, '173.177.203.0/24', 'a bare IP becomes its /24');
  assert.ok(monitor.alerts.list().some((a) => /Trusted list changed/.test(a.title)));
  const bad = await call('/api/trusted', { method: 'POST', body: { kind: 'key', value: 'not-a-fingerprint', code: totp.totp(SECRET) }, cookie: c });
  assert.strictEqual(bad.status, 400);
});

test('push buttons: signed links work without a session; tampered ones do not', async () => {
  const a = monitor.alerts.raise({ key: 'access:t', rule: 'access', severity: 'warning', title: 'login' });
  const good = actionToken(process.env.JWT_SECRET, a.id, 'yes');
  const forged = actionToken('another-secret-entirely-xxxxxxxxxxxxxxxx', a.id, 'yes');
  assert.strictEqual((await call(`/api/alerts/action?t=${forged}`)).status, 400);
  const tampered = good.replace(/^[^.]+/, Buffer.from(`${a.id}.no.${Date.now() + 1e6}`).toString('base64url'));
  assert.strictEqual((await call(`/api/alerts/action?t=${tampered}`)).status, 400);
  const ok = await call(`/api/alerts/action?t=${good}`, { headers: { Accept: 'application/json' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(monitor.alerts.get(a.id).answer, 'yes');
});

test('deploy hook: token required', async () => {
  assert.strictEqual((await call('/api/hooks/deploy', { method: 'POST', body: { app: 'ifaima' } })).status, 401);
  assert.strictEqual((await call('/api/hooks/deploy', { method: 'POST', body: { app: 'ifaima' }, headers: { 'X-Pulse-Token': 'h'.repeat(31) + 'x' } })).status, 401);
  const r = await call('/api/hooks/deploy', { method: 'POST', body: { app: 'ifaima' }, headers: { 'X-Pulse-Token': 'h'.repeat(32) } });
  assert.strictEqual(r.status, 200);
  assert.ok(monitor.deploys.inDeploy('ifaima'));
});

test('security headers are on and the static app is served', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await r.text(), /DeonTech Pulse/);
});

test('review fixes: "trust this network" and alert-delivery changes need a fresh code', async () => {
  const c = await signIn('owner@example.com');
  monitor.handleAccess({ kind: 'ssh_login', user: 'deploy', method: 'publickey', fingerprint: 'SHA256:unknownunknownunknownunknownunknownunknownx', ip: '102.176.65.20', ts: Date.now() });
  const a = monitor.alerts.list().find((x) => x.rule === 'access' && x.status === 'open');
  const no = await call(`/api/alerts/${a.id}/answer`, { method: 'POST', body: { yes: true, trust: true }, cookie: c });
  assert.strictEqual(no.status, 403);
  const yes = await call(`/api/alerts/${a.id}/answer`, { method: 'POST', body: { yes: true, trust: true, code: totp.totp(SECRET) }, cookie: c });
  assert.strictEqual(yes.status, 200);
  assert.strictEqual(yes.json.trusted.cidr, '102.176.65.0/24');
  assert.ok(monitor.alerts.list().some((x) => /Trusted list changed: added Network 102\.176\.65\.0\/24/.test(x.title)));

  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { channels: { sms: false } }, cookie: c })).status, 403);
  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { timezones: ['Toronto'], code: totp.totp(SECRET) }, cookie: c })).status, 400);
  const ok = await call('/api/settings', { method: 'PUT', body: { ownerPhone: '+233244000000', code: totp.totp(SECRET) }, cookie: c });
  assert.strictEqual(ok.status, 200);
  assert.ok(monitor.alerts.list().some((x) => /Alert delivery settings changed/.test(x.title)));
  assert.strictEqual((await call('/api/settings', { method: 'PUT', body: { thresholds: { diskWarnPct: 80 } }, cookie: c })).status, 200, 'thresholds need no code');
});

test('review fixes: adding a passkey needs a code; a passkey without user verification is refused', async () => {
  const c = await signIn('owner@example.com');
  assert.strictEqual((await call('/api/auth/passkey/register/options', { method: 'POST', body: {}, cookie: c })).status, 403);
  const ok = await call('/api/auth/passkey/register/options', { method: 'POST', body: { code: totp.totp(SECRET) }, cookie: c });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.json.challenge);
  const ad = Buffer.alloc(37); ad[32] = 0x01; // user present, NOT verified
  const r = await call('/api/auth/passkey/login/verify', { method: 'POST', body: { authResp: { id: 'x', response: { authenticatorData: ad.toString('base64url') } } } });
  assert.strictEqual(r.status, 401);
  assert.match(r.json.error, /did not confirm/);
});

test('review fixes: a backup code works once as a fresh code; wrong codes lock out', async () => {
  const fc = require('../utils/freshCode');
  fc._resetFailures();
  const u = db.findOne('users', (x) => x.email === 'owner@example.com');
  db.update('users', u.id, { backupCodeHashes: [bcrypt.hashSync('abcd1-23456', 4)] });
  assert.ok(await fc.checkFreshCode(u.id, 'abcd1-23456'));
  assert.strictEqual(await fc.checkFreshCode(u.id, 'abcd1-23456'), null, 'used up');
  for (let i = 0; i < 4; i++) await fc.checkFreshCode(u.id, '000000');
  assert.strictEqual(await fc.checkFreshCode(u.id, totp.totp(SECRET)), null, 'five failures lock even a right code');
  const c = await signIn('owner@example.com');
  assert.strictEqual((await call('/api/trusted', { method: 'POST', body: { kind: 'network', value: '1.2.3.4', code: totp.totp(SECRET) }, cookie: c })).status, 429);
  fc._resetFailures();
});

test('About: which Pulse the server runs, to anyone signed in, never cached', async () => {
  assert.strictEqual((await call('/api/about')).status, 401);
  const cookie = await signIn('viewer@example.com');
  const r = await call('/api/about', { cookie });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.version, require('../package.json').version);
  assert.strictEqual(r.json.released, require('../package.json').released);
  assert.ok(r.json.started > 0 && r.json.node);
});
