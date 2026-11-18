const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, settingsStub, fakeChannels } = require('./helpers');
const { createMonitor } = require('../core/monitor');
const { parseAuthLine } = require('../core/authwatch');

const MAC = 'SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk';

function setup() {
  const { db } = tmpDb();
  const ch = fakeChannels();
  const m = createMonitor({ db, getSettings: settingsStub(), channels: ch, enableAuthWatch: false, log: { log() {}, error() {} }, si: {} });
  db.sql.run("INSERT INTO trusted_sources (kind, label, value, created_at) VALUES ('key', 'MacBook (deploy key)', ?, ?)", MAC, Date.now());
  db.sql.run("INSERT INTO trusted_sources (kind, label, value, created_at) VALUES ('network', 'Home Wi-Fi', '173.177.203.0/24', ?)", Date.now());
  const feed = (msg, ident, ts = Date.now()) => m.handleAccess({ ...parseAuthLine(msg, ident), ts, raw: msg });
  return { db, ch, m, feed };
}

test('the MacBook from home makes no noise; root makes a lot', () => {
  const { m, feed } = setup();
  const r1 = feed(`Accepted publickey for deploy from 173.177.203.145 port 1 ssh2: ED25519 ${MAC}`, 'sshd');
  assert.strictEqual(r1.grade, 'quiet');
  assert.strictEqual(m.alerts.list().length, 0);
  const r2 = feed('Accepted publickey for root from 45.1.2.3 port 1 ssh2: ED25519 SHA256:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', 'sshd');
  assert.strictEqual(r2.grade, 'urgent');
  const open = m.alerts.list();
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].severity, 'critical');
  assert.strictEqual(open[0].rule, 'access');
});

test('a deploy-shaped sudo opens a release window that covers the next login', () => {
  const { m, feed } = setup();
  const t = Date.now();
  feed(`Accepted publickey for deploy from 173.177.203.145 port 1 ssh2: ED25519 ${MAC}`, 'sshd', t);
  const s = feed('deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart ifaima-blue', 'sudo', t + 1000);
  assert.strictEqual(s.grade, 'release');
  assert.ok(m.deploys.inDeploy(null, t + 2000));
  const r = feed(`Accepted publickey for deploy from 41.66.1.1 port 1 ssh2: ED25519 ${MAC}`, 'sshd', t + 3000);
  assert.strictEqual(r.grade, 'release');
  assert.strictEqual(m.alerts.list().length, 0);
});

test('"Yes, trust this network" adds the /24 it came from', () => {
  const { m, feed, db } = setup();
  feed('Accepted publickey for deploy from 102.176.65.20 port 1 ssh2: ED25519 SHA256:unknownunknownunknownunknownunknownunknownx', 'sshd');
  const a = m.alerts.list()[0];
  m.alerts.answer(a.id, true, 'test');
  const t = m.trustFromAlert(a.id, 'test');
  assert.strictEqual(t.cidr, '102.176.65.0/24');
  const row = db.sql.get("SELECT * FROM trusted_sources WHERE value = '102.176.65.0/24'");
  assert.ok(row);
  // 7 days unless asked otherwise: a hotel network lapses by itself.
  assert.ok(Math.abs(row.expires_at - (Date.now() + 7 * 86400_000)) < 60_000);
  // Asking again for "always" extends it; asking for 1 day does not shorten it.
  assert.strictEqual(m.trustFromAlert(a.id, 'test', 1).renewed, false);
  const again = m.trustFromAlert(a.id, 'test', 0);
  assert.strictEqual(again.renewed, true);
  assert.strictEqual(db.sql.get("SELECT expires_at FROM trusted_sources WHERE value = '102.176.65.0/24'").expires_at, null);
});

test('failed-login bursts raise one warning per IP', () => {
  const { m, feed } = setup();
  for (let i = 0; i < 25; i++) feed(`Invalid user admin from 45.148.10.80 port ${40000 + i}`, 'sshd');
  const open = m.alerts.list();
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].rule, 'access-burst');
  assert.match(open[0].title, /20 failed SSH logins from 45\.148\.10\.80/);
});

test('a new SSH key in the inventory is an urgent access alert', async () => {
  const fs = require('fs');
  const path = require('path');
  const discovery = require('../core/discovery');
  const base = discovery.parseScan(fs.readFileSync(path.join(__dirname, 'fixtures/scan-real.txt'), 'utf8'));
  let n = 0;
  const gather = async () => {
    const scan = JSON.parse(JSON.stringify(base));
    scan.ts = Date.now() + n * 1000;   // fresh, so the "scan has stopped" rule stays quiet
    if (n++ > 0) scan.keys.push({ user: 'deploy', fingerprint: 'SHA256:intruderintruderintruderintruderintruderin', type: 'ED25519' });
    return { ts: Date.now(), scan, units: [], sites: [], live: {}, apps: [], timers: [] };
  };
  const { db } = tmpDb();
  const m = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {}, gather });
  await m.discover();
  assert.strictEqual(m.alerts.list().length, 0, 'first inventory is the baseline');
  await m.discover();
  const open = m.alerts.list();
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].severity, 'critical');
  assert.match(open[0].title, /New SSH key for deploy/);
});

