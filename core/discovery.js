// Auto-discovery: what is running on this server, and what changed.
//
// Two sources, merged:
//
//   1. inventory.txt, written hourly by scripts/pulse-scan.sh running as root
//      (port owners, SSH key fingerprints, crontabs, backup folders). Pulse's
//      own user cannot see these, which is the only reason the scan exists.
//   2. What the unprivileged `pulse` user can read for itself: systemd units,
//      Apache's enabled sites, /opt/*/live files.
//
// From the merged inventory it builds the list of APPS — one card per thing a
// person would call an application — and diffs each inventory against the
// previous one so that a new port, service, site, user, key or cron job
// becomes an event. Nothing is typed in by hand: a new app on the server shows
// up on its own.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// --------------------------------------------------------------------------
// Parsing the root scan
// --------------------------------------------------------------------------

function parseScan(text) {
  const out = { meta: {}, ports: [], containers: [], users: [], keys: [], cron: [], backups: [], backupcheck: [], offsite: { scripts: [], remotes: [], apps: [], cron: [], lastRun: null }, datadirs: [], security: { sudoers_d: [] } };
  let section = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^== (\w+)/);
    if (m) { section = m[1]; continue; }
    const f = line.split('\t');
    switch (section) {
      case 'meta': out.meta[f[0]] = f[1]; break;
      case 'ports': {
        const port = Number(f[0]);
        if (!Number.isFinite(port)) break;
        out.ports.push({ port, addr: f[1], proc: dash(f[2]), pid: num(f[3]), unit: dash(f[4]), cwd: dash(f[5]), pm2: dash(f[6]) });
        break;
      }
      case 'containers': {
        // "0.0.0.0:8080->80/tcp, :::8080->80/tcp" -> the host ports, 8080
        const hostPorts = [...String(f[1] || '').matchAll(/:(\d+)->/g)].map((x) => Number(x[1]));
        if (f[0]) out.containers.push({ name: f[0], ports: [...new Set(hostPorts)] });
        break;
      }
      case 'users': out.users.push({ name: f[0], uid: num(f[1]), home: f[2], shell: f[3], sudo: f[4] === 'yes' }); break;
      case 'keys': out.keys.push({ user: f[0], file: f[1], fingerprint: f[2], type: dash(f[3]), comment: dash(f[4]), mtime: num(f[5]) }); break;
      case 'cron':
        // owner, hash of the raw line, redacted line (older scans: owner, line)
        if (/^[0-9a-f]{12}$/.test(f[1] || '')) out.cron.push({ owner: f[0], hash: f[1], line: f.slice(2).join('\t') });
        else out.cron.push({ owner: f[0], hash: null, line: f.slice(1).join('\t') });
        break;
      case 'backups': out.backups.push({ dir: f[0], newestTs: f[1] ? Math.round(Number(f[1]) * 1000) || null : null, newest: dash(f[2]), count: num(f[3]), bytes: num(f[4]), kind: f[5] || 'var' }); break;
      case 'backupcheck': out.backupcheck.push({ dir: f[0], newest: f[1], databases: num(f[2]), result: f[3], detail: dash(f[4]) }); break;
      case 'offsite':
        if (f[0] === 'script') out.offsite.scripts.push(f[1]);
        else if (f[0] === 'remotes') out.offsite.remotes = String(f[1] || '').split(/\s+/).filter(Boolean);
        else if (f[0] === 'app') out.offsite.apps.push({ path: f[1], folder: f[2] });
        else if (f[0] === 'cron') out.offsite.cron.push({ schedule: f[1], command: f[2] });
        else if (f[0] === 'lastrun') out.offsite.lastRun = num(f[1]) ? num(f[1]) * 1000 : null;
        break;
      case 'datadirs': out.datadirs.push({ path: f[0], bytes: num(f[1]) }); break;
      case 'security':
        if (f[0] === 'sudoers_d') out.security.sudoers_d.push(f[1]);
        else out.security[f[0]] = /^\d+$/.test(f[1] || '') ? Number(f[1]) : (f[1] || '');
        break;
      default: break;
    }
  }
  out.ts = out.meta.ts ? Number(out.meta.ts) * 1000 : null;
  // ss lists a port once per address it is bound to; keep one row per
  // port+owner, with every address, so "who is listening where" stays visible.
  const byKey = new Map();
  for (const p of out.ports) {
    const k = `${p.port}|${p.pid}`;
    if (!byKey.has(k)) byKey.set(k, { ...p, addrs: [] });
    const row = byKey.get(k);
    if (!row.addrs.includes(p.addr)) row.addrs.push(p.addr);
  }
  out.ports = [...byKey.values()].map((p) => ({ ...p, public: p.addrs.some(isPublicAddr) }));
  return out;
}

// Bound to every interface, or to a non-loopback address.
function isPublicAddr(a) {
  const x = String(a || '').replace(/%.*$/, '').replace(/^\[|\]$/g, '');
  if (x === '*' || x === '0.0.0.0' || x === '::') return true;
  return !(/^127\./.test(x) || x === '::1' || /^::ffff:127\./.test(x));
}

const dash = (v) => (v === undefined || v === '' || v === '-' ? null : v);
const num = (v) => (v === undefined || v === '' || v === '-' || Number.isNaN(Number(v)) ? null : Number(v));

