const test = require('node:test');
const assert = require('node:assert');
const { tmpDb } = require('./helpers');
const r = require('../core/rollup');

test('aggregate averages each column and keeps the CPU peak', () => {
  const row = r.aggregate([{ cpu: 10, mem: 50, rx: 100 }, { cpu: 90, mem: 52, rx: null }, { cpu: 20, mem: 54, rx: 300 }], 1000);
  assert.strictEqual(row.cpu, 40);
  assert.strictEqual(row.cpu_max, 90);
  assert.strictEqual(row.mem, 52);
  assert.strictEqual(row.rx, 200, 'nulls are skipped, not counted as zero');
  assert.strictEqual(r.aggregate([], 0), null);
});

test('2 s samples become 10 s rows, 1 min rows and 1 h rows', () => {
  const { db } = tmpDb();
  const roll = r.createRollup(db);
  const start = Date.UTC(2026, 9, 9, 3, 0, 0);
  for (let t = start; t < start + 3600_000 + 120_000; t += 2000) roll.add({ ts: t, cpu: (t / 1000) % 60, mem: 40, disk: 21, swap: 75 });
  roll.flush();
  const n10 = db.sql.get('SELECT COUNT(*) n FROM m_10s').n;
  const n1m = db.sql.get('SELECT COUNT(*) n FROM m_1m').n;
  const n1h = db.sql.get('SELECT COUNT(*) n FROM m_1h').n;
  assert.ok(n10 >= 366 && n10 <= 372, `10 s rows: ${n10}`);
  assert.ok(n1m >= 61 && n1m <= 62, `1 min rows: ${n1m}`);
  assert.strictEqual(n1h, 1);
  const h = db.sql.get('SELECT * FROM m_1h');
  assert.strictEqual(h.ts, start);
  assert.strictEqual(h.mem, 40);
  assert.ok(h.cpu_max >= 58, 'the hour keeps the peak from inside it');
});

test('the range picks a tier with a sensible number of points', () => {
  assert.strictEqual(r.tierFor(3600_000), 'm_10s');
  assert.strictEqual(r.tierFor(24 * 3600_000), 'm_1m');
  assert.strictEqual(r.tierFor(30 * 86400_000), 'm_1h');
});

test('prune keeps each tier to its retention', () => {
  const { db } = tmpDb();
  const now = Date.now();
  r.writeRow(db, 'm_10s', { ts: now - 25 * 3600_000, cpu: 1 });
  r.writeRow(db, 'm_10s', { ts: now - 3600_000, cpu: 1 });
  r.writeRow(db, 'm_1m', { ts: now - 31 * 86400_000, cpu: 1 });
  require('../core/store').prune(db, now);
  assert.strictEqual(db.sql.get('SELECT COUNT(*) n FROM m_10s').n, 1);
  assert.strictEqual(db.sql.get('SELECT COUNT(*) n FROM m_1m').n, 0);
});

test('disk forecast: a steady climb gives a date; noise and flat lines do not', () => {
  const { diskForecast } = require('../core/forecast');
  const now = Date.UTC(2026, 9, 9);
  const climb = Array.from({ length: 168 }, (_, i) => ({ ts: now - (167 - i) * 3600_000, disk: 60 + (i / 24) * 1.0 + (i % 5) * 0.05 }));
  const f = diskForecast(climb, now);
  assert.ok(f && f.daysLeft >= 31 && f.daysLeft <= 35, JSON.stringify(f));
  assert.strictEqual(f.perDay, 1);
  const flat = climb.map((r, i) => ({ ...r, disk: 21 + (i % 2) * 0.1 }));
  assert.strictEqual(diskForecast(flat, now), null);
  assert.strictEqual(diskForecast(climb.slice(0, 10), now), null, 'needs two days of history');
});
