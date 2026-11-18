/**
 * Reset a password from the server (hidden prompt). Signs the account out
 * everywhere and lifts any lockout.
 *
 *   node scripts/set-password.js you@example.com
 *   node scripts/set-password.js --list
 *   node scripts/set-password.js you@example.com --reset-2fa   (lost phone: 2FA is set up again at next sign-in)
 */
'use strict';
require('dotenv').config({ quiet: true });
require('@deontech/config').configureApp({ productName: 'DeonTech Pulse', legalName: 'Smart DeonTech Limited', dataDir: require('../utils/dataDir') });
const bcrypt = require('bcryptjs');
const db = require('../utils/db');
const { validatePassword } = require('../utils/passwordPolicy');

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
if (args.includes('--list') || !email) {
  for (const u of db.readAll('users')) console.log(`  ${u.email.padEnd(34)} ${String(u.role).padEnd(8)} 2FA:${u.twoFactorEnabled ? 'on' : 'off'} passkeys:${(u.passkeys || []).length}`);
  if (!email) console.log('\nUsage: node scripts/set-password.js <email> [--reset-2fa]');
  process.exit(0);
}
const user = db.findOne('users', (u) => u.email.toLowerCase() === email.toLowerCase());
if (!user) { console.error(`No account for ${email}.`); process.exit(1); }

function ask(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin; process.stdout.write(prompt); let v = '';
    if (!stdin.isTTY) { stdin.once('data', (d) => resolve(String(d).trim())); return; }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); resolve(v); }
      else if (ch === '\u0003') process.exit(130); else if (ch === '\u007f') v = v.slice(0, -1); else v += ch;
    };
    stdin.on('data', on);
  });
}

(async () => {
  const pw = await ask(`New password for ${user.email}: `);
  const check = validatePassword(pw, { email: user.email, name: user.name });
  if (!check.valid) { console.error('Not strong enough:\n  - ' + check.failedRules.join('\n  - ')); process.exit(1); }
  if ((await ask('Again: ')) !== pw) { console.error('They do not match.'); process.exit(1); }
  const NOT_A_FAILURE = new Set(['locked-out', 'awaiting-2fa', 'must-change-password']);
  for (const l of db.findAll('login_logs', (x) => x.email && x.email.toLowerCase() === user.email.toLowerCase() && !x.success && !NOT_A_FAILURE.has(x.reason))) db.remove('login_logs', l.id);
  const patch = { passwordHash: bcrypt.hashSync(pw, 10), mustChangePassword: false, sessionVersion: (user.sessionVersion || 0) + 1 };
  if (args.includes('--reset-2fa')) Object.assign(patch, { twoFactorEnabled: false, twoFactorSecret: null, backupCodeHashes: [], twoFactorMethod: null });
  db.update('users', user.id, patch);
  console.log(`Password set for ${user.email}. Every session is signed out.${patch.twoFactorEnabled === false ? ' 2FA will be set up again at next sign-in.' : ''}`);
})();
