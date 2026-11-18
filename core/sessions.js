// Who is on the server right now: every open login session (SSH and console).
//
// From systemd-logind (`loginctl`), which also lists sessions that have no
// terminal (a command run over SSH); `who` (utmp) is the fallback. Neither
// needs root. Each session is matched to the SSH login Pulse recorded when it
// opened, which says which key was used — "MacBook (deploy key)", "iPhone".
'use strict';
const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

const IP_RE = /^[0-9a-fA-F.:]+$/;

// "@1791812345" (--timestamp=unix) or "Mon 2026-10-12 11:29:00 UTC".
function parseStamp(v) {
  if (!v) return null;
  const m = String(v).match(/^@(\d+)/);
  if (m) return Number(m[1]) * 1000;
  const t = Date.parse(String(v).replace(/^\w{3} /, '').replace(/ (UTC|GMT)$/, 'Z').replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

// `loginctl show-session A B …` prints one block of Key=Value lines per session.
function parseShowSession(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const o = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
    }
    if (!o.Id) continue;
    out.push({
      id: o.Id, user: o.Name || null, remote: o.Remote === 'yes', ip: IP_RE.test(o.RemoteHost || '') ? o.RemoteHost : (o.RemoteHost || null),
      service: o.Service || null, tty: o.TTY || null, state: o.State || null, cls: o.Class || null,
      since: parseStamp(o.Timestamp), source: 'logind',
    });
  }
  return out;
}

// `who --ips`: "deploy   pts/0        2026-10-12 11:29 102.176.65.20"
function parseWho(text) {
  return String(text || '').split('\n').filter(Boolean).map((l, i) => {
    const m = l.trim().match(/^(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?:\s+\(?([0-9a-fA-F.:]+)\)?)?/);
    if (!m) return null;
    return { id: `who-${i}`, user: m[1], tty: m[2], since: Date.parse(`${m[3].replace(' ', 'T')}:00Z`), ip: m[4] || null, remote: !!m[4], service: m[4] ? 'sshd' : null, state: 'active', source: 'who' };
  }).filter(Boolean);
}

function createSessions({ loginctl = 'loginctl', who = 'who' } = {}) {
  async function list() {
    const ids = await run(loginctl, ['list-sessions', '--no-legend', '--no-pager']);
    if (ids !== null) {
      const want = ids.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((x) => /^[\w-]+$/.test(x || ''));
      if (!want.length) return { source: 'logind', sessions: [] };
      const props = ['Id', 'Name', 'Remote', 'RemoteHost', 'Service', 'TTY', 'State', 'Class', 'Timestamp'].flatMap((p) => ['-p', p]);
      const text = await run(loginctl, ['show-session', ...want, ...props, '--timestamp=unix']) ?? await run(loginctl, ['show-session', ...want, ...props]);
      if (text !== null) {
        // Background/manager sessions are systemd's own bookkeeping, not a person.
        return { source: 'logind', sessions: parseShowSession(text).filter((s) => s.cls !== 'manager' && s.cls !== 'background' && s.state !== 'closing') };
      }
    }
    const w = await run(who, ['--ips']);
    if (w !== null) return { source: 'who', sessions: parseWho(w) };
    return { source: null, sessions: [], error: 'Neither loginctl nor who could be read.' };
  }

  // Put a name on each session: the SSH login that opened it, and its key.
  function annotate(sessions, { findLogin, keyLabel, country }) {
    return sessions.map((s) => {
      const login = s.remote && s.ip && s.user ? findLogin(s.user, s.ip, s.since) : null;
      const fp = login && login.fingerprint;
      return { ...s, method: login ? login.method : null, fingerprint: fp || null, key: fp ? keyLabel(fp) : null, country: s.ip && country ? country(s.ip) : null };
    }).sort((a, b) => (a.since || 0) - (b.since || 0));
  }

  return { list, annotate };
}

module.exports = { createSessions, parseShowSession, parseWho, parseStamp };
