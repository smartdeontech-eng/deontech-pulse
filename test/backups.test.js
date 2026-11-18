// Backups: the root script's plans and checks (run here as a normal user with
// stand-ins for mysqldump, systemctl and rclone), the scan's new sections, the
// per-app picture, and "Back up now" end to end through the action helper.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const discovery = require('../core/discovery');

const HELPER = path.join(__dirname, '..', 'scripts', 'pulse-action.sh');
const BACKUP = path.join(__dirname, '..', 'scripts', 'pulse-backup.sh');
const HAS_SQLITE = spawnSync('sqlite3', ['-version']).status === 0;

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bk-'));
  const fsroot = path.join(d, 'fs');
  const bin = path.join(d, 'bin');
  const remote = path.join(d, 'remote');
  for (const x of [bin, remote, path.join(d, 'req'), path.join(d, 'out'), path.join(d, 'man')]) fs.mkdirSync(x, { recursive: true });
  const w = (f, body) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  // An app with a live SQLite database (WAL), settings, uploads and its own backups.
  const data = path.join(fsroot, 'opt/smart-deontech/data');
  w(path.join(data, 'settings.json'), '{"a":1}');
  w(path.join(fsroot, 'opt/smart-deontech/public/uploads/logo.png'), 'png');
  w(path.join(data, 'backups/old/readme.txt'), 'old');
  if (HAS_SQLITE) execFileSync('sqlite3', [path.join(data, 'app.db'), 'PRAGMA journal_mode=WAL; create table t(x); insert into t values (1),(2),(3);']);
  w(path.join(bin, 'mysqldump'), '#!/bin/bash\nfor a; do db=$a; done\necho "CREATE TABLE $db (id int);"\n[ "$db" = brokendb ] || echo "-- Dump completed on 2026-10-17"\n');
  w(path.join(bin, 'mysql'), "#!/bin/bash\nprintf 'information_schema\\nmysql\\npcgaotdb\\npledgedb\\nsys\\n'\n");
  w(path.join(bin, 'rclone'), `#!/bin/bash\n[ "$1" = copyto ] || exit 3\n[ -n "$FAIL_REMOTE" ] && [[ $3 == $FAIL_REMOTE* ]] && { echo "token expired" >&2; exit 1; }\nt="${remote}/\${3/:/\\/}"; mkdir -p "$(dirname "$t")"; cp "$2" "$t"\n`);
  w(path.join(bin, 'systemctl'), `#!/bin/bash\n[ "$2" = ifaima-backup.service ] || exit 5\nmkdir -p ${fsroot}/var/backups/ifaima\nsqlite3 ${d}/x.db "create table m(a); insert into m values(1);"\ngzip -c ${d}/x.db > ${fsroot}/var/backups/ifaima/ifaima-now.db.gz\necho f > ${fsroot}/var/backups/ifaima/ifaima-files-now.tar.gz\n`);
  for (const f of fs.readdirSync(bin)) fs.chmodSync(path.join(bin, f), 0o755);
  const env = {
    ...process.env, PULSE_BACKUP_PREFIX: fsroot, PULSE_BACKUP_MANIFEST: path.join(d, 'man'), PULSE_BACKUP_MYSQLDUMP: path.join(bin, 'mysqldump'),
    PULSE_BACKUP_MYSQL: path.join(bin, 'mysql'), PULSE_BACKUP_RCLONE: path.join(bin, 'rclone'), PULSE_BACKUP_SYSTEMCTL: path.join(bin, 'systemctl'),
    PULSE_ACTION_ROOT_UID: String(process.getuid()), PULSE_ACTION_REQ: path.join(d, 'req'), PULSE_ACTION_OUT: path.join(d, 'out'), PULSE_BACKUP_KEEP: '3',
  };
  const run = (app, off = '0', id = 'abc123', extra = {}) => spawnSync('bash', [BACKUP, app, off, id], { env: { ...env, ...extra }, encoding: 'utf8' });
  const record = (app) => fs.readFileSync(path.join(d, 'man', `${app}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  return { d, fsroot, remote, env, run, record };
}

test('files plan: databases snapshotted while live and checked; files copied; nested backups left out; archive root-only', { skip: !HAS_SQLITE && 'sqlite3 not installed' }, () => {
  const s = sandbox();
  const r = s.run('smart-deontech');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /database app\.db: snapshot intact/);
  const rec = s.record('smart-deontech');
  assert.strictEqual(rec.ok, true);
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);
  const arch = rec.file;
  assert.strictEqual((fs.statSync(arch).mode & 0o777).toString(8), '600');
  const list = execFileSync('tar', ['-tzf', arch], { encoding: 'utf8' });
  assert.match(list, /databases\/.*\/app\.db/);
  assert.match(list, /files\.tar/);
  const files = execFileSync('bash', ['-c', `tar -xzOf "${arch}" ./files.tar | tar -t`], { encoding: 'utf8' });
  assert.match(files, /settings\.json/);
  assert.match(files, /uploads\/logo\.png/);
  assert.ok(!/app\.db/.test(files), 'the live database file is not copied raw');
  assert.ok(!/backups\/old/.test(files), "the app's own backups are not backed up again");
  assert.ok(!/\.err/.test(list), 'no scratch files in the archive');
  // The snapshot really has the rows.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bk-x-'));
  execFileSync('tar', ['-xzf', arch, '-C', tmp]);
  const db = execFileSync('bash', ['-c', `find "${tmp}/databases" -name app.db`], { encoding: 'utf8' }).trim();
  assert.strictEqual(execFileSync('sqlite3', [db, 'select count(*) from t;'], { encoding: 'utf8' }).trim(), '3');
});

test('off-site: each remote gets a copy; a failing remote is reported, the local backup still counts', { skip: !HAS_SQLITE && 'sqlite3 not installed' }, () => {
  const s = sandbox();
  let r = s.run('smart-deontech', '1', 'off1');
  assert.strictEqual(r.status, 0, r.stdout);
  const rec = s.record('smart-deontech');
  assert.deepStrictEqual(rec.offsite.map((o) => [o.remote, o.ok]), [['onedrive:', true], ['minutes:', true]]);
  assert.ok(fs.readdirSync(path.join(s.remote, 'onedrive/Smart-DeonTech/Backups')).length === 1);
  r = s.run('smart-deontech', '1', 'off2', { FAIL_REMOTE: 'minutes:' });
  assert.strictEqual(r.status, 0, 'the backup itself is fine');
  const rec2 = s.record('smart-deontech');
  assert.strictEqual(rec2.ok, true);
  assert.deepStrictEqual(rec2.offsite.map((o) => o.ok), [true, false]);
  assert.match(rec2.offsite[1].error, /token expired/);
});

test('MySQL plans: one database, all user databases; an unfinished dump fails the backup', () => {
  const s = sandbox();
  assert.strictEqual(s.run('pledge').status, 0);
  assert.match(s.record('pledge').checks.join('\n'), /MySQL pledgedb: dump complete/);
  assert.strictEqual(s.run('mysql').status, 0);
  const all = s.record('mysql').checks.join('\n');
  assert.match(all, /pcgaotdb/); assert.match(all, /pledgedb/);
  assert.ok(!/information_schema|performance_schema| sys/.test(all), 'system databases are left out');
  // A dump that stops half-way is not a backup.
  fs.writeFileSync(path.join(s.d, 'bin', 'mysqldump'), '#!/bin/bash\necho "CREATE TABLE x (id int);"\n');
  const r = s.run('pman');
  assert.strictEqual(r.status, 1);
  const rec = s.record('pman');
  assert.strictEqual(rec.ok, false);
  assert.match(rec.error, /did not finish/);
  assert.strictEqual(rec.file, '');
});

test('IFAIMA: its own backup runs, and its database copy is checked', { skip: !HAS_SQLITE && 'sqlite3 not installed' }, () => {
  const s = sandbox();
  const r = s.run('ifaima');
  assert.strictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /ran IFAIMA's own backup/);
  assert.match(r.stdout, /IFAIMA database copy intact/);
});

test('refusals: unknown app, odd names, odd off-site flag; only the newest backups are kept', () => {
  const s = sandbox();
  assert.strictEqual(s.run('nope').status, 2);
  assert.strictEqual(s.run('../etc').status, 2);
  assert.strictEqual(s.run('pledge', 'yes').status, 2);
  for (const id of ['k1', 'k2', 'k3', 'k4', 'k5']) assert.strictEqual(s.run('pledge', '0', id).status, 0);
  assert.strictEqual(fs.readdirSync(path.join(s.fsroot, 'var/backups/pulse/pledge')).filter((f) => f.endsWith('.tar.gz')).length, 3);
});

test('through the action helper: "backup <app> 0|1" runs; anything else is refused', () => {
  const s = sandbox();
  const ask = (id, line) => {
    fs.writeFileSync(path.join(s.d, 'req', `${id}.req`), `${line}\n`);
    execFileSync('bash', [HELPER], { env: s.env });
    return fs.readFileSync(path.join(s.d, 'out', `${id}.out`), 'utf8');
  };
  assert.match(ask('cccccccc01', 'backup pledge 0'), /dump complete[\s\S]*exit=0/);
  assert.match(ask('cccccccc02', 'backup pledge maybe'), /Refused[\s\S]*exit=2/);
  assert.match(ask('cccccccc03', 'backup /etc 0'), /Refused[\s\S]*exit=2/);
  assert.match(ask('cccccccc04', 'backup nope 1'), /no backup plan[\s\S]*exit=2/);
  assert.strictEqual(s.record('pledge').id, 'cccccccc01');
});

test('scan: app-made backups, Pulse backups, the newest backup check and the off-site job are read; sources are per app', () => {
  const scan = discovery.parseScan([
    '== backups',
    '/var/backups/aotc-track\t1791800000.0\tdata-before-blue-20261012-042907.tar.gz\t8\t9700000\tvar',
    '/var/backups/ifaima\t1792200000.0\tifaima-files-20261017-023003.tar.gz\t75\t12000000\tvar',
    '/var/backups/pulse/pledge\t1792210000.0\tpledge-20261017-x.tar.gz\t2\t40000\tpulse',
    '/opt/aotc-track/backups\t1792210500.0\tbackup-20261017-042926\t16\t139000000\tapp',
    '== backupcheck',
    '/opt/aotc-track/backups\tbackup-20261017-042926\t1\tok\t-',
    '== offsite',
    'script\t/usr/local/bin/aotc-offsite-backup.sh',
    'remotes\tonedrive: minutes:',
    'app\t/opt/aotc-track\tAOTC-Track',
    'app\t/opt/smart-deontech\tSmart-DeonTech',
    'cron\t15 3 * * *\t/usr/local/bin/backup-alert.sh',
    'lastrun\t1792206900',
  ].join('\n'));
  assert.strictEqual(scan.backups[3].kind, 'app');
  assert.deepStrictEqual(scan.offsite.remotes, ['onedrive:', 'minutes:']);
  assert.strictEqual(scan.offsite.lastRun, 1792206900000);
  const apps = discovery.buildApps({ scan, units: [
    { unit: 'aotc-track@blue.service', base: 'aotc-track@blue', active: 'active' },
    { unit: 'ifaima-blue.service', base: 'ifaima-blue', active: 'active' },
    { unit: 'ifaima-backup.service', base: 'ifaima-backup', active: 'inactive' },
    { unit: 'pledge.service', base: 'pledge', active: 'active' },
  ] });
  const aotc = apps.find((a) => a.id === 'aotc-track');
  assert.deepStrictEqual(aotc.backupSources.map((x) => x.role).sort(), ['own', 'release']);
  assert.strictEqual(aotc.backups.dir, '/opt/aotc-track/backups', 'the newest REGULAR backup, not the release copy');
  assert.strictEqual(aotc.backupSources.find((x) => x.role === 'own').check.result, 'ok');
  assert.strictEqual(aotc.offsite.folder, 'AOTC-Track');
  const ifa = apps.find((a) => a.id === 'ifaima');
  assert.strictEqual(ifa.backupSources[0].role, 'scheduled');
  assert.strictEqual(ifa.offsite, null, 'IFAIMA is not in the off-site job');
  assert.strictEqual(apps.find((a) => a.id === 'pledge').backupSources[0].role, 'pulse');
});

test('per-app picture and "Back up now" through Pulse: started, recorded, event, then the page shows it', async () => {
  const { createBackups } = require('../core/backups');
  const { tmpDb } = require('./helpers');
  const { db } = tmpDb();
  const man = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bk-man-'));
  let settings = { thresholds: { backupMaxAgeHours: 26 }, timezones: ['Africa/Accra'], backupSchedule: {} };
  const raised = [];
  const t = Date.now();
  const monitor = {
    state: { apps: [
      { id: 'aotc-track', name: 'AOTC Track', kind: 'app', backupSources: [{ role: 'own', dir: '/opt/aotc-track/backups', newestTs: t - 3600_000, newest: 'backup-x', count: 16, bytes: 1 }, { role: 'release', dir: '/var/backups/aotc-track', newestTs: t - 196 * 3600_000 }], offsite: { folder: 'AOTC-Track', remotes: ['onedrive:'] } },
      { id: 'ifaima', name: 'IFAIMA', kind: 'app', backupSources: [{ role: 'scheduled', dir: '/var/backups/ifaima', newestTs: t - 3600_000 }], offsite: null },
      { id: 'pledge', name: 'Pledges', kind: 'app', backupSources: [] },
      { id: 'mssql-server', name: 'SQL Server', kind: 'database', listening: [1433] },
    ] },
    alerts: { raise: (a) => raised.push(a), resolve: () => {} },
  };
  const actions = { backup: async (app, off) => {
    fs.appendFileSync(path.join(man, `${app}.jsonl`), JSON.stringify({ ts: Date.now(), app, ok: true, file: `/var/backups/pulse/${app}/${app}-1.tar.gz`, bytes: 1234, checks: ['MySQL pledgedb: dump complete'], offsite: off ? [{ remote: 'onedrive:', ok: true }] : [], error: '' }) + '\n');
    return { ok: true, output: 'Done.' };
  } };
  const b = createBackups({ monitor, actions, db, getSettings: () => settings, updateSettings: (p) => { settings = { ...settings, ...p }; }, manifestDir: man });
  const byId = () => Object.fromEntries(b.list().map((x) => [x.id, x]));
  let s = byId();
  assert.strictEqual(s['aotc-track'].verdict, 'ok', 'fresh, and off-site by the nightly job — the release copy does not make it look old');
  assert.strictEqual(s.ifaima.verdict, 'local', 'fresh but no off-site copy');
  assert.strictEqual(s.pledge.verdict, 'none');
  assert.ok(s['mssql-server'].plan, 'SQL Server has a plan now');
  assert.match(s['mssql-server'].note, /set-mssql-login\.sh/);
  assert.ok(s.pulse && s.pulse.plan, 'Pulse lists itself, with a plan');

  const r = b.run('pledge', { offsite: true, by: 'owner@example.com' });
  assert.ok(r.started);
  assert.strictEqual(b.run('pledge').status, 409, 'one at a time per app');
  assert.ok(byId().pledge.running);
  const res = await r.done;
  assert.strictEqual(res.ok, true);
  s = byId();
  assert.strictEqual(s.pledge.running, null);
  assert.strictEqual(s.pledge.verdict, 'ok', 'now backed up, and off-site');
  assert.strictEqual(s.pledge.history[0].file, 'pledge-1.tar.gz', 'only the file name reaches the page');
  assert.ok(db.sql.get("SELECT title FROM events WHERE title LIKE 'Pledges: backup done%'"));

  // Nightly: at the set time, the apps switched on run once that day.
  b.setSchedule('pledge', { nightly: true, offsite: false });
  settings.backupTime = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Accra', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  assert.deepStrictEqual(await b.tick(), ['pledge']);
  assert.strictEqual(await b.tick(), null, 'not twice the same day');
  assert.ok(settings.backupLastNightly);
});

test('Pulse backs itself up: its database snapshotted and checked, settings kept; the country table and requests left out', { skip: !HAS_SQLITE && 'sqlite3 not installed' }, () => {
  const s = sandbox();
  const lib = path.join(s.fsroot, 'var/lib/pulse');
  fs.mkdirSync(path.join(lib, 'actions'), { recursive: true });
  fs.writeFileSync(path.join(lib, 'settings.json'), '{"backupTime":"01:40"}');
  fs.writeFileSync(path.join(lib, 'dbip-country-lite.csv'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(lib, 'actions', 'abc.req'), 'backup pulse 1');
  execFileSync('sqlite3', [path.join(lib, 'pulse.db'), 'PRAGMA journal_mode=WAL; create table alerts(x); insert into alerts values (1);']);
  const r = s.run('pulse', '1');
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /database pulse\.db: snapshot intact/);
  const rec = s.record('pulse');
  assert.strictEqual(rec.ok, true);
  assert.deepStrictEqual(rec.offsite.map((o) => o.ok), [true, true]);
  assert.ok(fs.existsSync(path.join(s.remote, 'onedrive', 'DeonTech-Pulse', 'Backups', path.basename(rec.file))), 'off-site in its own folder');
  const files = execFileSync('bash', ['-c', `tar -xzOf "${rec.file}" ./files.tar | tar -t`], { encoding: 'utf8' });
  assert.match(files, /settings\.json/);
  assert.ok(!/\.csv|actions\//.test(files), files);
});

test('SQL Server: every user database backed up by SQL Server with checksums, using the stored login, never on the command line', () => {
  const s = sandbox();
  const bin = path.join(s.d, 'bin');
  const data = path.join(s.fsroot, 'var/opt/mssql/data');
  fs.mkdirSync(data, { recursive: true });
  const log = path.join(s.d, 'sqlcmd.log');
  fs.writeFileSync(path.join(bin, 'sqlcmd'), `#!/bin/bash
echo "ARGS: $* | PW=$SQLCMDPASSWORD" >> ${log}
q="\${@: -1}"
case "$q" in
  *"FROM sys.databases"*) printf 'HangfireDb\\r\\nBroken_Db\\r\\n' ;;
  *"BACKUP DATABASE [HangfireDb]"*) f=$(sed -E "s/.*DISK = N'([^']+)'.*/\\1/" <<<"$q"); echo hangfire > "$f"; echo "BACKUP DATABASE successfully processed" ;;
  *"BACKUP DATABASE [Broken_Db]"*) echo "Msg 3201, Level 16: Cannot open backup device. Operating system error 5(Access is denied.)"; exit 1 ;;
