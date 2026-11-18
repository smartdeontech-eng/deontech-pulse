// 0.1.11: anything new on the server is found by itself — whatever runs it —
// named sensibly, announced once, and noticed within a minute.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const d = require('../core/discovery');
const { tmpDb, settingsStub, fakeChannels } = require('./helpers');
const { createMonitor } = require('../core/monitor');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const base = d.parseScan(fx('scan-real.txt'));

const BUDGET_SITE = `<VirtualHost *:443>
    ServerName budget.smartdeontech.com
    ProxyPass / http://127.0.0.1:3202/
    SSLCertificateFile /etc/letsencrypt/live/budget.smartdeontech.com/fullchain.pem
</VirtualHost>`;
const budgetUnit = { unit: 'budget.service', base: 'budget', load: 'loaded', active: 'active', sub: 'running', description: 'Budget (budget.smartdeontech.com)' };

test('Budget: its service, its site and its port make one app, named Budget, checked on /healthz', () => {
  const scan = JSON.parse(JSON.stringify(base));
  scan.ports.push({ port: 3202, addr: '127.0.0.1', addrs: ['127.0.0.1'], proc: 'node', pid: 4242, unit: 'budget.service', cwd: '/opt/budget/app', pm2: null, public: false });
  const sites = d.parseApacheSite(BUDGET_SITE, '/etc/apache2/sites-enabled/budget-le-ssl.conf');
  const apps = d.buildApps({ scan, units: [budgetUnit], sites });
  const b = apps.find((a) => a.id === 'budget');
  assert.ok(b);
  assert.strictEqual(b.name, 'Budget');
  assert.strictEqual(b.checkPort, 3202);
  assert.deepStrictEqual(b.healthPaths, ['/healthz']);
  assert.deepStrictEqual(b.domains, ['budget.smartdeontech.com']);
});

test('an app nobody named gets a readable name from its address or its id', () => {
  assert.strictEqual(d.friendlyName('notes', ['notes.smartdeontech.com']), 'Notes');
  assert.strictEqual(d.friendlyName('budget-api'), 'Budget API');
  assert.strictEqual(d.friendlyName('school_crm'), 'School CRM');
  const sites = d.parseApacheSite('<VirtualHost *:80>\nServerName stock.smartdeontech.com\nProxyPass / http://127.0.0.1:4100/\n</VirtualHost>', '/etc/apache2/sites-enabled/stock.conf');
  const apps = d.buildApps({ scan: base, units: [], sites });
  assert.strictEqual(apps.find((a) => a.id === 'stock').name, 'Stock');
});

test('the scan carries the folder and the PM2 name of each listening program, and Docker containers', () => {
  const s = d.parseScan(`== meta\nts\t1\n== ports\n4100\t127.0.0.1\tnode\t900\tpm2-deploy.service\t/home/deploy/apps/expenses\texpenses\n8080\t0.0.0.0\tdocker-proxy\t901\tdocker.service\t/\t-\n== containers\nwiki\t0.0.0.0:8080->3000/tcp, :::8080->3000/tcp\n`);
  assert.deepStrictEqual([s.ports[0].cwd, s.ports[0].pm2], ['/home/deploy/apps/expenses', 'expenses']);
  assert.deepStrictEqual(s.containers, [{ name: 'wiki', ports: [8080] }]);
  // Older scans (five columns) still parse.
  assert.strictEqual(d.parseScan('== ports\n3011\t*\tnode\t1\taotc-track@blue.service\n').ports[0].cwd, null);
});

