// Watching who gets into the server.
//
// Follows the systemd journal for the auth facilities (sshd, sudo, useradd,
// usermod, passwd) — `journalctl -f -o json`, which the `pulse` user may read
// as a member of systemd-journal. If journalctl can't be started it falls back
// to `tail -F /var/log/auth.log` (group adm).
//
// parseAuthLine() is pure and tested against real Ubuntu 24.04 log lines.
'use strict';
const { spawn } = require('child_process');
const readline = require('readline');

const RE = {
  accepted: /^Accepted (publickey|password|keyboard-interactive(?:\/pam)?) for (\S+) from (\S+) port (\d+)(?: ssh2)?(?:: (\S+) (SHA256:\S+))?/,
  failed: /^Failed (password|publickey|none|keyboard-interactive(?:\/pam)?) for (invalid user )?(\S+) from (\S+) port (\d+)/,
  invalid: /^Invalid user (\S*) from (\S+) port (\d+)/,
  preauthClose: /^(?:Connection closed|Disconnected) by (?:authenticating|invalid) user (\S+) (\S+) port (\d+) \[preauth\]/,
  maxAuth: /^error: maximum authentication attempts exceeded for (invalid user )?(\S+) from (\S+) port (\d+)/,
  sudo: /^\s*(\S+) : (?:(\d+) incorrect password attempts? ; )?TTY=(\S+) ; PWD=(.*?) ; USER=(\S+) ; (?:ENV=.*? ; )?COMMAND=(.*)$/,
  sudoAuthFail: /^pam_unix\(sudo:auth\): authentication failure;.*\bruser=(\S*).*?\buser=(\S+)/,
  newUser: /^new user: name=([^,]+), UID=(\d+)/,
  newGroup: /^new group: name=([^,]+)/,
  addToGroup: /^add '([^']+)' to (?:shadow )?group '([^']+)'/,
  delUser: /^delete user '([^']+)'/,
  passwd: /^password (?:changed|for '([^']+)' changed) (?:for )?(\S+)?/,
  sessionOpen: /^pam_unix\(sshd:session\): session opened for user (\S+?)(?:\(uid=\d+\))? by/,
};

/**
 * @param msg   the log MESSAGE (no syslog prefix)
 * @param ident SYSLOG_IDENTIFIER: sshd | sudo | useradd | usermod | passwd | ...
 * @returns an access event, or null if the line is not interesting
 */