esac
`, { mode: 0o755 });
  const env = { PULSE_BACKUP_SQLCMD: path.join(bin, 'sqlcmd') };
  // No login yet: a clear way forward.
  let r = s.run('mssql-server', '0', 'abc123', env);
  assert.notStrictEqual(r.status, 0);
  assert.match(s.record('mssql-server').error, /set-mssql-login\.sh/);
  // A login readable by others is refused.
  const cnf = path.join(s.fsroot, 'etc/pulse-mssql.cnf');
  fs.mkdirSync(path.dirname(cnf), { recursive: true });
  fs.writeFileSync(cnf, 'MSSQL_USER=pulse_backup\nMSSQL_PASSWORD=Secret-123!\n', { mode: 0o644 });
  fs.chmodSync(cnf, 0o644);
  r = s.run('mssql-server', '0', 'abc124', env);
  assert.match(s.record('mssql-server').error, /root only/);
  fs.chmodSync(cnf, 0o600);
  r = s.run('mssql-server', '0', 'abc125', env);
  const rec = s.record('mssql-server');
  assert.strictEqual(rec.ok, false, 'one database failed, so the backup does not count');
  assert.match(rec.checks.join('\n'), /SQL Server HangfireDb: backed up with page checksums/);
  assert.match(rec.error, /Broken_Db: Msg 3201/);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /-U pulse_backup/);
  assert.match(calls, /PW=Secret-123!/);
  assert.ok(!/ARGS: [^|]*Secret-123/.test(calls), 'the password is never an argument');
  assert.match(calls, /WITH COPY_ONLY, CHECKSUM, INIT/);
  assert.deepStrictEqual(fs.readdirSync(data), [], 'nothing left in SQL Server’s folder');
});