// --------------------------------------------------------------------------
// Apache
// --------------------------------------------------------------------------

// Parses a site file (with its Include targets already inlined) into vhosts.
function parseApacheSite(text, file = '') {
  const hosts = [];
  let cur = null;
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^<VirtualHost\s+([^>]+)>/i))) {
      const portMatch = m[1].match(/:(\d+)/);
      cur = { file, listen: portMatch ? Number(portMatch[1]) : 80, serverName: null, aliases: [], proxies: [], excluded: [], certFile: null, docRoot: null, customLogs: [] };
      continue;
    }
    if (/^<\/VirtualHost>/i.test(line)) { if (cur) hosts.push(cur); cur = null; continue; }
    const target = cur || (hosts.length ? hosts[hosts.length - 1] : null);
    if (!target) continue;
    if ((m = line.match(/^ServerName\s+(\S+)/i))) target.serverName = m[1].replace(/:\d+$/, '');
    else if ((m = line.match(/^ServerAlias\s+(.+)/i))) target.aliases.push(...m[1].split(/\s+/).filter(Boolean));
    else if ((m = line.match(/^ProxyPass\s+(\S+)\s+!/i))) target.excluded.push(m[1]);
    else if ((m = line.match(/^ProxyPass\s+(\S+)\s+(\S+)/i))) addProxy(target, m[1], m[2]);
    else if ((m = line.match(/^RewriteRule\s+\S+\s+(\S+)\s+\[[^\]]*\bP\b[^\]]*\]/i))) addProxy(target, '(rewrite)', m[1]);
    else if ((m = line.match(/^SSLCertificateFile\s+(\S+)/i))) target.certFile = m[1];
    else if ((m = line.match(/^DocumentRoot\s+(\S+)/i))) target.docRoot = m[1].replace(/^"|"$/g, '');
    else if ((m = line.match(/^CustomLog\s+"?([^"\s]+)"?/i))) target.customLogs.push(m[1]);
  }
  if (cur) hosts.push(cur);
  return hosts;
}

function addProxy(host, pathPrefix, url) {
  const m = String(url).match(/^(?:https?|ws|wss):\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d+)/i);
  if (m) host.proxies.push({ path: pathPrefix, port: Number(m[2]), url });
}

// Reads every enabled site, inlining Include/IncludeOptional files (blue/green
// setups often keep the live backend in a separate included file).
function readApacheSites(dir = '/etc/apache2/sites-enabled', readFile = (p) => fs.readFileSync(p, 'utf8'), listDir = (d) => fs.readdirSync(d)) {
  let files = [];
  try { files = listDir(dir).filter((f) => !f.startsWith('.')); } catch { return { hosts: [], error: `cannot read ${dir}` }; }
  const hosts = [];
  for (const f of files) {
    const p = path.join(dir, f);
    let text = '';
    try { text = inlineIncludes(readFile(p), readFile); } catch { continue; }
    hosts.push(...parseApacheSite(text, p));
  }
  return { hosts };
}

function inlineIncludes(text, readFile, depth = 0) {
  if (depth > 3) return text;
  return String(text).replace(/^\s*Include(?:Optional)?\s+(\S+)\s*$/gim, (whole, file) => {
    if (/[*?]/.test(file)) return whole;   // globs: leave alone
    try { return inlineIncludes(readFile(file.replace(/^"|"$/g, '')), readFile, depth + 1); } catch { return whole; }
  });
}

// --------------------------------------------------------------------------
// systemd
// --------------------------------------------------------------------------

// Units that belong to the operating system, not to anyone's application.
const SYSTEM_UNITS = new Set([
  'apache2', 'cron', 'dbus', 'ssh', 'sshd', 'polkit', 'rsyslog', 'multipathd', 'qemu-guest-agent',
  'unattended-upgrades', 'fail2ban', 'snapd', 'getty@tty1', 'serial-getty@ttyS0', 'networkd-dispatcher',
  'ModemManager', 'udisks2', 'packagekit', 'irqbalance', 'chrony', 'atd', 'sysstat', 'apport', 'ufw',
  'pulse', 'pulse-scan', 'certbot', 'ua-timer', 'ubuntu-advantage', 'lvm2-monitor', 'blk-availability',
  'open-iscsi', 'iscsid', 'finalrd', 'setvtrgb', 'console-setup', 'keyboard-setup', 'kmod-static-nodes',
  'plymouth-quit', 'plymouth-quit-wait', 'plymouth-read-write', 'grub-common', 'grub-initrd-fallback',
  'e2scrub_reap', 'dmesg', 'emergency', 'rescue', 'snapd.seeded', 'cloud-init', 'cloud-config', 'cloud-final',
  'cloud-init-local', 'cloud-init-main', 'cloud-init-network', 'secureboot-db', 'apparmor', 'lxd-agent',
  'motd-news', 'apt-daily', 'apt-daily-upgrade', 'dpkg-db-backup', 'logrotate', 'man-db', 'fstrim',
  'e2scrub_all', 'update-notifier-download', 'update-notifier-motd', 'apport-autoreport', 'snapd.snap-repair',
]);
// pulse-* are Pulse's own helpers; run-*.service are throwaway units that
// systemd-run and package scripts create for a few seconds.
const isSystemUnit = (base) => SYSTEM_UNITS.has(base) || /^(systemd-|user@|user-runtime-dir@|getty@|modprobe@|dm-event|lvm2|snap[.-]|ssh@|session-|pulse-|run-r?[0-9a-f]{6,}$)/.test(base);

