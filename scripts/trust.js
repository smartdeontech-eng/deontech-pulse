/**
 * Manage trusted sources from the server (shell access is already root-level
 * trust, so no 2FA prompt here — but every change still raises an alert).
 *
 *   node scripts/trust.js list
 *   node scripts/trust.js key "MacBook (deploy key)" SHA256:X2tY...
 *   node scripts/trust.js network "Home Wi-Fi" 173.177.203.0/24 [--days 7]
 *   node scripts/trust.js remove <id>
 *
 * Run as the pulse user from /opt/pulse with /etc/pulse.env loaded (RUNBOOK.md).
 */
'use strict';
require('dotenv').config({ quiet: true });
const db = require('../utils/db');
const store = require('../core/store');
const trust = require('../core/trust');
store.init(db);

const [cmd, ...rest] = process.argv.slice(2);
const daysIdx = rest.indexOf('--days');
const days = daysIdx >= 0 ? Number(rest[daysIdx + 1]) : null;
const args = daysIdx >= 0 ? rest.slice(0, daysIdx) : rest;

function note(title) {
  store.addEvent(db, { kind: 'access', severity: 'warning', title, detail: { by: 'server shell' } });
}

if (cmd === 'list' || !cmd) {
  for (const s of db.sql.all('SELECT * FROM trusted_sources ORDER BY id')) console.log(`${String(s.id).padStart(3)}  ${s.kind.padEnd(8)} ${s.label.padEnd(28)} ${s.value}${s.expires_at ? `  until ${new Date(s.expires_at).toISOString().slice(0, 10)}` : ''}`);
  process.exit(0);
}
if (cmd === 'key' || cmd === 'network') {
  const [label, value0] = args;
  if (!label || !value0) { console.error(`usage: trust.js ${cmd} "<label>" <value>`); process.exit(1); }
  let value = value0;
  if (cmd === 'key' && !/^SHA256:[A-Za-z0-9+/=]{20,}$/.test(value)) { console.error('A key is its SHA256:… fingerprint (ssh-keygen -lf <pubkey>).'); process.exit(1); }
  if (cmd === 'network') { if (!trust.parseCidr(value)) { console.error('Not an IP or CIDR range.'); process.exit(1); } if (!value.includes('/')) value = trust.networkOf(value); }
  const exp = days > 0 ? Date.now() + days * 86400_000 : null;
  db.sql.run('INSERT INTO trusted_sources (kind, label, value, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', cmd, label, value, exp, Date.now(), 'server shell');
  note(`Trusted list changed: added ${label} (${value})`);
  console.log(`Trusted ${cmd}: ${label} = ${value}${exp ? ` for ${days} days` : ''}`);
  process.exit(0);
}
if (cmd === 'remove') {
  const s = db.sql.get('SELECT * FROM trusted_sources WHERE id = ?', Number(args[0]));
  if (!s) { console.error('No such id.'); process.exit(1); }
  db.sql.run('DELETE FROM trusted_sources WHERE id = ?', s.id);
  note(`Trusted list changed: removed ${s.label}`);
  console.log(`Removed ${s.label}`);
  process.exit(0);
}
console.error('usage: trust.js list | key <label> <fp> | network <label> <cidr> [--days N] | remove <id>');
process.exit(1);
