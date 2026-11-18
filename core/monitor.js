// The running monitor: wires the collector, discovery, checks, the access
// watcher and the alert rules together, and holds the current picture the API
// serves. server.js creates one of these; tests create one with fakes.
'use strict';
const fs = require('fs');
const store = require('./store');
const bus = require('./bus');
const { createRollup } = require('./rollup');
const { createCollector } = require('./metrics');
const discovery = require('./discovery');
const { createChecker, checkCerts } = require('./checks');
const { createDeploys } = require('./deploys');
const { createAlerts } = require('./alerts');
const trust = require('./trust');
const geoip = require('./geoip');
const { createAuthWatcher } = require('./authwatch');
const { fmtTimes } = require('./channels');
const { displayZones } = require('./zones');
const { createTraffic, judgeErrors } = require('./traffic');
const { createAppLogs } = require('./applogs');
const { diskForecast } = require('./forecast');
const { createAppSignins } = require('./appsignins');

const MIN = 60_000;
const SESSION_WINDOW = 8 * 3600_000;   // sudo is judged by the user's last SSH login within this

function createMonitor({
  db, getSettings, channels,
  scanPath = process.env.PULSE_SCAN_PATH || '/var/lib/pulse-scan/inventory.txt',
  geoipPath = process.env.PULSE_GEOIP_PATH || '/var/lib/pulse/dbip-country-lite.csv',
  sitesDir = process.env.PULSE_APACHE_SITES || '/etc/apache2/sites-enabled',
  optDir = process.env.PULSE_OPT_DIR || '/opt',
  si, gather = discovery.gather, enableAuthWatch = true, enableLogs = enableAuthWatch,
  apacheLogDir = process.env.PULSE_APACHE_LOGS || '/var/log/apache2', log = console,
  // Ask root for a fresh inventory scan now (server.js wires this to the
  // action helper). Used when something new appears between hourly scans.
  requestScan = null, procRoot = process.env.PULSE_PROC || '/proc',
} = {}) {
  store.init(db);
  const rollup = createRollup(db);
  const collector = createCollector({ si, rollup });
  const checker = createChecker();
  const deploys = createDeploys(db);
  const alerts = createAlerts({ db, channels, getSettings, log });
  const traffic = createTraffic({ db, logDir: apacheLogDir, log });
  // One alert per KIND of error (a group), naming it and linking to it:
  //   - a kind never seen before;
  //   - a kind marked "fixed" that came back;
  //   - a burst of one kind (10 in 5 minutes).
  // A kind marked "known" stays quiet. Releases hold all of these.
  const groupBursts = new Map();   // group id -> recent occurrence times
  const appLogs = createAppLogs({ db, log, onGroup: ({ group: g, isNew, reopened, ts }) => {
    const times = (groupBursts.get(g.id) || []).filter((x) => ts - x < 5 * MIN);
    times.push(ts);
    groupBursts.set(g.id, times);
    if (groupBursts.size > 2000) groupBursts.clear();
    if (g.status === 'known' || deploys.inDeploy(g.app, ts)) return;
    const name = (state.apps.find((a) => a.id === g.app) || {}).name || g.app;
    const detail = { summary: g.message || '', groupId: g.id, frame: g.frame || null };
    const key = `errgroup:${g.id}`;
    if (isNew) alerts.raise({ key, rule: 'errors', severity: 'warning', app: g.app, title: `${name}: new error — ${g.title}`, detail });
    else if (reopened) alerts.raise({ key, rule: 'errors', severity: 'warning', app: g.app, title: `${name}: ${g.title} is back (it was marked fixed)`, detail });
    else if (times.length >= 10) alerts.raise({ key, rule: 'errors', severity: 'warning', app: g.app, title: `${name}: ${g.title} — ${times.length} times in 5 min`, detail });
  } });
  let trafficStarted = false;

  const state = {
    startedAt: Date.now(),
    inventory: null,          // last gather()
    apps: [],
    checks: {},               // app id -> last result
    certs: [],
    findings: [],
    staticInfo: null,
    lastScanTs: null,
    authMode: null,
  };

  const appSignins = createAppSignins({ db, geoip, alerts, getSettings, appName: (id) => (id === 'pulse' ? 'Pulse' : (state.apps.find((a) => a.id === id) || {}).name || id) });

  const timers = [];
  const every = (ms, fn) => { const t = setInterval(() => Promise.resolve().then(fn).catch((e) => log.error('[monitor]', e.message)), ms); t.unref?.(); timers.push(t); };

  // ---------------------------------------------------------------- resources
  const windowSamples = [];  // last N minutes of compact samples, for "sustained" rules
  function onSample(s) {
    const th = getSettings().thresholds;
    windowSamples.push({ ts: s.ts, cpu: s.cpu, mem: s.mem });
    while (windowSamples.length && s.ts - windowSamples[0].ts > th.sustainMinutes * MIN) windowSamples.shift();
    const covered = windowSamples.length && s.ts - windowSamples[0].ts >= (th.sustainMinutes * MIN) * 0.9;

    for (const d of s.disks || []) {
      const key = `disk:${d.mount}`;
      if (d.pct >= th.diskCritPct) alerts.raise({ key, rule: 'disk', severity: 'critical', title: `Disk ${d.mount} is ${d.pct}% full`, detail: { summary: `${gb(d.size - d.used)} free of ${gb(d.size)}.`, mount: d.mount } });
      else if (d.pct >= th.diskWarnPct) alerts.raise({ key, rule: 'disk', severity: 'warning', title: `Disk ${d.mount} is ${d.pct}% full`, detail: { summary: `${gb(d.size - d.used)} free of ${gb(d.size)}.`, mount: d.mount } });
      else if (d.pct < th.diskWarnPct - 2) alerts.resolve(key);
    }
    if (covered) {
      const allHigh = (k, lim) => windowSamples.every((x) => x[k] >= lim);
      const allLow = (k, lim) => windowSamples.slice(-15).every((x) => x[k] < lim - 5);
      if (allHigh('cpu', th.cpuCritPct)) alerts.raise({ key: 'cpu', rule: 'cpu', severity: 'critical', title: `CPU above ${th.cpuCritPct}% for ${th.sustainMinutes} minutes`, detail: { summary: `Now ${s.cpu}%. Top: ${topProc()}` } });
      else if (allLow('cpu', th.cpuCritPct)) alerts.resolve('cpu');
      if (allHigh('mem', th.memCritPct)) alerts.raise({ key: 'memory', rule: 'memory', severity: 'critical', title: `Memory above ${th.memCritPct}% for ${th.sustainMinutes} minutes`, detail: { summary: `Now ${s.mem}%. Top: ${topProc()}` } });
      else if (allLow('mem', th.memCritPct)) alerts.resolve('memory');
    }
    if (s.swapTotal) {
      if (s.swap >= th.swapWarnPct) alerts.raise({ key: 'swap', rule: 'memory', severity: 'warning', title: `Swap ${s.swap}% used`, detail: { summary: `${gb(s.swapUsed)} of ${gb(s.swapTotal)} swap in use; RAM ${s.mem}% used.` } });
      else if (s.swap < th.swapWarnPct - 5) alerts.resolve('swap');
    }
  }
  function topProc() { const p = collector.processes()[0]; return p ? `${p.name} (${p.cpu}% CPU, ${p.mem}% mem)` : 'n/a'; }

  // ---------------------------------------------------------------- discovery
  let prevForDiff = null;
  async function discover() {
    const s = getSettings();
    const inv = await gather({ scanPath, overrides: s.appOverrides, sitesDir, optDir });
    const prev = state.inventory;

    // Live-line switches open a deploy window (and are an event in their own right).
    if (prev) {
      for (const [dir, v] of Object.entries(inv.live)) {
        const old = prev.live[dir];
        if (old && old.value !== v.value) {
          const app = (inv.apps.find((a) => a.liveFile === `/opt/${dir}/live`) || {}).id || dir;
          deploys.mark({ app, source: 'live-file', detail: { from: old.value, to: v.value } });
          store.addEvent(db, { kind: 'deploy', app, title: `${app}: live line switched ${old.value} → ${v.value}` });
        }
      }
    }

    // Diff against the previous inventory whenever the root scan is new.
    if (!prevForDiff) {
      const row = db.sql.get('SELECT data FROM inventory ORDER BY id DESC LIMIT 1');
      if (row) { try { prevForDiff = JSON.parse(row.data); } catch { /* corrupt row: start fresh */ } }
    }
    const scanTs = inv.scan && inv.scan.ts;
    const slimOf = (x) => ({ ts: x.ts, scan: x.scan, units: x.units, sites: x.sites, apps: x.apps.map((a) => ({ id: a.id })) });
    if (scanTs && scanTs !== state.lastScanTs) {
      const changes = discovery.diffInventories(prevForDiff, inv);
      // An app that went missing and is back: its "disappeared" alert closes.
      for (const a of inv.apps) alerts.resolve(`app-gone:${a.id}`, 'back on the server');
      onInventoryChanges(changes, inv);
      const slim = slimOf(inv);
      db.sql.run('INSERT INTO inventory (ts, data) VALUES (?, ?)', inv.ts, JSON.stringify(slim));
      prevForDiff = slim;
      state.lastScanTs = scanTs;
      if (!prev) store.addEvent(db, { kind: 'inventory', title: `Inventory: ${inv.apps.filter((a) => a.kind === 'app').length} apps, ${inv.apps.filter((a) => a.kind === 'database').length} databases found` });
    } else if (prevForDiff) {
      // Between scans: services, sites and apps Pulse can see for itself are
      // compared every minute, so a new app is noticed in about a minute.
      // Only what ARRIVED counts here. Something gone is still judged by the
      // hourly scan, as before: a service mid-restart must not read as an app
      // that disappeared.
      const changes = discovery.diffInventories(prevForDiff, inv, discovery.LIVE_KINDS).filter((c) => c.op === 'added');
      if (changes.length) {
        for (const a of inv.apps) alerts.resolve(`app-gone:${a.id}`, 'back on the server');
        onInventoryChanges(changes, inv);
        // Keep the root half of the last scan; add what arrived to the live
        // half (nothing is dropped, so the hourly diff still sees removals).
        const union = (a = [], b = [], key) => { const seen = new Set(a.map(key)); return [...a, ...b.filter((x) => !seen.has(key(x)))]; };
        const now = slimOf(inv);
        const slim = { ts: inv.ts, scan: prevForDiff.scan,
          units: union(prevForDiff.units, now.units, (u) => u.unit),
          sites: union(prevForDiff.sites, now.sites, (h) => h.serverName),
          apps: union(prevForDiff.apps, now.apps, (a) => a.id) };
        db.sql.run('INSERT INTO inventory (ts, data) VALUES (?, ?)', inv.ts, JSON.stringify(slim));
        prevForDiff = slim;
        // Something new: ask for a root scan so its port and owner are known now.
        if (changes.some((c) => c.op === 'added')) askForScan('new service or site');
      }
    }
    // A port is listening that the last scan didn't see: scan again now
    // rather than in up to an hour.
    if (inv.scan && inv.scan.ports) {
      const known = new Set(inv.scan.ports.map((p) => p.port));
      // Each unknown port is asked about once: one the scan can't attribute
      // must not trigger a scan every 10 minutes forever.
      const fresh = discovery.readListeningPorts(procRoot).filter((p) => !known.has(p) && !askedPorts.has(p));
      if (fresh.length && askForScan(`new listening port ${fresh.slice(0, 3).join(', ')}`)) fresh.forEach((p) => askedPorts.add(p));
    }

    state.inventory = inv;
    state.apps = inv.apps;
    if (enableLogs) {
      appLogs.follow(inv.apps);
      if (!trafficStarted) trafficStarted = traffic.start(inv.sites);
    }
    state.findings = discovery.findings(inv);

    // Backups and the scan itself.
    const th = s.thresholds;
    for (const a of inv.apps) {
      // Alerts used to be keyed by folder; a release-copy folder could look
      // "196 hours old" while the app backed itself up every day elsewhere.
      for (const x of a.backupSources || []) alerts.resolve(`backup:${x.dir}`, 'now judged per app, across all its backups');
      if (!a.backups || !a.backups.newestTs || a.watched === false) continue;
      const ageH = (Date.now() - a.backups.newestTs) / 3600_000;
      const key = `backup:${a.id}`;
      const where = (a.backupSources || []).map((x) => x.dir).join(', ');
      if (ageH > th.backupMaxAgeHours) alerts.raise({ key, rule: 'backup', severity: 'warning', app: a.id, title: `${a.name}: newest backup is ${Math.floor(ageH)} hours old`, detail: { summary: `Newest: ${a.backups.newest} in ${a.backups.dir}. Looked in: ${where}. Pulse → Backups → Back up now.` } });
      else alerts.resolve(key);
      // The newest backup the app made itself must open, intact.
      const bad = (a.backupSources || []).find((x) => x.check && x.check.result === 'bad');
      const ckey = `backup-check:${a.id}`;
      if (bad) alerts.raise({ key: ckey, rule: 'backup', severity: 'warning', app: a.id, title: `${a.name}: its newest backup failed its database check`, detail: { summary: `${bad.check.newest} in ${bad.dir}: ${bad.check.detail}` } });
      else alerts.resolve(ckey);
    }
    if (inv.scan && inv.scan.ts && Date.now() - inv.scan.ts > 3 * 3600_000) alerts.raise({ key: 'scan:stale', rule: 'scan', severity: 'warning', title: 'The hourly inventory scan has stopped', detail: { summary: 'Check pulse-scan.timer: systemctl status pulse-scan.timer' } });
    else if (inv.scan) alerts.resolve('scan:stale');
    bus.emit('inventory', { ts: inv.ts });
    return inv;
  }

  // Root scans asked for outside the hourly timer: at most one every 10 minutes.
  let lastScanAsk = 0;
  const askedPorts = new Set();
  function askForScan(why) {
    if (typeof requestScan !== 'function' || Date.now() - lastScanAsk < 10 * MIN) return false;
    lastScanAsk = Date.now();
    log.log(`[discovery] asking for an inventory scan now: ${why}`);
    Promise.resolve(requestScan()).then(() => discover()).catch((e) => log.error('[discovery] scan request', e.message));
    return true;
  }

  // A new app arrives as several changes at once (its service, its site, its
  // port, and the app itself). That is one message: "New app found", not four.
  function partOfNewApp(c, newApps) {
    if (c.op !== 'added' || !newApps.length) return false;
    if (c.kind === 'service') return newApps.some((a) => (a.units || []).some((u) => u.unit === c.key));
    if (c.kind === 'site') return newApps.some((a) => (a.domains || []).includes(c.key));
    if (c.kind === 'port') return newApps.some((a) => (a.ports || []).includes(Number(String(c.key).split(' ')[0])));
    return false;
  }
  function onInventoryChanges(changes, inv) {
    const newApps = changes.filter((c) => c.kind === 'app' && c.op === 'added')
      .map((c) => inv.apps.find((a) => a.id === c.key)).filter(Boolean);
    for (const c of changes) {
      if (c.kind === 'app' && c.op === 'added') continue;
      if (partOfNewApp(c, newApps)) { store.addEvent(db, { kind: 'inventory', severity: 'info', title: c.title, detail: c }); continue; }
      onInventoryChange(c, inv);
    }
    for (const a of newApps) newAppFound(a);
  }
  function newAppFound(a) {
    const how = a.runner === 'pm2' ? `PM2 app "${a.runnerName}"` : a.runner === 'docker' ? `Docker container "${a.runnerName}"` : a.runner === 'process' ? `a program running from ${a.cwd}` : (a.units || []).length ? `service ${a.units.map((u) => u.unit).join(', ')}` : 'its Apache site';
    const where = [a.domains && a.domains.length ? a.domains.join(', ') : null, a.ports && a.ports.length ? `port ${a.ports.join(', ')}` : null].filter(Boolean).join(' · ');
    store.addEvent(db, { kind: 'inventory', severity: 'info', app: a.id, title: `New app found: ${a.name}`, detail: { app: a.id, how, where } });
    if (a.kind !== 'app' || a.watched === false) return;
    // Not held during a release: a new app is news, not noise.
    alerts.raise({ key: `app-new:${a.id}`, rule: 'inventory', severity: 'warning', app: a.id, title: `New app found: ${a.name}`,
      detail: { summary: `Pulse found it by itself (${how}${where ? `; ${where}` : ''}) and is watching it now: health checks, errors, sign-ins and backups. Rename it or switch it off on its page in Apps.` } });
  }

  function onInventoryChange(c, inv) {
    store.addEvent(db, { kind: 'inventory', severity: c.severity, title: c.title, detail: c });
    // New ways in are access events, graded and alerted like a login.
    if (c.op === 'added' && (c.kind === 'key' || c.kind === 'user' || c.kind === 'sudoer')) {
      const [user, fp] = c.key.split('\t');
      handleAccess({ kind: `${c.kind === 'sudoer' ? 'sudoer' : c.kind}_added`, user, fingerprint: fp || null, ts: Date.now(), raw: c.title, fromScan: true });
      return;
    }
    if (c.kind === 'app' && c.op === 'removed' && (getSettings().appOverrides[c.key] || {}).watch !== false) {
      alerts.raise({ key: `app-gone:${c.key}`, rule: 'inventory', severity: 'critical', app: c.key, title: `App disappeared: ${c.key}`, detail: { summary: 'Its service, port or site is no longer on the server.' } });
      return;
    }
    if (c.severity === 'warning' || c.severity === 'critical') {
      // One alert per scan round for everything else that changed, so a busy
      // deploy produces one message, not twelve.
      const held = deploys.inDeploy();
      if (!held) alerts.raise({ key: `inventory:${c.kind}:${c.op}:${c.key}`, rule: 'inventory', severity: 'warning', title: c.title, detail: { summary: 'Found by the hourly inventory scan.' } });
    }
  }

  // ---------------------------------------------------------------- checks
  const lastRestarts = {};
  async function runChecks() {
    const th = getSettings().thresholds;
    const watched = state.apps.filter((a) => a.watched !== false);
    const results = await checker.checkAll(watched);
    const t = Date.now();
    // Switched-off apps: no check, and anything open about them is closed.
    for (const a of state.apps) {
      if (a.watched !== false) continue;
      state.checks[a.id] = { app: a.id, ts: t, kind: a.kind, ok: null, status: 'off', failures: 0 };
      for (const k of ['health', 'restarts', 'traffic', 'errors']) alerts.resolve(`${k}:${a.id}`, 'monitoring switched off');
      if (a.backups && a.backups.dir) alerts.resolve(`backup:${a.backups.dir}`, 'monitoring switched off');
      delete lastRestarts[a.id];
    }
    for (const r of results) {
      const app = state.apps.find((a) => a.id === r.app) || { id: r.app, name: r.app };
      state.checks[r.app] = r;
      if (r.ok !== null) db.sql.run('INSERT INTO check_results (app, ts, ok, ms, status, error) VALUES (?, ?, ?, ?, ?, ?)', r.app, t, r.ok ? 1 : 0, r.ms ?? null, typeof r.status === 'number' ? r.status : null, r.error || null);
      const key = `health:${r.app}`;
      if (r.ok === false && r.failures >= th.healthFailuresBeforeAlert) {
        if (deploys.inDeploy(r.app)) continue;   // a planned restart
        alerts.raise({ key, rule: 'health', severity: 'critical', app: r.app, title: `${app.name} is down`, detail: { summary: r.error || 'Health check failed', port: r.port, path: r.path || null, failures: r.failures } });
      } else if (r.ok) alerts.resolve(key, `answered in ${r.ms} ms`);

      // Restarts outside a deploy mean it crashed and systemd brought it back.
      const prev = lastRestarts[r.app];
      if (prev !== undefined && r.restarts > prev && !deploys.inDeploy(r.app)) {
        alerts.raise({ key: `restarts:${r.app}`, rule: 'restarts', severity: 'warning', app: r.app, title: `${app.name} restarted on its own (${r.restarts - prev}×)`, detail: { summary: 'systemd restarted the service. Check its journal for the crash.' } });
      }
      lastRestarts[r.app] = r.restarts;
      noteVersion(app, r, t);
    }
    bus.emit('checks', { ts: t, results });
    return results;
  }

  // Apps that report their version on their health check (Budget, IFAIMA...):
  // a new version is a release, kept on the app's timeline and its charts.
  function noteVersion(app, r, t = Date.now()) {
    const v = r && r.ok && r.health && r.health.version != null ? String(r.health.version).slice(0, 40) : null;
    if (!v) return;
    const row = db.sql.get('SELECT version FROM app_versions WHERE app = ?', app.id);
    if (!row) { db.sql.run('INSERT INTO app_versions (app, version, seen_at) VALUES (?, ?, ?)', app.id, v, t); return; }
    if (row.version === v) return;
    db.sql.run('UPDATE app_versions SET prev = version, version = ?, seen_at = ?, changed_at = ? WHERE app = ?', v, t, t, app.id);
    deploys.mark({ app: app.id, source: 'version', detail: { from: row.version, to: v }, ts: t, quiet: true });
    store.addEvent(db, { ts: t, kind: 'deploy', app: app.id, title: `${app.name} updated to ${v} (was ${row.version})`, detail: { from: row.version, to: v } });
  }
  function appVersions() {
    return Object.fromEntries(db.sql.all('SELECT * FROM app_versions').map((x) => [x.app, { version: x.version, prev: x.prev || null, changedAt: x.changed_at || null }]));
  }

  async function runCerts() {
    const th = getSettings().thresholds;
    state.certs = await checkCerts(state.apps.filter((a) => a.watched !== false));
    const days = [...th.sslDays].sort((a, b) => a - b);   // 3, 14, 30
    for (const c of state.certs) {
      const key = `ssl:${c.domain}`;
      if (c.daysLeft == null) continue;
      const band = days.find((d) => c.daysLeft <= d);
      if (band !== undefined) alerts.raise({ key, rule: 'ssl', severity: band <= days[0] ? 'critical' : 'warning', app: c.app, title: `Certificate for ${c.domain} expires in ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'}`, detail: { summary: 'certbot renews automatically; if this persists, run: sudo certbot renew --dry-run' } });
      else alerts.resolve(key);
    }
  }

  // ---------------------------------------------------------------- forecast
  function runForecast(now = Date.now()) {
    const rows = db.sql.all('SELECT ts, disk FROM m_1h WHERE ts >= ? ORDER BY ts', now - 7 * 86400_000);
    state.forecast = diskForecast(rows, now);
    const f = state.forecast;
    if (f && f.daysLeft <= 30) alerts.raise({ key: 'forecast:disk', rule: 'forecast', severity: f.daysLeft <= 7 ? 'critical' : 'warning', title: `Disk will be full in about ${f.daysLeft} days`, detail: { summary: `Growing about ${f.perDay}% a day over the last week.` } });
    else alerts.resolve('forecast:disk');
    return f;
  }

  // ---------------------------------------------------------------- traffic + app errors
  function vhostsOf(a) { return (a.domains || []).filter((d) => !d.startsWith('*')).map((d) => d.toLowerCase()); }

  function evaluateLogs(now = Date.now()) {
    traffic.flush(now);
    // An error alert closes once that error has been quiet for 30 minutes.
    for (const a of alerts.list().filter((x) => x.key.startsWith('errgroup:'))) {
      const g = db.sql.get('SELECT last_seen, status FROM error_groups WHERE id = ?', Number(a.key.slice(9)));
      if (!g || now - g.last_seen > 30 * MIN || g.status === 'known') alerts.resolve(a.key, g && g.status === 'known' ? 'marked known' : 'quiet for 30 minutes');
    }
    for (const a of state.apps) {
      if (a.kind !== 'app' || a.watched === false) continue;
      const v = vhostsOf(a);
      if (v.length) {
        const rows = traffic.series(v, now - 5 * MIN, now);
        const tot = rows.reduce((acc, r) => ({ n: acc.n + r.n, s5: acc.s5 + r.s5 }), { n: 0, s5: 0 });
        const verdict = judgeErrors(tot);
        const key = `traffic:${a.id}`;
        if ((verdict === 'warning' || verdict === 'critical') && !deploys.inDeploy(a.id, now)) {
          alerts.raise({ key, rule: 'traffic', severity: verdict, app: a.id, title: `${a.name}: ${Math.round((tot.s5 / tot.n) * 100)}% of requests failing (5xx)`, detail: { summary: `${tot.s5} of ${tot.n} requests in the last 5 minutes got a server error.` } });
        } else if (verdict === 'clear' || tot.s5 === 0) alerts.resolve(key);
      }
      // Older per-app error alerts (before error groups) are closed for good.
      alerts.resolve(`errors:${a.id}`, 'replaced by per-error alerts');
    }
  }

  // ---------------------------------------------------------------- access
  const burst = trust.createBurstCounter({ threshold: getSettings().thresholds.failedBurstCount, windowMs: getSettings().thresholds.failedBurstMinutes * MIN });
  const lastLoginByUser = new Map();   // user -> { ts, grade }

  function sources() { return db.sql.all('SELECT * FROM trusted_sources'); }

  // Session memory survives a restart: without this, the first sudo after
  // Pulse restarts (say, during its own release) would look like sudo with no
  // SSH login behind it — an urgent false alarm.
  function restoreSessions(now = Date.now()) {
    const rows = db.sql.all(`SELECT user, ts, grade FROM access_events a WHERE kind = 'ssh_login' AND ts > ?
      AND ts = (SELECT MAX(ts) FROM access_events b WHERE b.kind = 'ssh_login' AND b.user = a.user)`, now - SESSION_WINDOW);
    for (const r of rows) lastLoginByUser.set(r.user, { ts: r.ts, grade: r.grade });
    return rows.length;
  }

  function handleAccess(ev) {
    const s = getSettings();
    const ts = ev.ts || Date.now();
    const country = ev.ip ? geoip.country(ev.ip) : null;

    if (ev.kind === 'ssh_failed') {
      const b = burst(ev.ip, ts);
      db.sql.run('INSERT INTO access_events (ts, kind, user, ip, method, country, grade, reason, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ts, ev.kind, ev.user || null, ev.ip, ev.method || null, country, 'failed', ev.invalidUser ? 'invalid user' : 'failed', String(ev.raw || '').slice(0, 300));
      if (b.burst) {
        alerts.raise({ key: `burst:${ev.ip}`, rule: 'access-burst', severity: 'warning', title: `${b.count} failed SSH logins from ${ev.ip}${country ? ` (${country})` : ''} in ${s.thresholds.failedBurstMinutes} min`, detail: { summary: 'Password logins are off, so these cannot succeed by guessing; fail2ban should ban the IP.', ip: ev.ip, country } });
      }
      bus.emit('access', { kind: ev.kind, ts });
      return null;
    }

    const userLast = ev.user ? lastLoginByUser.get(ev.user) : null;
    const recentLogin = userLast && ts - userLast.ts < SESSION_WINDOW ? userLast : null;
    const inDeploy = deploys.inDeploy(null, ts);
    const g = trust.grade(ev, { sources: sources(), inDeploy, country, usualCountries: s.usualCountries || ['GH', 'CA'], recentLogin });

    // A deploy-shaped sudo from a trusted session opens a deploy window.
    if (ev.kind === 'sudo' && g.grade !== 'urgent' && trust.DEPLOY_COMMAND.test(ev.command || '')) {
      deploys.mark({ app: deploys.appFromCommand(ev.command, state.apps), source: 'sudo', detail: { user: ev.user, command: ev.command }, ts });
      if (g.grade === 'quiet') g.grade = 'release';
    }
    if (ev.kind === 'ssh_login') lastLoginByUser.set(ev.user, { ts, grade: g.grade });

    const r = db.sql.run(
      'INSERT INTO access_events (ts, kind, user, ip, method, fingerprint, country, grade, reason, source_id, command, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ts, ev.kind, ev.user || null, ev.ip || null, ev.method || null, ev.fingerprint || null, country, g.grade, g.reason, g.sourceId, ev.command || null, String(ev.raw || '').slice(0, 500));
    const accessId = Number(r.lastInsertRowid);

    const who = describe(ev, country);
    if (g.grade !== 'quiet') store.addEvent(db, { ts, kind: 'access', severity: g.severity, title: who, detail: { accessId, grade: g.grade, reason: g.reason } });

    if (g.grade === 'urgent' || g.grade === 'normal') {
      alerts.raise({
        key: `access:${accessId}`, rule: 'access', severity: g.severity, accessId,
        title: who, detail: { summary: `${g.reason}. Was this you?`, when: fmtTimes(ts, displayZones(db, s, ts)), ip: ev.ip, country, fingerprint: ev.fingerprint, command: ev.command },
      });
    }
    bus.emit('access', { kind: ev.kind, ts, grade: g.grade });
    return { accessId, ...g };
  }

  function describe(ev, country) {
    const where = ev.ip ? ` from ${ev.ip}${country && country !== 'LAN' ? ` (${country})` : ''}` : '';
    switch (ev.kind) {
      case 'ssh_login': return `SSH login: ${ev.user}${where}${ev.method && ev.method !== 'publickey' ? ` with a ${ev.method}` : ''}`;
      case 'sudo': return `sudo by ${ev.user}: ${String(ev.command || '').slice(0, 80)}`;
      case 'sudo_failed': return `Failed sudo by ${ev.user}`;
      case 'user_added': return `New login user: ${ev.user}`;
      case 'key_added': return `New SSH key for ${ev.user}`;
      case 'sudoer_added': return `${ev.user} was given sudo`;
      case 'user_changed': return `Account changed: ${ev.user}${ev.change ? ` (${ev.change})` : ''}${ev.group ? ` → group ${ev.group}` : ''}`;
      case 'dashboard_login': return `Pulse sign-in from a new device: ${ev.user}${where}`;
      default: return `${ev.kind}: ${ev.user || ''}`;
    }
  }

  // "Yes, trust this" — remember the network the alert came from.
  // days: 1, 7, 30, or 0 for always. A hotel or airport network should lapse
  // on its own; home and office can be "always".
  function trustFromAlert(alertId, by, days = 7) {
    const a = alerts.get(alertId);
    if (!a || !a.access_id) return null;
    const ev = db.sql.get('SELECT * FROM access_events WHERE id = ?', a.access_id);
    if (!ev || !ev.ip) return null;
    const cidr = trust.networkOf(ev.ip);
    if (!cidr) return null;
    const d = [0, 1, 7, 30].includes(Number(days)) ? Number(days) : 7;
    const until = d ? Date.now() + d * 86400_000 : null;
    const exists = db.sql.get("SELECT id, label, expires_at FROM trusted_sources WHERE kind = 'network' AND value = ?", cidr);
    if (exists) {
      // Already listed: extend it if this asks for longer (or it had lapsed).
      const longer = exists.expires_at && (until === null || until > exists.expires_at);
      if (longer) {
        db.sql.run('UPDATE trusted_sources SET expires_at = ? WHERE id = ?', until, exists.id);
        store.addEvent(db, { kind: 'access', severity: 'warning', title: `Trusted list changed: ${exists.label} now ${until ? `until ${new Date(until).toISOString().slice(0, 10)}` : 'always'}`, detail: { by } });
      }
      return { id: exists.id, cidr, label: exists.label, existed: true, renewed: !!longer, expiresAt: longer ? until : exists.expires_at };
    }
    const label = `Network ${cidr}${ev.country ? ` (${ev.country})` : ''}`;
    const r = db.sql.run("INSERT INTO trusted_sources (kind, label, value, expires_at, created_at, created_by) VALUES ('network', ?, ?, ?, ?, ?)", label, cidr, until, Date.now(), by || 'alert');
    store.addEvent(db, { kind: 'access', severity: 'warning', title: `Trusted list changed: added ${label}${until ? ` for ${d} day${d === 1 ? '' : 's'}` : ''}`, detail: { by } });
    return { id: Number(r.lastInsertRowid), cidr, label, expiresAt: until, days: d };
  }

  // ---------------------------------------------------------------- digest
  function digest(sinceMs = 24 * 3600_000) {
    const since = Date.now() - sinceMs;
    const byGrade = db.sql.all('SELECT grade, COUNT(*) n FROM access_events WHERE ts >= ? GROUP BY grade', since);
    const digestLines = db.sql.all("SELECT * FROM access_events WHERE ts >= ? AND grade = 'digest' ORDER BY ts", since);
    const failed = db.sql.get("SELECT COUNT(*) n, COUNT(DISTINCT ip) ips FROM access_events WHERE ts >= ? AND kind = 'ssh_failed'", since);
    const opened = db.sql.all('SELECT * FROM alerts WHERE opened_at >= ? ORDER BY opened_at', since).map(store.parseDetail);
    const deps = deploys.recent(since);
    return {
      since, quietLogins: (byGrade.find((g) => g.grade === 'quiet') || {}).n || 0,
      releaseEvents: (byGrade.find((g) => g.grade === 'release') || {}).n || 0,
      digestLines, failed, opened, deploys: deps, active: alerts.list(), findings: state.findings,
      latest: collector.latest(),
    };
  }

  // ---------------------------------------------------------------- lifecycle
  async function start() {
    restoreSessions();
    deploys.restore();
    collector.start();
    bus.on('sample', onSample);
    state.staticInfo = await collector.staticInfo().catch(() => null);
    const g = await geoip.load(geoipPath).catch((e) => ({ ok: false, reason: e.message }));
    if (!g.ok) log.log(`[geoip] ${g.reason} — countries will read "unknown"`);
    await discover().catch((e) => log.error('[discovery]', e.message));
    await runChecks().catch((e) => log.error('[checks]', e.message));
    runCerts().catch((e) => log.error('[certs]', e.message));
    every(MIN, discover);
    every(30_000, runChecks);
    every(6 * 60 * MIN, runCerts);
    every(MIN, () => alerts.sweep());
    every(60 * MIN, () => { store.prune(db); appLogs.prune(); appSignins.prune(); });
    every(MIN, evaluateLogs);
    runForecast();
    every(60 * MIN, runForecast);
    every(7 * 24 * 60 * MIN, () => geoip.load(geoipPath));   // the file changes monthly; setInterval cannot wait 30 days
    if (enableAuthWatch) {
      const w = createAuthWatcher({ onEvent: (ev) => { try { handleAccess(ev); } catch (e) { log.error('[access]', e.message); } }, log });
      w.start();
      state.authWatcher = w;
    }
  }

  function stop() {
    timers.forEach(clearInterval);
    collector.stop();
    bus.off('sample', onSample);
    if (state.authWatcher) state.authWatcher.stop();
    traffic.stop();
    appLogs.stop();
  }

  return {
    start, stop, state, collector, checker, deploys, alerts, appSignins, discover, runChecks, runCerts,
    handleAccess, trustFromAlert, digest, sources, onSample, restoreSessions, traffic, appLogs, evaluateLogs, vhostsOf, runForecast,
    appVersions, askForScan, noteVersion,
    authMode: () => (state.authWatcher ? state.authWatcher.mode() : null),
  };
}

function gb(bytes) { return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }

module.exports = { createMonitor };
