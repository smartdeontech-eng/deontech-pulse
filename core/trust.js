// Trusted sources and alert grading for server access.
//
// The owner wants no noise from their own MacBook, wherever it is. The
// MacBook's IP changes — home Wi-Fi, the office, a phone hotspot on IPv6 — but
// its SSH key does not. So trust goes by KEY first and NETWORK second:
//
//   Who, from where                              Grade     What happens
//   -------------------------------------------  --------  ------------------------
//   Direct root login                            urgent    push + SMS/WhatsApp
//   Password / keyboard-interactive login        urgent    push + SMS/WhatsApp
//   Unknown key                                  urgent    push + SMS/WhatsApp
//   Trusted key during a deploy                  release   folded into the release
//   Trusted key + trusted network                quiet     timeline only
//   Trusted key, new network, usual country      digest    one line in the morning
//   Trusted key, new country                     normal    push
//
// Everything is recorded either way; the grade only decides who is disturbed.
'use strict';

// ---- IP and CIDR ----------------------------------------------------------

function parseIp(ip) {
  ip = String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) ip = v4mapped[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    return { v: 4, n: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]), bits: 32 };
  }
  if (ip.includes(':')) {
    const [head, tail = ''] = ip.split('::');
    if (ip.split('::').length > 2) return null;
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    if (!ip.includes('::') && h.length !== 8) return null;
    const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
    let n = 0n;
    for (const g of groups) n = (n << 16n) + BigInt(parseInt(g, 16));
    return { v: 6, n, bits: 128 };
  }
  return null;
}

function parseCidr(s) {
  const [ip, len] = String(s).trim().split('/');
  const p = parseIp(ip);
  if (!p) return null;
  const prefix = len === undefined ? p.bits : Number(len);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > p.bits) return null;
  const shift = BigInt(p.bits - prefix);
  return { v: p.v, base: (p.n >> shift) << shift, prefix, shift };
}

function cidrContains(cidr, ip) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const p = typeof ip === 'string' ? parseIp(ip) : ip;
  if (!c || !p || c.v !== p.v) return false;
  return ((p.n >> c.shift) << c.shift) === c.base;
}

// A sensible "network" to trust from one address: the /24 for IPv4 (home
// routers renumber within it), the /56 for IPv6 (what an ISP or carrier
// typically delegates to one customer).
function networkOf(ip) {
  const p = parseIp(ip);
  if (!p) return null;
  const prefix = p.v === 4 ? 24 : 56;
  const c = parseCidr(`${ip.replace(/^\[|\]$/g, '')}/${prefix}`);
  return c ? formatCidr(c) : null;
}

