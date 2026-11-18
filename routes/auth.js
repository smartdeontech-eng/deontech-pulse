// ---- Sign-in ----
// Copied from IFAIMA's routes/auth.js (the Smart DeonTech pattern).
// Passkeys, two-factor and the codes behind them are mounted from
// @deontech/identity. What is left here is the password login itself, which
// is the one part the two existing applications had genuinely diverged on —
// so it is yours to own. Extend it; don't push its variations into the package.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');

const db = require('../utils/db');
const totp = require('../utils/totp');
const webauthn = require('../utils/webauthn');
const { sendMail } = require('../utils/mailer');
const { sendSms } = require('../utils/sms');
const { validatePassword } = require('../utils/passwordPolicy');
const { requireAuth, JWT_SECRET, PERMISSIONS, ROLE_TIERS } = require('../middleware/auth');
const { createSession, createAuthRouters } = require('@deontech/identity');

const router = express.Router();

// A Pulse sign-in from a device never seen before on that account is itself
// an access alert ("Was this you?"). server.js points this at the monitor.
let newDeviceHook = null;
router.onNewDevice = (fn) => { newDeviceHook = fn; };

const session = createSession({
  db, jwt, jwtSecret: JWT_SECRET, sendMail, sendSms,
  roleTiers: ROLE_TIERS,
  onNewDevice(entry) { if (newDeviceHook) newDeviceHook(entry); },
});
// A switched-off account never gets a session, by any path: password, the
// 2FA step, a passkey. The shared routers call session.finalizeLogin, so the
// guard goes there. It is reached only after the password / passkey proved
// correct, so it never tells a guesser the account exists.
const finalizeLoginCore = session.finalizeLogin;
session.finalizeLogin = (res, user, remember) => {
  if (user && user.disabled) {
    const e = new Error('This account has been switched off. Ask the owner.');
    e.status = 403; e.expose = true;
    throw e;
  }
  return finalizeLoginCore(res, user, remember);
};
// Pulse's own sign-ins also appear on the Sign-ins page, beside the other apps'.
let loginHook = null;
router.onLogin = (fn) => { loginHook = fn; };
const logLoginCore = session.logLogin;
session.logLogin = (entry) => {
  logLoginCore(entry);
  if (loginHook) { try { loginHook(entry); } catch { /* never blocks sign-in */ } }
};
const {
  clientIp, logLogin, checkLockout, finalizeLogin, safeUser, bumpSessionVersion,
} = session;

// ---- Pulse's guards around the shared passkey routes ----
//
// 1. Adding a passkey is a new way into the owner's account, so it needs a
//    fresh 2FA code (like the trusted list) and raises an alert when done.
// 2. A passkey sign-in replaces password + 2FA, so it must prove the person —
//    Face ID, Touch ID or a security-key PIN — not just possession of a key.
//    The core verifies with requireUserVerification:false; here the
//    authenticator's "user verified" flag is checked before it runs. The flag
//    sits inside authenticatorData, which the signature covers, so it cannot
//    be set by the client without failing verification.
const { requireFreshCode } = require('../utils/freshCode');
let securityHook = null;
router.onSecurityChange = (fn) => { securityHook = fn; };

router.post('/passkey/register/options', requireAuth, requireFreshCode);
router.post('/passkey/register/verify', requireAuth, (req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode === 200 && securityHook) securityHook({ title: `Passkey added to ${req.user.email}${req.body && req.body.deviceName ? ` (${String(req.body.deviceName).slice(0, 40)})` : ''}`, by: req.user.email });
  });
  next();
});
router.delete('/passkey/:id', requireAuth, requireFreshCode);
router.post('/passkey/login/verify', (req, res, next) => {
  try {
    const ad = Buffer.from(String(req.body.authResp.response.authenticatorData || ''), 'base64url');
    const flags = ad.length > 32 ? ad[32] : 0;
    if (!(flags & 0x04)) return res.status(401).json({ error: 'This passkey did not confirm it was you (no Face ID, Touch ID or PIN). Sign in with your password and code.' });
  } catch (e) {
    return res.status(400).json({ error: 'No passkey provided.' });
  }
  next();
});