const DATABASE_UNITS = /^(mysql|mariadb|postgresql(@.*)?|mssql-server|mongod|redis-server|redis)$/;

// Services that run OTHER programs: PM2 (pm2-<user>), Docker and friends. Each
// program they run is its own app, found by its port; the runner itself is not.
const RUNNER_UNITS = /^(pm2-[a-z0-9_-]+|pm2|docker|containerd|podman|supervisor|supervisord)$/;
const isRunnerUnit = (base) => RUNNER_UNITS.test(base);

// Apps are services someone set up on this server: their unit file is in
// /etc/systemd/system. Units that came with Ubuntu or a package (ldconfig,
// snapd.apparmor, ...) live in /usr/lib/systemd and are not apps — except the
// databases, which are packaged but are exactly what you want to watch.
function isOsUnit(u) {
  if (!u || !u.fragment) return false;   // not known: judged by name only
  if (DATABASE_UNITS.test(String(u.base || u.unit || '').replace(/\.service$/, ''))) return false;
  return !String(u.fragment).startsWith('/etc/systemd/system/');
}

// Folders that say nothing about which app runs there.
const VAGUE_DIRS = new Set(['', 'app', 'apps', 'src', 'dist', 'build', 'current', 'releases', 'release', 'server', 'api', 'web', 'www', 'html', 'public', 'bin', 'opt', 'srv', 'home', 'root', 'var', 'tmp', 'live', 'blue', 'green', 'code', 'node', 'backend', 'frontend']);

// The app a program belongs to when it isn't its own systemd service: its PM2
// name, the Docker container that publishes the port, or the folder it runs
// from (/opt/budget/app -> budget, /home/deon/sites/notes -> notes).
function appFromProcess(p, containers = []) {
  if (p.pm2) return { id: slug(p.pm2), runner: 'pm2', runnerName: p.pm2 };
  const c = containers.find((x) => x.ports.includes(p.port));
  if (c) return { id: slug(c.name), runner: 'docker', runnerName: c.name };
  if (p.proc === 'docker-proxy') return null;   // published by a container we couldn't name
  if (p.cwd && p.cwd !== '/') {
    const parts = p.cwd.split('/').filter(Boolean);
    // /opt/<app>/..., /srv/<app>/..., /var/www/<app>/..., /home/<user>/<app>/...
    let pick = null;
    if (['opt', 'srv'].includes(parts[0]) && parts[1]) pick = parts[1];
    else if (parts[0] === 'var' && parts[1] === 'www' && parts[2]) pick = parts[2];
    else if (parts[0] === 'home' && parts[2]) pick = parts.slice(2).find((x) => !VAGUE_DIRS.has(x.toLowerCase())) || null;
    else pick = [...parts].reverse().find((x) => !VAGUE_DIRS.has(x.toLowerCase())) || null;
    if (pick && !VAGUE_DIRS.has(pick.toLowerCase())) return { id: slug(pick), runner: 'process', runnerName: p.proc || null, cwd: p.cwd };
  }
  return null;
}

// A readable name for an app nobody has named: from its web address when that
// matches (budget.smartdeontech.com -> Budget), else from its id
// (budget-api -> Budget API).
const ACRONYMS = new Set(['api', 'crm', 'erp', 'cms', 'hr', 'pos', 'sms', 'ai', 'qms', 'id', 'ui', 'db']);
function titleWords(s) {
  return String(s).split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}
function friendlyName(id, domains = []) {
  const c = compact(id);
  for (const d of domains) {
    const first = String(d).toLowerCase().split('.')[0];
    if (first && compact(first) === c) return titleWords(first);
  }
  return titleWords(id);
}

function parseUnits(json) {
  let arr = [];
  try { arr = JSON.parse(json); } catch { return []; }
  return arr
    .filter((u) => /\.service$/.test(u.unit))
    .map((u) => ({ unit: u.unit, base: u.unit.replace(/\.service$/, ''), load: u.load, active: u.active, sub: u.sub, description: u.description }));
}

function run(cmd, args, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? err.code : 0 }));
  });
}

async function readUnits() {
  const r = await run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--output=json']);
  return r.ok ? parseUnits(r.stdout) : [];
}

// NRestarts, start time, memory and main PID for the units Pulse cares about.
async function unitDetails(units) {
  if (!units.length) return {};
  const r = await run('systemctl', ['show', ...units, '--property=Id,NRestarts,ActiveEnterTimestamp,MainPID,MemoryCurrent,ActiveState,SubState,Result,ExecMainStartTimestamp,FragmentPath,Environment']);
  return parseShow(r.stdout);
}

function envPort(env) {
  const m = String(env || '').match(/(?:^|\s)PORT=(\d{2,5})(?=\s|$)/);
  return m ? Number(m[1]) : null;
}

