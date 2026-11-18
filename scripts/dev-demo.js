/**
 * Local demo: runs Pulse against the recorded inventory of the real server
 * (test/fixtures), with fake app backends, a demo owner and a few sample
 * logins — for screenshots and for clicking through the UI on a laptop.
 *
 *   node scripts/dev-demo.js            then open http://127.0.0.1:3201
 *   sign in: demo@pulse.local / Demo-Pulse-2026!   2FA code: printed below
 *
 * Refuses to run with NODE_ENV=production.
 */
'use strict';
if (process.env.NODE_ENV === 'production') { console.error('dev-demo is for local use only.'); process.exit(1); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const root = path.join(__dirname, '..');
const dataDir = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-demo-'));
const scan = path.join(dataDir, 'inventory.txt');
const nowS = Math.floor(Date.now() / 1000);
// The backup picture as the real server showed it on 17 Oct 2026.
const demoBackups = [
  '== backups',
  `/var/backups/aotc-track\t${nowS - 196 * 3600}.0\tdata-before-blue-20261012-042907.tar.gz\t8\t10170000\tvar`,
  `/var/backups/ifaima\t${nowS - 9 * 3600}.0\tifaima-files-20261017-023003.tar.gz\t75\t12500000\tvar`,
  `/opt/aotc-track/backups\t${nowS - 4 * 3600}.0\tbackup-20261017-042926\t16\t145700000\tapp`,
  `/opt/smart-deontech/backups\t${nowS - 4 * 3600}.0\tbackup-20261017-043549\t14\t19900000\tapp`,
  `/opt/ginasangel/backups\t${nowS - 1800}.0\tbackup-20261017-211707\t14\t12500000\tapp`,
  '== backupcheck',
  '/opt/aotc-track/backups\tbackup-20261017-042926\t1\tok\t-',
  '/opt/smart-deontech/backups\tbackup-20261017-043549\t1\tok\t-',
  '/opt/ginasangel/backups\tbackup-20261017-211707\t0\tnodb\t-',
  '== offsite',
  'script\t/usr/local/bin/aotc-offsite-backup.sh',
  'remotes\tonedrive: minutes:',
  'app\t/opt/aotc-track\tAOTC-Track', 'app\t/opt/smart-deontech\tSmart-DeonTech', 'app\t/opt/ginasangel\tGinasAngel-Hub',
  'cron\t15 3 * * *\t/usr/local/bin/backup-alert.sh',
  `lastrun\t${nowS - 18 * 3600}`,
].join('\n');
fs.writeFileSync(scan, fs.readFileSync(path.join(root, 'test/fixtures/scan-real.txt'), 'utf8')
  .replace(/^ts\t\d+/m, `ts\t${nowS - 600}`)
  .replace(/^== backups\n(?:[^=\n][^\n]*\n)*/m, `${demoBackups}\n`));
Object.assign(process.env, {
  DATA_DIR: dataDir, PULSE_SCAN_PATH: scan, PULSE_APACHE_SITES: path.join(root, 'test/fixtures/sites'),
  PULSE_OPT_DIR: path.join(dataDir, 'opt'), PULSE_AUTHWATCH: 'off', PULSE_LOGS: 'on', PULSE_BACKUP_MANIFEST: path.join(dataDir, 'backup-records'),
  PULSE_APACHE_LOGS: path.join(dataDir, 'apache'),
  JWT_SECRET: process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex'),
});
fs.mkdirSync(path.join(dataDir, 'opt/aotc-lines'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'opt/ifaima'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'opt/aotc-lines/live'), 'blue\n');
fs.writeFileSync(path.join(dataDir, 'opt/ifaima/live'), 'blue\n');
fs.mkdirSync(path.join(dataDir, 'apache'), { recursive: true });
const vlog = path.join(dataDir, 'apache/other_vhosts_access.log');
fs.writeFileSync(vlog, '');
// A trickle of visitors, with the odd server error on the pledge site.
const SITES = [['track.pcg-aotc.com', 6], ['app.smartdeontech.com', 3], ['ifaima.smartdeontech.com', 2], ['pledges.pcg-aotc.com', 2], ['ginasangel.smartdeontech.com', 1]];
setInterval(() => {
  const lines = [];
  for (const [host, rate] of SITES) for (let i = 0; i < Math.round(Math.random() * rate); i++) {
    const st = host.startsWith('pledges') && Math.random() < 0.08 ? 502 : Math.random() < 0.05 ? 404 : 200;
    lines.push(`${host}:443 41.66.${Math.floor(Math.random() * 255)}.9 - - [09/Oct/2026:03:54:15 +0000] "GET / HTTP/1.1" ${st} ${1000 + Math.floor(Math.random() * 9000)} "-" "Mozilla/5.0"`);
  }
  if (lines.length) fs.appendFileSync(vlog, lines.join('\n') + '\n');
}, 1000).unref();

// Fake backends: every app on the real server except pman (5002), which is down there too.
const apps = { 3001: '/', 3011: '/api/healthz', 3100: '/', 3101: '/healthz', 3102: '/healthz', 5000: '/' };
for (const [port, ok] of Object.entries(apps)) {
  http.createServer((req, res) => {
    const delay = port === '5000' ? 180 : 15 + Math.random() * 40;
    setTimeout(() => {
      if (req.url === ok || ok === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, line: port === '3011' || port === '3101' ? 'blue' : port === '3102' ? 'green' : undefined })); }
      else { res.writeHead(404); res.end('not found'); }
    }, delay);
  }).listen(Number(port), '127.0.0.1');
}
for (const p of [3306, 1433]) net.createServer((s) => s.end()).listen(p, '127.0.0.1');