function formatCidr(c) {
  if (c.v === 4) {
    const n = Number(c.base);
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}/${c.prefix}`;
  }
  const g = [];
  let n = c.base;
  for (let i = 0; i < 8; i++) { g.unshift((n & 0xffffn).toString(16)); n >>= 16n; }
  return `${g.join(':').replace(/(^|:)0(:0)+(:|$)/, '::')}/${c.prefix}`;
}

// ---- Sources ---------------------------------------------------------------

function activeSources(sources, now = Date.now()) {
  return sources.filter((s) => !s.expires_at || s.expires_at > now);
}

function matchKey(sources, fingerprint) {
  if (!fingerprint) return null;
  return sources.find((s) => s.kind === 'key' && s.value === fingerprint) || null;
}

function matchNetwork(sources, ip) {
  if (!ip) return null;
  return sources.find((s) => s.kind === 'network' && cidrContains(s.value, ip)) || null;
}

// ---- Grading ---------------------------------------------------------------

const DEPLOY_COMMAND = /(systemctl\s+(restart|start|stop|reload)\s+\S+|\/release\.sh|\/switch\.sh|\/push\.sh|\/deploy\/\S+\.sh|tar\s+x\S*\s+.*\/opt\/|rsync\s.*\/opt\/)/;
const SENSITIVE_COMMAND = /(useradd|adduser|usermod|userdel|deluser|passwd|chpasswd|visudo|sudoers|authorized_keys|sshd_config|ufw\s+(disable|allow)|iptables|nft\s|crontab\s+-e|\/etc\/shadow|chmod\s+[0-7]*7[0-7]*\s+\/etc)/;

/**
 * @param event   { kind, user, ip, method, fingerprint, command }
 * @param ctx     { sources, inDeploy, country, usualCountries, recentLogin }
 * @returns       { grade, severity, reason, sourceId }
 */
function grade(event, ctx = {}) {
  const sources = activeSources(ctx.sources || []);
  const usual = new Set((ctx.usualCountries || []).map((c) => String(c).toUpperCase()));
  const country = ctx.country ? String(ctx.country).toUpperCase() : null;

  if (event.kind === 'ssh_login') {
    const key = matchKey(sources, event.fingerprint);
    const net = matchNetwork(sources, event.ip);
    if (event.user === 'root') return out('urgent', 'Direct root login', key);
    if (event.method && event.method !== 'publickey') return out('urgent', `Login with a ${event.method === 'password' ? 'password' : event.method}, not a key`, null);
    if (!key) return out('urgent', 'Login with a key that is not on the trusted list', null);
    if (ctx.inDeploy) return out('release', `${key.label} during a release`, key);
    if (net) return out('quiet', `${key.label} from ${net.label}`, key);
    if (country && usual.size && !usual.has(country)) return out('normal', `${key.label} from a new country (${country})`, key);
    return out('digest', `${key.label} from a new network${country ? ` in ${country}` : ''}`, key);
  }

  if (event.kind === 'sudo') {
    if (SENSITIVE_COMMAND.test(event.command || '')) return out('normal', 'sudo used to change users, keys, SSH or the firewall', null);
    const rl = ctx.recentLogin;   // this user's latest SSH login, if within the session window
    if (!rl) return out('urgent', `sudo by ${event.user} with no recent SSH login — not from a trusted session`, null);
    if (rl.grade === 'urgent') return out('urgent', `sudo in a session that was itself flagged`, null);
    if (ctx.inDeploy || DEPLOY_COMMAND.test(event.command || '')) return out('release', 'sudo as part of a release', null);
    if (rl.grade === 'quiet' || rl.grade === 'release') return out('quiet', 'sudo in a trusted session', null);
    return out('digest', 'sudo in a session from a new network', null);
  }

  if (event.kind === 'sudo_failed') return out('normal', `Failed sudo password for ${event.user}`, null);
  if (event.kind === 'user_added' || event.kind === 'key_added' || event.kind === 'sudoer_added') return out('urgent', 'A new way into the server was added', null);
  if (event.kind === 'user_changed' || event.kind === 'key_removed') return out('normal', 'Accounts or keys changed', null);
  if (event.kind === 'dashboard_login') return out('normal', 'Pulse sign-in from a new device', null);
  if (event.kind === 'ssh_failed') return out('quiet', 'Failed login (counted toward bursts)', null);
  return out('normal', 'Access event', null);

  function out(g, reason, src) {
    return { grade: g, severity: g === 'urgent' ? 'critical' : g === 'normal' ? 'warning' : 'info', reason, sourceId: src ? src.id : null, sourceLabel: src ? src.label : null };
  }
}

// ---- Failed-login bursts ---------------------------------------------------

// Counts failures per IP in a sliding window; returns true exactly once per
// burst (when the count first reaches the threshold).
function createBurstCounter({ threshold = 20, windowMs = 5 * 60_000 } = {}) {
  const hits = new Map();   // ip -> [ts...]
  const fired = new Map();  // ip -> ts fired
  return function hit(ip, ts = Date.now()) {
    const arr = (hits.get(ip) || []).filter((t) => ts - t < windowMs);
    arr.push(ts);
    hits.set(ip, arr);
    if (arr.length >= threshold && !(fired.get(ip) && ts - fired.get(ip) < windowMs * 6)) {
      fired.set(ip, ts);
      return { burst: true, count: arr.length };
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (ts - v[v.length - 1] > windowMs) hits.delete(k);
    return { burst: false, count: arr.length };
  };
}

module.exports = {
  parseIp, parseCidr, cidrContains, networkOf, formatCidr, activeSources, matchKey, matchNetwork,
  grade, createBurstCounter, DEPLOY_COMMAND, SENSITIVE_COMMAND,
};