function parseShow(text) {
  const out = {};
  for (const block of String(text || '').split(/\n\n+/)) {
    const o = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!o.Id) continue;
    const mem = Number(o.MemoryCurrent);
    out[o.Id] = {
      restarts: Number(o.NRestarts) || 0,
      since: o.ActiveEnterTimestamp ? Date.parse(o.ActiveEnterTimestamp.replace(/ [A-Z]{2,5}$/, '')) || null : null,
      mainPid: Number(o.MainPID) || null,
      memory: Number.isFinite(mem) && mem < 2 ** 60 ? mem : null,
      active: o.ActiveState, sub: o.SubState, result: o.Result,
      fragment: o.FragmentPath || null,
      // The port a unit is told to listen on (Environment=PORT=4102 ...), readable
      // without root, so a blue/green line's port is known the moment it starts
      // rather than at the next hourly scan.
      port: envPort(o.Environment),
    };
  }
  return out;
}

async function readTimers() {
  const r = await run('systemctl', ['list-timers', '--all', '--no-pager', '--output=json']);
  if (!r.ok) return [];
  try {
    return JSON.parse(r.stdout).map((t) => ({ unit: t.unit, activates: t.activates, next: t.next ? Math.round(t.next / 1000) : null, last: t.last ? Math.round(t.last / 1000) : null }));
  } catch { return []; }
}

function readLiveFiles(root = '/opt') {
  const out = {};
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const d of dirs) {
    const f = path.join(root, d, 'live');
    try {
      const st = fs.lstatSync(f);
      const v = st.isSymbolicLink() ? path.basename(fs.readlinkSync(f)) : fs.readFileSync(f, 'utf8').trim();
      out[d] = { value: v.split(/\s+/)[0], mtime: st.mtimeMs };
    } catch { /* no live file */ }
  }
  return out;
}

// --------------------------------------------------------------------------
// From inventory to apps
// --------------------------------------------------------------------------

// Friendly names for what is already known to be on this server. Anything not
// listed still appears — named after its unit — and can be renamed from the
// Inventory page.
const KNOWN = {
  'aotc-track': { name: 'AOTC Track', health: ['/api/healthz', '/healthz'] },
  ifaima: { name: 'IFAIMA', health: ['/healthz'] },
  'smart-deontech': { name: 'Smart DeonTech' },
  ginasangel: { name: "Gina's Angel (Genius School)" },
  pledge: { name: 'Pledges' },
  pman: { name: 'pman' },
  budget: { name: 'Budget', health: ['/healthz'] },
  mysql: { name: 'MySQL' },
  'mssql-server': { name: 'SQL Server' },
  postgresql: { name: 'PostgreSQL' },
  // Pulse itself, found through its own Apache site (0.1.15). Its service is one
  // of Pulse's own units, so before 0.1.15 the site became an app of its own
  // named after the site ("Monitor"), beside the Backups page's "DeonTech Pulse".
  pulse: { name: 'DeonTech Pulse', health: ['/healthz'] },
};

// The port a person means when they say "the database is up".
const PREFERRED_DB_PORTS = [3306, 1433, 5432, 27017, 6379];

const LINE_RE = /^(.*?)(?:[-@](blue|green))$/;

// Clusters of one database server (postgresql@15-main, postgresql@16-main) and
// Ubuntu's wrapper unit (postgresql.service, a oneshot that is always
// "active (exited)") are one database: one card, checked on its main port.
const DB_INSTANCE_RE = /^(postgresql|mysql|mariadb)@.+$/;

function baseOf(unitBase) {
  const i = unitBase.match(DB_INSTANCE_RE);
  if (i) return { app: i[1], line: null };
  const m = unitBase.match(LINE_RE);
  return m ? { app: m[1], line: m[2] } : { app: unitBase, line: null };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !['www', 'com', 'org', 'net', 'app', 'api', 'track', 'service'].includes(t));

// The app a site belongs to by name: the service whose name, run together,
// is in the site's name — the leftmost part wins, so ginasangel.smartdeontech.com
// is Gina's Angel and app.smartdeontech.com is smart-deontech.
const compact = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
const GENERIC_LABELS = new Set(['www', 'app', 'api', 'portal', 'admin', 'my', 'web', 'm', 'staging', 'dev', 'test']);
function nameMatch(domains, ...idLists) {
  let best = null;
  for (const id of idLists.flat()) {
    const c = compact(id);
    if (c.length < 5) continue;
    for (const d of domains) {
      const labels = String(d).toLowerCase().split('.');
      const i = labels.findIndex((l) => compact(l).includes(c));
      if (i < 0) continue;
      // stock.smartdeontech.com is Stock, not Smart DeonTech: a match further
      // right only counts when the left part is a generic word (app., www.).
      if (i > 0 && !GENERIC_LABELS.has(labels[0])) continue;
      if (!best || i < best.i || (i === best.i && c.length > best.len)) best = { id, i, len: c.length };
    }
  }
  return best ? best.id : null;
}