test('apps run by PM2, Docker or by hand are found, and the runner itself is not an app', () => {
  const scan = { ts: 1, ports: [
    { port: 4100, addrs: ['127.0.0.1'], proc: 'node', pid: 900, unit: 'pm2-deploy.service', cwd: '/home/deploy/apps/expenses', pm2: 'expenses' },
    { port: 8080, addrs: ['0.0.0.0'], proc: 'docker-proxy', pid: 901, unit: 'docker.service', cwd: '/', pm2: null },
    { port: 5100, addrs: ['127.0.0.1'], proc: 'python3', pid: 902, unit: null, cwd: '/opt/reports/current', pm2: null },
    { port: 5200, addrs: ['127.0.0.1'], proc: 'node', pid: 903, unit: null, cwd: '/', pm2: null },
  ], containers: [{ name: 'wiki', ports: [8080] }] };
  const units = [
    { unit: 'pm2-deploy.service', base: 'pm2-deploy', load: 'loaded', active: 'active', sub: 'running' },
    { unit: 'docker.service', base: 'docker', load: 'loaded', active: 'active', sub: 'running' },
  ];
  const apps = d.buildApps({ scan, units, sites: [] });
  const ids = apps.map((a) => a.id).sort();
  assert.deepStrictEqual(ids, ['expenses', 'reports', 'wiki']);
  const by = Object.fromEntries(apps.map((a) => [a.id, a]));
  assert.strictEqual(by.expenses.runner, 'pm2');
  assert.strictEqual(by.expenses.checkPort, 4100);
  assert.strictEqual(by.wiki.runner, 'docker');
  assert.strictEqual(by.reports.runner, 'process');
  assert.strictEqual(by.reports.name, 'Reports');
  assert.strictEqual(d.appFromProcess({ port: 1, cwd: '/home/deon/app' }), null, 'a vague folder names nothing');
});

test('listening ports are read from /proc/net/tcp', () => {
  const t = '  sl  local_address rem_address   st\n   0: 0100007F:0C82 00000000:0000 0A 0\n   1: 0100007F:1F90 0100007F:9C40 01 0\n';
  assert.deepStrictEqual(d.parseProcNetTcp(t), [3202]);
});

test('PM2 leaving the app list after the upgrade is not "an app disappeared"', () => {
  const prev = { scan: base, units: [], sites: [], apps: [{ id: 'pm2-deploy' }, { id: 'budget' }] };
  const next = { scan: base, units: [], sites: [], apps: [{ id: 'budget' }, { id: 'expenses' }] };
  const ch = d.diffInventories(prev, next).filter((c) => c.kind === 'app');
  assert.deepStrictEqual(ch.map((c) => `${c.op} ${c.key}`), ['added expenses']);
});

function budgetWorld() {
  // A server where Budget appears between two root scans.
  const state = { budget: false };
  const scan = JSON.parse(JSON.stringify(base));
  scan.ts = Date.now();
  const gather = async () => {
    const units = state.budget ? [budgetUnit] : [];
    const sites = state.budget ? d.parseApacheSite(BUDGET_SITE, '/etc/apache2/sites-enabled/budget-le-ssl.conf') : [];
    const apps = d.buildApps({ scan, units, sites });
    return { ts: Date.now(), scan, units, sites, live: {}, apps, timers: [] };
  };
  return { state, gather };
}

test('a new app is noticed between scans, announced once (not as four changes), and a scan is asked for', async () => {
  const { db } = tmpDb();
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-proc-'));
  const w = budgetWorld();
  let scans = 0;
  const m = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {}, gather: w.gather, procRoot: proc, requestScan: async () => { scans++; } });
  const inv = () => m.alerts.list().filter((a) => a.rule === 'inventory');
  await m.discover();
  assert.strictEqual(inv().length, 0, 'first inventory is the baseline');
  w.state.budget = true;
  await m.discover();   // same root scan: the live half sees it
  const open = inv();
  assert.deepStrictEqual(open.map((a) => a.title), ['New app found: Budget']);
  assert.match(open[0].detail.summary || JSON.parse(open[0].detail).summary, /service budget\.service; budget\.smartdeontech\.com · port 3202/);
  assert.strictEqual(scans, 1, 'asked root for a fresh scan');
  const ev = db.sql.all("SELECT title FROM events WHERE kind = 'inventory' ORDER BY id").map((r) => r.title);
  assert.ok(ev.includes('New service: budget.service') && ev.includes('New Apache site: budget.smartdeontech.com'), 'the parts are on the timeline');
  await new Promise((r) => setTimeout(r, 20));
  await m.discover();   // nothing changed: nothing new
  assert.strictEqual(inv().length, 1);
  assert.strictEqual(db.sql.all("SELECT * FROM events WHERE kind = 'inventory' AND title = 'New app found: Budget'").length, 1);
});

