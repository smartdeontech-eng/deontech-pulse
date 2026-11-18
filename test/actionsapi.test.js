// Restart / Switch line / log through the API: who may, the 2FA code, the alert.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-actapi-'));
Object.assign(process.env, {
  DATA_DIR: dir, JWT_SECRET: 'p'.repeat(16) + require('crypto').randomBytes(24).toString('hex'),
  PULSE_AUTHWATCH: 'off', PULSE_LOGS: 'off', PULSE_HOOK_TOKEN: 'h'.repeat(32), PULSE_SCAN_PATH: path.join(dir, 'none.txt'), PULSE_ACTION_OUT: path.join(dir, 'out'),
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


fs.mkdirSync(path.join(dir, 'out'));
// Stands in for root's helper: answers each request and remembers what it was asked.
const asked = [];
const helper = setInterval(() => {
  const rd = path.join(dir, 'actions');
  if (!fs.existsSync(rd)) return;
  for (const f of fs.readdirSync(rd).filter((x) => x.endsWith('.req'))) {
    const line = fs.readFileSync(path.join(rd, f), 'utf8').trim();
    fs.unlinkSync(path.join(rd, f));
    asked.push(line);
    fs.writeFileSync(path.join(dir, 'out', f.replace('.req', '.out')), `did: ${line}\nexit=0\n`);
  }
}, 30);
test.after(() => clearInterval(helper));

monitor.state.apps.push(
  { id: 'smart-deontech', name: 'Smart DeonTech', kind: 'app', units: [{ unit: 'smart-deontech.service', active: 'active' }], lines: [], ports: [3001], domains: [] },
  { id: 'aotc-track', name: 'AOTC Track', kind: 'app', liveLine: 'blue', units: [{ unit: 'aotc-track@blue.service', active: 'active' }], lines: [{ line: 'blue', unit: 'aotc-track@blue.service', port: 3011 }, { line: 'green', unit: 'aotc-track@green.service', port: null }], ports: [3011], domains: [] },
);
monitor.runChecks = async () => [];
monitor.discover = async () => {};

test('restart: needs a fresh code, restarts the live service, raises an alert', async () => {
  const o = await signIn('owner@example.com');
  assert.strictEqual((await call('/api/apps/smart-deontech/restart', { method: 'POST', cookie: o, body: {} })).status, 403);
  assert.strictEqual(asked.length, 0, 'nothing asked without a code');
  const r = await call('/api/apps/smart-deontech/restart', { method: 'POST', cookie: o, body: { code: code() } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(asked.pop(), 'restart smart-deontech.service');
  assert.ok(monitor.alerts.list().some((a) => a.title === 'Smart DeonTech: restarted from Pulse'));
  const b = await call('/api/apps/aotc-track/restart', { method: 'POST', cookie: o, body: { code: code() } });
  assert.strictEqual(b.status, 200);
  assert.strictEqual(asked.pop(), 'restart aotc-track@blue.service', 'the live line');
});

test('switch line: only to the other colour, with a code', async () => {
  const o = await signIn('owner@example.com');
  assert.strictEqual((await call('/api/apps/aotc-track/switch', { method: 'POST', cookie: o, body: { code: code(), line: 'blue' } })).status, 400, 'already live');
  assert.strictEqual((await call('/api/apps/smart-deontech/switch', { method: 'POST', cookie: o, body: { code: code(), line: 'green' } })).status, 404, 'no lines');
  const r = await call('/api/apps/aotc-track/switch', { method: 'POST', cookie: o, body: { code: code(), line: 'green' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(asked.pop(), 'switch aotc-track green');
  assert.ok(monitor.alerts.list().some((a) => a.title === 'AOTC Track: switched to green from Pulse'));
});

test('viewers can do none of it', async () => {
  const v = await signIn('viewer@example.com');
  assert.strictEqual((await call('/api/apps/smart-deontech/restart', { method: 'POST', cookie: v, body: { code: code() } })).status, 403);
  assert.strictEqual((await call('/api/apps/smart-deontech/logs', { cookie: v })).status, 403);
  assert.strictEqual((await call('/api/server/top', { cookie: v })).status, 200, 'what uses memory is fine to see');
});