function buildApps({ scan, units = [], details = {}, sites = [], live = {}, overrides = {}, selfPort = Number(process.env.PORT) || 3201 }) {
  const apps = new Map();
  const ensure = (id, seed = {}) => {
    if (!apps.has(id)) apps.set(id, { id, name: (KNOWN[id] && KNOWN[id].name) || id, kind: 'app', units: [], lines: [], ports: [], domains: [], certFiles: [], liveLine: null, healthPaths: (KNOWN[id] && KNOWN[id].health) || null, backups: null, ...seed });
    return apps.get(id);
  };

  // 1. Services that aren't the operating system's.
  const dormant = [];
  for (const u of units) {
    if (isSystemUnit(u.base) || /@$/.test(u.base) || isRunnerUnit(u.base) || isOsUnit(u)) continue;
    if (u.load === 'not-found') continue;
    const { app, line } = baseOf(u.base);
    const kind = DATABASE_UNITS.test(u.base) ? 'database' : 'app';
    if (kind === 'app' && u.active !== 'active' && !apps.has(app) && !line) {
      // A stopped unit with nothing else pointing at it is usually leftovers;
      // it stays on the Inventory page but doesn't get a card — unless a site
      // still sends traffic its way (step 3), which makes it an app that's down.
      dormant.push({ app, unit: { unit: u.unit, line, active: u.active, sub: u.sub, ...(details[u.unit] || {}) } });
      continue;
    }
    const a = ensure(app, { kind });
    a.units.push({ unit: u.unit, line, active: u.active, sub: u.sub, ...(details[u.unit] || {}) });
    if (line && !a.lines.find((l) => l.line === line)) a.lines.push({ line, unit: u.unit, port: (details[u.unit] && details[u.unit].port) || null, active: u.active });
  }

  // 2. Listening ports, attributed to a unit by the root scan.
  const portOwner = new Map();
  for (const p of (scan && scan.ports) || []) {
    const ub = p.unit ? p.unit.replace(/\.service$/, '') : null;
    if (ub && (isSystemUnit(ub) || isOsUnit(units.find((u) => u.unit === p.unit)))) continue;
    if (!ub || isRunnerUnit(ub)) {
      // Not its own service: PM2, Docker, or started by hand. Name it after
      // what runs it, or the folder it runs from; otherwise it stays a port
      // on the Inventory page (and a new port is still an alert).
      const found = appFromProcess(p, (scan && scan.containers) || []);
      if (!found) continue;
      const a = ensure(found.id, { runner: found.runner, runnerName: found.runnerName, runnerUnit: p.unit || null, cwd: found.cwd || null });
      if (!a.ports.includes(p.port)) a.ports.push(p.port);
      portOwner.set(p.port, found.id);
      continue;
    }
    const { app, line } = baseOf(ub);
    const a = ensure(app, { kind: DATABASE_UNITS.test(ub) ? 'database' : 'app' });
    if (!a.ports.includes(p.port)) a.ports.push(p.port);
    portOwner.set(p.port, app);
    if (line) {
      const l = a.lines.find((x) => x.line === line) || (a.lines.push({ line, unit: p.unit, port: null, active: 'active' }), a.lines[a.lines.length - 1]);
      if (!l.port) l.port = p.port;
    }
  }
  const listening = new Set(((scan && scan.ports) || []).map((p) => p.port));

  // 3. Apache sites: domain -> backend port -> app. A site whose backend
  //    belongs to nobody becomes its own app, named after the site — that is
  //    how a dead backend (nothing listening) shows up as an app that's down.
  // Sites with a readable backend go first, so a redirect-only or
  // rewrite-map vhost can then be matched to whoever already owns its name.
  const ordered = [...sites].sort((x, y) => (y.proxies.length ? 1 : 0) - (x.proxies.length ? 1 : 0));
  const domainOwner = new Map();
  for (const h of ordered) {
    const domains = [h.serverName, ...h.aliases].filter(Boolean);
    const backPorts = [...new Set(h.proxies.map((p) => p.port))];
    let owner = null;
    // Pulse's own site (its backend is Pulse's port): that is Pulse, one app.
    if (backPorts.includes(selfPort)) owner = 'pulse';
    for (const port of backPorts) if (!owner && portOwner.has(port)) { owner = portOwner.get(port); break; }
    if (!owner && backPorts.length) {
      // Is it one of the colour lines of a known app (the idle one may not be listening)?
      owner = [...apps.values()].find((a) => a.lines.some((l) => backPorts.includes(l.port)))?.id || null;
    }
    if (!owner && backPorts.length) {
      // Nothing is listening on the backend: the app behind it is down. Find
      // it by name — a stopped service whose name is in the domain
      // (smart-deontech ↔ app.smartdeontech.com) — so a crash shows as that
      // app being down, not as a new app named after the site.
      const hit = nameMatch(domains, [...apps.values()].filter((a) => a.kind === 'app').map((a) => a.id), dormant.map((x) => x.app));
      if (hit) {
        const a = ensure(hit);
        for (const x of dormant.filter((y) => y.app === hit)) if (!a.units.some((u) => u.unit === x.unit.unit)) a.units.push(x.unit);
        owner = hit;
      }
    }
    if (!owner && !backPorts.length) {
      // No ProxyPass we could read (e.g. a rewrite map). Same name as a site
      // already placed? Otherwise the app whose name shares the most words.
      owner = domains.map((d) => domainOwner.get(d)).find(Boolean) || null;
      if (!owner) {
        const t = new Set(domains.flatMap(tokens));
        let best = null, bestScore = 0;
        for (const a of apps.values()) {
          if (a.kind !== 'app') continue;
          const score = tokens(a.id).filter((x) => t.has(x)).length;
          if (score > bestScore) { best = a; bestScore = score; }
        }
        owner = best ? best.id : null;
      }
    }
    if (!owner) {
      const fileBase = path.basename(h.file || '').replace(/(-le-ssl)?\.conf$/, '');
      owner = slug(/^\d+\.\d+\.\d+\.\d+$/.test(fileBase) ? h.serverName : fileBase.split('.')[0] || h.serverName || 'site');
    }
    const a = ensure(owner);
    for (const d of domains) { if (!a.domains.includes(d)) a.domains.push(d); if (!domainOwner.has(d)) domainOwner.set(d, owner); }
    if (h.certFile && !a.certFiles.includes(h.certFile)) a.certFiles.push(h.certFile);
    for (const port of backPorts) {
      if (!a.ports.includes(port)) a.ports.push(port);
      if (!a.upstreamPorts) a.upstreamPorts = [];
      if (!a.upstreamPorts.includes(port)) a.upstreamPorts.push(port);
    }
    if (h.excluded.length) a.excludedPaths = [...new Set([...(a.excludedPaths || []), ...h.excluded])];
  }

  // 4. Which colour is live: /opt/<dir>/live, matched to the app by name.
  for (const [dir, v] of Object.entries(live)) {
    const head = dir.split('-')[0];
    const a = apps.get(dir) || [...apps.values()].find((x) => x.lines.length && x.id.split('-')[0] === head);
    if (!a) continue;
    a.liveLine = v.value;
    a.liveFile = `/opt/${dir}/live`;
    a.liveChangedAt = v.mtime;
  }

  // 5. Backups. An app can have several sources; each is kept with its role:
  //   own        /opt/<app>/backups — made by the app itself
  //   scheduled  /var/backups/<app> written by a <app>-backup timer
  //   release    /var/backups/<app> holding only pre-release copies (data-before-*)
  //   pulse      /var/backups/pulse/<app> — "Back up now" in Pulse
  // a.backups is the newest REGULAR one (release copies are not a schedule).
  const checks = (scan && scan.backupcheck) || [];
  const findApp = (name) => apps.get(name) || [...apps.values()].find((x) => name.startsWith(x.id) || x.id.startsWith(name));
  for (const b of (scan && scan.backups) || []) {
    let name, role;
    if (b.kind === 'pulse') { name = path.basename(b.dir); role = 'pulse'; }
    else if (b.kind === 'app') { name = b.dir.split('/')[2]; role = 'own'; }
    else {
      name = path.basename(b.dir);
      const timer = (units || []).some((u) => String(u.unit || '').startsWith(`${name}-backup`));
      role = timer ? 'scheduled' : /^data-before/.test(b.newest || '') ? 'release' : 'scheduled';
    }
    const a = findApp(name);
    if (!a) continue;
    const check = checks.find((c) => c.dir === b.dir) || null;
    (a.backupSources = a.backupSources || []).push({ ...b, role, check });
  }
  const off = (scan && scan.offsite) || null;
  for (const a of apps.values()) {
    const src = a.backupSources || [];
    const regular = src.filter((x) => x.role !== 'release');
    const pick = (list) => list.slice().sort((x, y) => (y.newestTs || 0) - (x.newestTs || 0))[0] || null;
    a.backups = pick(regular) || pick(src);
    const covered = off && off.apps.find((x) => x.path.split('/').filter(Boolean).pop() === a.id);
    if (off && off.scripts.length) a.offsite = covered ? { folder: covered.folder, remotes: off.remotes, cron: off.cron, lastRun: off.lastRun, script: off.scripts[0] } : null;
  }

  // 5b. How big each database's data is (from the scan's folder sizes).
  const DATA_DIRS = { mysql: ['/var/lib/mysql'], mariadb: ['/var/lib/mysql'], 'mssql-server': ['/var/opt/mssql'], postgresql: ['/var/lib/postgresql'], mongod: ['/var/lib/mongodb'], 'redis-server': ['/var/lib/redis'] };
  for (const a of apps.values()) {
    const dirs = DATA_DIRS[a.id] || [`/var/lib/${a.id}`];
    const hit = ((scan && scan.datadirs) || []).filter((x) => dirs.includes(x.path));
    if (hit.length) a.dataBytes = hit.reduce((n, x) => n + (x.bytes || 0), 0);
  }

  // 6. Finish: ports listening?, the port to health-check, overrides.
  const out = [];
  for (const a of apps.values()) {
    const ov = overrides[a.id] || {};
    if (ov.ignore) continue;
    if (!KNOWN[a.id] && a.name === a.id) a.name = friendlyName(a.id, a.domains);
    if (ov.name) a.name = ov.name;
    if (ov.healthPath) a.healthPaths = [ov.healthPath];
    // Switched off = still listed, never checked or alerted on (an app that
    // isn't live yet). Switching it back on is one toggle.
    a.watched = ov.watch !== false;
    if (!a.watched) a.watchOff = { at: ov.watchAt || null, by: ov.watchBy || null, note: ov.watchNote || '' };
    a.ports.sort((x, y) => x - y);
    for (const l of a.lines) l.listening = l.port ? listening.has(l.port) : false;
    a.listening = a.ports.filter((p) => listening.has(p));
    a.checkPort = pickCheckPort(a, listening);
    a.hasBackups = !!a.backups;
    out.push(a);
  }
  out.sort((x, y) => (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === 'app' ? -1 : 1));
  return out;
}

