// Health checks for every discovered app.
//
//   apps:      HTTP GET to the app's local port (the LIVE line's port for
//              blue/green apps) — /healthz, /api/healthz, else /
//   databases: a TCP connect to their port
//   both:      systemd state and restart count, from discovery
//   sites:     certificate expiry, read over TLS from Apache on localhost with
//              the site's name as SNI — so it is the certificate Apache is
//              actually serving, not the file on disk
//
// Checks only ever GET. A health check that writes is not a health check.
'use strict';
const http = require('http');
const net = require('net');
const tls = require('tls');

const TIMEOUT_MS = 5000;
const SLOW_MS = 2000;

function httpGet({ port, path = '/', host, timeout = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'GET', timeout,
      headers: { Host: host || `127.0.0.1:${port}`, 'User-Agent': 'DeonTech-Pulse/1 (health check)', Accept: 'application/json, text/html;q=0.8' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, ms: Date.now() - started, body }));
    });
    req.on('timeout', () => { req.destroy(new Error(`no answer in ${timeout / 1000}s`)); });
    req.on('error', (e) => resolve({ ok: false, status: null, ms: Date.now() - started, error: friendlyError(e) }));
    req.end();
  });
}

function tcpConnect({ port, host = '127.0.0.1', timeout = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.connect({ port, host });
    const done = (r) => { s.destroy(); resolve({ ms: Date.now() - started, ...r }); };
    s.setTimeout(timeout, () => done({ ok: false, error: `no answer in ${timeout / 1000}s` }));
    s.on('connect', () => done({ ok: true }));
    s.on('error', (e) => done({ ok: false, error: friendlyError(e) }));
  });
}

function certExpiry({ servername, port = 443, host = '127.0.0.1', timeout = TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout }, () => {
      const c = s.getPeerCertificate();
      s.end();
      if (!c || !c.valid_to) return resolve({ ok: false, error: 'no certificate' });
      const names = String(c.subjectaltname || '').split(',').map((x) => x.trim().replace(/^DNS:/, ''));
      resolve({ ok: true, validTo: Date.parse(c.valid_to), issuer: c.issuer && (c.issuer.O || c.issuer.CN), names, matches: names.some((n) => n === servername || (n.startsWith('*.') && servername.endsWith(n.slice(1)))) });
    });
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
    s.on('error', (e) => resolve({ ok: false, error: friendlyError(e) }));
  });
}

function friendlyError(e) {
  if (!e) return 'error';
  if (e.code === 'ECONNREFUSED') return 'connection refused (nothing listening)';
  if (e.code === 'ECONNRESET') return 'connection reset';
  if (e.code === 'EHOSTUNREACH') return 'host unreachable';
  return e.message || String(e.code || e);
}

// What counts as healthy for a given path: a health route must answer 2xx;
// the home page of an app with no health route may redirect to a login (3xx)
// or refuse an anonymous caller (401/403) and still be perfectly well.
function judge(path, r) {
  if (!r.ok) return false;
  if (path === '/') return r.status < 500;
  return r.status >= 200 && r.status < 300;
}

// The one domain to send as Host, so a name-based app answers as it would to
// a visitor. Wildcards and bare IPs are skipped.
function hostFor(app) {
  return (app.domains || []).find((d) => !d.startsWith('*') && !/^\d+\.\d+\.\d+\.\d+$/.test(d)) || null;
}

