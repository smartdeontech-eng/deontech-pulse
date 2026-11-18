// Restart / Switch line from Pulse: the root helper's rules (run here as a
// normal user against a fake systemctl and a fake /opt), and Pulse's side.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createActions } = require('../core/actions');

const HELPER = path.join(__dirname, '..', 'scripts', 'pulse-action.sh');

function sandbox() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-act-'));
  const req = path.join(d, 'req'); const out = path.join(d, 'out'); const units = path.join(d, 'etc-systemd');
  for (const x of [req, out, units]) fs.mkdirSync(x);
  // A fake systemctl: apps live in our "/etc/systemd/system", ssh and mysql elsewhere.
  const log = path.join(d, 'systemctl.log');
  const sc = path.join(d, 'systemctl');
  fs.writeFileSync(sc, `#!/usr/bin/env bash
echo "$*" >> ${log}
case "$1" in
  show) u="\${@: -1}"; case "$u" in smart-deontech.service|aotc-track@blue.service) echo ${units}/$u ;; *) echo /usr/lib/systemd/system/$u ;; esac ;;
  is-active) echo active ;;
  restart) exit 0 ;;
esac`, { mode: 0o755 });
  const env = { ...process.env, PULSE_ACTION_REQ: req, PULSE_ACTION_OUT: out, PULSE_ACTION_UNIT_DIR: units, PULSE_ACTION_SYSTEMCTL: sc, PULSE_ACTION_ROOT_UID: String(process.getuid()), PULSE_ACTION_SWITCH_ROOT: d };
  const ask = (id, line) => {
    fs.writeFileSync(path.join(req, `${id}.req`), `${line}\n`);
    execFileSync('bash', [HELPER], { env });
    return fs.readFileSync(path.join(out, `${id}.out`), 'utf8');
  };
  return { d, req, out, log, env, ask };
}

test('the root helper restarts only an app, never ssh or a system service', () => {
  const s = sandbox();
  assert.match(s.ask('aaaaaaaa01', 'restart smart-deontech.service'), /smart-deontech\.service is active\nexit=0/);
  assert.match(fs.readFileSync(s.log, 'utf8'), /^restart smart-deontech\.service$/m);
  assert.match(s.ask('aaaaaaaa02', 'restart ssh.service'), /may not restart ssh\.service[\s\S]*exit=2/);
  assert.match(s.ask('aaaaaaaa03', 'restart mysql.service'), /not one of the apps[\s\S]*exit=2/);
  assert.match(s.ask('aaaaaaaa04', 'restart pulse.service'), /exit=2/);
  assert.match(s.ask('aaaaaaaa05', 'restart ../../etc/passwd'), /Not a service name[\s\S]*exit=2/);
  assert.match(s.ask('aaaaaaaa06', 'rm -rf /'), /Refused[\s\S]*exit=2/);
  assert.match(s.ask('aaaaaaaa07', 'restart smart-deontech.service extra words'), /Refused[\s\S]*exit=2/);
  assert.strictEqual(fs.readFileSync(s.log, 'utf8').match(/^restart /gm).length, 1, 'only the one allowed restart ran');
  assert.deepStrictEqual(fs.readdirSync(s.req), [], 'requests are consumed');
});

test('the root helper never echoes a request, and ignores odd file names and symlinks', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.d, 'secret'), 'TOPSECRET line\n');
  fs.symlinkSync(path.join(s.d, 'secret'), path.join(s.req, 'bbbbbbbb01.req'));
  fs.writeFileSync(path.join(s.req, 'BAD NAME.req'), 'restart smart-deontech.service\n');
  execFileSync('bash', [HELPER], { env: s.env });
  assert.deepStrictEqual(fs.readdirSync(s.out).filter((f) => f.endsWith('.out')), [], 'nothing answered');
  assert.deepStrictEqual(fs.readdirSync(s.req), [], 'both removed');
  const r = s.ask('bbbbbbbb02', 'TOPSECRET line');
  assert.ok(!r.includes('TOPSECRET'));
});

test('switching a line runs only that app\'s own switch.sh, and only if it is safe to run', () => {
  const s = sandbox();
  const dir = path.join(s.d, 'opt', 'aotc-lines'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'switch.sh'), '#!/usr/bin/env bash\necho "switched to $1"\n', { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  assert.match(s.ask('cccccccc01', 'switch aotc-track green'), /switched to green\nexit=0/);
  assert.match(s.ask('cccccccc02', 'switch aotc-track purple'), /blue or green[\s\S]*exit=2/);
  assert.match(s.ask('cccccccc03', 'switch smart-deontech blue'), /only for[\s\S]*exit=2/);
  fs.chmodSync(path.join(dir, 'switch.sh'), 0o777);   // writable by others: refuse
  assert.match(s.ask('cccccccc04', 'switch aotc-track blue'), /will not run it[\s\S]*exit=2/);
  assert.match(s.ask('cccccccc05', 'switch ifaima blue'), /missing[\s\S]*exit=2/);
});

test("Pulse's side: a request goes in whole, the answer comes back, and a missing helper is reported", async () => {
  const s = sandbox();
  const a = createActions({ reqDir: s.req, outDir: s.out, pollMs: 50, noHelperMs: 400 });
  // The helper, as systemd's path unit would run it.
  const timer = setInterval(() => { if (fs.readdirSync(s.req).some((f) => f.endsWith('.req'))) execFileSync('bash', [HELPER], { env: s.env }); }, 60);
  const r = await a.restart('smart-deontech.service');
  clearInterval(timer);
  assert.strictEqual(r.ok, true);
  assert.match(r.output, /smart-deontech\.service is active/);
  assert.strictEqual((await a.restart('nope; rm -rf /')).code, 2, 'refused before it is written');
  const lost = await a.restart('smart-deontech.service');   // nobody listening now
  assert.strictEqual(lost.ok, false);
  assert.match(lost.output, /did not answer/);
});

test('who is on the server: logind blocks and who lines are read, background sessions left out', () => {
  const { parseShowSession, parseWho, createSessions } = require('../core/sessions');
  const s = parseShowSession(`Id=12
Name=deploy
Remote=yes
RemoteHost=102.176.65.20
Service=sshd
TTY=pts/0
State=active
Class=user
Timestamp=@1791812345

Id=c1
Name=root
Remote=no
TTY=tty1
State=online
Class=user
Timestamp=Mon 2026-10-12 11:29:00 UTC

Id=3
Name=deploy
Class=manager
State=active`);
  assert.strictEqual(s.length, 3);
  assert.deepStrictEqual([s[0].user, s[0].ip, s[0].since, s[0].remote], ['deploy', '102.176.65.20', 1791812345000, true]);
  assert.strictEqual(s[1].since, Date.parse('2026-10-12T11:29:00Z'));
  const w = parseWho('deploy   pts/0        2026-10-12 11:29 102.176.65.20\nroot     tty1         2026-10-12 09:00\n');
  assert.deepStrictEqual(w.map((x) => [x.user, x.ip, x.remote]), [['deploy', '102.176.65.20', true], ['root', null, false]]);
  const named = createSessions().annotate([s[0], s[1]], {
    findLogin: (user, ip) => (ip === '102.176.65.20' ? { fingerprint: 'SHA256:iphone', method: 'publickey' } : null),
    keyLabel: (fp) => ({ label: fp === 'SHA256:iphone' ? 'iPhone' : '?', trusted: true }),
  });
  assert.strictEqual(named.find((x) => x.id === '12').key.label, 'iPhone');
  assert.strictEqual(named.find((x) => x.id === 'c1').key, null, 'console: no key');
});