test('a new listening port the last scan did not see asks for a scan (at most every 10 minutes)', async () => {
  const { db } = tmpDb();
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-proc-'));
  fs.mkdirSync(path.join(proc, 'net'));
  fs.writeFileSync(path.join(proc, 'net', 'tcp'), '  sl  local_address rem_address   st\n   0: 0100007F:0C82 00000000:0000 0A 0\n');
  const w = budgetWorld();
  let scans = 0;
  const m = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {}, gather: w.gather, procRoot: proc, requestScan: async () => { scans++; } });
  await m.discover();
  await m.discover();
  assert.strictEqual(scans, 1);
});

test('an app that reports a new version: a release on its timeline, once', () => {
  const { db } = tmpDb();
  const m = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {} });
  const app = { id: 'budget', name: 'Budget' };
  m.noteVersion(app, { ok: true, health: { version: '1.0.44' } });
  m.noteVersion(app, { ok: true, health: { version: '1.0.44' } });
  m.noteVersion(app, { ok: true, health: { version: '1.0.45' } });
  m.noteVersion(app, { ok: false, health: { version: '9.9.9' } });
  const ev = db.sql.all("SELECT title FROM events WHERE kind = 'deploy'").map((r) => r.title);
  assert.deepStrictEqual(ev, ['Budget updated to 1.0.45 (was 1.0.44)']);
  assert.deepStrictEqual(m.appVersions().budget, { version: '1.0.45', prev: '1.0.44', changedAt: m.appVersions().budget.changedAt });
  assert.strictEqual(m.deploys.recent(0).length, 1, 'a marker for the charts');
});

test('between scans only arrivals count; something gone waits for the hourly scan', async () => {
  const { db } = tmpDb();
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-proc-'));
  const w = budgetWorld();
  w.state.budget = true;
  const m = createMonitor({ db, getSettings: settingsStub(), channels: fakeChannels(), enableAuthWatch: false, log: { log() {}, error() {} }, si: {}, gather: w.gather, procRoot: proc });
  await m.discover();
  w.state.budget = false;   // e.g. mid-restart
  await m.discover();
  assert.strictEqual(m.alerts.list().filter((a) => a.rule === 'inventory').length, 0);
  w.state.budget = true;
  await m.discover();
  assert.strictEqual(m.alerts.list().filter((a) => a.rule === 'inventory').length, 0, 'back: and never announced as new');
});

test('Ubuntu’s own units (ldconfig, snapd.apparmor) are not apps; databases and your services are', () => {
  const units = [
    { unit: 'ldconfig.service', base: 'ldconfig', load: 'loaded', active: 'inactive', sub: 'dead', fragment: '/usr/lib/systemd/system/ldconfig.service' },
    { unit: 'snapd.apparmor.service', base: 'snapd.apparmor', load: 'loaded', active: 'active', sub: 'exited', fragment: '/usr/lib/systemd/system/snapd.apparmor.service' },
    { unit: 'mysql.service', base: 'mysql', load: 'loaded', active: 'active', sub: 'running', fragment: '/usr/lib/systemd/system/mysql.service' },
    { ...budgetUnit, fragment: '/etc/systemd/system/budget.service' },
  ];
  const apps = d.buildApps({ scan: { ts: 1, ports: [] }, units, sites: [] });
  assert.deepStrictEqual(apps.map((a) => a.id).sort(), ['budget', 'mysql']);
  // An older inventory that still had them as apps: not "gone".
  const prev = { scan: null, units: units.map(({ fragment, ...u }) => u), sites: [], apps: [{ id: 'ldconfig' }, { id: 'snapd.apparmor' }, { id: 'budget' }, { id: 'mysql' }] };
  const ch = d.diffInventories(prev, { scan: null, units, sites: [], apps });
  assert.deepStrictEqual(ch, []);
});
