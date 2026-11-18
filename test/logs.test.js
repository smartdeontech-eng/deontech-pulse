const test = require('node:test');
const assert = require('node:assert');
const { tmpDb } = require('./helpers');
const { createTraffic, parseAccessLine, judgeErrors, customLogMap } = require('../core/traffic');
const { createAppLogs, isErrorLine, mask } = require('../core/applogs');

test('access lines: vhost_combined and combined', () => {
  assert.deepStrictEqual(parseAccessLine('track.pcg-aotc.com:443 41.66.1.2 - - [09/Oct/2026:03:54:15 +0000] "GET /x HTTP/1.1" 502 341 "-" "UA"'), { vhost: 'track.pcg-aotc.com', status: 502, bytes: 341, method: 'GET', path: '/x' });
  assert.deepStrictEqual(parseAccessLine('41.66.1.2 - - [09/Oct/2026:03:54:15 +0000] "POST /y HTTP/2.0" 304 - "-" "UA"', 'monitor.smartdeontech.com'), { vhost: 'monitor.smartdeontech.com', status: 304, bytes: 0 });
  assert.strictEqual(parseAccessLine('garbage'), null);
  assert.deepStrictEqual(customLogMap([{ serverName: 'a.b', customLogs: ['${APACHE_LOG_DIR}/a.log'] }]), { '/var/log/apache2/a.log': 'a.b' });
});

test('per-minute buckets and the 5xx rule', () => {
  const { db } = tmpDb();
  const t = createTraffic({ db });
  const now = Date.UTC(2026, 9, 9, 12, 0, 30);
  for (let i = 0; i < 40; i++) t.add({ vhost: 'x.com', status: i < 4 ? 503 : 200, bytes: 10 }, now);
  t.flush(now);
  const [row] = t.series(['x.com'], now - 600_000, now);
  assert.deepStrictEqual([row.n, row.s5], [40, 4]);
  assert.strictEqual(judgeErrors({ n: 40, s5: 4 }), 'warning');
  assert.strictEqual(judgeErrors({ n: 40, s5: 12 }), 'critical');
  assert.strictEqual(judgeErrors({ n: 10, s5: 10 }), 'ok', 'too few requests to judge');
  assert.strictEqual(judgeErrors({ n: 100, s5: 1 }), 'clear');
});

test('app log errors: recognised, masked, rate-limited', () => {
  assert.ok(isErrorLine('Unhandled exception. System.Exception: boom'));
  assert.ok(isErrorLine('anything', 3));
  assert.ok(!isErrorLine('GET /api/members 200 12ms'));
  assert.ok(!isErrorLine('Migration finished with 0 errors'));
  assert.strictEqual(mask('connect failed password=hunter2 token: abc'), 'connect failed password=<redacted> token: <redacted>');
  assert.match(mask('Authorization: Bearer eyJhbGciOi.xx.yy'), /<redacted>/);
  const { db } = tmpDb();
  const seen = [];
  const l = createAppLogs({ db, onError: (e) => seen.push(e) });
  l._setUnits({ 'pledge.service': 'pledge' });
  const ts = Date.now();
  for (let i = 0; i < 50; i++) l.record({ ts, unit: 'pledge.service', message: `error ${i}` });
  l.record({ ts, unit: 'other.service', message: 'error elsewhere' });
  assert.strictEqual(l.count('pledge', 60_000), 30, 'capped at 30 per app per minute');
  assert.strictEqual(seen.length, 30);
  assert.deepStrictEqual(l.counts(60_000), { pledge: 30 });
});

test('traffic series can be summed into 5-minute steps', () => {
  const { db } = tmpDb();
  const t = createTraffic({ db });
  const now = Date.UTC(2026, 9, 9, 12, 7, 0);
  for (let i = 0; i < 10; i++) t.add({ vhost: 'x', status: 200 }, now - i * 60_000);
  t.flush(now);
  assert.deepStrictEqual(t.series(['x'], now - 3600_000, now, 300_000).map((r) => r.n), [2, 5, 3]);
});

test('flushing twice in one minute adds, never overwrites', () => {
  const { db } = tmpDb();
  const t = createTraffic({ db });
  const now = Date.UTC(2026, 9, 9, 12, 0, 10);
  t.add({ vhost: 'x', status: 200 }, now); t.add({ vhost: 'x', status: 500 }, now);
  t.flush(now);
  t.add({ vhost: 'x', status: 200 }, now + 5000);
  t.flush(now + 5000);
  // A restarted Pulse starts with empty buckets and adds on top.
  const t2 = createTraffic({ db });
  t2.add({ vhost: 'x', status: 200 }, now + 9000);
  t2.flush(now + 9000);
  const row = db.sql.get('SELECT n, s5 FROM traffic_1m');
  assert.deepStrictEqual([row.n, row.s5], [4, 1]);
});

test('replacing the journal follower leaves exactly one running', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakejc-'));
  const fake = path.join(dir, 'journalctl');
  fs.writeFileSync(fake, '#!/bin/sh\necho start >> ' + path.join(dir, 'spawns') + '\nexec sleep 30\n');
  fs.chmodSync(fake, 0o755);
  const { db } = tmpDb();
  const l = createAppLogs({ db, journalctl: fake, log: { error() {} } });
  l.follow([{ kind: 'app', id: 'a', units: [{ unit: 'a.service' }] }]);
  await new Promise((r) => setTimeout(r, 200));
  l.follow([{ kind: 'app', id: 'a', units: [{ unit: 'a.service' }] }, { kind: 'app', id: 'b', units: [{ unit: 'b.service' }] }]);
  await new Promise((r) => setTimeout(r, 400));
  const spawns = fs.readFileSync(path.join(dir, 'spawns'), 'utf8').trim().split('\n').length;
  l.stop();
  assert.strictEqual(spawns, 2, 'one per distinct unit set, no respawn of the replaced one');
});
