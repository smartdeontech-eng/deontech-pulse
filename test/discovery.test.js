const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const d = require('../core/discovery');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const scan = d.parseScan(fx('scan-real.txt'));
const units = d.parseUnits(fx('units.json'));
const sites = d.readApacheSites(path.join(__dirname, 'fixtures/sites'), (p) => {
  if (p === '/etc/apache2/aotc-live.conf') return 'ProxyPass / http://127.0.0.1:3011/\n';
  return fs.readFileSync(p, 'utf8');
}).hosts;
const live = { 'aotc-lines': { value: 'blue' }, ifaima: { value: 'blue' } };
const apps = d.buildApps({ scan, units, sites, live });
const byId = Object.fromEntries(apps.map((a) => [a.id, a]));

test('the root scan parses: ports, keys, users, backups, security', () => {
  assert.strictEqual(scan.ts, 1791518055000);
  assert.ok(scan.ports.find((p) => p.port === 3011 && p.unit === 'aotc-track@blue.service'));
  assert.strictEqual(scan.ports.filter((p) => p.port === 22).length, 1, 'v4 and v6 rows for one owner are one port');
  assert.strictEqual(scan.keys.length, 1);
  assert.strictEqual(scan.keys[0].fingerprint, 'SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk');
  assert.deepStrictEqual(scan.users.filter((u) => u.sudo).map((u) => u.name).sort(), ['deon', 'deploy', 'pduodu', 'root']);
  assert.strictEqual(scan.backups.length, 2);
  assert.strictEqual(scan.security.fail2ban_banned, 3);
});

test('every app on the real server is found, with the right ports', () => {
  assert.deepStrictEqual(apps.filter((a) => a.kind === 'app').map((a) => a.id).sort(), ['aotc-track', 'ginasangel', 'ifaima', 'pledge', 'pman', 'smart-deontech']);
  assert.deepStrictEqual(apps.filter((a) => a.kind === 'database').map((a) => a.id).sort(), ['mssql-server', 'mysql', 'postgresql']);
  assert.strictEqual(byId['smart-deontech'].checkPort, 3001);
  assert.ok(byId['smart-deontech'].domains.includes('smartdeontech.com'));
  assert.strictEqual(byId.pledge.checkPort, 5000);
  assert.strictEqual(byId.ginasangel.name, "Gina's Angel (Genius School)");
});

test('blue/green: the live line is the one checked', () => {
  const a = byId['aotc-track'];
  assert.strictEqual(a.liveLine, 'blue');
  assert.strictEqual(a.checkPort, 3011);
  assert.ok(a.domains.includes('track.pcg-aotc.com'), 'Include-d backend file is followed');
  const i = byId.ifaima;
  assert.deepStrictEqual(i.lines.map((l) => [l.line, l.port]).sort(), [['blue', 3101], ['green', 3102]]);
  assert.strictEqual(i.checkPort, 3101);
  assert.deepStrictEqual(i.excludedPaths, ['/healthz']);
});

test('pman: a site whose backend is dead is an app that is down', () => {
  const p = byId.pman;
  assert.strictEqual(p.checkPort, 5002);
  assert.deepStrictEqual(p.listening, []);
  const f = d.findings({ scan, apps });
  assert.ok(f.find((x) => x.app === 'pman' && x.severity === 'critical'));
});

test('findings: missing backups, old tarballs; stopped postgres is not nagged about', () => {
  const f = d.findings({ scan, apps }).map((x) => x.title);
  assert.ok(f.some((t) => /Smart DeonTech has no backups/.test(t)));
  assert.ok(f.some((t) => /MySQL has no backup/.test(t)));
  assert.ok(!f.some((t) => /PostgreSQL/.test(t)));
  assert.ok(f.some((t) => /GB of old release tarballs/.test(t)));
});

test('overrides rename and hide', () => {
  const x = d.buildApps({ scan, units, sites, live, overrides: { pman: { name: 'Property Manager' }, postgresql: { ignore: true } } });
  assert.strictEqual(x.find((a) => a.id === 'pman').name, 'Property Manager');
  assert.ok(!x.find((a) => a.id === 'postgresql'));
});

