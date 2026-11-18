// Backups, per app: what exists, whether it is fresh, checked and off-site,
// and "Back up now" / a nightly run through the root helper.
//
// What a Pulse backup contains is fixed in scripts/pulse-backup.sh (root).
// PLANS below only DESCRIBE those plans for the page; keep the two in step.
// Results come back as JSON lines in /var/lib/pulse-scan/backups/<app>.jsonl,
// written by root; Pulse never reads the archives themselves.
'use strict';
const fs = require('fs');
const path = require('path');
const bus = require('./bus');
const store = require('./store');

const PLANS = {
  'aotc-track': { folder: 'AOTC-Track', method: 'files', includes: ['Records database (safe snapshot, checked)', 'data/ — settings, member photos', 'public/uploads', 'document-files, marriage-files', 'minutes'] },
  'smart-deontech': { folder: 'Smart-DeonTech', method: 'files', includes: ['data/ (databases snapshotted and checked)', 'public/uploads'] },
  ginasangel: { folder: 'GinasAngel-Hub', method: 'files', includes: ['/opt/ginasangel/data (databases snapshotted and checked)', 'app/public/uploads'] },
  ifaima: { folder: 'IFAIMA', method: 'ifaima', includes: ["Runs IFAIMA's own verified backup (ifaima-backup.service)", 'Database snapshot + its files, then checked'] },
  pledge: { folder: 'Pledges', method: 'mysql', includes: ['MySQL database pledgedb (full dump)'] },
  pman: { folder: 'Pman', method: 'mysql', includes: ['MySQL database pmandb (full dump)'] },
  mysql: { folder: 'Databases', method: 'mysql', includes: ['Every MySQL database except the system ones (pcgaotdb, pledgedb, pmandb …)'] },
  'mssql-server': { folder: 'SQL-Server', method: 'mssql', includes: ['Every SQL Server user database (HangfireDb, the Pledges app\u2019s job queue, and any added later)', 'Written by SQL Server itself WITH CHECKSUM (every page checked) and COPY_ONLY'] },
  rondoq: { folder: 'RondoQ', method: 'rondoq', offsiteBy: 'app', maxDays: 30, includes: ["Runs RondoQ's own checked backup (rondoq-backup.service): its database dump, read back before it counts, and its uploads", "Off-site: RondoQ's own ENCRYPTED copy to OneDrive \u2192 RondoQ/Backups, once its key exists (sudo bash /opt/rondoq/bin/offsite-key.sh). Pulse never sends RondoQ's records off-site itself", 'Copies kept no longer than 30 days (RondoQ erases deleted organisations within 60 days)'] },
  postgresql: { folder: 'PostgreSQL', method: 'postgres', maxDays: 30, includes: ['Every PostgreSQL database in every running cluster (pg_dump), each read back before it counts', "Except databases an app backs up itself: RondoQ's (its plan, encrypted off-site)", 'Copies kept no longer than 30 days'] },
  pulse: { folder: 'DeonTech-Pulse', method: 'files', includes: ['Pulse\u2019s database (safe snapshot, checked): readings, alerts, sign-ins, trusted list, logins', 'settings.json', 'Not its secrets (/etc/pulse.env) — those never leave the server'] },
};
// Things Pulse knows it cannot back up (or back up off-site), and why.
const NOTES = {
  'mssql-server': 'Needs a SQL Server login for backups, once: on the server run  sudo bash /opt/pulse/scripts/set-mssql-login.sh  (it asks for the sa password once and stores only a backup-only login).',
  rondoq: "Off-site copies are RondoQ's own and encrypted: they start once RondoQ's key exists (on the server: sudo bash /opt/rondoq/bin/offsite-key.sh). The Off-site switch has no effect for RondoQ.",
};

const ROLE_LABEL = {
  own: 'Made by the app itself',
  scheduled: 'Nightly job on the server',
  release: 'Copies taken before each release',
  pulse: 'Made by Pulse',
};

