// The dashboard's API. Everything here needs a signed-in account with 2FA on;
// reading needs monitor.view, changing needs monitor.manage or settings.manage.
'use strict';
const express = require('express');
const db = require('../utils/db');
const { getSettings, updateSettings } = require('../utils/settings');
const { requireAuth, require2fa, requirePermission, userHasPermission } = require('../middleware/auth');
const store = require('../core/store');
const { history } = require('../core/rollup');
const trust = require('../core/trust');
const geoip = require('../core/geoip');
const { verifyActionToken } = require('../core/channels');
const { requireFreshCode } = require('../utils/freshCode');
const { hintFor, journalCommand } = require('../core/errgroups');
const { displayZones, homeZone, validZone: validTz } = require('../core/zones');

const validZone = (z) => { try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return true; } catch { return false; } };

const RANGES = { '15m': 15 * 60_000, '1h': 3600_000, '6h': 6 * 3600_000, '24h': 24 * 3600_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, '1y': 365 * 86400_000 };

function createApi({ monitor, channels, secret, actions, backups }) {
  const router = express.Router();
  const st = monitor.state;
  const view = [requireAuth, require2fa, requirePermission('monitor.view')];
  const manage = [requireAuth, require2fa, requirePermission('monitor.manage')];
  const settingsRight = [requireAuth, require2fa, requirePermission('settings.manage')];

  // ---- Push-notification buttons (no session: the link itself is signed) ----
  router.get('/alerts/action', (req, res) => {
    const v = verifyActionToken(secret, req.query.t);
    if (!v) return res.status(400).type('html').send(page('That link has expired.', 'Open Pulse to deal with the alert.'));
    const a = monitor.alerts.get(v.alertId);
    if (!a) return res.status(404).type('html').send(page('Alert not found.', ''));
    let msg = '';
    if (v.action === 'yes') { monitor.alerts.answer(a.id, true, 'push-button'); msg = 'Thanks — marked as you. Nothing else to do.'; }
    else if (v.action === 'no') { monitor.alerts.answer(a.id, false, 'push-button'); msg = 'Escalated. Open Pulse now for the next steps.'; }
    else if (v.action === 'ack') { monitor.alerts.ack(a.id, 'push-button'); msg = 'Acknowledged.'; }
    else if (v.action === 'snooze') { monitor.alerts.snooze(a.id, 60); msg = 'Snoozed for an hour.'; }
    if (req.get('accept') && req.get('accept').includes('application/json')) return res.json({ ok: true, message: msg });
    res.type('html').send(page(msg, a.title));
  });

  // ---- About: which Pulse the server runs (the page compares it with its own) ----
  router.get('/about', [requireAuth, require2fa], (req, res) => {
    const pkg = require('../package.json');
    let build = null;
    try { build = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'build.json'), 'utf8')); } catch { /* a dev checkout has none */ }
    res.set('Cache-Control', 'no-store');
    res.json({ version: pkg.version, released: pkg.released || null, build: build && build.commit ? `${build.commit}${build.builtAt ? ` · ${String(build.builtAt).slice(0, 10)}` : ''}` : null, node: process.versions.node, started: st.startedAt });
  });

  // ---- Overview ----
  router.get('/overview', view, (req, res) => {
    const day = Date.now() - 24 * 3600_000;
    const extra = logExtras();
    const apps = st.apps.map((a) => ({ ...appSummary(a, st.checks[a.id]), ...extra(a) }));
    const s = getSettings();
    res.json({
      server: st.staticInfo,
      latest: monitor.collector.latest(),
      alerts: monitor.alerts.counts(),
      activeAlerts: monitor.alerts.list().slice(0, 20),
      apps,
      findings: st.findings,
      events: store.listEvents(db, { since: day, limit: 60 }),
      deploys: monitor.deploys.recent(day),
      maintenance: s.maintenanceUntil && Date.parse(s.maintenanceUntil) > Date.now() ? { until: s.maintenanceUntil, note: s.maintenanceNote } : null,
      scan: { ts: st.inventory && st.inventory.scan ? st.inventory.scan.ts : null, error: st.inventory ? st.inventory.scanError : 'starting' },
      authWatch: monitor.authMode(),
      geoip: geoip.loaded(),
      timezones: displayZones(db, s),
      home: homeZone(s),
      health: healthScore(apps, monitor.alerts.counts(), monitor.collector.latest()),
      forecast: st.forecast || null,
      online: monitor.appSignins.online().length,
      errors: db.sql.get("SELECT COUNT(*) n FROM error_groups WHERE status = 'open' AND last_seen >= ?", Date.now() - 86400_000).n,
    });
  });

  // ---- Metrics ----
  router.get('/metrics', view, (req, res) => {
    const range = RANGES[req.query.range] ? req.query.range : '1h';
    const to = Date.now();
    const from = to - RANGES[range];
    if (range === '15m') return res.json({ range, tier: 'live', rows: monitor.collector.ring(), deploys: monitor.deploys.recent(from) });
    const h = history(db, { from, to });
    res.json({ range, ...h, deploys: monitor.deploys.recent(from) });
  });

  router.get('/live', view, (req, res) => {
    res.json({ latest: monitor.collector.latest(), ring: monitor.collector.ring(), processes: monitor.collector.processes() });
  });

  // ---- Apps ----
  router.get('/apps', view, (req, res) => {
    const extra = logExtras();
    const ov = getSettings().appOverrides;
    const hidden = Object.entries(ov).filter(([, o]) => o && o.ignore).map(([id, o]) => ({ id, name: o.name || id }));
    res.json({ apps: st.apps.map((a) => ({ ...a, check: st.checks[a.id] || null, summary: { ...appSummary(a, st.checks[a.id]), ...extra(a) } })), certs: st.certs, hidden, canManage: userHasPermission(req.user, 'monitor.manage') });
  });

  router.get('/apps/:id', view, (req, res) => {
    const a = st.apps.find((x) => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: 'No such app.' });
    const since = Date.now() - 24 * 3600_000;
    res.json({
      app: a,
      check: st.checks[a.id] || null,
      version: monitor.appVersions()[a.id] || null,
      checks: db.sql.all('SELECT ts, ok, ms, status, error FROM check_results WHERE app = ? AND ts >= ? ORDER BY ts', a.id, since),
      certs: st.certs.filter((c) => c.app === a.id),
      events: db.sql.all('SELECT * FROM events WHERE app = ? ORDER BY ts DESC LIMIT 50', a.id).map(store.parseDetail),
      alerts: db.sql.all('SELECT * FROM alerts WHERE app = ? ORDER BY updated_at DESC LIMIT 20', a.id).map(store.parseDetail),
      deploys: db.sql.all('SELECT * FROM deploys WHERE app = ? OR app = ? ORDER BY started_at DESC LIMIT 20', a.id, '*'),
      traffic: monitor.traffic.series(monitor.vhostsOf(a), since, Date.now(), 5 * 60_000),
      errors: monitor.appLogs.recent(a.id, 30),
      errorGroups: monitor.appLogs.groups({ app: a.id, since: Date.now() - 7 * 86400_000 }).slice(0, 12),
    });
  });

  // ---- Doing, not just watching: restart, switch line, logs, memory now ----
  // Restart and Switch need a fresh 2FA code and raise an alert every time,
  // like any other change a stolen session must not make quietly.
  const appById = (id) => st.apps.find((x) => x.id === id);
  const serviceOf = (a) => {
    if (a.lines && a.lines.length && a.liveLine) {
      const l = a.lines.find((x) => x.line === a.liveLine);
      if (l && l.unit) return l.unit;
    }
    const u = (a.units || []).find((x) => x.active === 'active') || (a.units || [])[0];
    return u ? u.unit : null;
  };
  const tellAction = (a, what, by, r) => monitor.alerts.raise({
    key: `action:${a.id}:${Date.now()}`, rule: 'settings', severity: 'warning', app: a.id,
    title: `${a.name}: ${what} from Pulse${r.ok ? '' : ' — it failed'}`, detail: { summary: `by ${by}` },
  });

  router.get('/apps/:id/logs', manage, async (req, res) => {
    const a = appById(req.params.id);
    if (!a) return res.status(404).json({ error: 'No such app.' });
    const units = [...new Set((a.units || []).map((u) => u.unit))];
    const live = serviceOf(a);
    res.json({ units, ...(await actions.logs(live && a.lines && a.lines.length ? [live] : units, Number(req.query.n) || 60)) });
  });

  router.post('/apps/:id/restart', manage, requireFreshCode, async (req, res) => {
    const a = appById(req.params.id);
    if (!a || a.kind !== 'app') return res.status(404).json({ error: 'No such app.' });
    const unit = serviceOf(a);
    if (!unit) return res.status(400).json({ error: 'Pulse found no service for this app.' });
    monitor.deploys.mark({ app: a.id, source: 'pulse-restart', detail: { unit, by: req.user.email } });   // a planned restart, not an outage
    const r = await actions.restart(unit);
    store.addEvent(db, { kind: 'deploy', app: a.id, severity: r.ok ? 'info' : 'warning', title: `${a.name} restarted from Pulse (${unit})${r.ok ? '' : ' — failed'}`, detail: { by: req.user.email, output: r.output.slice(-2000) } });
    tellAction(a, 'restarted', req.user.email, r);
    monitor.runChecks().catch(() => {});
    res.status(r.ok ? 200 : 502).json({ ...r, unit, error: r.ok ? undefined : `${a.name} did not restart cleanly — see what the server said below.` });
  });

  router.post('/apps/:id/switch', manage, requireFreshCode, async (req, res) => {
    const a = appById(req.params.id);
    if (!a || !a.liveLine) return res.status(404).json({ error: 'This app has no blue/green lines.' });
    const line = String((req.body && req.body.line) || '');
    if (!['blue', 'green'].includes(line)) return res.status(400).json({ error: 'Choose blue or green.' });
    if (line === a.liveLine) return res.status(400).json({ error: `${line} is already live.` });
    monitor.deploys.mark({ app: a.id, source: 'pulse-switch', detail: { from: a.liveLine, to: line, by: req.user.email } });
    const r = await actions.switchLine(a.id, line);
    store.addEvent(db, { kind: 'deploy', app: a.id, severity: r.ok ? 'info' : 'warning', title: `${a.name}: live line ${a.liveLine || '?'} → ${line} from Pulse${r.ok ? '' : ' — failed'}`, detail: { by: req.user.email, output: r.output.slice(-2000) } });
    tellAction(a, `switched to ${line}`, req.user.email, r);
    monitor.discover().then(() => monitor.runChecks()).catch(() => {});
    res.status(r.ok ? 200 : 502).json({ ...r, line, error: r.ok ? undefined : `Still on ${a.liveLine} — the switch did not happen. See what the server said below.` });
  });

  router.get('/server/top', view, async (req, res) => {
    res.json({ processes: await actions.top(10), latest: monitor.collector.latest() });
  });

  router.put('/apps/:id', manage, (req, res) => {
    const { name, healthPath, ignore, watch, note } = req.body || {};
    const s = getSettings();
    const id = String(req.params.id).slice(0, 80);
    const known = st.apps.find((x) => x.id === id) || s.appOverrides[id];
    if (!known) return res.status(404).json({ error: 'No such app.' });
    const ov = { ...(s.appOverrides[id] || {}) };
    if (name !== undefined) ov.name = String(name).slice(0, 60) || undefined;
    if (healthPath !== undefined) ov.healthPath = healthPath ? String(healthPath).slice(0, 120) : undefined;
    if (ignore !== undefined) ov.ignore = !!ignore;
    if (watch !== undefined && (ov.watch !== false) !== !!watch) {
      const label = (st.apps.find((x) => x.id === id) || {}).name || ov.name || id;
      if (watch) { delete ov.watch; delete ov.watchAt; delete ov.watchBy; delete ov.watchNote; }
      else { ov.watch = false; ov.watchAt = new Date().toISOString(); ov.watchBy = req.user.email; ov.watchNote = note ? String(note).slice(0, 140) : ''; }
      store.addEvent(db, { kind: 'system', app: id, title: `Monitoring switched ${watch ? 'on' : 'off'} for ${label}`, detail: { by: req.user.email, note: ov.watchNote || null } });
    }
    updateSettings({ appOverrides: { [id]: ov } });
    monitor.discover().then(() => (watch !== undefined ? monitor.runChecks() : null)).then(() => res.json({ ok: true })).catch((e) => res.status(500).json({ error: e.message }));
  });

  // Requests and errors in the last hour, per app.
  function logExtras() {
    const t = monitor.traffic.summary(60);
    const byHost = Object.fromEntries(t.map((r) => [r.vhost, r]));
    const errs = monitor.appLogs.counts(3600_000);
    return (a) => {
      const rows = monitor.vhostsOf(a).map((v) => byHost[v]).filter(Boolean);
      const n = rows.reduce((x, r) => x + r.n, 0);
      const s5 = rows.reduce((x, r) => x + r.s5, 0);
      // The last 30 health checks (15 minutes), oldest first, for the uptime strip.
      const hist = a.watched === false ? [] : ((monitor.checker.state(a.id) || {}).history || []).slice(-30).map((x) => (x.ok ? 1 : 0));
      return { requests1h: n, errors5xx1h: s5, logErrors1h: errs[a.id] || 0, history: hist };
    };
  }

  // ---- Where am I? Each device reports its time zone (set by the phone or
  // computer from where it is). Saved on the account; written only when it
  // changes or an hour has passed, so this is cheap to call on every launch.
  router.post('/me/timezone', view, (req, res) => {
    const tz = String((req.body && req.body.tz) || '');
    if (!validTz(tz)) return res.status(400).json({ error: 'Not a time zone.' });
    const u = db.findById('users', req.user.id);
    if (u && (u.timezone !== tz || Date.now() - (Date.parse(u.timezoneAt) || 0) > 3600_000)) db.update('users', u.id, { timezone: tz, timezoneAt: new Date().toISOString() });
    const s = getSettings();
    res.json({ home: homeZone(s), zones: displayZones(db, s) });
  });

  // ---- Backups ----
  router.get('/backups', view, (req, res) => {
    if (!backups) return res.status(503).json({ error: 'Backups are not available.' });
    const inv = st.inventory || {};
    const off = (inv.scan && inv.scan.offsite) || null;
    res.json({
      apps: backups.list(),
      offsite: off && off.scripts.length ? off : null,
      schedule: backups.schedule(),
      scanTs: inv.scan ? inv.scan.ts : null,
      maxAgeHours: getSettings().thresholds.backupMaxAgeHours,
      canManage: userHasPermission(req.user, 'monitor.manage'),
    });
  });

  router.post('/backups/:app/run', manage, (req, res) => {
    const r = backups.run(String(req.params.app), { offsite: !!(req.body && req.body.offsite), by: req.user.email });
    if (r.error) return res.status(r.status || 400).json({ error: r.error });
    store.addEvent(db, { kind: 'system', app: req.params.app, title: `Backup of ${req.params.app} started from Pulse${req.body && req.body.offsite ? ' (with off-site copy)' : ''}`, detail: { by: req.user.email } });
    res.status(202).json({ started: true, startedAt: r.startedAt });
  });

  router.put('/backups/:app/schedule', manage, (req, res) => {
    const v = backups.setSchedule(String(req.params.app), req.body || {});
    if (!v) return res.status(400).json({ error: 'Pulse has no backup plan for this app.' });
    store.addEvent(db, { kind: 'system', app: req.params.app, title: `Nightly backup by Pulse ${v.nightly ? 'on' : 'off'} for ${req.params.app}${v.nightly && v.offsite ? ' (with off-site copy)' : ''}`, detail: { by: req.user.email } });
    res.json({ schedule: v });
  });

  router.put('/backups-time', manage, (req, res) => {
    const t = String((req.body && req.body.time) || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return res.status(400).json({ error: 'Time must be HH:MM.' });
    updateSettings({ backupTime: t });
    res.json({ time: t });
  });

  // ---- Errors, grouped by kind, with their logs ----
  const appName = (id) => (st.apps.find((a) => a.id === id) || {}).name || id;
  router.get('/errors', view, (req, res) => {
    const RANGE = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };
    const range = RANGE[req.query.range] ? req.query.range : '7d';
    const status = ['open', 'known', 'fixed'].includes(req.query.status) ? req.query.status : null;
    const groups = monitor.appLogs.groups({ app: req.query.app ? String(req.query.app) : null, status, since: Date.now() - RANGE[range] })
      .map((g) => ({ ...g, appName: appName(g.app), hint: hintFor(`${g.type || ''} ${g.message || ''} ${g.title}`).title }));
    const apps = [...new Set(groups.map((g) => g.app))].map((id) => ({ id, name: appName(id) }));
    res.json({ range, groups, apps, canManage: userHasPermission(req.user, 'monitor.manage') });
  });

  router.get('/errors/:id', view, (req, res) => {
    const g = monitor.appLogs.group(Number(req.params.id));
    if (!g) return res.status(404).json({ error: 'No such error.' });
    const a = st.apps.find((x) => x.id === g.app);
    const vhosts = a ? monitor.vhostsOf(a) : [];
    g.events = g.events.map((e) => ({
      ...e,
      requests: monitor.traffic.failedAround(vhosts, e.ts - 10_000, e.ts + 5_000),
      command: journalCommand(e.unit || (a && a.units && a.units[0] && a.units[0].unit) || g.app, e.ts),
    }));
    const text = [g.type, g.message, g.title, ...(g.events[0] ? [g.events[0].block] : [])].join('\n');
    res.json({
      group: { ...g, appName: appName(g.app) },
      hint: hintFor(text),
      alert: db.sql.get("SELECT id, status FROM alerts WHERE key = ? ORDER BY id DESC LIMIT 1", `errgroup:${g.id}`) || null,
      canManage: userHasPermission(req.user, 'monitor.manage'),
    });
  });

  router.put('/errors/:id', manage, (req, res) => {
    const { status, note } = req.body || {};
    const g = monitor.appLogs.setStatus(Number(req.params.id), status, req.user.email, note == null ? null : String(note).slice(0, 300));
    if (!g) return res.status(400).json({ error: 'Status must be open, known or fixed.' });
    if (status !== 'open') monitor.alerts.resolve(`errgroup:${g.id}`, `marked ${status} by ${req.user.email}`);
    store.addEvent(db, { kind: 'system', app: g.app, title: `Error marked ${status}: ${appName(g.app)} — ${g.title}`, detail: { by: req.user.email, note: note || null } });
    res.json({ group: g });
  });

  // ---- Sign-ins to the apps (and to Pulse) ----
  router.get('/signins', view, (req, res) => {
    const RANGE = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000, '90d': 90 * 86400_000 };
    const range = RANGE[req.query.range] ? req.query.range : '24h';
    const t = Date.now();
    const since = t - RANGE[range];
    const sg = monitor.appSignins;
    const sum = sg.summary(since, t);
    const rep = Object.fromEntries(sum.reporters.map((r) => [r.app, r]));
    // Every app Pulse knows, connected or not, so the gaps are visible.
    const apps = [{ id: 'pulse', name: 'Pulse', builtIn: true }, ...st.apps.filter((a) => a.kind === 'app').map((a) => ({ id: a.id, name: a.name }))];
    for (const r of sum.reporters) if (!apps.some((a) => a.id === r.app)) apps.push({ id: r.app, name: r.app });
    res.json({
      range,
      onlineWindowMin: sg.ONLINE_MS / 60_000,
      online: sg.online(t),
      recent: sg.recent({ since, app: req.query.app ? String(req.query.app) : null, failedOnly: req.query.failed === '1', q: req.query.q || '' }),
      apps: apps.map((a) => ({
        ...a,
        connected: a.builtIn || !!rep[a.id],
        lastReport: a.builtIn ? t : rep[a.id] ? rep[a.id].last_seen : null,
        online: (sum.online.find((x) => x.app === a.id) || {}).n || 0,
        ok: (sum.per.find((x) => x.app === a.id) || {}).ok || 0,
        failed: (sum.per.find((x) => x.app === a.id) || {}).failed || 0,
        people: (sum.per.find((x) => x.app === a.id) || {}).people || 0,
      })),
    });
  });

  // ---- Inventory ----
  router.get('/inventory', view, (req, res) => {
    const inv = st.inventory || {};
    res.json({
      ts: inv.ts, scan: inv.scan, scanError: inv.scanError, units: inv.units, timers: inv.timers, sites: inv.sites,
      live: inv.live, apps: st.apps, findings: st.findings,
      changes: store.listEvents(db, { kind: 'inventory', limit: 100, since: Date.now() - 30 * 86400_000 }),
    });
  });

  // ---- Access ----
  router.get('/access', view, (req, res) => {
    const since = Number(req.query.since) || Date.now() - 7 * 86400_000;
    const includeFailed = req.query.failed === '1';
    const rows = includeFailed
      ? db.sql.all('SELECT * FROM access_events WHERE ts >= ? ORDER BY ts DESC LIMIT 500', since)
      : db.sql.all("SELECT * FROM access_events WHERE ts >= ? AND kind != 'ssh_failed' ORDER BY ts DESC LIMIT 500", since);
    const day = Date.now() - 24 * 3600_000;
    res.json({
      events: rows,
      sources: monitor.sources().map((s) => ({ ...s, expired: !!(s.expires_at && s.expires_at < Date.now()) })),
      failed24h: db.sql.get("SELECT COUNT(*) n, COUNT(DISTINCT ip) ips FROM access_events WHERE kind = 'ssh_failed' AND ts >= ?", day),
      topFailed: db.sql.all("SELECT ip, country, COUNT(*) n, MAX(ts) last FROM access_events WHERE kind = 'ssh_failed' AND ts >= ? GROUP BY ip ORDER BY n DESC LIMIT 10", day),
      quietWeek: db.sql.get("SELECT COUNT(*) n FROM access_events WHERE grade IN ('quiet','release') AND ts >= ?", Date.now() - 7 * 86400_000).n,
      geoip: geoip.loaded(),
      keys: (st.inventory && st.inventory.scan && st.inventory.scan.keys) || [],
      authWatch: monitor.authMode(),
    });
  });

  // Who is on the server right now (open SSH and console sessions), each with
  // the key it came in with.
  const sessions = require('../core/sessions').createSessions();
  router.get('/access/now', view, async (req, res) => {
    const r = await sessions.list();
    const sources = monitor.sources();
    const keys = (st.inventory && st.inventory.scan && st.inventory.scan.keys) || [];
    const findLogin = (user, ip, since) => (since
      ? db.sql.get("SELECT * FROM access_events WHERE kind = 'ssh_login' AND user = ? AND ip = ? AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) LIMIT 1", user, ip, since - 300_000, since + 300_000, since)
      : null) || db.sql.get("SELECT * FROM access_events WHERE kind = 'ssh_login' AND user = ? AND ip = ? ORDER BY ts DESC LIMIT 1", user, ip);
    const keyLabel = (fp) => {
      const t = sources.find((x) => x.kind === 'key' && x.value === fp);
      if (t) return { label: t.label, trusted: true };
      const k = keys.find((x) => x.fingerprint === fp);
      return { label: (k && k.comment) || `key ${String(fp).replace(/^SHA256:/, '').slice(0, 8)}…`, trusted: false };
    };
    res.json({ ts: Date.now(), source: r.source, error: r.error || null, sessions: sessions.annotate(r.sessions, { findLogin, keyLabel, country: (ip) => geoip.country(ip) }) });
  });

  // Editing the trusted list needs a fresh 2FA code and raises an alert of its
  // own — so a stolen session can't quietly whitelist itself.
  router.post('/trusted', manage, requireFreshCode, (req, res) => {
    const u = req.freshUser;
    const { kind, label, value, days } = req.body || {};
    if (!['key', 'network'].includes(kind)) return res.status(400).json({ error: 'kind must be key or network.' });
    let v = String(value || '').trim();
    // A phone may lower-case the prefix or add spaces; the part after it is
    // case-sensitive and kept exactly. A whole ssh-keygen -lf line works too.
    if (kind === 'key') { const m = v.match(/sha256:\s*([A-Za-z0-9+/=]+)/i); if (m) v = `SHA256:${m[1]}`; }
    if (kind === 'key' && !/^SHA256:[A-Za-z0-9+/=]{20,}$/.test(v)) return res.status(400).json({ error: 'A key is its fingerprint, like SHA256:abc… (ssh-keygen -lf ~/.ssh/id_ed25519.pub).' });
    if (kind === 'network') {
      const c = trust.parseCidr(v);
      if (!c) return res.status(400).json({ error: 'Give an IP address or a range like 41.66.0.0/16.' });
      if (!v.includes('/')) v = trust.networkOf(v);
    }
    const name = String(label || '').trim().slice(0, 60) || (kind === 'key' ? 'Key' : `Network ${v}`);
    const exp = Number(days) > 0 ? Date.now() + Number(days) * 86400_000 : null;
    const r = db.sql.run('INSERT INTO trusted_sources (kind, label, value, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', kind, name, v, exp, Date.now(), u.email);
    monitor.alerts.raise({ key: `trusted-change:${r.lastInsertRowid}`, rule: 'trusted', severity: 'warning', title: `Trusted list changed: added ${name}`, detail: { summary: `${kind} ${v}${exp ? `, until ${new Date(exp).toISOString().slice(0, 10)}` : ''} — by ${u.email}` } });
    res.json({ ok: true, id: Number(r.lastInsertRowid) });
  });

  router.delete('/trusted/:id', manage, requireFreshCode, (req, res) => {
    const u = req.freshUser;
    const s = db.sql.get('SELECT * FROM trusted_sources WHERE id = ?', Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Not found.' });
    db.sql.run('DELETE FROM trusted_sources WHERE id = ?', s.id);
    monitor.alerts.raise({ key: `trusted-change:del:${s.id}`, rule: 'trusted', severity: 'warning', title: `Trusted list changed: removed ${s.label}`, detail: { summary: `by ${u.email}` } });
    res.json({ ok: true });
  });

  // ---- Alerts ----
  router.get('/alerts', view, (req, res) => {
    res.json({ alerts: monitor.alerts.list({ status: req.query.status || 'active' }), counts: monitor.alerts.counts(), deliveries: channels.recent() });
  });
  router.get('/alerts/:id', view, (req, res) => {
    const a = monitor.alerts.get(Number(req.params.id));
    if (!a) return res.status(404).json({ error: 'Not found.' });
    const access = a.access_id ? db.sql.get('SELECT * FROM access_events WHERE id = ?', a.access_id) : null;
    res.json({ alert: a, access });
  });
  router.post('/alerts/:id/ack', manage, (req, res) => res.json(monitor.alerts.ack(Number(req.params.id), req.user.email)));
  router.post('/alerts/:id/close', manage, (req, res) => res.json(monitor.alerts.close(Number(req.params.id), req.user.email)));
  router.post('/alerts/:id/snooze', manage, (req, res) => res.json(monitor.alerts.snooze(Number(req.params.id), Math.min(7 * 1440, Number(req.body && req.body.minutes) || 60))));
  router.post('/alerts/:id/answer', manage, (req, res, next) => {
    // "Yes — and trust this network" changes the trusted list, so it needs
    // the same fresh code as the Access page does.
    if (req.body && req.body.yes && req.body.trust) return requireFreshCode(req, res, next);
    next();
  }, (req, res) => {
    const yes = !!(req.body && req.body.yes);
    const row = monitor.alerts.answer(Number(req.params.id), yes, req.user.email);
    let trusted = null;
    if (yes && req.body.trust) {
      trusted = monitor.trustFromAlert(Number(req.params.id), req.user.email, req.body.days ?? 7);
      const howLong = trusted && (trusted.expiresAt ? `until ${new Date(trusted.expiresAt).toISOString().slice(0, 10)}` : 'always');
      if (trusted && (!trusted.existed || trusted.renewed)) monitor.alerts.raise({ key: `trusted-change:net:${trusted.id}:${Date.now()}`, rule: 'trusted', severity: 'warning', title: `Trusted list changed: ${trusted.existed ? '' : 'added '}${trusted.label} (${howLong})`, detail: { summary: `From "Yes, trust this network" on an alert — by ${req.user.email}` } });
    }
    res.json({ alert: row, trusted });
  });
  router.post('/alerts/test', manage, async (req, res) => {
    const a = monitor.alerts.raise({ key: `test:${Date.now()}`, rule: 'test', severity: req.body && req.body.urgent ? 'critical' : 'warning', title: 'Test alert from DeonTech Pulse', detail: { summary: 'If you can read this, this channel works.' } });
    res.json({ ok: true, alert: a });
  });

  // ---- Events ----
  router.get('/events', view, (req, res) => {
    res.json({ events: store.listEvents(db, { since: Number(req.query.since) || Date.now() - 7 * 86400_000, kind: req.query.kind || undefined, limit: 500 }) });
  });

  router.get('/digest', view, (req, res) => res.json(monitor.digest()));

  // ---- Maintenance ----
  router.post('/maintenance', manage, (req, res) => {
    const minutes = Math.max(5, Math.min(24 * 60, Number(req.body && req.body.minutes) || 60));
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    updateSettings({ maintenanceUntil: until, maintenanceNote: String((req.body && req.body.note) || '').slice(0, 200) });
    store.addEvent(db, { kind: 'system', title: `Maintenance mode on for ${minutes} min`, detail: { by: req.user.email, note: req.body && req.body.note } });
    res.json({ ok: true, until });
  });
  router.delete('/maintenance', manage, (req, res) => {
    updateSettings({ maintenanceUntil: null, maintenanceNote: '' });
    store.addEvent(db, { kind: 'system', title: 'Maintenance mode off', detail: { by: req.user.email } });
    res.json({ ok: true });
  });

  // ---- Settings ----
  router.get('/settings', view, (req, res) => {
    const s = getSettings();
    res.json({
      settings: s,
      canManage: userHasPermission(req.user, 'monitor.manage'),
      canSettings: userHasPermission(req.user, 'settings.manage'),
      status: {
        push: channels.pushReady(), sms: !!process.env.SMS_API_KEY, email: !!process.env.SMTP_HOST,
        whatsapp: !!process.env.WHATSAPP_TOKEN, geoip: geoip.loaded(), authWatch: monitor.authMode(),
        scan: st.inventory && st.inventory.scan ? st.inventory.scan.ts : null,
      },
      devices: db.sql.all('SELECT id, label, created_at, last_ok_at, failures FROM push_subs ORDER BY id'),
    });
  });

  const MANAGE_KEYS = ['thresholds', 'quietHours', 'usualCountries', 'digestTime'];
  const SETTINGS_KEYS = ['channels', 'ownerPhone', 'ownerEmail', 'timezones'];
  // Where alerts go is guarded like the trusted list: turning the SMS off or
  // pointing it at another phone is exactly what an intruder would do first.
  router.put('/settings', [requireAuth, require2fa], (req, res, next) => {
    const b = req.body || {};
    // Permission first, so someone without the right can't use this to guess codes.
    if (MANAGE_KEYS.some((k) => b[k] !== undefined) && !userHasPermission(req.user, 'monitor.manage')) return res.status(403).json({ error: 'Not allowed.' });
    if (SETTINGS_KEYS.some((k) => b[k] !== undefined)) {
      if (!userHasPermission(req.user, 'settings.manage')) return res.status(403).json({ error: 'Not allowed.' });
      return requireFreshCode(req, res, next);
    }
    next();
  }, (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const k of MANAGE_KEYS) if (body[k] !== undefined) {
      if (!userHasPermission(req.user, 'monitor.manage')) return res.status(403).json({ error: 'Not allowed.' });
      patch[k] = body[k];
    }
    for (const k of SETTINGS_KEYS) if (body[k] !== undefined) {
      if (!userHasPermission(req.user, 'settings.manage')) return res.status(403).json({ error: 'Not allowed.' });
      patch[k] = body[k];
    }
    if (patch.ownerPhone !== undefined && patch.ownerPhone && !/^\+?\d[\d\s-]{7,16}$/.test(patch.ownerPhone)) return res.status(400).json({ error: 'Phone number looks wrong. Use +233…' });
    if (patch.timezones !== undefined && !(Array.isArray(patch.timezones) && patch.timezones.length >= 1 && patch.timezones.length <= 3 && patch.timezones.every(validZone))) return res.status(400).json({ error: 'Time zones must be 1–3 IANA names, e.g. Africa/Accra.' });
    if (patch.channels !== undefined) patch.channels = { push: !!patch.channels.push, sms: !!patch.channels.sms, email: !!patch.channels.email, whatsapp: !!patch.channels.whatsapp };
    if (patch.thresholds) for (const [k, v] of Object.entries(patch.thresholds)) if (k !== 'sslDays' && !(Number(v) > 0)) return res.status(400).json({ error: `${k} must be a positive number.` });
    const s = updateSettings(patch);
    store.addEvent(db, { kind: 'system', title: 'Settings changed', detail: { by: req.user.email, keys: Object.keys(patch) } });
    const sensitive = Object.keys(patch).filter((k) => SETTINGS_KEYS.includes(k));
    if (sensitive.length) monitor.alerts.raise({ key: `settings-change:${Date.now()}`, rule: 'settings', severity: 'warning', title: `Alert delivery settings changed (${sensitive.join(', ')})`, detail: { summary: `by ${req.user.email}` } });
    res.json({ settings: s });
  });

  // ---- Push subscriptions ----
  router.get('/push/key', view, (req, res) => res.json({ key: channels.vapidPublicKey(), ready: channels.pushReady() }));
  router.post('/push/subscribe', view, (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ error: 'Bad subscription.' });
    const label = String((req.body && req.body.label) || '').slice(0, 60) || deviceLabel(req.get('user-agent'));
    db.sql.run(`INSERT INTO push_subs (endpoint, keys, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, label = excluded.label, failures = 0`, sub.endpoint, JSON.stringify(sub.keys), req.user.id, label, Date.now());
    res.json({ ok: true });
  });
  router.delete('/push/subscribe/:id', manage, requireFreshCode, (req, res) => {
    const sub = db.sql.get('SELECT * FROM push_subs WHERE id = ?', Number(req.params.id));
    if (!sub) return res.status(404).json({ error: 'Not found.' });
    db.sql.run('DELETE FROM push_subs WHERE id = ?', sub.id);
    monitor.alerts.raise({ key: `device-removed:${sub.id}`, rule: 'settings', severity: 'warning', title: `Push device removed: ${sub.label || 'device'}`, detail: { summary: `by ${req.user.email}` } });
    res.json({ ok: true });
  });
  router.post('/push/test', view, async (req, res) => {
    const r = await channels.push({ title: 'DeonTech Pulse', body: 'Push notifications work on this device.', tag: 'test', url: '/#/settings' });
    res.json(r);
  });

  return router;
}