test('diff: a new key, user and port are reported; a failed scan is not "everything removed"', () => {
  const prev = { scan, units, sites, apps };
  const s2 = JSON.parse(JSON.stringify(scan));
  s2.keys.push({ user: 'deploy', fingerprint: 'SHA256:newkey', file: '', type: 'ED25519' });
  s2.users.push({ name: 'bob', uid: 1003, home: '/home/bob', shell: '/bin/bash', sudo: true });
  s2.ports.push({ port: 8080, addr: '*', proc: 'node', pid: 1, unit: 'mystery.service' });
  const ch = d.diffInventories(prev, { scan: s2, units, sites, apps });
  const keys = ch.map((c) => `${c.kind}:${c.op}`);
  assert.ok(keys.includes('key:added'));
  assert.ok(keys.includes('user:added'));
  assert.ok(keys.includes('sudoer:added'));
  assert.ok(keys.includes('port:added'));
  assert.strictEqual(ch.find((c) => c.kind === 'key').severity, 'critical');
  assert.deepStrictEqual(d.diffInventories(prev, { scan: null, units, sites, apps }).filter((c) => ['key', 'user', 'port'].includes(c.kind)), []);
  assert.deepStrictEqual(d.diffInventories(null, prev), []);
});

test('apache parser: rewrite [P] rules, aliases, cert files', () => {
  const h = d.parseApacheSite('<VirtualHost *:443>\n ServerName a.example.com\n ServerAlias b.example.com c.example.com\n RewriteRule ^/(.*)$ http://localhost:4000/$1 [P,L]\n SSLCertificateFile /x/fullchain.pem\n</VirtualHost>');
  assert.strictEqual(h.length, 1);
  assert.deepStrictEqual(h[0].aliases, ['b.example.com', 'c.example.com']);
  assert.strictEqual(h[0].proxies[0].port, 4000);
  assert.strictEqual(h[0].listen, 443);
});

test('systemctl show parsing', () => {
  const x = d.parseShow('Id=ifaima-blue.service\nNRestarts=3\nMainPID=86946\nMemoryCurrent=104857600\nActiveState=active\nSubState=running\n\nId=x.service\nNRestarts=0\nMemoryCurrent=[not set]\nActiveState=failed\n');
  assert.strictEqual(x['ifaima-blue.service'].restarts, 3);
  assert.strictEqual(x['ifaima-blue.service'].memory, 104857600);
  assert.strictEqual(x['x.service'].memory, null);
  assert.strictEqual(x['x.service'].active, 'failed');
});

test('review fixes: redirect vhosts stay with their own app; DB exposure; changed cron and bind address are noticed', () => {
  assert.ok(!byId['aotc-track'].domains.includes('pledges.pcg-aotc.com'), 'pledges :80 redirect is not AOTC');
  assert.ok(byId.pledge.domains.includes('pledges.pcg-aotc.com'));

  const s2 = JSON.parse(JSON.stringify(scan));
  s2.cron[0].hash = 'ffffffffffff';            // same redacted text, different real line
  const my = s2.ports.find((p) => p.port === 3306);
  my.addrs = ['0.0.0.0']; my.public = true;    // MySQL opened up
  const ch = d.diffInventories({ scan, units, sites, apps }, { scan: s2, units, sites, apps });
  assert.ok(ch.some((c) => c.kind === 'cron' && c.op === 'added'), 'cron change seen through redaction');
  assert.ok(ch.some((c) => c.kind === 'port' && c.key === '3306 on 0.0.0.0'));
  const f = d.findings({ scan: s2, apps });
  assert.ok(f.some((x) => x.severity === 'critical' && /MySQL listens on 0\.0\.0\.0:3306/.test(x.title)));
  assert.ok(f.some((x) => /app ports listen on all interfaces.*3001 Smart DeonTech/.test(x.title)), 'node apps bound to * are pointed out while ufw is inactive');
});

