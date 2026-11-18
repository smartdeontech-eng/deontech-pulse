// Knowing when a release is happening, without touching any other repo.
//
// A deploy window opens when:
//   - an /opt/<app>/live file changes (a blue/green switch), or
//   - a trusted session runs sudo with a deploy-shaped command
//     (systemctl restart <app>, release.sh, switch.sh, push.sh ...), or
//   - something POSTs to /api/hooks/deploy with the hook token.
//
// While it is open (10 minutes after the last such signal), access events are
// shown as "part of the release" and service-down alerts are held, so a
// planned restart doesn't page anybody. The window closes on its own.
'use strict';
const { addEvent } = require('./store');

const WINDOW_MS = 10 * 60_000;

function wordIn(text, word) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])${esc}(?=$|[^\\w-]|[-@](?:blue|green)\\b)`).test(text);
}

function createDeploys(db) {
  // app id ('*' when unknown) -> { id, until }
  const open = new Map();

  function appFromCommand(cmd, apps = []) {
    const s = String(cmd || '');
    for (const a of apps) {
      for (const u of a.units || []) if (s.includes(u.unit.replace(/\.service$/, ''))) return a.id;
      if (s.includes(`/opt/${a.id}`) || wordIn(s, a.id)) return a.id;
    }
    return '*';
  }

  function mark({ app = '*', source, detail, ts = Date.now(), quiet = false }) {
    // Windows are kept in event time, so a replayed or delayed log line opens
    // the window it belongs to rather than one starting now.
    const cur = open.get(app);
    if (cur && cur.until > ts) {
      cur.until = ts + WINDOW_MS;
      db.sql.run('UPDATE deploys SET ended_at = ? WHERE id = ?', cur.until, cur.id);
      return { id: cur.id, extended: true };
    }
    const r = db.sql.run('INSERT INTO deploys (app, started_at, ended_at, source, detail) VALUES (?, ?, ?, ?, ?)', app, ts, ts + WINDOW_MS, source, detail ? JSON.stringify(detail) : null);
    const id = Number(r.lastInsertRowid);
    open.set(app, { id, until: ts + WINDOW_MS });
    if (!quiet) addEvent(db, { ts, kind: 'deploy', app: app === '*' ? null : app, title: `Release started${app === '*' ? '' : ` — ${app}`}`, detail: { source, ...(detail || {}) } });
    return { id, extended: false };
  }

  function inDeploy(app = null, ts = Date.now()) {
    for (const [k, v] of open) {
      if (v.until <= ts) { open.delete(k); continue; }
      if (k === '*' || !app || k === app) return true;
    }
    return false;
  }

  // After a restart (e.g. Pulse's own release), pick up windows still open.
  function restore(now = Date.now()) {
    for (const r of db.sql.all('SELECT * FROM deploys WHERE ended_at > ? ORDER BY started_at', now)) open.set(r.app || '*', { id: r.id, until: r.ended_at });
    return open.size;
  }

  function recent(since) {
    return db.sql.all('SELECT * FROM deploys WHERE started_at >= ? ORDER BY started_at', since);
  }

  return { mark, inDeploy, recent, restore, appFromCommand, WINDOW_MS };
}

module.exports = { createDeploys, WINDOW_MS, wordIn };
