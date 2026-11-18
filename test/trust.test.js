const test = require('node:test');
const assert = require('node:assert');
const t = require('../core/trust');

const MAC = 'SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk';
const sources = [
  { id: 1, kind: 'key', label: 'MacBook (deploy key)', value: MAC },
  { id: 2, kind: 'network', label: 'Home Wi-Fi', value: '173.177.203.0/24' },
  { id: 3, kind: 'network', label: 'Hotel', value: '81.2.3.0/24', expires_at: Date.now() - 1000 },
  { id: 4, kind: 'network', label: 'Phone hotspot', value: '2607:fea8:1d00::/40' },
];
const login = (o) => ({ kind: 'ssh_login', user: 'deploy', method: 'publickey', fingerprint: MAC, ip: '173.177.203.145', ...o });
const ctx = (o) => ({ sources, usualCountries: ['GH', 'CA'], ...o });

test('the grading table from the plan', () => {
  assert.strictEqual(t.grade(login(), ctx()).grade, 'quiet', 'trusted key + trusted network');
  assert.strictEqual(t.grade(login({ ip: '2607:fea8:1d00:5a00::1' }), ctx()).grade, 'quiet', 'IPv6 range');
  assert.strictEqual(t.grade(login({ ip: '9.9.9.9' }), ctx({ inDeploy: true })).grade, 'release');
  assert.strictEqual(t.grade(login({ ip: '41.66.1.1' }), ctx({ country: 'GH' })).grade, 'digest', 'new network, usual country');
  assert.strictEqual(t.grade(login({ ip: '41.66.1.1' }), ctx({ country: 'FR' })).grade, 'normal', 'new country');
  assert.strictEqual(t.grade(login({ fingerprint: 'SHA256:other' }), ctx()).grade, 'urgent', 'unknown key');
  assert.strictEqual(t.grade(login({ method: 'password', fingerprint: null }), ctx()).grade, 'urgent', 'password');
  assert.strictEqual(t.grade(login({ user: 'root' }), ctx()).grade, 'urgent', 'root is always urgent');
  assert.strictEqual(t.grade(login({ user: 'root' }), ctx({ inDeploy: true })).grade, 'urgent', 'even during a deploy');
});

test('expired sources are ignored', () => {
  assert.strictEqual(t.grade(login({ ip: '81.2.3.4' }), ctx({ country: 'GB' })).grade, 'normal');
});

test('sudo follows the session it came from', () => {
  const quiet = { ts: Date.now(), grade: 'quiet' };
  assert.strictEqual(t.grade({ kind: 'sudo', user: 'deploy', command: '/usr/bin/journalctl -u x' }, ctx({ recentLogin: quiet })).grade, 'quiet');
  assert.strictEqual(t.grade({ kind: 'sudo', user: 'deploy', command: '/usr/bin/systemctl restart ifaima-blue' }, ctx({ recentLogin: quiet })).grade, 'release');
  assert.strictEqual(t.grade({ kind: 'sudo', user: 'deploy', command: '/usr/sbin/useradd bob' }, ctx({ recentLogin: quiet })).grade, 'normal', 'sensitive commands always alert');
  assert.strictEqual(t.grade({ kind: 'sudo', user: 'www-data', command: '/bin/sh' }, ctx()).grade, 'urgent', 'sudo with no SSH login behind it');
  assert.strictEqual(t.grade({ kind: 'sudo', user: 'deploy', command: '/bin/ls' }, ctx({ recentLogin: { grade: 'urgent' } })).grade, 'urgent');
});

test('new ways in are urgent', () => {
  for (const k of ['user_added', 'key_added', 'sudoer_added']) assert.strictEqual(t.grade({ kind: k, user: 'bob' }, ctx()).grade, 'urgent');
});

test('CIDR maths, both families', () => {
  assert.ok(t.cidrContains('10.0.0.0/8', '10.255.1.2'));
  assert.ok(!t.cidrContains('10.0.0.0/8', '11.0.0.1'));
  assert.ok(t.cidrContains('173.177.203.145/32', '173.177.203.145'));
  assert.ok(t.cidrContains('2001:db8::/32', '2001:db8:ffff::1'));
  assert.ok(!t.cidrContains('2001:db8::/32', '2001:db9::1'));
  assert.ok(!t.cidrContains('10.0.0.0/8', '2001:db8::1'), 'families never match');
  assert.ok(t.cidrContains('192.168.1.0/24', '::ffff:192.168.1.9'), 'v4-mapped v6');
  assert.strictEqual(t.parseCidr('300.1.1.1'), null);
  assert.strictEqual(t.parseCidr('1.2.3.4/33'), null);
});

test('networkOf picks /24 and /56 and prints them back', () => {
  assert.strictEqual(t.networkOf('173.177.203.145'), '173.177.203.0/24');
  const v6 = t.networkOf('2607:fea8:1d00:5a00::1');
  assert.ok(t.cidrContains(v6, '2607:fea8:1d00:5aff::9'));
  assert.ok(!t.cidrContains(v6, '2607:fea8:1d00:5b00::1'));
  assert.ok(t.parseCidr(v6), `printed form parses back: ${v6}`);
});

test('failed-login bursts fire once per burst', () => {
  const hit = t.createBurstCounter({ threshold: 5, windowMs: 60_000 });
  const now = Date.now();
  const fired = Array.from({ length: 12 }, (_, i) => hit('1.2.3.4', now + i * 1000).burst).filter(Boolean);
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(hit('5.6.7.8', now).burst, false);
});

test('GeoIP: CSV lookup, then the packed cache gives the same answers', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'));
  const f = path.join(dir, 'c.csv');
  fs.writeFileSync(f, '41.66.0.0,41.66.255.255,GH\n173.177.0.0,173.177.255.255,CA\n2607:fea8::,2607:fea8:ffff:ffff:ffff:ffff:ffff:ffff,CA\n');
  const load = async () => { delete require.cache[require.resolve('../core/geoip')]; const g = require('../core/geoip'); const r = await g.load(f); return { g, r }; };
  const a = await load();
  assert.ok(!a.r.cached);
  const b = await load();
  assert.strictEqual(b.r.cached, true);
  for (const { g } of [a, b]) {
    assert.strictEqual(g.country('41.66.3.4'), 'GH');
    assert.strictEqual(g.country('2607:fea8:1d00:5a00::1'), 'CA');
    assert.strictEqual(g.country('8.8.8.8'), null);
    assert.strictEqual(g.country('192.168.1.5'), 'LAN');
  }
});