test('a crashed app stays itself: its site is matched to the stopped service, not made a new app', () => {
  // Smart DeonTech crashed (MODULE_NOT_FOUND): its unit is failed and nothing listens on 3001.
  const crashedUnits = units.map((u) => (u.unit === 'smart-deontech.service' ? { ...u, active: 'failed', sub: 'failed' } : u));
  const crashedScan = { ...scan, ports: scan.ports.filter((p) => p.port !== 3001) };
  const x = d.buildApps({ scan: crashedScan, units: crashedUnits, sites, live });
  const ids = x.map((a) => a.id);
  assert.ok(ids.includes('smart-deontech'), 'still the same app');
  assert.ok(!ids.includes('app'), 'no new app named after the site');
  const sdt = x.find((a) => a.id === 'smart-deontech');
  assert.strictEqual(sdt.name, 'Smart DeonTech');
  assert.strictEqual(sdt.checkPort, 3001);
  assert.ok(sdt.domains.includes('app.smartdeontech.com'));
  assert.deepStrictEqual(sdt.units.map((u) => u.unit), ['smart-deontech.service']);

  // Gina's Angel down too: its own name is in the leftmost part, so it isn't given to Smart DeonTech.
  const both = d.buildApps({ scan: { ...crashedScan, ports: crashedScan.ports.filter((p) => p.port !== 3100) }, units: crashedUnits.map((u) => (u.unit === 'ginasangel.service' ? { ...u, active: 'failed' } : u)), sites, live });
  assert.ok(both.find((a) => a.id === 'ginasangel').domains.includes('ginasangel.smartdeontech.com'));
  assert.ok(!both.find((a) => a.id === 'smart-deontech').domains.includes('ginasangel.smartdeontech.com'));
});

// ---- 0.1.14: blue/green right after a release, and PostgreSQL clusters ----
test('a line\'s port comes from its unit (Environment=PORT), so a release is followed at once', () => {
  const x = d.parseShow('Id=rondoq-green.service\nActiveState=active\nSubState=running\nEnvironment=NODE_ENV=production LINE=green PORT=4102\n\nId=rondoq-blue.service\nActiveState=inactive\nEnvironment=\n');
  assert.strictEqual(x['rondoq-green.service'].port, 4102);
  assert.strictEqual(x['rondoq-blue.service'].port, null);
});

const U = (unit, active, sub) => ({ unit, base: unit.replace(/\.service$/, ''), load: 'loaded', active, sub });
const pgUnits = [U('postgresql.service', 'active', 'exited'), U('postgresql@15-main.service', 'active', 'running'), U('postgresql@16-main.service', 'active', 'running')];
// The last root scan was taken mid-release: only blue was listening then.
const midScan = { ts: 1, ports: [
  { port: 4101, addr: '127.0.0.1', addrs: ['127.0.0.1'], unit: 'rondoq-blue.service' },
  { port: 5432, addr: '127.0.0.1', addrs: ['127.0.0.1'], unit: 'postgresql@15-main.service' },
  { port: 5433, addr: '127.0.0.1', addrs: ['127.0.0.1'], unit: 'postgresql@16-main.service' }] };

test('after a switch to green, green is checked, never the stopped blue line', () => {
  const units = [...pgUnits, U('rondoq-green.service', 'active', 'running')];
  const details = { 'rondoq-green.service': { active: 'active', port: 4102 } };
  const r = d.buildApps({ scan: midScan, units, details, sites: [], live: { rondoq: { value: 'green' } } }).find((a) => a.id === 'rondoq');
  assert.strictEqual(r.liveLine, 'green');
  assert.strictEqual(r.checkPort, 4102);
  // Without the unit's port, still not the idle line's.
  const r2 = d.buildApps({ scan: midScan, units, details: {}, sites: [], live: { rondoq: { value: 'green' } } }).find((a) => a.id === 'rondoq');
  assert.notStrictEqual(r2.checkPort, 4101);
});

test('PostgreSQL clusters and the wrapper unit are one database, checked on 5432', () => {
  const apps = d.buildApps({ scan: midScan, units: pgUnits, sites: [], live: {} });
  const dbs = apps.filter((a) => a.kind === 'database');
  assert.deepStrictEqual(dbs.map((a) => a.id), ['postgresql']);
  assert.strictEqual(dbs[0].name, 'PostgreSQL');
  assert.strictEqual(dbs[0].checkPort, 5432);
  assert.deepStrictEqual(dbs[0].ports, [5432, 5433]);
});

test('the old per-cluster cards going away is not "Gone app"', () => {
  const prev = { scan: midScan, units: pgUnits, sites: [], apps: [{ id: 'postgresql' }, { id: 'postgresql@15-main' }, { id: 'postgresql@16-main' }] };
  const next = { scan: midScan, units: pgUnits, sites: [], apps: [{ id: 'postgresql' }] };
  assert.deepStrictEqual(d.diffInventories(prev, next).filter((c) => c.kind === 'app'), []);
});