function createChecker() {
  // app id -> state, kept between rounds
  const state = new Map();

  async function checkApp(app) {
    const prev = state.get(app.id) || { failures: 0, healthPath: null, history: [] };
    const result = { app: app.id, ts: Date.now(), kind: app.kind, port: app.checkPort };

    if (!app.checkPort) {
      Object.assign(result, { ok: false, error: 'no port found for this app' });
    } else if (app.kind === 'database') {
      Object.assign(result, await tcpConnect({ port: app.checkPort }));
    } else {
      const host = hostFor(app);
      const paths = prev.healthPath ? [prev.healthPath] : (app.healthPaths && app.healthPaths.length ? app.healthPaths : ['/healthz', '/api/healthz', '/']);
      let r = null;
      let used = null;
      for (const p of paths) {
        r = await httpGet({ port: app.checkPort, path: p, host });
        used = p;
        if (judge(p, r)) break;
        if (!r.ok) break;          // refused or timed out: another path won't help
      }
      // A remembered path that has started failing: forget it and try all next time.
      const ok = judge(used, r);
      Object.assign(result, { ok, status: r.status, ms: r.ms, path: used, error: ok ? null : (r.error || `HTTP ${r.status} from ${used}`) });
      if (ok) prev.healthPath = used; else if (prev.healthPath) prev.healthPath = null;
      try { const j = JSON.parse(r.body || ''); if (j && typeof j === 'object') result.health = pick(j, ['ok', 'line', 'version', 'status']); } catch { /* not JSON */ }
    }

    // The idle colour of a blue/green app is worth knowing about, not alerting on.
    if (app.lines && app.lines.length > 1 && app.kind === 'app') {
      result.lines = [];
      for (const l of app.lines) {
        if (!l.port) { result.lines.push({ line: l.line, live: l.line === app.liveLine, ok: false, error: 'not running' }); continue; }
        const path = result.path && result.path !== '/' ? result.path : (app.healthPaths || ['/healthz'])[0];
        const r = l.port === app.checkPort ? { ok: result.ok, status: result.status, ms: result.ms } : await httpGet({ port: l.port, path, host: hostFor(app) });
        result.lines.push({ line: l.line, port: l.port, live: l.line === app.liveLine, ok: l.port === app.checkPort ? result.ok : judge(path, r), ms: r.ms, status: r.status });
      }
    }

    // systemd's view.
    const svc = (app.units || []).filter((u) => u.active === 'active' || (app.lines || []).some((l) => l.unit === u.unit && l.line === app.liveLine));
    result.restarts = svc.reduce((n, u) => n + (u.restarts || 0), 0);
    result.memory = svc.reduce((n, u) => n + (u.memory || 0), 0) || null;
    result.unitsActive = svc.every((u) => u.active === 'active');
    result.slow = !!(result.ok && result.ms > SLOW_MS);

    prev.failures = result.ok ? 0 : prev.failures + 1;
    result.failures = prev.failures;
    result.status = statusOf(app, result);
    prev.last = result;
    prev.history.push({ ts: result.ts, ok: result.ok, ms: result.ms });
    if (prev.history.length > 60) prev.history.shift();
    state.set(app.id, prev);
    return result;
  }

  async function checkAll(apps) {
    const out = [];
    for (const a of apps) {
      if (a.kind === 'database' && !a.listening.length && !(a.units || []).some((u) => u.active === 'active')) {
        // A database that isn't running and isn't meant to be (no port, unit stopped).
        out.push({ app: a.id, ts: Date.now(), kind: a.kind, ok: null, status: 'stopped', failures: 0 });
        continue;
      }
      out.push(await checkApp(a));
    }
    return out;
  }

  return { checkApp, checkAll, state: (id) => state.get(id), all: () => state };
}

function statusOf(app, r) {
  if (r.ok === null) return 'stopped';
  if (!r.ok) return 'down';
  if (r.slow) return 'slow';
  if (r.lines && r.lines.some((l) => !l.live && l.port && !l.ok)) return 'up';   // idle line down: fine
  return 'up';
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }

// Certificate expiry for every distinct domain Apache serves over TLS.
async function checkCerts(apps) {
  const out = [];
  const seen = new Set();
  for (const a of apps) {
    if (!(a.certFiles && a.certFiles.length)) continue;
    for (const d of a.domains || []) {
      if (d.startsWith('*') || /^\d+\.\d+\.\d+\.\d+$/.test(d) || seen.has(d)) continue;
      seen.add(d);
      const r = await certExpiry({ servername: d });
      out.push({ app: a.id, domain: d, ...r, daysLeft: r.validTo ? Math.floor((r.validTo - Date.now()) / 86400_000) : null });
    }
  }
  return out;
}

module.exports = { createChecker, checkCerts, httpGet, tcpConnect, certExpiry, judge, hostFor, statusOf };
