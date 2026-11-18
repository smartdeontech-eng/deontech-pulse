// Who is signed in to the other apps on this server.
//
// Each app built on the Smart DeonTech core sends Pulse two things, through a
// small drop-in file (connectors/pulse-reporter.js):
//   - every sign-in attempt, as its login log already records it;
//   - once a minute, the accounts that used the app in that minute.
// "Signed in now" therefore means "used the app in the last 15 minutes" — the
// apps use stateless sessions and keep no list of open ones.
//
// Pulse keeps names, emails, role, IP, country and a device label. Never a
// password, a token, a URL or anything from the app's own data. Sign-ins are
// kept 90 days.
//
// Each app proves who it is with its own token, derived from Pulse's hook
// token: HMAC-SHA256(PULSE_HOOK_TOKEN, "app:<id>"). One app cannot speak for
// another, and Pulse stores no per-app secrets.
'use strict';
const crypto = require('crypto');
const { addEvent } = require('./store');

const ONLINE_MS = 15 * 60_000;
const KEEP_MS = 90 * 86400_000;
const STEP_REASONS = /^(awaiting-|must-change|ok)/;          // not a failure: a step on the way in
const PRIVILEGED = new Set(['admin', 'localadmin', 'owner', 'manager', 'superadmin']);

function appToken(hookToken, app) {
  return crypto.createHmac('sha256', String(hookToken)).update(`app:${app}`).digest('hex');
}

