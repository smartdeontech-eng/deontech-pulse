// The alert engine.
//
// Every problem has a stable KEY (rule + subject, e.g. "health:ifaima" or
// "disk:/"). Raising the same key again updates the open alert instead of
// opening a second one, and only re-notifies after the cool-down. When the
// condition clears, resolve(key) closes it and sends one "resolved" message.
//
//   open ─┬─> acknowledged ──┐
//         ├─> snoozed ───────┼─> resolved
//         └──────────────────┘
//
// Quiet hours hold back warnings (they appear in the app and the digest);
// urgent alerts always go out. Maintenance mode holds service and health
// alerts; access alerts are never held, because "someone logged in while I
// said I was doing maintenance" is exactly when you want to know.
'use strict';
const { addEvent, parseDetail } = require('./store');
const bus = require('./bus');

const COOLDOWN = { critical: 30 * 60_000, warning: 6 * 3600_000 };
const HELD_IN_MAINTENANCE = new Set(['health', 'service', 'cpu', 'memory', 'restarts', 'backup', 'line']);

function inQuietHours(qh, now = Date.now(), tz = 'Africa/Accra') {
  if (!qh || !qh.enabled) return false;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const t = toMin(hm), a = toMin(qh.start), b = toMin(qh.end);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

function createAlerts({ db, channels, getSettings, now = () => Date.now(), log = console }) {
  const get = (id) => parseDetail(db.sql.get('SELECT * FROM alerts WHERE id = ?', id)) || null;
  const activeByKey = (key) => parseDetail(db.sql.get("SELECT * FROM alerts WHERE key = ? AND status != 'resolved' ORDER BY id DESC LIMIT 1", key)) || null;

  function inMaintenance() {
    const s = getSettings();
    return !!(s.maintenanceUntil && Date.parse(s.maintenanceUntil) > now());
  }

  function notify(alert, opts) {
    if (!channels) return;
    Promise.resolve(channels.deliver(alert, opts)).catch((e) => log.error('[alerts] deliver', e.message));
  }

  /**
   * @returns the alert row, or null if held (maintenance)
   */
  function raise({ key, rule, severity = 'warning', title, detail = null, app = null, accessId = null, forceNotify = false }) {
    const t = now();
    const s = getSettings();
    if (HELD_IN_MAINTENANCE.has(rule) && inMaintenance()) return null;
    const quiet = severity !== 'critical' && inQuietHours(s.quietHours, t, (s.timezones || [])[0]);
    const detailText = detail == null ? null : JSON.stringify(typeof detail === 'string' ? { summary: detail } : detail);
    const existing = activeByKey(key);

    if (existing) {
      const escalated = severity === 'critical' && existing.severity !== 'critical';
      db.sql.run('UPDATE alerts SET updated_at = ?, occurrences = occurrences + 1, title = ?, detail = ?, severity = ? WHERE id = ?',
        t, title, detailText, escalated ? 'critical' : existing.severity, existing.id);
      let row = get(existing.id);
      // Getting worse reopens it: an acknowledged warning must not swallow the critical.
      if (escalated && row.status !== 'open') { db.sql.run("UPDATE alerts SET status = 'open', snooze_until = NULL WHERE id = ?", row.id); row = get(row.id); }
      const snoozed = row.status === 'snoozed' && row.snooze_until && row.snooze_until > t;
      const cooled = !row.last_notified_at || t - row.last_notified_at >= COOLDOWN[row.severity === 'critical' ? 'critical' : 'warning'];
      if (snoozed) return row;
      if (row.status === 'snoozed') { db.sql.run("UPDATE alerts SET status = 'open', snooze_until = NULL WHERE id = ?", row.id); row = get(row.id); }
      if ((row.status === 'open' && (cooled || escalated)) || forceNotify) {
        db.sql.run('UPDATE alerts SET last_notified_at = ? WHERE id = ?', t, row.id);
        notify(row, { quiet });
      }
      bus.emit('alert', { type: 'updated', alert: row });
      return row;
    }

    const r = db.sql.run(
      `INSERT INTO alerts (key, rule, severity, status, title, detail, app, opened_at, updated_at, last_notified_at, access_id)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      key, rule, severity, title, detailText, app, t, t, t, accessId);
    const row = get(Number(r.lastInsertRowid));
    // Access alerts are already on the timeline as the access event itself.
    if (rule !== 'access') addEvent(db, { ts: t, kind: 'alert', severity, app, title, detail: { alertId: row.id, rule } });
    notify(row, { quiet });
    bus.emit('alert', { type: 'opened', alert: row });
    return row;
  }

  function resolve(key, note = null) {
    const a = activeByKey(key);
    if (!a) return null;
    const t = now();
    db.sql.run("UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?", t, t, a.id);
    const row = get(a.id);
    addEvent(db, { ts: t, kind: 'alert', severity: 'info', app: a.app, title: `Resolved: ${a.title}`, detail: { alertId: a.id, note } });
    // Only tell the owner something is fixed if they were told it was broken.
    if (a.last_notified_at) notify(row, { resolved: true });
    bus.emit('alert', { type: 'resolved', alert: row });
    return row;
  }

  function ack(id, by = null) {
    const a = get(id);
    if (!a || a.status === 'resolved') return a;
    db.sql.run("UPDATE alerts SET status = 'acknowledged', ack_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
    addEvent(db, { kind: 'alert', app: a.app, title: `Acknowledged: ${a.title}`, detail: { alertId: id, by } });
    const row = get(id);
    bus.emit('alert', { type: 'updated', alert: row });
    return row;
  }

  // The owner has dealt with it (a one-off notice such as a new port or a
  // passkey added). If the problem is still there, the next check raises it again.
  function close(id, by = null) {
    const a = get(id);
    if (!a || a.status === 'resolved') return a;
    const t = now();
    db.sql.run("UPDATE alerts SET status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?", t, t, id);
    addEvent(db, { ts: t, kind: 'alert', app: a.app, title: `Closed: ${a.title}`, detail: { alertId: id, by } });
    const row = get(id);
    bus.emit('alert', { type: 'updated', alert: row });
    return row;
  }

  function snooze(id, minutes = 60) {
    const a = get(id);
    if (!a || a.status === 'resolved') return a;
    const until = now() + minutes * 60_000;
    db.sql.run("UPDATE alerts SET status = 'snoozed', snooze_until = ?, updated_at = ? WHERE id = ?", until, now(), id);
    const row = get(id);
    bus.emit('alert', { type: 'updated', alert: row });
    return row;
  }

  // "Was this you?" — yes closes it; no escalates it to urgent and keeps it open.
  function answer(id, yes, by = null) {
    const a = get(id);
    if (!a) return null;
    const t = now();
    if (yes) {
      db.sql.run("UPDATE alerts SET answer = 'yes', status = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?", t, t, id);
      addEvent(db, { ts: t, kind: 'access', app: a.app, title: `Confirmed by owner: ${a.title}`, detail: { alertId: id, by } });
    } else {
      db.sql.run("UPDATE alerts SET answer = 'no', severity = 'critical', status = 'open', updated_at = ?, last_notified_at = ? WHERE id = ?", t, t, id);
      addEvent(db, { ts: t, kind: 'access', severity: 'critical', app: a.app, title: `NOT recognised by owner: ${a.title}`, detail: { alertId: id, by } });
      const row = get(id);
      notify({ ...row, title: `Not you: ${a.title}`, detail: { summary: 'You said this was not you. Next: rotate the deploy key, check ~/.ssh/authorized_keys and sudo logs, and consider blocking the IP. Steps are on the alert page.' } }, {});
    }
    const row = get(id);
    bus.emit('alert', { type: 'updated', alert: row });
    return row;
  }

  // Snoozes that ran out go back to open (and will notify on the next raise).
  function sweep() {
    db.sql.run("UPDATE alerts SET status = 'open', snooze_until = NULL WHERE status = 'snoozed' AND snooze_until <= ?", now());
  }

  function list({ status = 'active', limit = 200 } = {}) {
    const rows = status === 'active'
      ? db.sql.all("SELECT * FROM alerts WHERE status != 'resolved' ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?", limit)
      : status === 'all'
        ? db.sql.all('SELECT * FROM alerts ORDER BY updated_at DESC LIMIT ?', limit)
        : db.sql.all('SELECT * FROM alerts WHERE status = ? ORDER BY updated_at DESC LIMIT ?', status, limit);
    return rows.map(parseDetail);
  }

  function counts() {
    const r = db.sql.get(`SELECT
      SUM(CASE WHEN status != 'resolved' AND severity = 'critical' THEN 1 ELSE 0 END) AS critical,
      SUM(CASE WHEN status != 'resolved' AND severity = 'warning' THEN 1 ELSE 0 END) AS warning,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS unacked
      FROM alerts`);
    return { critical: r.critical || 0, warning: r.warning || 0, unacked: r.unacked || 0 };
  }

  return { raise, resolve, ack, close, snooze, answer, sweep, list, counts, get, activeByKey, inMaintenance };
}

module.exports = { createAlerts, inQuietHours, COOLDOWN };
