/**
 * Create the owner account — run once, on the server, from the app root:
 *
 *   cd /opt/pulse && sudo -u pulse node scripts/create-owner.js you@example.com "Your Name"
 *
 * The password is typed at a hidden prompt, never on the command line (where
 * it would land in shell history) and never in chat. Two-factor is set up at
 * first sign-in; until it is, the account can reach nothing but the 2FA setup.
 *
 *   --viewer   create a read-only login instead (for later)
 */
'use strict';
require('dotenv').config({ quiet: true });
require('@deontech/config').configureApp({ productName: 'DeonTech Pulse', legalName: 'Smart DeonTech Limited', dataDir: require('../utils/dataDir') });
const bcrypt = require('bcryptjs');
const db = require('../utils/db');
const { validatePassword } = require('../utils/passwordPolicy');
const { ROLE_DEFAULT_PERMISSIONS } = { ROLE_DEFAULT_PERMISSIONS: { owner: ['monitor.view', 'monitor.manage', 'staff.manage', 'settings.manage'], viewer: ['monitor.view'] } };

const args = process.argv.slice(2);
const role = args.includes('--viewer') ? 'viewer' : 'owner';
const [email, ...nameParts] = args.filter((a) => !a.startsWith('--'));
const name = nameParts.join(' ') || (email || '').split('@')[0];

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: node scripts/create-owner.js <email> "<name>" [--viewer]');
  process.exit(1);
}
if (db.findOne('users', (u) => u.email.toLowerCase() === email.toLowerCase())) {
  console.error(`${email} already exists. To reset its password: node scripts/set-password.js ${email}`);
  process.exit(1);
}
if (role === 'owner' && db.findOne('users', (u) => u.role === 'owner')) {
  console.error('An owner already exists. Add --viewer to create a read-only login.');
  process.exit(1);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    if (!stdin.isTTY) { stdin.once('data', (d) => resolve(String(d).trim())); return; }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(value); }
      else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f') value = value.slice(0, -1);
      else value += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const pw = await ask(`Password for ${email}: `);
  const check = validatePassword(pw, { email, name });
  if (!check.valid) { console.error('Not strong enough:\n  - ' + check.failedRules.join('\n  - ')); process.exit(1); }
  const again = await ask('Again: ');
  if (again !== pw) { console.error('They do not match.'); process.exit(1); }
  db.insert('users', {
    email, name, role, permissions: ROLE_DEFAULT_PERMISSIONS[role],
    passwordHash: bcrypt.hashSync(pw, 10), mustChangePassword: false, sessionVersion: 0,
    twoFactorEnabled: false, createdAt: new Date().toISOString(),
  });
  console.log(`\nCreated ${role} ${email}.`);
  console.log('Sign in at https://monitor.smartdeontech.com — you will be asked to set up two-factor first.');
})();