function verifyAppToken(hookToken, app, got) {
  if (!hookToken || String(hookToken).length < 24 || !/^[a-z0-9][a-z0-9._-]{0,59}$/.test(String(app || ''))) return false;
  const a = Buffer.from(String(got || '')), b = Buffer.from(appToken(hookToken, app));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function deviceLabel(ua = '') {
  const s = String(ua);
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : '';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : /curl|python|node|okhttp/i.test(s) ? 'script' : '';
  return [br, os].filter(Boolean).join(' on ') || (s ? 'Other' : 'Unknown');
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

function init(db) {
  db.sql.exec(`
    CREATE TABLE IF NOT EXISTS app_signins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      app TEXT NOT NULL,
      user_id TEXT,
      email TEXT,
      name TEXT,
      role TEXT,
      ok INTEGER NOT NULL,
      reason TEXT,
      ip TEXT,
      country TEXT,
      device TEXT
    );
    CREATE INDEX IF NOT EXISTS app_signins_ts ON app_signins(ts);
    CREATE INDEX IF NOT EXISTS app_signins_app_ts ON app_signins(app, ts);
    CREATE TABLE IF NOT EXISTS app_presence (
      app TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT, name TEXT, role TEXT,
      first_seen INTEGER, last_seen INTEGER NOT NULL,
      ip TEXT, country TEXT, device TEXT,
      PRIMARY KEY (app, user_id)
    );
    CREATE TABLE IF NOT EXISTS app_reporters (
      app TEXT PRIMARY KEY,
      last_seen INTEGER NOT NULL,
      version TEXT,
      reports INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function createAppSignins({ db, geoip, alerts, getSettings, appName = (id) => id, now = () => Date.now() }) {
  init(db);

  // ---- intake ----
  function ingest(app, body = {}) {
    const t = now();
    const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    const presence = Array.isArray(body.presence) ? body.presence.slice(0, 2000) : [];
    let n = 0;
    for (const e of events) {
      const reason = clip(e.reason, 40) || (e.success ? 'ok' : 'failed');
      const ok = !!e.success;
      if (!ok && STEP_REASONS.test(reason)) continue;          // "awaiting-2fa" etc: not an outcome
      const ts = clampTs(e.ts, t);
      const ip = clip(e.ip, 64);
      const country = ip ? geoip.country(ip) : null;
      const row = { ts, app, user_id: e.userId == null ? null : clip(e.userId, 40), email: clip(e.email, 120), name: clip(e.name, 80), role: clip(e.role, 30), ok: ok ? 1 : 0, reason, ip, country, device: deviceLabel(e.ua || e.userAgent) };
      db.sql.run('INSERT INTO app_signins (ts, app, user_id, email, name, role, ok, reason, ip, country, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        row.ts, row.app, row.user_id, row.email, row.name, row.role, row.ok, row.reason, row.ip, row.country, row.device);
      n++;
      if (ok) {
        touch(app, { userId: row.user_id, email: row.email, name: row.name, role: row.role, lastSeen: ts, ip, ua: e.ua || e.userAgent });
        judgeSuccess(row);
      } else judgeFailure(row);
    }
    for (const p of presence) touch(app, p, t);
    db.sql.run(`INSERT INTO app_reporters (app, last_seen, version, reports) VALUES (?, ?, ?, 1)
      ON CONFLICT(app) DO UPDATE SET last_seen = excluded.last_seen, version = excluded.version, reports = reports + 1`, app, t, clip(body.v, 20));
    return { events: n, presence: presence.length };
  }

  function clampTs(ts, t) { const x = Number(ts); return Number.isFinite(x) && x > t - 86400_000 && x <= t + 60_000 ? Math.round(x) : t; }

  function touch(app, p, t = now()) {
    if (!p || p.userId == null) return;
    const ts = clampTs(p.lastSeen, t);
    const ip = clip(p.ip, 64);
    db.sql.run(`INSERT INTO app_presence (app, user_id, email, name, role, first_seen, last_seen, ip, country, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(app, user_id) DO UPDATE SET
        email = COALESCE(excluded.email, email), name = COALESCE(excluded.name, name), role = COALESCE(excluded.role, role),
        first_seen = CASE WHEN last_seen < ? THEN excluded.first_seen ELSE first_seen END,
        last_seen = MAX(last_seen, excluded.last_seen),
        ip = COALESCE(excluded.ip, ip), country = COALESCE(excluded.country, country), device = COALESCE(excluded.device, device)`,
      app, clip(p.userId, 40), clip(p.email, 120), clip(p.name, 80), clip(p.role, 30), ts, ts, ip, ip ? geoip.country(ip) : null, p.ua || p.userAgent ? deviceLabel(p.ua || p.userAgent) : null,
      ts - ONLINE_MS);
  }

  // ---- alerts ----
  // Password guessing against one account, or one address trying many.
  function judgeFailure(row) {
    const since = row.ts - 15 * 60_000;
    if (row.email) {
      const n = db.sql.get('SELECT COUNT(*) n FROM app_signins WHERE app = ? AND email = ? AND ok = 0 AND ts >= ?', row.app, row.email, since).n;
      if (n >= 10) alerts.raise({ key: `app-guess:${row.app}:${row.email}`, rule: 'app-signin', severity: 'warning', app: row.app,
        title: `${appName(row.app)}: ${n} failed sign-ins for ${row.email} in 15 min`, detail: { summary: `Latest from ${row.ip || 'unknown IP'}${row.country && row.country !== 'LAN' ? ` (${row.country})` : ''}. The app locks the account after repeated failures.` } });
    }
    if (row.ip) {
      const r = db.sql.get('SELECT COUNT(*) n, COUNT(DISTINCT email) e FROM app_signins WHERE ip = ? AND ok = 0 AND ts >= ?', row.ip, since);
      if (r.n >= 20 || r.e >= 5) alerts.raise({ key: `app-spray:${row.ip}`, rule: 'app-signin', severity: 'warning',
        title: `${r.n} failed app sign-ins from ${row.ip}${row.country && row.country !== 'LAN' ? ` (${row.country})` : ''} in 15 min`, detail: { summary: `${r.e} different account${r.e === 1 ? '' : 's'} tried. Consider: sudo fail2ban-client set sshd banip ${row.ip}` } });
    }
  }

  // An admin of an app signing in from a country you don't usually work from.
  function judgeSuccess(row) {
    if (!row.role || !PRIVILEGED.has(String(row.role).toLowerCase())) return;
    const usual = (getSettings().usualCountries || ['GH', 'CA']).map((c) => c.toUpperCase());
    if (!row.country || row.country === 'LAN' || usual.includes(row.country)) return;
    const seen = db.sql.get('SELECT COUNT(*) n FROM app_signins WHERE app = ? AND email = ? AND ok = 1 AND country = ? AND ts < ? AND ts > ?', row.app, row.email, row.country, row.ts, row.ts - 30 * 86400_000).n;
    if (seen) return;
    alerts.raise({ key: `app-country:${row.app}:${row.email}:${row.country}`, rule: 'app-signin', severity: 'warning', app: row.app,
      title: `${appName(row.app)}: ${row.role} ${row.email} signed in from ${row.country}`, detail: { summary: `First sign-in from ${row.country} in 30 days · ${row.ip} · ${row.device}` } });
  }

  // ---- reading ----
  function online(t = now()) {
    return db.sql.all('SELECT * FROM app_presence WHERE last_seen >= ? ORDER BY last_seen DESC', t - ONLINE_MS);
  }
  function recent({ since, app = null, failedOnly = false, q = '', limit = 300 } = {}) {
    const where = ['ts >= ?']; const args = [since];
    if (app) { where.push('app = ?'); args.push(app); }
    if (failedOnly) where.push('ok = 0');
    if (q) { where.push('(email LIKE ? OR name LIKE ? OR ip LIKE ?)'); const like = `%${String(q).slice(0, 60)}%`; args.push(like, like, like); }
    return db.sql.all(`SELECT * FROM app_signins WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`, ...args, Math.min(1000, limit));
  }
  function summary(since, t = now()) {
    const per = db.sql.all('SELECT app, SUM(ok) ok, SUM(1 - ok) failed, COUNT(DISTINCT CASE WHEN ok = 1 THEN email END) people FROM app_signins WHERE ts >= ? GROUP BY app', since);
    const on = db.sql.all('SELECT app, COUNT(*) n FROM app_presence WHERE last_seen >= ? GROUP BY app', t - ONLINE_MS);
    const rep = db.sql.all('SELECT * FROM app_reporters');
    return { per, online: on, reporters: rep };
  }
  function prune(t = now()) {
    db.sql.run('DELETE FROM app_signins WHERE ts < ?', t - KEEP_MS);
    db.sql.run('DELETE FROM app_presence WHERE last_seen < ?', t - KEEP_MS);
  }
  return { ingest, online, recent, summary, prune, touch, ONLINE_MS };
}

module.exports = { createAppSignins, appToken, verifyAppToken, deviceLabel, PRIVILEGED };