function pickCheckPort(a, listening) {
  if (a.kind === 'database') return PREFERRED_DB_PORTS.find((p) => a.ports.includes(p) && listening.has(p)) || a.ports.find((p) => listening.has(p)) || null;
  if (a.lines.length && a.liveLine) {
    const l = a.lines.find((x) => x.line === a.liveLine);
    if (l && l.port) return l.port;
    // Live line's port not known yet: anything but the idle line's port, which
    // is stopped by design after a release (checking it reads as "down").
    const idle = new Set(a.lines.filter((x) => x.line !== a.liveLine && x.port).map((x) => x.port));
    const up = (a.upstreamPorts || []).filter((p) => !idle.has(p));
    const rest = a.ports.filter((p) => !idle.has(p));
    return up.find((p) => listening.has(p)) || up[0] || rest.find((p) => listening.has(p)) || rest[0] || null;
  }
  // The port Apache sends traffic to is the one that matters, even if dead.
  if (a.upstreamPorts && a.upstreamPorts.length) {
    return a.upstreamPorts.find((p) => listening.has(p)) || a.upstreamPorts[0];
  }
  return a.ports.find((p) => listening.has(p)) || a.ports[0] || null;
}

// --------------------------------------------------------------------------
// Diff
// --------------------------------------------------------------------------

