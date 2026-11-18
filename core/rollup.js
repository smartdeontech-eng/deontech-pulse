// Turning 2-second samples into stored history.
//
//   2 s samples  -> memory ring (live view, last 15 minutes)
//   10 s buckets -> m_10s, kept 24 h
//   1 min        -> m_1m,  kept 30 days   (built from m_10s)
//   1 h          -> m_1h,  kept 1 year    (built from m_1m)
//
// Averages are stored for every column, plus cpu_max — the peak inside the
// bucket — because a 1-hour average of 12% CPU hides the minute it hit 100%.
'use strict';
const { METRIC_COLS, TIERS } = require('./store');

const VALUE_COLS = METRIC_COLS.filter((c) => c !== 'cpu_max');

function bucketStart(ts, step) { return Math.floor(ts / step) * step; }

// Pure: average a list of samples into one row.
function aggregate(samples, ts) {
  if (!samples.length) return null;
  const row = { ts };
  for (const c of VALUE_COLS) {
    const vals = samples.map((s) => s[c]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    row[c] = vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  const peaks = samples.map((s) => (typeof s.cpu_max === 'number' ? s.cpu_max : s.cpu)).filter(Number.isFinite);
  row.cpu_max = peaks.length ? round(Math.max(...peaks)) : null;
  return row;
}

function round(v) { return Math.round(v * 100) / 100; }

function writeRow(db, table, row) {
  const cols = ['ts', ...METRIC_COLS];
  db.sql.run(
    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => (row[c] === undefined ? null : row[c])));
}

// Rebuild one coarser bucket from the finer table beneath it.
function rollFrom(db, fromTable, toTable, start, step) {
  const rows = db.sql.all(`SELECT * FROM ${fromTable} WHERE ts >= ? AND ts < ? ORDER BY ts`, start, start + step);
  const row = aggregate(rows, start);
  if (row) writeRow(db, toTable, row);
  return row;
}

// Stateful: feed it samples in time order; it writes whole buckets as they close.
function createRollup(db) {
  let pending = [];
  let current10 = null;
  let lastMinute = null;
  let lastHour = null;

  function add(sample) {
    const b = bucketStart(sample.ts, TIERS.m_10s.step);
    if (current10 !== null && b !== current10) flush();
    current10 = b;
    pending.push(sample);
  }

  function flush() {
    if (current10 === null || !pending.length) return;
    writeRow(db, 'm_10s', aggregate(pending, current10));
    const minute = bucketStart(current10, TIERS.m_1m.step);
    if (lastMinute !== null && minute !== lastMinute) {
      rollFrom(db, 'm_10s', 'm_1m', lastMinute, TIERS.m_1m.step);
      const hour = bucketStart(lastMinute, TIERS.m_1h.step);
      if (lastHour !== null && hour !== lastHour) rollFrom(db, 'm_1m', 'm_1h', lastHour, TIERS.m_1h.step);
      lastHour = hour;
    }
    lastMinute = minute;
    pending = [];
  }

  return { add, flush };
}

// Pick the tier that answers a time range with a sensible number of points.
function tierFor(rangeMs) {
  if (rangeMs <= 6 * 3600_000) return 'm_10s';
  if (rangeMs <= 7 * 24 * 3600_000) return 'm_1m';
  return 'm_1h';
}

function history(db, { from, to = Date.now() }) {
  const table = tierFor(to - from);
  return { tier: table, rows: db.sql.all(`SELECT * FROM ${table} WHERE ts >= ? AND ts <= ? ORDER BY ts`, from, to) };
}

module.exports = { aggregate, bucketStart, createRollup, rollFrom, tierFor, history, writeRow };