function createBackups({ monitor, actions, db, getSettings, updateSettings, manifestDir = process.env.PULSE_BACKUP_MANIFEST || '/var/lib/pulse-scan/backups', log = console, now = () => Date.now() }) {
  const running = new Map();   // app -> { startedAt, offsite, by, nightly }

  function history(app, n = 15) {
    try {
      const lines = fs.readFileSync(path.join(manifestDir, `${app}.jsonl`), 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .map((r) => ({ ...r, file: r.file ? path.basename(r.file) : null }));   // the path is root's business
    } catch { return []; }
  }

  function schedule() {
    const s = getSettings();
    return { time: s.backupTime || '01:40', apps: s.backupSchedule || {}, lastNightly: s.backupLastNightly || null };
  }

  // One app's picture.
  function status(a) {
    const th = getSettings().thresholds;
    const maxAge = (th.backupMaxAgeHours || 26) * 3600_000;
    const t = now();
    const hist = history(a.id);
    const lastPulse = hist[0] || null;
    const sources = (a.backupSources || []).map((x) => ({
      role: x.role, label: ROLE_LABEL[x.role] || x.role, dir: x.dir, count: x.count, bytes: x.bytes, newest: x.newest, newestTs: x.newestTs,
      check: x.check ? { result: x.check.result, databases: x.check.databases, newest: x.check.newest, detail: x.check.detail } : null,
    }));
    // A Pulse run just now is not in the hourly scan yet; the record says so.
    if (lastPulse && lastPulse.ok && !sources.some((x) => x.role === 'pulse')) {
      sources.push({ role: 'pulse', label: ROLE_LABEL.pulse, dir: `/var/backups/pulse/${a.id}`, count: hist.filter((h) => h.ok).length, bytes: lastPulse.bytes, newest: lastPulse.file, newestTs: lastPulse.ts, check: { result: 'ok', databases: null, detail: null } });
    }
    const regular = sources.filter((x) => x.role !== 'release' && x.newestTs);
    const newestTs = Math.max(0, ...regular.map((x) => x.newestTs), ...(lastPulse && lastPulse.ok ? [lastPulse.ts] : [])) || null;
    const recentPulseOff = hist.find((h) => h.ok && (h.offsite || []).some((o) => o.ok) && t - h.ts < 3 * 86400_000);
    const offsite = {
      nightly: a.offsite || null,
      pulse: recentPulseOff ? { ts: recentPulseOff.ts, remotes: recentPulseOff.offsite.filter((o) => o.ok).map((o) => o.remote) } : null,
    };
    const bad = sources.find((x) => x.check && x.check.result === 'bad');
    const plan = PLANS[a.id] || null;
    let verdict;
    if (!newestTs) verdict = 'none';
    else if (t - newestTs > maxAge) verdict = 'stale';
    else if (bad) verdict = 'bad';
    else if (!offsite.nightly && !offsite.pulse) verdict = 'local';
    else verdict = 'ok';
    const sch = schedule().apps[a.id] || {};
    return {
      id: a.id, name: a.name, kind: a.kind, watched: a.watched !== false,
      verdict, newestTs, sources, offsite, plan, note: NOTES[a.id] || null,
      history: hist, running: running.get(a.id) || null,
      schedule: { nightly: !!sch.nightly, offsite: sch.offsite !== false },
    };
  }

  // Pulse is not one of the apps it watches, but its own records deserve a
  // backup like any other.
  function pulseSelf() {
    return { id: 'pulse', name: 'DeonTech Pulse', kind: 'app', watched: true, backupSources: [], offsite: null };
  }
  function findApp(appId) {
    return (monitor.state.apps || []).find((x) => x.id === appId) || (appId === 'pulse' ? pulseSelf() : null);
  }

  function list() {
    const apps = (monitor.state.apps || []).filter((a) => a.kind === 'app' || PLANS[a.id] || (a.kind === 'database' && (a.listening || []).length) || (a.backupSources || []).length);
    if (!apps.some((a) => a.id === 'pulse')) apps.push(pulseSelf());
    return apps.map(status).sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) : x.kind === 'app' ? -1 : 1));
  }

  // Start one; returns at once. The result arrives through the record file.
  function run(appId, { offsite = false, by = 'pulse', nightly = false } = {}) {
    const a = findApp(appId);
    if (!a) return { error: 'No such app.', status: 404 };
    if (!PLANS[appId]) return { error: NOTES[appId] || `Pulse has no backup plan for ${a.name}.`, status: 400 };
    if (running.has(appId)) return { error: `A backup of ${a.name} is already running.`, status: 409 };
    const r = { startedAt: now(), offsite: !!offsite, by, nightly };
    running.set(appId, r);
    bus.emit('backup', { app: appId, state: 'started' });
    const done = actions.backup(appId, !!offsite).then((res) => {
      running.delete(appId);
      const rec = history(appId, 1)[0];
      const ok = res.ok && rec && rec.ok;
      const offFail = rec && (rec.offsite || []).filter((o) => !o.ok);
      store.addEvent(db, { kind: 'system', app: appId, severity: ok ? 'info' : 'warning', title: `${a.name}: ${nightly ? 'nightly ' : ''}backup ${ok ? 'done' : 'failed'}${ok && offsite ? (offFail && offFail.length ? ' (off-site copy failed)' : ' and copied off-site') : ''}`, detail: { by, output: String(res.output || '').slice(-2000) } });
      if (!ok) monitor.alerts.raise({ key: `backup-run:${appId}`, rule: 'backup', severity: 'warning', app: appId, title: `${a.name}: backup failed`, detail: { summary: (rec && rec.error) || String(res.output || '').split('\n').slice(-2).join(' ').slice(0, 200) } });
      else {
        monitor.alerts.resolve(`backup-run:${appId}`, 'a later backup worked');
        if (offFail && offFail.length) monitor.alerts.raise({ key: `backup-offsite:${appId}`, rule: 'backup', severity: 'warning', app: appId, title: `${a.name}: off-site copy failed`, detail: { summary: offFail.map((o) => `${o.remote} ${o.error || ''}`).join('; ').slice(0, 200) } });
        else if (offsite) monitor.alerts.resolve(`backup-offsite:${appId}`, 'a later copy worked');
      }
      bus.emit('backup', { app: appId, state: ok ? 'done' : 'failed' });
      return { ok, output: res.output, record: rec || null };
    }, (e) => { running.delete(appId); log.error('[backups]', e.message); bus.emit('backup', { app: appId, state: 'failed' }); return { ok: false, output: e.message }; });
    return { started: true, startedAt: r.startedAt, done };
  }

  function setSchedule(appId, { nightly, offsite }) {
    if (!PLANS[appId]) return null;
    const cur = { ...(getSettings().backupSchedule || {}) };
    cur[appId] = { nightly: !!nightly, offsite: offsite !== false };
    updateSettings({ backupSchedule: cur });
    return cur[appId];
  }

  // Called every minute. At the set time (first time zone, like the digest),
  // the apps with "nightly" on are backed up one after another.
  let nightlyBusy = false;
  async function tick(t = now()) {
    const s = getSettings();
    const tz = (s.timezones || ['Africa/Accra'])[0];
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const hm = `${parts.hour}:${parts.minute}`;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (nightlyBusy || hm !== (s.backupTime || '01:40') || s.backupLastNightly === day) return null;
    const apps = Object.entries(s.backupSchedule || {}).filter(([id, v]) => v && v.nightly && PLANS[id]).map(([id, v]) => [id, v]);
    updateSettings({ backupLastNightly: day });
    if (!apps.length) return [];
    nightlyBusy = true;
    const results = [];
    try {
      for (const [id, v] of apps) {
        const r = run(id, { offsite: v.offsite !== false, by: 'nightly', nightly: true });
        results.push(id);
        if (r.done) await r.done;
      }
    } finally { nightlyBusy = false; }
    return results;
  }

  return { list, status, run, history, setSchedule, schedule, tick, PLANS, running };
}

module.exports = { createBackups, PLANS, NOTES };
