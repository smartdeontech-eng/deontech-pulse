// "Prove it's still you": a current authenticator code (or a backup code,
// which is then used up) for changes a stolen session must not make quietly —
// the trusted list, where alerts go, and adding a passkey.
const bcrypt = require('bcryptjs');
const db = require('./db');
const totp = require('./totp');

const BACKUP_FORMAT = /^[0-9a-f]{5}-[0-9a-f]{5}$/i;   // as @deontech/identity makes them

// Failed attempts per account: five wrong codes in 15 minutes locks fresh-code
// checks for that account for 15 minutes. bcrypt is slow on purpose; it is
// only reached for input shaped like a backup code, and asynchronously.
const failures = new Map();   // userId -> [ts]
const WINDOW = 15 * 60_000;
function lockedOut(userId, now = Date.now()) {
  const f = (failures.get(userId) || []).filter((t) => now - t < WINDOW);
  failures.set(userId, f);
  return f.length >= 5;
}

async function checkFreshCode(userId, code) {
  const u = db.findById('users', userId);
  const c = String(code || '').trim();
  if (!u || !u.twoFactorEnabled || !c) return null;
  if (lockedOut(u.id)) return null;
  if (/^\d{6}$/.test(c) && totp.matchAuthenticator(u, c)) return u;   // any of their phones
  if (BACKUP_FORMAT.test(c)) {
    const hashes = u.backupCodeHashes || [];
    for (let i = 0; i < hashes.length; i++) {
      if (await bcrypt.compare(c.toLowerCase(), hashes[i])) {
        db.update('users', u.id, { backupCodeHashes: hashes.filter((_, j) => j !== i) });
        return u;
      }
    }
  }
  failures.get(u.id).push(Date.now());
  return null;
}

// Express middleware form. Reads the code from body.code or the X-Pulse-Code header.
function requireFreshCode(req, res, next) {
  const code = (req.body && req.body.code) || req.get('x-pulse-code');
  const id = req.user && req.user.id;
  if (id && lockedOut(id)) return res.status(429).json({ error: 'Too many wrong codes. Wait 15 minutes and try again.' });
  checkFreshCode(id, code).then((u) => {
    if (!u) return res.status(403).json({ error: 'Enter the current code from your authenticator app (or a backup code).', needsCode: true });
    req.freshUser = u;
    next();
  }, next);
}

module.exports = { checkFreshCode, requireFreshCode, _resetFailures: () => failures.clear() };
