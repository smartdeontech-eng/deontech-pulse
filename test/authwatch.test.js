const test = require('node:test');
const assert = require('node:assert');
const { parseAuthLine, parseSyslogLine } = require('../core/authwatch');

test('accepted publickey gives user, IP, port and key fingerprint', () => {
  const e = parseAuthLine('Accepted publickey for deploy from 173.177.203.145 port 51234 ssh2: ED25519 SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk', 'sshd');
  assert.deepStrictEqual(e, { kind: 'ssh_login', method: 'publickey', user: 'deploy', ip: '173.177.203.145', port: 51234, keyType: 'ED25519', fingerprint: 'SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk' });
});

test('IPv6 logins parse (phone hotspot)', () => {
  const e = parseAuthLine('Accepted publickey for deploy from 2607:fea8:1d00:5a00::1 port 60122 ssh2: ED25519 SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', 'sshd');
  assert.strictEqual(e.ip, '2607:fea8:1d00:5a00::1');
});

test('password logins are recognised as such', () => {
  const e = parseAuthLine('Accepted password for root from 45.1.2.3 port 2222 ssh2', 'sshd');
  assert.strictEqual(e.kind, 'ssh_login');
  assert.strictEqual(e.method, 'password');
  assert.strictEqual(e.user, 'root');
  assert.strictEqual(e.fingerprint, null);
});

test('failed and invalid-user lines count as failures', () => {
  assert.strictEqual(parseAuthLine('Failed password for invalid user admin from 1.2.3.4 port 5555 ssh2', 'sshd').kind, 'ssh_failed');
  const inv = parseAuthLine('Invalid user oracle from 45.148.10.80 port 40001', 'sshd');
  assert.deepStrictEqual([inv.kind, inv.user, inv.ip], ['ssh_failed', 'oracle', '45.148.10.80']);
  assert.strictEqual(parseAuthLine('Failed publickey for deploy from 9.9.9.9 port 1 ssh2: ED25519 SHA256:x', 'sshd').kind, 'ssh_failed');
});

test('sudo commands, including failed passwords', () => {
  const s = parseAuthLine('deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/systemctl restart aotc-track@blue', 'sudo');
  assert.deepStrictEqual([s.kind, s.user, s.runAs, s.command], ['sudo', 'deploy', 'root', '/usr/bin/systemctl restart aotc-track@blue']);
  const f = parseAuthLine('deploy : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/ls', 'sudo');
  assert.strictEqual(f.kind, 'sudo_failed');
  assert.strictEqual(parseAuthLine('pam_unix(sudo:auth): authentication failure; logname=deploy uid=1002 euid=0 tty=/dev/pts/0 ruser=deploy rhost=  user=deploy', 'sudo'), null);
});

test('new users and sudo group membership', () => {
  assert.deepStrictEqual(parseAuthLine('new user: name=bob, UID=1003, GID=1003, home=/home/bob, shell=/bin/bash, from=/dev/pts/0', 'useradd'), { kind: 'user_added', user: 'bob', uid: 1003 });
  assert.strictEqual(parseAuthLine("add 'bob' to group 'sudo'", 'usermod').kind, 'sudoer_added');
  assert.strictEqual(parseAuthLine("add 'bob' to group 'audio'", 'usermod').kind, 'user_changed');
});

test('noise is ignored', () => {
  assert.strictEqual(parseAuthLine('pam_unix(sshd:session): session closed for user deploy', 'sshd'), null);
  assert.strictEqual(parseAuthLine('Received disconnect from 1.2.3.4 port 5: 11: disconnected by user', 'sshd'), null);
  assert.strictEqual(parseAuthLine('Accepted publickey for x from 1.2.3.4 port 5 ssh2: ED25519 SHA256:abc', 'cron'), null);
});

test('auth.log fallback lines (ISO and classic timestamps)', () => {
  const a = parseSyslogLine('2026-10-09T03:54:15.123456+00:00 ssdnodes-65e4d2d73d70c sshd[1234]: Accepted publickey for deploy from 173.177.203.145 port 51234 ssh2: ED25519 SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk');
  assert.strictEqual(a.kind, 'ssh_login');
  assert.strictEqual(a.ts, Date.parse('2026-10-09T03:54:15.123Z'));
  const b = parseSyslogLine('Oct  9 03:54:15 host sudo:   deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/true');
  assert.strictEqual(b.kind, 'sudo');
});
