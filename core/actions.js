// The few things the owner can do from Pulse, not just watch.
//
//   restart / switch line   need root: Pulse writes a one-line request that
//                           pulse-action.path hands to scripts/pulse-action.sh
//                           (root), and waits for its result file.
//   logs / top processes    Pulse can read these itself (systemd-journal group,
//                           /proc), so no request is needed.
//
// Pulse stays unprivileged: a stolen Pulse session could at most ask for these
// two things, and the routes in front of them need a fresh 2FA code and raise
// an alert every time.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function run(cmd, args, { timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._-]{0,80}\.service$/;

function createActions({ reqDir, outDir, journalctl = 'journalctl', ps = 'ps', waitMs = 120_000, pollMs = 500, noHelperMs = 15_000 } = {}) {
  // Ask root for one thing and wait for the answer.
  async function request(line, { waitMs: wait = waitMs } = {}) {
    fs.mkdirSync(reqDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    const tmp = path.join(reqDir, `.${id}.tmp`);
    fs.writeFileSync(tmp, `${line}\n`, { mode: 0o640 });
    fs.renameSync(tmp, path.join(reqDir, `${id}.req`));   // appears whole, never half-written
    const out = path.join(outDir, `${id}.out`);
    const started = Date.now();
    while (Date.now() - started < wait) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (fs.existsSync(out)) {
        const text = fs.readFileSync(out, 'utf8');
        const m = text.match(/\nexit=(\d+)\s*$/) || text.match(/^exit=(\d+)\s*$/);
        const code = m ? Number(m[1]) : 1;
        try { fs.unlinkSync(out); } catch { /* root's file; it is swept daily */ }
        return { ok: code === 0, code, output: text.replace(/\n?exit=\d+\s*$/, '').trim() };
      }
      // Nobody picked it up: the helper isn't installed (or is stopped).
      if (Date.now() - started > noHelperMs && fs.existsSync(path.join(reqDir, `${id}.req`))) {
        try { fs.unlinkSync(path.join(reqDir, `${id}.req`)); } catch { /* */ }
        return { ok: false, code: -1, output: 'The action helper on the server did not answer. Install this Pulse release with deploy/release.sh (it sets up pulse-action.path), then try again.' };
      }
    }
    return { ok: false, code: -1, output: `Still running after ${Math.round(wait / 60_000)} minutes. Check the app in a moment; the result will show in its status.` };
  }

  const restart = (unit) => {
    if (!UNIT_RE.test(String(unit))) return Promise.resolve({ ok: false, code: 2, output: 'Not a service name.' });
    return request(`restart ${unit}`);
  };
  const switchLine = (app, line) => {
    if (!/^[a-z0-9-]{1,40}$/.test(String(app)) || !['blue', 'green'].includes(line)) return Promise.resolve({ ok: false, code: 2, output: 'Unknown app or line.' });
    return request(`switch ${app} ${line}`);
  };

  // A fresh inventory scan (read-only, as root), when something new appeared
  // between the hourly ones.
  const scan = () => request('scan', { waitMs: 3 * 60_000 });

  // A backup can take a while (a dump, then an upload to OneDrive).
  const backup = (app, offsite) => {
    if (!/^[a-z0-9-]{1,40}$/.test(String(app))) return Promise.resolve({ ok: false, code: 2, output: 'Not an app name.' });
    return request(`backup ${app} ${offsite ? 1 : 0}`, { waitMs: 40 * 60_000 });
  };

  // The last lines an app wrote, from the journal (all its units, merged).
  async function logs(units, lines = 60) {
    const us = (units || []).filter((u) => UNIT_RE.test(u));
    if (!us.length) return { ok: false, text: 'This app has no service to read logs from.' };
    const args = ['--no-pager', '-o', 'short-iso', '-n', String(Math.min(500, Math.max(10, lines)))];
    for (const u of us) args.push('-u', u);
    const r = await run(journalctl, args);
    return { ok: r.ok, text: (r.stdout || r.stderr).trim() || 'No log lines.' };
  }

  // What is using the memory right now.
  async function top(n = 10) {
    const r = await run(ps, ['-eo', 'pid=,rss=,pcpu=,etimes=,comm=', '--sort=-rss']);
    if (!r.ok) return [];
    return r.stdout.split('\n').filter(Boolean).slice(0, n).map((l) => {
      // Command lines can carry passwords, so only the program name is shown,
      // with the service it belongs to (from its cgroup).
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return { pid: Number(m[1]), rss: Number(m[2]) * 1024, cpu: Number(m[3]), uptime: Number(m[4]), name: m[5].trim(), unit: unitOf(Number(m[1])) };
    }).filter(Boolean);
  }

  function unitOf(pid) {
    try {
      const cg = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
      const m = cg.match(/\/([^/\n]+\.service)(?:\/|\n|$)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  return { restart, switchLine, backup, scan, logs, top, request };
}

module.exports = { createActions, UNIT_RE };