function parseAuthLine(msg, ident = '') {
  msg = String(msg || '').trim();
  ident = String(ident || '').replace(/\[\d+\]$/, '');
  let m;

  if (ident === 'sshd' || ident === 'sshd-session' || ident === '') {
    if ((m = msg.match(RE.accepted))) {
      const method = m[1].startsWith('keyboard-interactive') ? 'keyboard-interactive' : m[1];
      return { kind: 'ssh_login', method, user: m[2], ip: m[3], port: Number(m[4]), keyType: m[5] || null, fingerprint: m[6] || null };
    }
    if ((m = msg.match(RE.failed))) return { kind: 'ssh_failed', method: m[1], user: m[3], invalidUser: !!m[2], ip: m[4], port: Number(m[5]) };
    if ((m = msg.match(RE.invalid))) return { kind: 'ssh_failed', method: 'none', user: m[1] || '', invalidUser: true, ip: m[2], port: Number(m[3]) };
    if ((m = msg.match(RE.maxAuth))) return { kind: 'ssh_failed', method: 'max-attempts', user: m[2], invalidUser: !!m[1], ip: m[3], port: Number(m[4]) };
    if (ident !== '') return null;
  }

  if (ident === 'sudo' || ident === '') {
    if ((m = msg.match(RE.sudo))) {
      if (m[2]) return { kind: 'sudo_failed', user: m[1], attempts: Number(m[2]), command: m[6].trim(), runAs: m[5] };
      return { kind: 'sudo', user: m[1], tty: m[3], cwd: m[4], runAs: m[5], command: m[6].trim() };
    }
    if ((m = msg.match(RE.sudoAuthFail))) return null;   // the "N incorrect password attempts" line follows and carries the command
    if (ident !== '') return null;
  }

  if ((m = msg.match(RE.newUser))) return { kind: 'user_added', user: m[1], uid: Number(m[2]) };
  if ((m = msg.match(RE.addToGroup))) {
    const priv = /^(sudo|admin|wheel|root|adm|systemd-journal|docker|lxd)$/.test(m[2]);
    return { kind: priv && /^(sudo|admin|wheel|root)$/.test(m[2]) ? 'sudoer_added' : 'user_changed', user: m[1], group: m[2], privileged: priv };
  }
  if ((m = msg.match(RE.delUser))) return { kind: 'user_changed', user: m[1], change: 'deleted' };
  if (ident === 'passwd' || ident === 'chpasswd') {
    if ((m = msg.match(/password (?:changed|updated) for (\S+)/)) || (m = msg.match(/password for '([^']+)' changed/))) return { kind: 'user_changed', user: m[1], change: 'password' };
  }
  return null;
}

// From a classic syslog line in /var/log/auth.log:
//   2026-10-09T03:54:15.123456+00:00 host sshd[1234]: Accepted publickey for ...
//   Oct  9 03:54:15 host sshd[1234]: Accepted publickey for ...
function parseSyslogLine(line) {
  const m = String(line).match(/^(\S+(?:\s+\d+\s+[\d:]+)?)\s+\S+\s+([\w.@-]+)(?:\[\d+\])?:\s(.*)$/);
  if (!m) return null;
  let ts = Date.parse(m[1]);
  if (!Number.isFinite(ts)) {
    const y = new Date().getFullYear();
    ts = Date.parse(`${m[1]} ${y}`);
    if (!Number.isFinite(ts)) ts = Date.now();
  }
  const ev = parseAuthLine(m[3], m[2]);
  return ev ? { ...ev, ts, raw: m[3] } : null;
}

function createAuthWatcher({ onEvent, journalctl = 'journalctl', authLog = '/var/log/auth.log', log = console } = {}) {
  let child = null;
  let stopped = false;
  let mode = null;
  let restarts = 0;

  function startJournal() {
    mode = 'journal';
    // Auth (4) and authpriv (10) facilities; multiple matches on one field are OR'ed.
    child = spawn(journalctl, ['-f', '-o', 'json', '-n', '0', '--no-pager', 'SYSLOG_FACILITY=4', 'SYSLOG_FACILITY=10'], { stdio: ['ignore', 'pipe', 'pipe'] });
    wire(child, (line) => {
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const msg = Array.isArray(j.MESSAGE) ? Buffer.from(j.MESSAGE).toString('utf8') : j.MESSAGE;
      const ev = parseAuthLine(msg, j.SYSLOG_IDENTIFIER);
      if (ev) onEvent({ ...ev, ts: Math.round(Number(j.__REALTIME_TIMESTAMP) / 1000) || Date.now(), raw: msg });
    });
  }

  function startTail() {
    mode = 'auth.log';
    child = spawn('tail', ['-n', '0', '-F', authLog], { stdio: ['ignore', 'pipe', 'pipe'] });
    wire(child, (line) => { const ev = parseSyslogLine(line); if (ev) onEvent(ev); });
  }

  function wire(proc, handle) {
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (l) => { try { handle(l); } catch (e) { log.error('[authwatch]', e.message); } });
    let errText = '';
    proc.stderr.on('data', (d) => { errText += d; });
    proc.on('error', (e) => { log.error(`[authwatch] ${mode} failed to start: ${e.message}`); });
    proc.on('exit', (code) => {
      if (stopped) return;
      log.error(`[authwatch] ${mode} exited (${code}) ${errText.trim().slice(0, 200)}`);
      // journalctl not permitted or missing: fall back to auth.log once.
      const next = mode === 'journal' && restarts === 0 ? startTail : (mode === 'journal' ? startJournal : startTail);
      restarts++;
      setTimeout(() => { if (!stopped) next(); }, Math.min(60_000, 2000 * restarts));
    });
  }

  return {
    start() { stopped = false; startJournal(); },
    stop() { stopped = true; if (child) child.kill(); },
    mode: () => mode,
  };
}

module.exports = { parseAuthLine, parseSyslogLine, createAuthWatcher };