const { app, monitor, actions } = require('../server');
// "Back up now" in the demo: a pretend root helper that takes 6 s and writes a record.
fs.mkdirSync(path.join(dataDir, 'backup-records'), { recursive: true });
actions.backup = async (appId, offsite) => {
  await new Promise((r) => setTimeout(r, 6000));
  const checks = appId === 'pledge' ? ['MySQL pledgedb: dump complete (412K compressed)'] : appId === 'ifaima' ? ["ran IFAIMA's own backup (ifaima-backup.service)", 'IFAIMA database copy intact'] : ['database aotc.db: snapshot intact (9.4M)', 'files: 1,284 from 4 folder(s)'];
  checks.push(`archive opens: ${appId}-x.tar.gz`);
  fs.appendFileSync(path.join(dataDir, 'backup-records', `${appId}.jsonl`), JSON.stringify({ ts: Date.now(), app: appId, ok: true, method: 'demo', file: `/var/backups/pulse/${appId}/${appId}-x.tar.gz`, bytes: 3_400_000, seconds: 6, checks, offsite: offsite ? [{ remote: 'onedrive:', ok: true }, { remote: 'minutes:', ok: true }] : [], error: '' }) + '\n');
  return { ok: true, code: 0, output: 'Done in 6 s.' };
};
const db = require('../utils/db');
const bcrypt = require('bcryptjs');
const totp = require('../utils/totp');
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
if (!db.findOne('users', (u) => u.email === 'demo@pulse.local')) {
  db.insert('users', {
    email: 'demo@pulse.local', name: 'Demo Owner', role: 'owner', permissions: ['monitor.view', 'monitor.manage', 'staff.manage', 'settings.manage'],
    passwordHash: bcrypt.hashSync('Demo-Pulse-2026!', 10), mustChangePassword: false, sessionVersion: 0,
    twoFactorEnabled: true, twoFactorMethod: 'totp', twoFactorSecret: SECRET, backupCodeHashes: [],
  });
}

