// Phase 2: app errors from the journal.
//
// Follows the journal for the discovered apps' own units only. A line counts
// as an error when journald says so (priority err or worse) or when it reads
// like one — Node and .NET apps print errors to stderr at the default level,
// so priority alone would miss almost everything.
//
// Kept 7 days, at most 30 lines per app per minute (a crash loop must not
// fill the disk). Message text is cut to 300 characters and obvious secrets
// (password=, token=, Bearer …) are masked before storing.
//
// Since 0.1.6 each error is also assembled into an OCCURRENCE: the error line,
// the stack-trace lines after it, the 20 lines before it and up to 20 after,
// all masked. Occurrences of the same fault (core/errgroups.js signature) form
// one GROUP with a count, first/last seen, an hourly trend and a status
// (open / known / fixed). At most 12 occurrences per group per hour are kept
// in full; the count is always exact.
'use strict';
const { analyse } = require('./errgroups');
const { spawn } = require('child_process');
const readline = require('readline');

const ERROR_RE = /\b(error|exception|unhandled|uncaught|fatal|traceback|panic|segfault|ECONNREFUSED|ECONNRESET|EADDRINUSE|ENOSPC|EACCES|out of memory|SQLITE_BUSY|database is locked|stack overflow)\b|^\s*(fail|crit):/i;
// Lines that continue an error block: stack frames, inner exceptions, .NET's indented logger text.
const CONTINUATION_RE = /^\s+at\s|^\s*---\s*(>|End of)|^\s*(Caused by|Inner exception|\[?CallStack)|^\s{2,}\S|^\s*(System|Microsoft)\.[\w.]+(Exception|Error)\b|^\s*\{?\s*\[?(code|errno|syscall|address|port|sqlMessage|sql)\]?\s*[:=]/;
const NOT_ERROR_RE = /\b(0 errors?|no errors?|errors?: 0|error_log|errorHandler registered)\b/i;

function isErrorLine(msg, priority) {
  if (priority != null && Number(priority) <= 3) return true;
  return ERROR_RE.test(msg) && !NOT_ERROR_RE.test(msg);
}

function mask(msg, max = 300) {
  return String(msg)
    .replace(/((?:pass(?:word)?|pwd|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, '$1<redacted>')
    .replace(/(:\/\/[^/:@\s]+:)[^@\s]+@/g, '$1<redacted>@')
    // Visitors' details are not ours to keep: addresses and emails go.
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .slice(0, max);
}

function createAppLogs({ db, onError = () => {}, onGroup = () => {}, journalctl = 'journalctl', log = console, now: clock = () => Date.now() } = {}) {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS app_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, app TEXT NOT NULL, unit TEXT, message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS app_errors_app_ts ON app_errors(app, ts);
    CREATE TABLE IF NOT EXISTS error_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT NOT NULL, sig TEXT NOT NULL,
      title TEXT NOT NULL, type TEXT, message TEXT, frame TEXT, frame_is_app INTEGER,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, total INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open', status_at INTEGER, status_by TEXT, note TEXT,
      UNIQUE (app, sig));
    CREATE TABLE IF NOT EXISTS error_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, ts INTEGER NOT NULL, app TEXT NOT NULL, unit TEXT,
      block TEXT NOT NULL, before TEXT, after TEXT);
    CREATE INDEX IF NOT EXISTS error_events_group_ts ON error_events(group_id, ts);
    CREATE TABLE IF NOT EXISTS error_hits (group_id INTEGER NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (group_id, hour));`);

  // ---- occurrence assembly, per unit ----
  const ring = new Map();      // unit -> last 20 masked lines {ts, text}
  const pending = new Map();   // unit -> { app, unit, ts, lastTs, block: [], before: [], after: [], inBlock }
  const BEFORE = 20, AFTER = 20, BLOCK_MAX = 80;

  function pushRing(unit, ts, text) {
    let r = ring.get(unit);
    if (!r) { r = []; ring.set(unit, r); }
    r.push({ ts, text });
    if (r.length > BEFORE) r.shift();
  }

  // Every line from an app unit goes through here (errors or not).
  function line({ ts = clock(), unit, message, priority }) {
    const app = unitToApp[unit];
    if (!app || message == null) return;
    for (const raw of String(message).split('\n')) {
      if (!raw.trim()) continue;
      const text = mask(raw, 500);
      const p = pending.get(unit);
      const isErr = isErrorLine(raw, priority);
      if (p && p.inBlock && p.block.length < BLOCK_MAX && ts - p.lastTs < 2000 && (CONTINUATION_RE.test(raw) || (isErr && ts - p.lastTs < 500))) {
        p.block.push(text); p.lastTs = ts;
      } else if (p && isErr && !CONTINUATION_RE.test(raw)) {
        finalize(unit);
        start(app, unit, ts, text);
      } else if (p) {
        p.inBlock = false;
        if (p.after.length < AFTER) p.after.push({ ts, text });
        p.lastTs = Math.max(p.lastTs, ts);
      } else if (isErr) {
        start(app, unit, ts, text);
      }
      if (isErr) record({ ts, unit, message: raw, priority });
      pushRing(unit, ts, text);
    }
  }

  function start(app, unit, ts, text) {
    pending.set(unit, { app, unit, ts, lastTs: ts, block: [text], before: (ring.get(unit) || []).slice(), after: [], inBlock: true });
  }

  // Close occurrences that have had their say: quiet for 3 s, 20 lines after, or 15 s old.
  function flushPending(t = clock(), force = false) {
    for (const [unit, p] of pending) {
      if (force || t - p.lastTs >= 3000 || p.after.length >= AFTER || t - p.ts >= 15_000) finalize(unit);
    }
  }

  function finalize(unit) {
    const p = pending.get(unit);
    if (!p) return null;
    pending.delete(unit);
    const a = analyse(p.app, p.block);
    const hour = Math.floor(p.ts / 3600_000) * 3600_000;
    let g = db.sql.get('SELECT * FROM error_groups WHERE app = ? AND sig = ?', p.app, a.sig);
    const isNew = !g;
    const wasFixed = g && g.status === 'fixed';
    if (isNew) {
      const r = db.sql.run('INSERT INTO error_groups (app, sig, title, type, message, frame, frame_is_app, first_seen, last_seen, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
        p.app, a.sig, a.title, a.type, a.message, a.frame, a.frameIsApp ? 1 : 0, p.ts, p.ts);
      g = { id: Number(r.lastInsertRowid) };
    } else {
      db.sql.run(`UPDATE error_groups SET last_seen = MAX(last_seen, ?), total = total + 1, message = ?,
        status = CASE WHEN status = 'fixed' THEN 'open' ELSE status END,
        status_at = CASE WHEN status = 'fixed' THEN ? ELSE status_at END,
        status_by = CASE WHEN status = 'fixed' THEN 'came back' ELSE status_by END WHERE id = ?`, p.ts, a.message, p.ts, g.id);
    }
    db.sql.run('INSERT INTO error_hits (group_id, hour, n) VALUES (?, ?, 1) ON CONFLICT(group_id, hour) DO UPDATE SET n = n + 1', g.id, hour);
    const keptThisHour = db.sql.get('SELECT COUNT(*) n FROM error_events WHERE group_id = ? AND ts >= ?', g.id, p.ts - 3600_000).n;
    if (keptThisHour < 12) {
      db.sql.run('INSERT INTO error_events (group_id, ts, app, unit, block, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)',
        g.id, p.ts, p.app, p.unit, p.block.join('\n').slice(0, 16_000), JSON.stringify(p.before), JSON.stringify(p.after));
    }
    const row = db.sql.get('SELECT * FROM error_groups WHERE id = ?', g.id);
    try { onGroup({ group: row, isNew, reopened: wasFixed, ts: p.ts }); } catch (e) { log.error('[applogs]', e.message); }
    return row;
  }

  const flushTimer = setInterval(() => { try { flushPending(); } catch (e) { log.error('[applogs]', e.message); } }, 2000);
  flushTimer.unref?.();

  let child = null;
  let unitsKey = '';
  let unitToApp = {};
  let stopped = false;
  const perMinute = new Map();   // `${app}|${minute}` -> n

  function record({ ts = Date.now(), unit, message, priority }) {
    const app = unitToApp[unit];
    if (!app || !message || !isErrorLine(message, priority)) return false;
    const k = `${app}|${Math.floor(ts / 60_000)}`;
    const n = (perMinute.get(k) || 0) + 1;
    perMinute.set(k, n);
    if (perMinute.size > 2000) perMinute.clear();
    if (n > 30) return false;
    db.sql.run('INSERT INTO app_errors (ts, app, unit, message) VALUES (?, ?, ?, ?)', ts, app, unit, mask(message));
    onError({ app, unit, ts });
    return true;
  }

  // (Re)start the follower whenever the set of app units changes.
  let latestApps = [];
  function follow(apps) {
    latestApps = apps;
    const map = {};
    for (const a of apps) if (a.kind === 'app') for (const u of a.units || []) map[u.unit] = a.id;
    const key = Object.keys(map).sort().join(',');
    unitToApp = map;
    if (key === unitsKey && child) return;
    unitsKey = key;
    if (child) { const old = child; child = null; old.kill(); }
    if (!key) return;
    stopped = false;
    const args = ['-f', '-o', 'json', '-n', '0', '--no-pager', ...Object.keys(map).flatMap((u) => ['-u', u])];
    const me = spawn(journalctl, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    child = me;
    readline.createInterface({ input: me.stdout }).on('line', (l) => {
      if (me !== child) return;   // a follower being replaced
      let j;
      try { j = JSON.parse(l); } catch { return; }
      const message = Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString('utf8') : j.MESSAGE;
      try { line({ ts: Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000) || Date.now(), unit: j._SYSTEMD_UNIT, message, priority: j.PRIORITY }); } catch (e) { log.error('[applogs]', e.message); }
    });
    me.on('error', (e) => log.error('[applogs]', e.message));
    // Only the CURRENT follower may trigger a restart; a replaced one just goes.
    me.on('exit', () => {
      if (me !== child || stopped) return;
      child = null;
      unitsKey = '';
      setTimeout(() => { if (!stopped && !child) follow(latestApps); }, 15_000);
    });
  }

  function stop() { stopped = true; clearInterval(flushTimer); try { flushPending(clock(), true); } catch { /* */ } if (child) { const c = child; child = null; c.kill(); } }
  function prune(now = Date.now()) {
    db.sql.run('DELETE FROM app_errors WHERE ts < ?', now - 7 * 86400_000);
    db.sql.run('DELETE FROM error_events WHERE ts < ?', now - 7 * 86400_000);
    db.sql.run('DELETE FROM error_hits WHERE hour < ?', now - 30 * 86400_000);
    // A group is remembered 90 days after it was last seen, so "known" and "fixed" stick.
    db.sql.run('DELETE FROM error_groups WHERE last_seen < ?', now - 90 * 86400_000);
  }

  // ---- reading ----
  function groups({ app = null, status = null, since = 0 } = {}) {
    const where = ['last_seen >= ?']; const args = [since];
    if (app) { where.push('app = ?'); args.push(app); }
    if (status) { where.push('status = ?'); args.push(status); }
    const rows = db.sql.all(`SELECT * FROM error_groups WHERE ${where.join(' AND ')} ORDER BY last_seen DESC LIMIT 300`, ...args);
    const t = clock();
    const from = Math.floor(t / 3600_000) * 3600_000 - 23 * 3600_000;
    for (const g of rows) {
      const hits = db.sql.all('SELECT hour, n FROM error_hits WHERE group_id = ? AND hour >= ?', g.id, from);
      g.trend = Array.from({ length: 24 }, (_, i) => (hits.find((h) => h.hour === from + i * 3600_000) || {}).n || 0);
      g.last24h = g.trend.reduce((x, y) => x + y, 0);
    }
    return rows;
  }
  function group(id) {
    const g = db.sql.get('SELECT * FROM error_groups WHERE id = ?', id);
    if (!g) return null;
    const t = clock();
    const from = Math.floor(t / 3600_000) * 3600_000 - 23 * 3600_000;
    const hits = db.sql.all('SELECT hour, n FROM error_hits WHERE group_id = ? AND hour >= ?', g.id, from);
    g.trend = Array.from({ length: 24 }, (_, i) => (hits.find((h) => h.hour === from + i * 3600_000) || {}).n || 0);
    g.last24h = g.trend.reduce((x, y) => x + y, 0);
    g.events = db.sql.all('SELECT * FROM error_events WHERE group_id = ? ORDER BY ts DESC LIMIT 30', g.id).map((e) => ({
      ...e, before: safeJson(e.before), after: safeJson(e.after),
    }));
    return g;
  }
  function setStatus(id, status, by, note = null) {
    if (!['open', 'known', 'fixed'].includes(status)) return null;
    db.sql.run('UPDATE error_groups SET status = ?, status_at = ?, status_by = ?, note = COALESCE(?, note) WHERE id = ?', status, clock(), by, note, id);
    return db.sql.get('SELECT * FROM error_groups WHERE id = ?', id);
  }
  function hitsSince(id, sinceMs) {
    return db.sql.get('SELECT COUNT(*) n FROM error_events WHERE group_id = ? AND ts >= ?', id, clock() - sinceMs).n;
  }
  function count(app, sinceMs) { return db.sql.get('SELECT COUNT(*) n FROM app_errors WHERE app = ? AND ts >= ?', app, Date.now() - sinceMs).n; }
  function counts(sinceMs) { return Object.fromEntries(db.sql.all('SELECT app, COUNT(*) n FROM app_errors WHERE ts >= ? GROUP BY app', Date.now() - sinceMs).map((r) => [r.app, r.n])); }
  function recent(app, limit = 30) { return db.sql.all('SELECT ts, unit, message FROM app_errors WHERE app = ? ORDER BY ts DESC LIMIT ?', app, limit); }

  return { follow, stop, record, line, flushPending, finalize, prune, count, counts, recent, groups, group, setStatus, hitsSince, _setUnits: (m) => { unitToApp = m; } };
}

function safeJson(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

module.exports = { createAppLogs, isErrorLine, mask };