// The comparable shape of an inventory: one set of keys per kind of thing.
function fingerprint(inv, osUnits = new Set()) {
  const s = inv.scan || {};
  return {
    service: new Set((inv.units || []).filter((u) => !isSystemUnit(u.base) && u.load !== 'not-found' && !isOsUnit(u) && !osUnits.has(u.unit)).map((u) => u.unit)),
    port: new Set((s.ports || []).flatMap((p) => (p.addrs || [p.addr]).map((a) => `${p.port} on ${a}`))),
    site: new Set((inv.sites || []).map((h) => h.serverName).filter(Boolean)),
    cron: new Set((s.cron || []).map((c) => `${c.owner}\t${c.hash ? `${c.line} [${c.hash}]` : c.line}`)),
    user: new Set((s.users || []).map((u) => u.name)),
    key: new Set((s.keys || []).map((k) => `${k.user}\t${k.fingerprint}`)),
    sudoer: new Set((s.users || []).filter((u) => u.sudo).map((u) => u.name)),
    app: new Set((inv.apps || []).map((a) => a.id).filter((id) => !osUnits.has(`${id}.service`))),
  };
}

const CHANGE_SEVERITY = {
  'key:added': 'critical', 'user:added': 'critical', 'sudoer:added': 'critical',
  'key:removed': 'warning', 'user:removed': 'warning', 'sudoer:removed': 'warning',
  'app:removed': 'critical', 'service:removed': 'warning', 'port:added': 'warning', 'port:removed': 'warning',
  'cron:added': 'warning', 'cron:removed': 'info', 'site:added': 'warning', 'site:removed': 'warning',
  'service:added': 'warning', 'app:added': 'info',
};

// What Pulse can see for itself every minute, without waiting for the hourly
// root scan: services, Apache sites, and so the apps they make.
const LIVE_KINDS = ['service', 'site', 'app'];

function diffInventories(prev, next, kinds = null) {
  if (!prev) return [];
  // Units known (now) to be Ubuntu's own are left out of BOTH sides, so an
  // older inventory that still listed them doesn't read as "gone".
  const osUnits = new Set((next.units || []).filter(isOsUnit).map((u) => u.unit));
  const a = fingerprint(prev, osUnits);
  const b = fingerprint(next, osUnits);
  const changes = [];
  for (const kind of Object.keys(b)) {
    if (kinds && !kinds.includes(kind)) continue;
    // A scan that failed (no root data) must not read as "every key removed".
    if (['port', 'cron', 'user', 'key', 'sudoer'].includes(kind) && (!prev.scan || !next.scan)) continue;
    for (const k of b[kind]) if (!a[kind].has(k)) changes.push(change(kind, 'added', k));
    for (const k of a[kind]) {
      if (b[kind].has(k)) continue;
      // PM2 / Docker themselves were app cards before 0.1.11; now each program
      // they run is. The runner leaving the app list is not an app disappearing.
      if (kind === 'app' && (isRunnerUnit(k) || /^pulse-/.test(k))) continue;
      // postgresql@15-main etc. were cards of their own before 0.1.14; now they are
      // part of one PostgreSQL card.
      if (kind === 'app' && DB_INSTANCE_RE.test(k)) continue;
      // The release that first names Pulse's own site "pulse": the old name for
      // the same site (e.g. "monitor") is not an app disappearing.
      if (kind === 'app' && b.app.has('pulse') && !a.app.has('pulse') && b.site && a.site && [...a.site].every((x) => b.site.has(x))) continue;
      changes.push(change(kind, 'removed', k));
    }
  }
  return changes;
}

function change(kind, op, key) {
  const label = key.replace('\t', ' · ');
  const nouns = { service: 'service', port: 'listening port', site: 'Apache site', cron: 'cron job', user: 'login user', key: 'SSH key', sudoer: 'sudo user', app: 'app' };
  return { kind, op, key, severity: CHANGE_SEVERITY[`${kind}:${op}`] || 'info', title: `${op === 'added' ? 'New' : 'Gone'} ${nouns[kind]}: ${label}` };
}

