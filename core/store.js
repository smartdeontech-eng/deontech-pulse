// Pulse's own tables, in the same SQLite file as the core's document store.
//
// Users, sign-ins and settings use the core's schemaless collections. Anything
// that grows with time — samples, events, alerts, access logs — gets a real
// table with an index on time, because "the last hour of CPU" over a JSON blob
// scan would be the slowest page in the app within a week.
'use strict';

const METRIC_COLS = ['cpu', 'cpu_max', 'mem', 'swap', 'disk', 'rx', 'tx', 'rd', 'wr', 'load1'];

// Retention per tier (milliseconds). 10 s for a day, 1 min for 30 days,
// 1 h for a year — the plan's numbers.
const TIERS = {
  m_10s: { step: 10_000, keep: 24 * 3600_000 },
  m_1m: { step: 60_000, keep: 30 * 24 * 3600_000 },
  m_1h: { step: 3600_000, keep: 366 * 24 * 3600_000 },
};

function init(db) {
  const cols = METRIC_COLS.map((c) => `${c} REAL`).join(', ');
  db.sql.exec(`
    ${Object.keys(TIERS).map((t) => `CREATE TABLE IF NOT EXISTS ${t} (ts INTEGER PRIMARY KEY, ${cols});`).join('\n')}

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,           -- deploy | access | inventory | alert | check | system
      severity TEXT NOT NULL DEFAULT 'info',   -- info | warning | critical
      app TEXT,
      title TEXT NOT NULL,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,            -- stable identity: rule + subject
      rule TEXT NOT NULL,
      severity TEXT NOT NULL,       -- warning | critical
      status TEXT NOT NULL,         -- open | acknowledged | snoozed | resolved
      title TEXT NOT NULL,
      detail TEXT,
      app TEXT,
      opened_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      ack_at INTEGER,
      snooze_until INTEGER,
      last_notified_at INTEGER,
      occurrences INTEGER NOT NULL DEFAULT 1,
      answer TEXT,                  -- 'yes' | 'no' for "Was this you?"
      access_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status);
    CREATE INDEX IF NOT EXISTS alerts_key ON alerts(key);

    CREATE TABLE IF NOT EXISTS access_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,           -- ssh_login | ssh_failed | sudo | user_added | user_changed | key_added | key_removed | dashboard_login
      user TEXT,
      ip TEXT,
      method TEXT,                  -- publickey | password | keyboard-interactive
      fingerprint TEXT,
      country TEXT,
      grade TEXT,                   -- quiet | release | digest | normal | urgent
      reason TEXT,
      source_id INTEGER,
      command TEXT,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS access_ts ON access_events(ts);

    CREATE TABLE IF NOT EXISTS trusted_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,           -- key | network
      label TEXT NOT NULL,
      value TEXT NOT NULL,          -- SHA256:... fingerprint, or an IP / CIDR
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      keys TEXT NOT NULL,
      user_id INTEGER,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_ok_at INTEGER,
      failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS check_results (
      app TEXT NOT NULL,
      ts INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      ms INTEGER,
      status INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS check_app_ts ON check_results(app, ts);

    CREATE TABLE IF NOT EXISTS deploys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      source TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS deploys_started ON deploys(started_at);

    CREATE TABLE IF NOT EXISTS app_versions (
      app TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      prev TEXT,
      changed_at INTEGER
    );
  `);
}

function addEvent(db, { ts = Date.now(), kind, severity = 'info', app = null, title, detail = null }) {
  const r = db.sql.run(
    'INSERT INTO events (ts, kind, severity, app, title, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ts, kind, severity, app, title, detail == null ? null : JSON.stringify(detail));
  return Number(r.lastInsertRowid);
}

function listEvents(db, { since = 0, limit = 200, kind } = {}) {
  const rows = kind
    ? db.sql.all('SELECT * FROM events WHERE ts >= ? AND kind = ? ORDER BY ts DESC LIMIT ?', since, kind, limit)
    : db.sql.all('SELECT * FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT ?', since, limit);
  return rows.map(parseDetail);
}

function parseDetail(r) {
  if (r && typeof r.detail === 'string') { try { r.detail = JSON.parse(r.detail); } catch { /* leave as text */ } }
  return r;
}

// Old rows go; a year of hourly samples is ~9k rows, a day of 10 s ones ~8.6k.
function prune(db, now = Date.now()) {
  for (const [t, { keep }] of Object.entries(TIERS)) db.sql.run(`DELETE FROM ${t} WHERE ts < ?`, now - keep);
  db.sql.run('DELETE FROM check_results WHERE ts < ?', now - 7 * 24 * 3600_000);
  db.sql.run('DELETE FROM events WHERE ts < ?', now - 366 * 24 * 3600_000);
  db.sql.run('DELETE FROM access_events WHERE ts < ?', now - 366 * 24 * 3600_000);
  db.sql.run("DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?", now - 180 * 24 * 3600_000);
  // Keep the last 200 inventories (8 days hourly) — enough to answer "when did that port appear?"
  db.sql.run('DELETE FROM inventory WHERE id NOT IN (SELECT id FROM inventory ORDER BY id DESC LIMIT 200)');
}

module.exports = { init, addEvent, listEvents, parseDetail, prune, METRIC_COLS, TIERS };