test('an app that disappears and comes back: its alert closes by itself', async () => {
  const fs = require('fs');
  const path = require('path');
  const discovery = require('../core/discovery');
  const base = discovery.parseScan(fs.readFileSync(path.join(__dirname, 'fixtures/scan-real.txt'), 'utf8'));
  const present = [true, false, true];
  let n = 0;
  const gather = async () => {
    const scan = JSON.parse(JSON.stringify(base));
    scan.ts = Date.now() + n * 1000;
    const here = present[n++];
    return { ts: Date.now(), scan, units: [], sites: [], live: {}, apps: here ? [{ id: 'demo', name: 'Demo', kind: 'app', ports: [], lines: [], units: [] }] : [], timers: [] };
  };
  const { db } = tmpDb();
  const m = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {}, gather });
  await m.discover();
  await m.discover();
  assert.ok(m.alerts.activeByKey('app-gone:demo'), 'gone: urgent alert');
  await m.discover();
  assert.strictEqual(m.alerts.activeByKey('app-gone:demo'), null, 'back: closed');
});

test('resource rules: disk bands, sustained CPU, and clearing', () => {
  const { m } = setup();
  const t0 = Date.now();
  const s = (o) => ({ ts: t0, cpu: 5, mem: 30, swap: 0, swapTotal: 0, disks: [{ mount: '/', size: 100e9, used: 10e9, pct: 10 }], ...o });
  const disk = (pct) => [{ mount: '/', size: 100e9, used: pct * 1e9, pct }];
  m.onSample(s({ disks: disk(86) }));
  assert.strictEqual(m.alerts.activeByKey('disk:/').severity, 'warning');
  m.onSample(s({ disks: disk(96) }));
  assert.strictEqual(m.alerts.activeByKey('disk:/').severity, 'critical');
  m.onSample(s({ disks: disk(50) }));
  assert.strictEqual(m.alerts.activeByKey('disk:/'), null);

  // CPU: a spike is not an alert; five minutes above 90% is.
  for (let i = 0; i < 30; i++) m.onSample(s({ ts: t0 + i * 2000, cpu: 99 }));
  assert.strictEqual(m.alerts.activeByKey('cpu'), null, 'one minute of 99% is not sustained');
  for (let i = 30; i <= 160; i++) m.onSample(s({ ts: t0 + i * 2000, cpu: 97 }));
  assert.strictEqual(m.alerts.activeByKey('cpu').severity, 'critical');
  for (let i = 161; i <= 330; i++) m.onSample(s({ ts: t0 + i * 2000, cpu: 10 }));
  assert.strictEqual(m.alerts.activeByKey('cpu'), null, 'clears when it settles');

  m.onSample(s({ swap: 95, swapTotal: 2e9, swapUsed: 1.9e9 }));
  assert.strictEqual(m.alerts.activeByKey('swap').severity, 'warning');
});

test('after a restart, sudo in an existing trusted session is still quiet', () => {
  const { db, feed } = setup();
  const t = Date.now() - 60_000;
  feed(`Accepted publickey for deploy from 173.177.203.145 port 1 ssh2: ED25519 ${MAC}`, 'sshd', t);
  // A fresh monitor on the same database = Pulse restarted.
  const m2 = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {} });
  assert.strictEqual(m2.restoreSessions(), 1);
  const r = m2.handleAccess({ ...parseAuthLine('deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl status pulse', 'sudo'), ts: Date.now() });
  assert.strictEqual(r.grade, 'quiet');
  assert.strictEqual(m2.alerts.list().length, 0);
});

test('channels: viewers get the alert but not the answer buttons', async () => {
  const { db } = setup();
  const { createChannels } = require('../core/channels');
  db.sql.run("INSERT INTO push_subs (endpoint, keys, user_id, label, created_at) VALUES ('https://p/owner', '{}', 1, 'o', 0), ('https://p/viewer', '{}', 2, 'v', 0)");
  const got = {};
  const webpush = { setVapidDetails() {}, sendNotification: async (sub, body) => { got[sub.endpoint] = JSON.parse(body); } };
  process.env.VAPID_PUBLIC_KEY = 'x'; process.env.VAPID_PRIVATE_KEY = 'y';
  const ch = createChannels({ db, getSettings: settingsStub({ channels: { push: true, sms: false, email: false } }), sendMail: async () => ({}), sendSms: async () => ({}), webpush, secret: 's'.repeat(40), canAct: (id) => id === 1, log: { error() {}, log() {} } });
  delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;
  await ch.deliver({ id: 7, key: 'access:7', rule: 'access', severity: 'warning', title: 'login', updated_at: Date.now() });
  assert.strictEqual(got['https://p/owner'].actions.length, 2);
  assert.strictEqual(got['https://p/viewer'].actions.length, 0);
});
