// Sign-ins from the other apps: the drop-in reporter, the intake, the page's
// API, and the alerts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jwt = require('jsonwebtoken');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-signins-'));
const HOOK = 'k'.repeat(40);
Object.assign(process.env, {
  DATA_DIR: dir, JWT_SECRET: 's'.repeat(16) + require('crypto').randomBytes(24).toString('hex'),
  PULSE_AUTHWATCH: 'off', PULSE_LOGS: 'off', PULSE_HOOK_TOKEN: HOOK, PULSE_SCAN_PATH: path.join(dir, 'none.txt'),
});
const { app, monitor } = require('../server');
const db = require('../utils/db');
const bcrypt = require('bcryptjs');
const totp = require('../utils/totp');
const { appToken, createAppSignins, deviceLabel } = require('../core/appsignins');
const { tmpDb, settingsStub } = require('./helpers');

const SECRET = totp.generateSecret();
db.insert('users', { email: 'owner@example.com', name: 'Owner', role: 'owner', permissions: [], passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [] });

let server, base, reporter;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // The reporter reads its settings when it is loaded, as it would in an app.
  Object.assign(process.env, { PULSE_APP: 'aotc-track', PULSE_APP_TOKEN: appToken(HOOK, 'aotc-track'), PULSE_URL: base });
  reporter = require('../connectors/pulse-reporter');
});
test.after(() => { server.close(); monitor.stop(); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(p, { method = 'GET', body, cookie, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* */ }
  return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function signIn() {
  const a = await call('/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: 'Correct-Horse-9!' } });
  const b = await call('/api/auth/login/verify-2fa', { method: 'POST', body: { pendingToken: a.json.pendingToken, code: totp.totp(SECRET) } });
  return b.cookie;
}

test('intake refuses a missing, wrong or borrowed app token', async () => {
  const body = { app: 'ifaima', events: [] };
  assert.strictEqual((await call('/api/ingest/app-signins', { method: 'POST', body })).status, 401);
  assert.strictEqual((await call('/api/ingest/app-signins', { method: 'POST', body, headers: { 'X-Pulse-App': 'ifaima', 'X-Pulse-App-Token': 'nope' } })).status, 401);
  // AOTC's token cannot speak for IFAIMA.
  assert.strictEqual((await call('/api/ingest/app-signins', { method: 'POST', body, headers: { 'X-Pulse-App': 'ifaima', 'X-Pulse-App-Token': appToken(HOOK, 'aotc-track') } })).status, 401);
  assert.strictEqual((await call('/api/ingest/app-signins', { method: 'POST', body, headers: { 'X-Pulse-App': 'ifaima', 'X-Pulse-App-Token': appToken(HOOK, 'ifaima') } })).status, 200);
});

test('the reporter mirrors the core login log; steps like awaiting-2fa are not stored', async () => {
  const logged = [];
  const session = { logLogin: (e) => { logged.push(e); } };
  reporter.wrapSession(session, { lookupUser: (id) => (id === 7 ? { name: 'Ama Owusu', role: 'secretary' } : null) });
  const { logLogin } = session;   // destructured after wrapping, as in the apps
  logLogin({ userId: 7, email: 'ama@example.com', success: false, reason: 'awaiting-2fa', ip: '41.66.1.2', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
  logLogin({ userId: 7, email: 'ama@example.com', success: true, reason: 'ok', ip: '41.66.1.2', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' });
  logLogin({ userId: null, email: 'ghost@example.com', success: false, reason: 'incorrect-credentials', ip: '203.0.113.9', userAgent: 'curl/8' });
  assert.strictEqual(logged.length, 3, 'the core still logs everything');
  await wait(2600);   // the reporter batches for 2 s
  const c = await signIn();
  const r = await call('/api/signins?range=24h', { cookie: c });
  assert.strictEqual(r.status, 200);
  const aotc = r.json.recent.filter((x) => x.app === 'aotc-track');
  assert.deepStrictEqual(aotc.map((x) => [x.email, x.ok, x.reason]).sort(), [['ama@example.com', 1, 'ok'], ['ghost@example.com', 0, 'incorrect-credentials']]);
  const ok = aotc.find((x) => x.ok);
  assert.strictEqual(ok.name, 'Ama Owusu');
  assert.strictEqual(ok.role, 'secretary');
  assert.strictEqual(ok.device, 'Safari on iPhone');
  assert.ok(r.json.online.some((p) => p.app === 'aotc-track' && p.email === 'ama@example.com'), 'a sign-in counts as online');
  const card = r.json.apps.find((a) => a.id === 'aotc-track');
  assert.ok(card.connected);
  assert.strictEqual(card.failed, 1);
  // Pulse's own sign-in is there too.
  assert.ok(r.json.recent.some((x) => x.app === 'pulse' && x.email === 'owner@example.com' && x.ok === 1));
  assert.ok(r.json.online.some((p) => p.app === 'pulse'));
});

test('the activity middleware reports who used the app, from the session cookie', async () => {
  const mw = reporter.activity({ jwt, secret: 'app-secret-123' });
  const tok = jwt.sign({ id: 42, name: 'Kojo Asante', email: 'kojo@example.com', role: 'admin', sv: 0 }, 'app-secret-123', { expiresIn: '1h' });
  const bad = jwt.sign({ id: 43, email: 'forged@example.com' }, 'not-the-secret');
  for (const t of [tok, tok, bad]) await new Promise((r) => mw({ cookies: { token: t }, ip: '102.176.65.20', get: () => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/128.0 Safari/537.36' }, {}, r));
  reporter.flush();
  await wait(400);
  const c = await signIn();
  const r = await call('/api/signins', { cookie: c });
  const k = r.json.online.find((p) => p.email === 'kojo@example.com');
  assert.ok(k, 'kojo is online');
  assert.strictEqual(k.role, 'admin');
  assert.strictEqual(k.device, 'Chrome on Mac');
  assert.ok(!r.json.online.some((p) => p.email === 'forged@example.com'), 'a cookie the app did not sign is ignored');
  const ov = await call('/api/overview', { cookie: c });
  assert.ok(ov.json.online >= 2);
});

test('behind Apache: the real address is the last X-Forwarded-For entry; report() works for apps with their own log', async () => {
  const mw = reporter.activity({ jwt, secret: 'app-secret-123' });
  const tok = jwt.sign({ id: 77, name: 'Efua Ansah', email: 'efua@example.com', role: 'secretary' }, 'app-secret-123', { expiresIn: '1h' });
  await new Promise((r) => mw({ cookies: { token: tok }, ip: '::ffff:127.0.0.1', headers: { 'x-forwarded-for': '6.6.6.6, 154.160.3.9' }, get: () => '' }, {}, r));
  reporter.report({ userId: 78, email: 'yaw@example.com', success: true, reason: 'ok-after-forced-password-change', ip: '41.66.2.2', userAgent: '' });
  reporter.flush();
  await wait(400);
  const c = await signIn();
  const r = await call('/api/signins', { cookie: c });
  assert.strictEqual(r.json.online.find((p) => p.email === 'efua@example.com').ip, '154.160.3.9');
  assert.ok(r.json.recent.some((x) => x.email === 'yaw@example.com' && x.ok === 1));
});

test('a viewer-less request cannot read sign-ins', async () => {
  assert.strictEqual((await call('/api/signins')).status, 401);
});

test('alerts: password guessing on one account, one address spraying, an admin from a new country', () => {
  const { db: d } = tmpDb();
  const raised = [];
  const alerts = { raise: (a) => raised.push(a) };
  const geo = { country: (ip) => (ip.startsWith('5.') ? 'RU' : ip.startsWith('41.') ? 'GH' : null) };
  let t = Date.now();
  const sg = createAppSignins({ db: d, geoip: geo, alerts, getSettings: settingsStub(), appName: () => 'AOTC Track', now: () => t });
  for (let i = 0; i < 10; i++) sg.ingest('aotc-track', { events: [{ ts: t, email: 'clerk@example.com', success: false, reason: 'incorrect-credentials', ip: '41.66.1.1' }] });
  assert.ok(raised.some((a) => a.key === 'app-guess:aotc-track:clerk@example.com' && /10 failed/.test(a.title)));
  for (let i = 0; i < 5; i++) sg.ingest('aotc-track', { events: [{ ts: t, email: `u${i}@example.com`, success: false, reason: 'incorrect-credentials', ip: '5.6.7.8' }] });
  assert.ok(raised.some((a) => a.key === 'app-spray:5.6.7.8'));
  raised.length = 0;
  sg.ingest('aotc-track', { events: [{ ts: t, userId: 1, email: 'boss@example.com', role: 'admin', success: true, ip: '41.66.1.1' }] });
  assert.strictEqual(raised.length, 0, 'admin from a usual country: quiet');
  sg.ingest('aotc-track', { events: [{ ts: t, userId: 1, email: 'boss@example.com', role: 'admin', success: true, ip: '5.1.1.1' }] });
  assert.ok(raised.some((a) => a.key === 'app-country:aotc-track:boss@example.com:RU'));
  raised.length = 0;
  sg.ingest('aotc-track', { events: [{ ts: t, userId: 2, email: 'member@example.com', role: 'secretary', success: true, ip: '5.1.1.1' }] });
  assert.strictEqual(raised.length, 0, 'ordinary role from abroad: no alert');
  // Online window and pruning.
  assert.strictEqual(sg.online().length, 2);
  t += 16 * 60_000;
  assert.strictEqual(sg.online().length, 0);
  t += 91 * 86400_000;
  sg.prune();
  assert.strictEqual(sg.recent({ since: 0 }).length, 0);
});

test('device labels', () => {
  assert.strictEqual(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0'), 'Edge on Windows');
  assert.strictEqual(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36'), 'Chrome on Android');
  assert.strictEqual(deviceLabel(''), 'Unknown');
});