// Passkeys + 2FA: nine endpoints, unchanged, shared.
const { passkeyRouter, twoFactorRouter } = createAuthRouters({
  express, db, jwt, jwtSecret: JWT_SECRET, bcrypt, totp, webauthn, QRCode,
  session, requireAuth,
  // Another phone added to (or taken off) an account is a new way in: alert.
  onSecurityEvent: (e) => {
    if (!securityHook || !e || !e.user) return;
    const what = e.type === 'authenticator-added' ? 'Authenticator added to' : e.type === 'authenticator-removed' ? 'Authenticator removed from' : null;
    if (what) securityHook({ title: `${what} ${e.user.email}${e.name ? ` (${String(e.name).slice(0, 40)})` : ''}`, by: e.user.email });
  },
});
router.use(passkeyRouter);
router.use(twoFactorRouter);

router.post('/login', (req, res) => {
  const { email, password, remember } = req.body;
  const ip = clientIp(req);
  const userAgent = req.get('user-agent') || '';

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const minutesLeft = checkLockout(email);
  if (minutesLeft !== null) {
    logLogin({ userId: null, email, success: false, reason: 'locked-out', ip, userAgent });
    return res.status(429).json({ error: `Too many failed attempts. Please try again in about ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.` });
  }

  const user = db.findOne('users', u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    // The same message either way — never disclose whether the account exists.
    logLogin({ userId: user ? user.id : null, email, success: false, reason: 'incorrect-credentials', ip, userAgent });
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  if (user.disabled) {
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'account-switched-off', ip, userAgent });
    return res.status(403).json({ error: 'This account has been switched off. Ask the owner.' });
  }

  // A brand-new account, or one an admin just reset, must set its own password
  // before getting a real session — otherwise a known admin-set password keeps
  // working indefinitely.
  if (user.mustChangePassword) {
    const pendingToken = jwt.sign({ id: user.id, purpose: 'password-change-required', remember: !!remember }, JWT_SECRET, { expiresIn: '10m' });
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'must-change-password', ip, userAgent });
    return res.json({ mustChangePassword: true, pendingToken });
  }

  if (user.twoFactorEnabled) {
    const pendingToken = jwt.sign({ id: user.id, purpose: '2fa-pending', remember: !!remember }, JWT_SECRET, { expiresIn: '5m' });
    logLogin({ userId: user.id, email: user.email, success: false, reason: 'awaiting-2fa', ip, userAgent });
    return res.json({ twoFactorRequired: true, pendingToken, method: user.twoFactorMethod || 'totp' });
  }

  logLogin({ userId: user.id, email: user.email, success: true, reason: 'ok', ip, userAgent });
  res.json(finalizeLogin(res, user, remember));
});

router.post('/login/complete-password-change', (req, res) => {
  const { pendingToken, newPassword } = req.body;
  let payload;
  try {
    payload = jwt.verify(pendingToken, JWT_SECRET);
    if (payload.purpose !== 'password-change-required') throw new Error('wrong purpose');
  } catch (e) {
    return res.status(401).json({ error: 'This step expired. Please log in again.' });
  }
  const user = db.findById('users', payload.id);
  if (!user) return res.status(401).json({ error: 'Please log in again.' });

  const check = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!check.valid) return res.status(400).json({ error: check.failedRules[0] || 'Password is not strong enough.' });

  // Bumping the session version invalidates every token issued before now.
  const updated = bumpSessionVersion(user.id, {
    passwordHash: bcrypt.hashSync(newPassword, 10),
    mustChangePassword: false,
  });
  logLogin({ userId: user.id, email: user.email, success: true, reason: 'ok-after-password-change', ip: clientIp(req), userAgent: req.get('user-agent') || '' });
  res.json(finalizeLogin(res, updated, payload.remember));
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const fresh = db.findById('users', req.user.id);
  if (!fresh) return res.status(401).json({ error: 'Account no longer exists.' });
  res.json(safeUser(fresh));
});

router.get('/permissions', requireAuth, (req, res) => res.json({ permissions: PERMISSIONS }));

// Change your own password (signed in). Signs out every other session.
router.post('/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.findById('users', req.user.id);
  if (!user || !bcrypt.compareSync(String(currentPassword || ''), user.passwordHash)) return res.status(400).json({ error: 'Current password is wrong.' });
  const check = validatePassword(newPassword, { email: user.email, name: user.name });
  if (!check.valid) return res.status(400).json({ error: check.failedRules[0] || 'Password is not strong enough.' });
  const updated = bumpSessionVersion(user.id, { passwordHash: bcrypt.hashSync(newPassword, 10), mustChangePassword: false });
  res.json(finalizeLogin(res, updated, false));
});

module.exports = router;
