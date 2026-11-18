// Errors: assembling a block from journal lines, grouping by kind, context
// before/after, masking, statuses, alerts, failed requests and the API.
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb } = require('./helpers');
const { createAppLogs } = require('../core/applogs');
const { analyse, hintFor, journalCommand } = require('../core/errgroups');

const DOTNET = (id) => [
  'fail: Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware[1]',
  '      An unhandled exception has occurred while executing the request.',
  `      System.NullReferenceException: Object reference not set to an instance of an object. Pledge ${id}`,
  '         at Pledge.Controllers.PledgeController.Submit(PledgeDto dto) in /src/Controllers/PledgeController.cs:line 42',
  '         at lambda_method12(Closure , Object , Object[] )',
  '         at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.SyncActionResultExecutor.Execute(ActionContext context)',
];

function feed(l, unit, lines, t0, step = 10) {
  lines.forEach((m, i) => l.line({ ts: t0 + i * step, unit, message: m }));
}

test('a .NET exception becomes one occurrence with its stack, the lines before and after, and a clear title', () => {
  const { db } = tmpDb();
  const seen = [];
  let t = 1_800_000_000_000;
  const l = createAppLogs({ db, onGroup: (e) => seen.push(e), now: () => t, log: { error() {} } });
  l._setUnits({ 'pledge.service': 'pledge' });
  feed(l, 'pledge.service', ['info: Request starting HTTP/1.1 POST /pledges/submit', 'info: user password=hunter2 logged in from 41.66.1.2'], t - 500);
  feed(l, 'pledge.service', DOTNET(1001), t);
  feed(l, 'pledge.service', ['info: Request finished in 12ms 500', 'info: Request starting GET /'], t + 200);
  t += 4000;
  l.flushPending();
  assert.strictEqual(seen.length, 1);
  const g = l.group(seen[0].group.id);
  assert.strictEqual(g.title, 'NullReferenceException in PledgeController.Submit');
  assert.strictEqual(g.type, 'System.NullReferenceException');
  assert.match(g.frame, /PledgeController\.cs:line 42/);
  assert.strictEqual(g.frame_is_app, 1);
  assert.strictEqual(g.total, 1);
  const e = g.events[0];
  assert.strictEqual(e.block.split('\n').length, 6, 'error + stack are one block');
  assert.ok(e.before.some((x) => /POST \/pledges\/submit/.test(x.text)));
  assert.ok(e.before.some((x) => /password=<redacted>/.test(x.text) && /<ip>/.test(x.text)), 'context lines are masked');
  assert.ok(!JSON.stringify(e).includes('hunter2'));
  assert.ok(e.after.some((x) => /Request finished/.test(x.text)));
});

test('the same fault with different ids is one group; a different fault is another', () => {
  const { db } = tmpDb();
  let t = 1_800_000_000_000;
  const l = createAppLogs({ db, now: () => t, log: { error() {} } });
  l._setUnits({ 'pledge.service': 'pledge' });
  for (const id of [1, 2, 3]) { feed(l, 'pledge.service', DOTNET(id), t); t += 5000; l.flushPending(); }
  feed(l, 'pledge.service', ['fail: x[1]', '      Microsoft.Data.SqlClient.SqlException (0x80131904): Timeout expired.', '         at Pledge.Data.Repo.Save() in /src/Data/Repo.cs:line 9'], t);
  t += 5000; l.flushPending();
  const gs = l.groups();
  assert.strictEqual(gs.length, 2);
  const npe = gs.find((g) => /NullReference/.test(g.title));
  assert.strictEqual(npe.total, 3);
  assert.strictEqual(npe.last24h, 3);
  assert.strictEqual(gs.find((g) => /SqlException/.test(g.title)).title, 'SqlException in Repo.Save');
});

test('Node errors: the first frame in the app code is used, not node_modules', () => {
  const a = analyse('aotc-track', [
    'Error: SQLITE_BUSY: database is locked',
    '    at Database.run (/opt/aotc-track/node_modules/better-sqlite3/lib/x.js:3:9)',
    '    at save (/opt/aotc-track/routes/minutes.js:120:15)',
  ]);
  assert.strictEqual(a.title, 'SQLITE_BUSY: database is locked — save (minutes.js:120)');
  assert.strictEqual(analyse('x', ['TypeError: Cannot read properties of undefined (reading \'id\')', '    at show (/opt/x/routes/m.js:5:3)']).title, 'TypeError in show (m.js:5)');
  assert.match(a.frame, /routes\/minutes\.js:120/);
  assert.strictEqual(hintFor('SQLITE_BUSY: database is locked').title, 'Two writes collided in the database');
  assert.strictEqual(hintFor('System.NullReferenceException').title, 'A bug in the code: something was missing');
  assert.match(journalCommand('pledge.service', Date.UTC(2026, 9, 15, 9, 12, 0)), /journalctl -u pledge\.service --since "2026-10-15 09:11:00 UTC" --until "2026-10-15 09:12:30 UTC"/);
});

