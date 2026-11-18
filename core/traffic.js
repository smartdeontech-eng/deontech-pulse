// Phase 2: web traffic and error rates, from Apache's own access logs.
//
// Follows /var/log/apache2/*access*.log (readable by the `adm` group) with
// `tail -F`. Lines in Ubuntu's `vhost_combined` format carry the site name;
// plain `combined` lines are attributed by which file they came from, using
// the CustomLog lines in the enabled sites.
//
// Counted per site per minute: requests, 4xx, 5xx, bytes. Kept 30 days.
// Nothing about a request beyond its status and size is stored — no IPs, no
// URLs — so the traffic table holds no visitor data.
//
// One exception, for diagnosing errors: requests that FAILED (5xx) keep their
// method and path — never the query string, the visitor's IP or user-agent —
// for 7 days, so an app error can be matched to the page that triggered it.
// Emails and long numbers in a path are masked; at most 60 per site a minute.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// %v:%p %h %l %u %t "%r" %>s %O "%{Referer}i" "%{User-Agent}i"
const VHOST_COMBINED = /^(\S+?)(?::\d+)? \S+ \S+ \S+ \[[^\]]+\] "([^"]*)" (\d{3}) (\d+|-)/;
// %h %l %u %t "%r" %>s %O ...
const COMBINED = /^\S+ \S+ \S+ \[[^\]]+\] "([^"]*)" (\d{3}) (\d+|-)/;