(async () => {
  await monitor.start();
  // Made-up errors, for the Errors pages.
  {
    const t = Date.now();
    const L = monitor.appLogs;
    L._setUnits({ 'pledge.service': 'pledge', 'smart-deontech.service': 'smart-deontech', 'aotc-track@blue.service': 'aotc-track' });
    const net = (id) => [
      'fail: Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware[1]',
      '      An unhandled exception has occurred while executing the request.',
      `      System.NullReferenceException: Object reference not set to an instance of an object.`,
      '         at Pledge.Controllers.PledgeController.Submit(PledgeDto dto) in /src/Pledge/Controllers/PledgeController.cs:line 87',
      '         at lambda_method12(Closure , Object , Object[] )',
      '         at Microsoft.AspNetCore.Mvc.Infrastructure.ActionMethodExecutor.SyncActionResultExecutor.Execute(ActionContext context)',
      '         at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.InvokeActionMethodAsync()',
      '         at Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddlewareImpl.Invoke(HttpContext context)',
    ];
    const before = (ts) => [
      [ts - 900, 'info: Microsoft.AspNetCore.Hosting.Diagnostics[1] Request starting HTTP/1.1 POST https://pledges.pcg-aotc.com/pledges/submit - application/x-www-form-urlencoded 312'],
      [ts - 700, 'info: Microsoft.AspNetCore.Routing.EndpointMiddleware[0] Executing endpoint \'Pledge.Controllers.PledgeController.Submit (Pledge)\''],
      [ts - 500, 'info: Pledge.Controllers.PledgeController[0] Pledge form received: campaign=harvest-2026 amount=500 member=(none)'],
    ];
    const after = (ts) => [
      [ts + 300, 'info: Microsoft.AspNetCore.Hosting.Diagnostics[2] Request finished HTTP/1.1 POST https://pledges.pcg-aotc.com/pledges/submit - 500 0 - 41.2ms'],
      [ts + 900, 'info: Microsoft.AspNetCore.Hosting.Diagnostics[1] Request starting HTTP/1.1 GET https://pledges.pcg-aotc.com/ - - -'],
    ];
    const emit = (unit, ts, lines, pre = [], post = []) => {
      for (const [x, m] of pre) L.line({ ts: x, unit, message: m });
      lines.forEach((m, i) => L.line({ ts: ts + i, unit, message: m }));
      for (const [x, m] of post) L.line({ ts: x, unit, message: m });
      L.flushPending(ts + 60_000, true);
    };
    for (const h of [20, 14, 9, 6, 5, 3, 2, 1.2, 0.6, 0.25, 0.1, 0.05]) {
      const ts = t - h * 3600_000;
      monitor.traffic.add({ vhost: 'pledges.pcg-aotc.com', status: 500, bytes: 0, method: 'POST', path: '/pledges/submit' }, ts - 100);
      emit('pledge.service', ts, net(h), before(ts), after(ts));
    }
    for (const h of [11, 4, 0.4]) {
      const ts = t - h * 3600_000;
      monitor.traffic.add({ vhost: 'pledges.pcg-aotc.com', status: 500, bytes: 0, method: 'GET', path: '/reports/campaign/harvest-2026' }, ts - 200);
      emit('pledge.service', ts, ['fail: Microsoft.EntityFrameworkCore.Query[10100]', '      Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired. The timeout period elapsed prior to completion of the operation or the server is not responding.',
        '         at Microsoft.Data.SqlClient.SqlCommand.ExecuteReader()', '         at Pledge.Data.ReportRepository.CampaignTotals(String campaign) in /src/Pledge/Data/ReportRepository.cs:line 41',
        '         at Pledge.Controllers.ReportsController.Campaign(String id) in /src/Pledge/Controllers/ReportsController.cs:line 23'],
        [[ts - 30_000, 'info: Request starting HTTP/1.1 GET https://pledges.pcg-aotc.com/reports/campaign/harvest-2026']], [[ts + 400, 'info: Request finished HTTP/1.1 GET /reports/campaign/harvest-2026 - 500']]);
    }
    const tsN = t - 7 * 3600_000;
    emit('smart-deontech.service', tsN, ["TypeError: Cannot read properties of undefined (reading 'email')", '    at sendInvoice (/opt/smart-deontech/routes/invoices.js:214:31)', '    at Layer.handle [as handle_request] (/opt/smart-deontech/node_modules/express/lib/router/layer.js:95:5)'],
      [[tsN - 400, 'POST /api/invoices/118/send']]);
    const k = L.groups({ app: 'smart-deontech' })[0];
    if (k) L.setStatus(k.id, 'known', 'demo@pulse.local', 'only for invoices with no client email — fix queued');
  }

  // Made-up people using the apps, for the Sign-ins page.
  {
    const t = Date.now();
    const UA = { iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/537.36', win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36 Edg/128.0', android: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36' };
    const P = [
      ['aotc-track', 3, 'Naa Akwele Atiapa', 'naa@pcg-aotc.com', 'localadmin', '41.66.200.14', UA.win, 4],
      ['aotc-track', 11, 'Kwame Mensah', 'kwame@pcg-aotc.com', 'secretary', '154.160.3.9', UA.iphone, 9],
      ['aotc-track', 18, 'Abena Owusu', 'abena@pcg-aotc.com', 'treasurer', '41.66.12.80', UA.android, 40],
      ['ifaima', 2, 'Yaw Darko', 'yaw@ifaima.org', 'admin', '102.176.65.20', UA.mac, 2],
      ['smart-deontech', 1, 'Prince Duodu', 'pduodu@smartdeontech.com', 'manager', '173.177.203.40', UA.mac, 6],
      ['ginasangel', 5, 'Gina Asante', 'gina@ginasangel.com', 'admin', '41.66.30.2', UA.iphone, 180],
    ];
    for (const [app, id, name, email, role, ip, ua, ago] of P) {
      monitor.appSignins.ingest(app, { events: [{ ts: t - (ago + 30) * 60_000, userId: id, email, name, role, success: true, reason: 'ok', ip, ua }] });
      if (ago < 15) monitor.appSignins.touch(app, { userId: id, email, name, role, lastSeen: t - ago * 60_000, ip, ua });
    }
    for (let i = 0; i < 3; i++) monitor.appSignins.ingest('aotc-track', { events: [{ ts: t - (70 + i) * 60_000, email: 'admin@pcg-aotc.com', success: false, reason: 'incorrect-credentials', ip: '185.220.101.7', ua: 'python-requests/2.32' }] });
  }
  if (!db.sql.get('SELECT id FROM trusted_sources LIMIT 1')) {
    db.sql.run("INSERT INTO trusted_sources (kind, label, value, created_at, created_by) VALUES ('key', 'MacBook (deploy key)', 'SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk', ?, 'demo')", Date.now());
    db.sql.run("INSERT INTO trusted_sources (kind, label, value, created_at, created_by) VALUES ('network', 'Home Wi-Fi (Toronto)', '173.177.203.0/24', ?, 'demo')", Date.now());
    const { parseAuthLine } = require('../core/authwatch');
    const t = Date.now();
    const lines = [
      [t - 7 * 3600_000, 'sshd', 'Accepted publickey for deploy from 173.177.203.145 port 51234 ssh2: ED25519 SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk'],
      [t - 7 * 3600_000 + 60_000, 'sudo', 'deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart aotc-track@blue'],
      [t - 3 * 3600_000, 'sshd', 'Accepted publickey for deploy from 2607:fea8:1d00:5a00::1 port 60122 ssh2: ED25519 SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk'],
      ...Array.from({ length: 22 }, (_, i) => [t - 2 * 3600_000 + i * 5000, 'sshd', `Invalid user ${['admin', 'oracle', 'test', 'ubuntu'][i % 4]} from 45.148.10.${80 + (i % 2)} port ${40000 + i}`]),
      [t - 40 * 60_000, 'sshd', 'Accepted publickey for deon from 102.176.65.20 port 50111 ssh2: ED25519 SHA256:b9Qe1Yk3m0Hc8kXnZ7m0J0pD4kq3r2LwV5uYx8tQwer'],
    ];
    for (const [ts, ident, msg] of lines) { const ev = parseAuthLine(msg, ident); if (ev) monitor.handleAccess({ ...ev, ts, raw: msg }); }
    // A day of traffic history, and a few errors in the pledge app's log.
    for (let m = 24 * 60; m > 0; m--) {
      const ts = Math.floor((t - m * 60_000) / 60_000) * 60_000;
      const busy = 0.4 + 0.6 * Math.sin(((ts / 3600_000) % 24) / 24 * Math.PI) ** 2;
      for (const [host, rate] of SITES) {
        const n = Math.round(rate * 60 * busy * (0.7 + Math.random() * 0.6));
        const s5 = host.startsWith('pledges') ? Math.round(n * (m < 90 && m > 70 ? 0.2 : 0.01)) : 0;
        db.sql.run('INSERT OR REPLACE INTO traffic_1m (ts, vhost, n, s4, s5, bytes) VALUES (?, ?, ?, ?, ?, ?)', ts, host, n, Math.round(n * 0.03), s5, n * 4000);
      }
    }
    monitor.appLogs._setUnits({ 'pledge.service': 'pledge' });
    for (const [ago, msg] of [[80, 'fail: Microsoft.EntityFrameworkCore.Database.Connection[20004] An error occurred using the connection to database \'Pledges\' on server \'localhost\'.'], [78, 'Unhandled exception. System.Data.SqlClient.SqlException (0x80131904): Timeout expired.'], [12, 'error: SMTP send failed: ECONNRESET']]) {
      monitor.appLogs.record({ ts: t - ago * 60_000, unit: 'pledge.service', message: msg });
    }
  }
  console.log(`\nDemo data in ${dataDir}`);
  console.log('Sign in: demo@pulse.local / Demo-Pulse-2026!');
  setInterval(() => process.stdout.write(`\r2FA code now: ${totp.totp(SECRET)}   `), 5000).unref();
  app.listen(3201, '127.0.0.1', () => console.log('Open http://127.0.0.1:3201'));
})();