function appSummary(a, c) {
  return {
    id: a.id, name: a.name, kind: a.kind, domains: a.domains, ports: a.ports, liveLine: a.liveLine,
    lines: (c && c.lines) || a.lines.map((l) => ({ line: l.line, port: l.port, live: l.line === a.liveLine })),
    status: c ? c.status : 'unknown', ok: c ? c.ok : null, ms: c ? c.ms : null, error: c ? c.error : null,
    restarts: c ? c.restarts : null, memory: c ? c.memory : null, hasBackups: a.hasBackups, dataBytes: a.dataBytes || null,
    backupAge: a.backups && a.backups.newestTs ? Date.now() - a.backups.newestTs : null,
    watched: a.watched !== false, watchOff: a.watchOff || null,
    version: c && c.health && c.health.version != null ? String(c.health.version) : null,
    runner: a.runner || null,
  };
}

// 0–100: a single number for the top of the page. Deliberately simple and
// explained on hover, so it is never a mystery why it dropped.
function healthScore(apps, counts, latest) {
  let score = 100;
  const why = [];
  const down = apps.filter((a) => a.status === 'down' && a.watched !== false).length;
  if (down) { score -= 25 * down; why.push(`${down} app${down > 1 ? 's' : ''} down`); }
  if (counts.critical) { score -= 10 * counts.critical; why.push(`${counts.critical} urgent alert${counts.critical > 1 ? 's' : ''}`); }
  if (counts.warning) { score -= 3 * counts.warning; why.push(`${counts.warning} warning${counts.warning > 1 ? 's' : ''}`); }
  if (latest) {
    if (latest.disk >= 85) { score -= 10; why.push('disk filling'); }
    if (latest.mem >= 90) { score -= 10; why.push('memory high'); }
    if (latest.cpu >= 90) { score -= 5; why.push('CPU busy'); }
  }
  return { score: Math.max(0, Math.min(100, score)), why };
}

function deviceLabel(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}

function page(title, sub) {
  const e = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeonTech Pulse</title>
<body style="font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#1d2433">
<h2 style="font-weight:600">${e(title)}</h2><p style="color:#5b6577">${e(sub)}</p><p><a href="/">Open DeonTech Pulse</a></p></body>`;
}

module.exports = { createApi, healthScore, appSummary };