function requestOf(r) {
  const m = String(r || '').match(/^([A-Z]{3,8}) (\S+)/);
  if (!m) return { method: null, path: null };
  const path = m[2].split('?')[0].split('#')[0]
    .replace(/[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\d{7,}/g, '<n>')
    .slice(0, 200);
  return { method: m[1], path };
}

function parseAccessLine(line, fileVhost = null) {
  let m = line.match(VHOST_COMBINED);
  if (m) { const status = Number(m[3]); return { vhost: m[1].toLowerCase(), status, bytes: m[4] === '-' ? 0 : Number(m[4]), ...(status >= 500 ? requestOf(m[2]) : {}) }; }
  m = line.match(COMBINED);
  if (m) { const status = Number(m[2]); return { vhost: fileVhost || '(default)', status, bytes: m[3] === '-' ? 0 : Number(m[3]), ...(status >= 500 ? requestOf(m[1]) : {}) }; }
  return null;
}

// CustomLog ${APACHE_LOG_DIR}/monitor-access.log combined  ->  file -> ServerName
function customLogMap(sites, logDir = '/var/log/apache2') {
  const map = {};
  for (const h of sites || []) {
    for (const f of h.customLogs || []) map[f.replace('${APACHE_LOG_DIR}', logDir)] = h.serverName;
  }
  return map;
}

function createTraffic({ db, logDir = '/var/log/apache2', log = console } = {}) {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS traffic_1m (
      ts INTEGER NOT NULL, vhost TEXT NOT NULL, n INTEGER NOT NULL, s4 INTEGER NOT NULL, s5 INTEGER NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY (ts, vhost));
    CREATE INDEX IF NOT EXISTS traffic_vhost_ts ON traffic_1m(vhost, ts);
    CREATE TABLE IF NOT EXISTS failed_requests (ts INTEGER NOT NULL, vhost TEXT NOT NULL, method TEXT, path TEXT, status INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS failed_requests_vhost_ts ON failed_requests(vhost, ts);`);
  const failedPerMinute = new Map();

  const buckets = new Map();   // `${minute}|${vhost}` -> counts
  let fileMap = {};
  let child = null;
  let stopped = false;
  let warned = false;

  function add(ev, ts = Date.now()) {
    const minute = Math.floor(ts / 60_000) * 60_000;
    const k = `${minute}|${ev.vhost}`;
    const b = buckets.get(k) || { ts: minute, vhost: ev.vhost, n: 0, s4: 0, s5: 0, bytes: 0, done: { n: 0, s4: 0, s5: 0, bytes: 0 } };
    b.n++;
    if (ev.status >= 500) {
      b.s5++;
      const fk = k;
      const n = (failedPerMinute.get(fk) || 0) + 1;
      failedPerMinute.set(fk, n);
      if (failedPerMinute.size > 500) failedPerMinute.clear();
      if (n <= 60) db.sql.run('INSERT INTO failed_requests (ts, vhost, method, path, status) VALUES (?, ?, ?, ?, ?)', ts, ev.vhost, ev.method || null, ev.path || null, ev.status);
    } else if (ev.status >= 400) b.s4++;
    b.bytes += ev.bytes || 0;
    buckets.set(k, b);
  }

  // Write finished minutes (and the current one, so a restart loses little).
  function flush(now = Date.now()) {
    const cur = Math.floor(now / 60_000) * 60_000;
    // Adds only what arrived since the last flush, so a restart in the middle
    // of a minute keeps the counts already written.
    for (const [k, b] of buckets) {
      const d = { n: b.n - b.done.n, s4: b.s4 - b.done.s4, s5: b.s5 - b.done.s5, bytes: b.bytes - b.done.bytes };
      if (d.n) {
        db.sql.run(`INSERT INTO traffic_1m (ts, vhost, n, s4, s5, bytes) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(ts, vhost) DO UPDATE SET n = n + excluded.n, s4 = s4 + excluded.s4, s5 = s5 + excluded.s5, bytes = bytes + excluded.bytes`, b.ts, b.vhost, d.n, d.s4, d.s5, d.bytes);
        b.done = { n: b.n, s4: b.s4, s5: b.s5, bytes: b.bytes };
      }
      if (b.ts < cur) buckets.delete(k);
    }
    db.sql.run('DELETE FROM traffic_1m WHERE ts < ?', now - 30 * 86400_000);
    db.sql.run('DELETE FROM failed_requests WHERE ts < ?', now - 7 * 86400_000);
  }

  // Failed requests to these sites between two moments (for an app error).
  function failedAround(vhosts, from, to) {
    if (!vhosts.length) return [];
    const q = vhosts.map(() => '?').join(',');
    return db.sql.all(`SELECT ts, vhost, method, path, status FROM failed_requests WHERE vhost IN (${q}) AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 20`, ...vhosts, from, to);
  }

  function start(sites) {
    fileMap = customLogMap(sites, logDir);
    let files = [];
    try { files = fs.readdirSync(logDir).filter((f) => /access.*\.log$/.test(f)).map((f) => path.join(logDir, f)); } catch (e) {
      if (!warned) log.error(`[traffic] cannot read ${logDir}: ${e.message} (is pulse in the adm group?)`);
      warned = true;
      return false;
    }
    if (!files.length) return false;
    stopped = false;
    // A site's own CustomLog file is followed with headers so its plain
    // `combined` lines can be credited to that site; everything else (the
    // shared other_vhosts_access.log in vhost_combined) needs no help.
    const own = files.filter((f) => fileMap[f]);
    const general = files.filter((f) => !fileMap[f]);
    killAll();
    const restart = (proc) => () => {
      if (stopped || (proc !== child && proc !== ownChild)) return;
      killAll();
      setTimeout(() => { if (!stopped && !child && !ownChild) start(sites); }, 10_000);
    };
    if (general.length) {
      const me = spawn('tail', ['-n', '0', '-q', '-F', ...general], { stdio: ['ignore', 'pipe', 'ignore'] });
      child = me;
      readline.createInterface({ input: me.stdout }).on('line', (l) => { if (me !== child) return; const ev = parseAccessLine(l); if (ev) add(ev); });
      me.on('error', (e) => log.error('[traffic]', e.message));
      me.on('exit', restart(me));
    }
    if (own.length) {
      // -v: headers even when there is only one file, so lines map to their site.
      const me = spawn('tail', ['-n', '0', '-v', '-F', ...own], { stdio: ['ignore', 'pipe', 'ignore'] });
      ownChild = me;
      me.on('error', (e) => log.error('[traffic]', e.message));
      me.on('exit', restart(me));
      let cur = null;
      readline.createInterface({ input: me.stdout }).on('line', (l) => {
        if (me !== ownChild) return;
        const hdr = l.match(/^==> (.+) <==$/);
        if (hdr) { cur = fileMap[hdr[1]] || null; return; }
        const ev = parseAccessLine(l, cur);
        if (ev) add(ev);
      });
    }
    return true;
  }

  let ownChild = null;

  function killAll() {
    const a = child, b = ownChild;
    child = null; ownChild = null;
    if (a) a.kill();
    if (b) b.kill();
  }
  function stop() { stopped = true; killAll(); }

  // Last `minutes` per site, from the table plus what is still in memory.
  function summary(minutes = 60, now = Date.now()) {
    flush(now);
    return db.sql.all(`SELECT vhost, SUM(n) n, SUM(s4) s4, SUM(s5) s5, SUM(bytes) bytes FROM traffic_1m WHERE ts >= ? GROUP BY vhost ORDER BY n DESC`, now - minutes * 60_000);
  }

  // bucketMs > 1 min sums minutes together (a day reads better in 5-minute steps).
  function series(vhosts, from, to = Date.now(), bucketMs = 60_000) {
    if (!vhosts.length) return [];
    const q = vhosts.map(() => '?').join(',');
    return db.sql.all(`SELECT ts - (ts % CAST(? AS INTEGER)) AS ts, SUM(n) n, SUM(s4) s4, SUM(s5) s5 FROM traffic_1m WHERE vhost IN (${q}) AND ts >= ? AND ts <= ? GROUP BY 1 ORDER BY 1`, bucketMs, ...vhosts, from, to);
  }

  return { add, flush, start, stop, summary, series, failedAround, parseAccessLine };
}

// Error-rate rule over the last five minutes of one site.
function judgeErrors({ n, s5 }, { minRequests = 20, warnPct = 5, critPct = 25 } = {}) {
  if (n < minRequests) return 'ok';
  const pct = (s5 / n) * 100;
  if (pct >= critPct) return 'critical';
  if (pct >= warnPct) return 'warning';
  if (pct < 2) return 'clear';
  return 'hold';
}

module.exports = { createTraffic, parseAccessLine, customLogMap, judgeErrors };