// --------------------------------------------------------------------------
// Findings: things worth fixing that are not emergencies
// --------------------------------------------------------------------------

function sec_ufwActive(s) { return !!(s.security && /^active/i.test(String(s.security.ufw || ''))); }

function findings(inv, now = Date.now()) {
  const out = [];
  const s = inv.scan || {};
  for (const a of inv.apps || []) {
    if (a.kind === 'app' && !a.hasBackups) out.push({ severity: 'warning', app: a.id, title: `${a.name} has no backups at all (Pulse → Backups → Back up now)` });
    if (a.kind === 'database' && !a.hasBackups && a.listening.length) out.push({ severity: 'warning', app: a.id, title: `Database ${a.name} has no backup folder` });
    if (a.upstreamPorts && a.checkPort && !a.listening.includes(a.checkPort)) out.push({ severity: 'critical', app: a.id, title: `${a.name}: Apache sends traffic to port ${a.checkPort}, but nothing is listening` });
  }
  const fwOn = sec_ufwActive(s);
  const open = [];
  for (const p of s.ports || []) {
    if (!p.public || [22, 80, 443].includes(p.port) || p.proc === 'systemd-resolve') continue;
    const app = (inv.apps || []).find((a) => a.ports.includes(p.port));
    if (app && app.kind === 'database') out.push({ severity: 'critical', app: app.id, title: `${app.name} listens on ${p.addrs.join(', ')}:${p.port} — open to the internet unless a firewall blocks it` });
    else if (!fwOn) open.push(`${p.port}${app ? ` ${app.name}` : ''}`);
  }
  if (open.length) out.push({ severity: 'warning', title: `${open.length} app port${open.length === 1 ? '' : 's'} listen on all interfaces, so they can be reached without Apache${s.security && s.security.ufw ? ' (ufw is inactive)' : ''}: ${open.join(', ')}` });
  const tarballs = (s.datadirs || []).find((d) => d.path === '/opt/*.tar.gz');
  if (tarballs && tarballs.bytes > 1024 ** 3) out.push({ severity: 'info', title: `${(tarballs.bytes / 1024 ** 3).toFixed(1)} GB of old release tarballs in /opt` });
  const sec = s.security || {};
  if (sec.upgradable_security > 0) out.push({ severity: 'warning', title: `${sec.upgradable_security} security update${sec.upgradable_security === 1 ? '' : 's'} pending` });
  if (sec.reboot_required === 'yes') out.push({ severity: 'warning', title: 'A reboot is required to finish installing updates' });
  if (sec.sshd_password_auth === 'yes') out.push({ severity: 'warning', title: 'SSH accepts passwords (PasswordAuthentication yes)' });
  if (sec.sshd_root_login && !['no', 'prohibit-password', 'without-password'].includes(sec.sshd_root_login)) out.push({ severity: 'warning', title: `SSH root login is allowed (${sec.sshd_root_login})` });
  if (s.ts && now - s.ts > 3 * 3600_000) out.push({ severity: 'warning', title: 'The root inventory scan has not run for over 3 hours' });
  return out;
}

// --------------------------------------------------------------------------
// The whole thing, live
// --------------------------------------------------------------------------

// Ports something is listening on, from /proc/net/tcp and tcp6 (readable by
// anyone, unlike WHO is listening). Used to notice a new one between scans.
function parseProcNetTcp(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4 || f[3] !== '0A') continue;   // 0A = LISTEN
    const port = parseInt(f[1].split(':').pop(), 16);
    if (Number.isFinite(port)) out.push(port);
  }
  return out;
}
function readListeningPorts(root = '/proc') {
  const ports = new Set();
  for (const f of ['net/tcp', 'net/tcp6']) {
    try { for (const p of parseProcNetTcp(fs.readFileSync(path.join(root, f), 'utf8'))) ports.add(p); } catch { /* not on this system */ }
  }
  return [...ports].sort((a, b) => a - b);
}

async function gather({ scanPath, overrides = {}, sitesDir, optDir } = {}) {
  let scan = null;
  let scanError = null;
  try { scan = parseScan(fs.readFileSync(scanPath, 'utf8')); } catch (e) { scanError = e.code === 'ENOENT' ? 'not yet run' : e.message; }
  const [units, timers] = await Promise.all([readUnits(), readTimers()]);
  const { hosts: sites, error: sitesError } = readApacheSites(sitesDir);
  const live = readLiveFiles(optDir);
  const appUnitNames = units.filter((u) => !isSystemUnit(u.base) && u.load !== 'not-found').map((u) => u.unit);
  const details = await unitDetails(appUnitNames);
  for (const u of units) if (details[u.unit] && details[u.unit].fragment) u.fragment = details[u.unit].fragment;
  const apps = buildApps({ scan, units, details, sites, live, overrides });
  return { ts: Date.now(), scan, scanError, units, timers, sites, sitesError, live, apps };
}

module.exports = {
  parseScan, parseApacheSite, readApacheSites, inlineIncludes, parseUnits, parseShow, buildApps,
  diffInventories, findings, gather, isSystemUnit, isRunnerUnit, isOsUnit, baseOf, KNOWN, run,
  appFromProcess, friendlyName, LIVE_KINDS, parseProcNetTcp, readListeningPorts,
};