test('statuses: known stays known; fixed reopens when the fault comes back', () => {
  const { db } = tmpDb();
  const seen = [];
  let t = 1_800_000_000_000;
  const l = createAppLogs({ db, onGroup: (e) => seen.push(e), now: () => t, log: { error() {} } });
  l._setUnits({ 'pledge.service': 'pledge' });
  feed(l, 'pledge.service', DOTNET(1), t); t += 5000; l.flushPending();
  const id = seen[0].group.id;
  assert.strictEqual(seen[0].isNew, true);
  l.setStatus(id, 'fixed', 'me');
  feed(l, 'pledge.service', DOTNET(2), t); t += 5000; l.flushPending();
  assert.strictEqual(seen[1].reopened, true);
  assert.strictEqual(l.group(id).status, 'open');
  l.setStatus(id, 'known', 'me');
  feed(l, 'pledge.service', DOTNET(3), t); t += 5000; l.flushPending();
  assert.strictEqual(seen[2].reopened, false);
  assert.strictEqual(l.group(id).status, 'known');
});

test('at most 12 full occurrences per group per hour are kept; the count stays exact', () => {
  const { db } = tmpDb();
  let t = 1_800_000_000_000;
  const l = createAppLogs({ db, now: () => t, log: { error() {} } });
  l._setUnits({ 'pledge.service': 'pledge' });
  for (let i = 0; i < 20; i++) { feed(l, 'pledge.service', DOTNET(i), t); t += 4000; l.flushPending(); }
  const g = l.groups()[0];
  assert.strictEqual(g.total, 20);
  assert.strictEqual(db.sql.get('SELECT COUNT(*) n FROM error_events').n, 12);
});

// ---- through the server ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-errors-'));
Object.assign(process.env, {
  DATA_DIR: dir, JWT_SECRET: 'e'.repeat(16) + require('crypto').randomBytes(24).toString('hex'),
  PULSE_AUTHWATCH: 'off', PULSE_LOGS: 'off', PULSE_HOOK_TOKEN: 'h'.repeat(32), PULSE_SCAN_PATH: path.join(dir, 'none.txt'),
});

test('API: list, detail with the failed request at that moment, statuses; alerts name the error', async () => {
  const { app, monitor } = require('../server');
  const db = require('../utils/db');
  const bcrypt = require('bcryptjs');
  const totp = require('../utils/totp');
  const SECRET = totp.generateSecret();
  const mk = (email, role, perms) => db.insert('users', { email, name: email, role, permissions: perms, passwordHash: bcrypt.hashSync('Correct-Horse-9!', 4), sessionVersion: 0, twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [] });
  mk('owner@example.com', 'owner', []);
  mk('viewer@example.com', 'viewer', ['monitor.view']);
  monitor.state.apps = [{ id: 'pledge', name: 'Pledges', kind: 'app', domains: ['pledges.pcg-aotc.com'], ports: [5000], lines: [], units: [{ unit: 'pledge.service' }], listening: [], watched: true }];
  monitor.appLogs._setUnits({ 'pledge.service': 'pledge' });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (p, { method = 'GET', body, cookie } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* */ }
    return { status: r.status, json, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const signIn = async (email) => {
    const a = await call('/api/auth/login', { method: 'POST', body: { email, password: 'Correct-Horse-9!' } });
    return (await call('/api/auth/login/verify-2fa', { method: 'POST', body: { pendingToken: a.json.pendingToken, code: totp.totp(SECRET) } })).cookie;
  };
  try {
    const t = Date.now();
    monitor.traffic.add({ vhost: 'pledges.pcg-aotc.com', status: 500, bytes: 10, method: 'POST', path: '/pledges/submit' }, t - 1000);
    feed(monitor.appLogs, 'pledge.service', DOTNET(7), t);
    monitor.appLogs.flushPending(t + 10_000, true);
    const alert = monitor.alerts.list().find((a) => a.key.startsWith('errgroup:'));
    assert.ok(alert, 'a new kind of error raises an alert');
    assert.strictEqual(alert.title, 'Pledges: new error — NullReferenceException in PledgeController.Submit');
    const detail = typeof alert.detail === 'string' ? JSON.parse(alert.detail) : alert.detail;
    assert.ok(detail.groupId);

    const o = await signIn('owner@example.com');
    const list = await call('/api/errors', { cookie: o });
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.groups[0].appName, 'Pledges');
    const id = list.json.groups[0].id;
    const d = await call(`/api/errors/${id}`, { cookie: o });
    assert.strictEqual(d.json.hint.title, 'A bug in the code: something was missing');
    const ev = d.json.group.events[0];
    assert.deepStrictEqual(ev.requests.map((r) => [r.method, r.path, r.status]), [['POST', '/pledges/submit', 500]]);
    assert.match(ev.command, /^sudo journalctl -u pledge\.service --since "/);

    const v = await signIn('viewer@example.com');
    assert.strictEqual((await call(`/api/errors/${id}`, { method: 'PUT', cookie: v, body: { status: 'known' } })).status, 403);
    const k = await call(`/api/errors/${id}`, { method: 'PUT', cookie: o, body: { status: 'known', note: 'harmless, users retry' } });
    assert.strictEqual(k.json.group.status, 'known');
    assert.ok(!monitor.alerts.list().some((a) => a.key === `errgroup:${id}`), 'marking it known closes its alert');
    feed(monitor.appLogs, 'pledge.service', DOTNET(8), t + 20_000);
    monitor.appLogs.flushPending(t + 40_000, true);
    assert.ok(!monitor.alerts.list().some((a) => a.key === `errgroup:${id}`), 'a known error stays quiet');
  } finally { server.close(); monitor.stop(); }
});
