// People: who can sign in to Pulse, and what they can do.
//
// Modelled on AOTC Track's Users page (claude/roles-and-access.md):
//   - one role per account, which seeds its permissions;
//   - an on/off switch per account, with a reason, instead of deleting;
//   - nobody can switch off or demote themselves, and the last working owner
//     can never be switched off, demoted or removed.
// Only the owner tier (staff.manage) reaches any of this. Anything that opens
// a way in — a new login, a password reset, switching an account back on,
// raising a role — needs a fresh 2FA code and raises an alert, exactly like
// the trusted list. Switching someone off makes things safer, so it needs a
// reason but no code.
//
// New accounts get a one-time password shown once to the owner, who passes it
// on in person or by phone. The new person must replace it at first sign-in
// and set up two-factor before they can see anything.
'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../utils/db');
const store = require('../core/store');
const { requireAuth, require2fa, requirePermission, ROLE_DEFAULT_PERMISSIONS, ROLE_LABELS, ROLE_TIERS } = require('../middleware/auth');
const { requireFreshCode } = require('../utils/freshCode');

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Easy to read aloud, no look-alike characters: "kfmr-7q2w-hx9d-3pna".
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += abc[bytes[i] % abc.length] + (i % 4 === 3 && i < 15 ? '-' : '');
  return out;
}

function workingOwners(exceptId = null) {
  return db.findAll('users', (u) => u.role === 'owner' && !u.disabled && u.id !== exceptId).length;
}

function view(u, lastLogin) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role,
    disabled: !!u.disabled, disabledAt: u.disabledAt || null, disabledBy: u.disabledBy || null, disabledReason: u.disabledReason || null,
    twoFactorEnabled: !!u.twoFactorEnabled, passkeys: (u.passkeys || []).length,
    mustChangePassword: !!u.mustChangePassword,
    createdAt: u.createdAt || null, createdBy: u.createdBy || null,
    lastLogin: lastLogin || null,
  };
}

function lastLogins() {
  const out = {};
  try {
    for (const l of db.findAll('login_logs', (x) => x.success)) {
      const t = Date.parse(l.createdAt || l.timestamp || 0) || 0;
      if (l.userId != null && (!out[l.userId] || t > out[l.userId])) out[l.userId] = t;
    }
  } catch { /* no log yet */ }
  return out;
}

function createUsers({ monitor }) {
  const router = express.Router();
  const owner = [requireAuth, require2fa, requirePermission('staff.manage')];

  function bump(id, patch = {}) {
    const u = db.findById('users', id);
    return db.update('users', id, { sessionVersion: (u.sessionVersion || 0) + 1, ...patch });
  }
  function note(title, by, severity = 'warning') {
    // A warning becomes an alert, which writes its own timeline line.
    if (severity !== 'warning' || !monitor) return store.addEvent(db, { kind: 'access', severity, title, detail: { by } });
    monitor.alerts.raise({ key: `people:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, rule: 'settings', severity: 'warning', title, detail: { summary: `by ${by}` } });
  }
  const target = (req, res) => {
    const u = db.findById('users', Number(req.params.id));
    if (!u) { res.status(404).json({ error: 'No such account.' }); return null; }
    return u;
  };

  router.get('/users', owner, (req, res) => {
    const ll = lastLogins();
    const users = db.findAll('users', () => true).map((u) => view(u, ll[u.id]))
      .sort((a, b) => (a.disabled - b.disabled) || (ROLE_TIERS[b.role] || 0) - (ROLE_TIERS[a.role] || 0) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    res.json({
      users,
      roles: Object.keys(ROLE_DEFAULT_PERMISSIONS).map((k) => ({ key: k, label: ROLE_LABELS[k] || k })),
      me: req.user.id,
    });
  });

  // Add someone. Returns the one-time password once; it is never stored in clear.
  router.post('/users', owner, requireFreshCode, (req, res) => {
    const { email, name, role } = req.body || {};
    const e = String(email || '').trim().toLowerCase();
    const n = String(name || '').trim().slice(0, 60) || e.split('@')[0];
    if (!EMAIL.test(e)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!ROLE_DEFAULT_PERMISSIONS[role]) return res.status(400).json({ error: 'Pick a role.' });
    if (db.findOne('users', (u) => u.email.toLowerCase() === e)) return res.status(409).json({ error: 'That email already has a login.' });
    const pw = tempPassword();
    const u = db.insert('users', {
      email: e, name: n, role, permissions: [...ROLE_DEFAULT_PERMISSIONS[role]],
      passwordHash: bcrypt.hashSync(pw, 10), mustChangePassword: true, sessionVersion: 0,
      twoFactorEnabled: false, createdAt: new Date().toISOString(), createdBy: req.user.email,
    });
    note(`New Pulse login: ${e} (${ROLE_LABELS[role]})`, req.user.email);
    res.json({ user: view(u), tempPassword: pw });
  });

  // Change name or role.
  router.put('/users/:id', owner, (req, res, next) => {
    // Only a role change needs the code; a typo in a name does not.
    if (req.body && req.body.role !== undefined) return requireFreshCode(req, res, next);
    next();
  }, (req, res) => {
    const u = target(req, res); if (!u) return;
    const { name, role } = req.body || {};
    const patch = {};
    if (name !== undefined) patch.name = String(name).trim().slice(0, 60) || u.name;
    if (role !== undefined && role !== u.role) {
      if (!ROLE_DEFAULT_PERMISSIONS[role]) return res.status(400).json({ error: 'Pick a role.' });
      if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });
      if (u.role === 'owner' && !u.disabled && workingOwners(u.id) === 0) return res.status(400).json({ error: 'This is the last working owner. Make someone else owner first.' });
      patch.role = role;
      patch.permissions = [...ROLE_DEFAULT_PERMISSIONS[role]];
    }
    // A role lives inside the session token too, so a change signs them out.
    const updated = patch.role ? bump(u.id, patch) : db.update('users', u.id, patch);
    if (patch.role) note(`${u.email} is now ${ROLE_LABELS[patch.role]} (was ${ROLE_LABELS[u.role] || u.role})`, req.user.email, (ROLE_TIERS[patch.role] || 0) > (ROLE_TIERS[u.role] || 0) ? 'warning' : 'info');
    res.json({ user: view(updated) });
  });

  // The on/off switch.
  router.post('/users/:id/status', owner, (req, res, next) => {
    if (req.body && req.body.enabled) return requireFreshCode(req, res, next);   // switching on opens a way in
    next();
  }, (req, res) => {
    const u = target(req, res); if (!u) return;
    const enabled = !!(req.body && req.body.enabled);
    if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot switch off your own account.' });
    if (enabled) {
      if (!u.disabled) return res.json({ user: view(u) });
      const updated = db.update('users', u.id, { disabled: false, disabledAt: null, disabledBy: null, disabledReason: null });
      note(`Pulse login switched back on: ${u.email}`, req.user.email);
      return res.json({ user: view(updated) });
    }
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
    if (!reason) return res.status(400).json({ error: 'Say why — it is kept with the account.' });
    if (u.role === 'owner' && workingOwners(u.id) === 0) return res.status(400).json({ error: 'This is the last working owner.' });
    const updated = bump(u.id, { disabled: true, disabledAt: new Date().toISOString(), disabledBy: req.user.email, disabledReason: reason });
    db.sql.run('DELETE FROM push_subs WHERE user_id = ?', u.id);   // their phone stops getting alerts
    note(`Pulse login switched off: ${u.email} — ${reason}`, req.user.email, 'info');
    res.json({ user: view(updated) });
  });

  // Forgotten password or lost phone: a new one-time password, and optionally
  // two-factor cleared so they set it up again. Signs them out everywhere.
  router.post('/users/:id/reset', owner, requireFreshCode, (req, res) => {
    const u = target(req, res); if (!u) return;
    if (u.id === req.user.id) return res.status(400).json({ error: 'Use “Change password” on your own account.' });
    const pw = tempPassword();
    const patch = { passwordHash: bcrypt.hashSync(pw, 10), mustChangePassword: true };
    if (req.body && req.body.reset2fa) Object.assign(patch, { twoFactorEnabled: false, twoFactorSecret: null, twoFactorDevices: [], twoFactorMainName: null, twoFactorDeviceTemp: null, backupCodeHashes: [], passkeys: [] });
    bump(u.id, patch);
    note(`Password reset for ${u.email}${patch.twoFactorEnabled === false ? ' (2FA and passkeys cleared)' : ''}`, req.user.email);
    res.json({ tempPassword: pw });
  });

  // Remove for good. Only once it is switched off, so it is never one click.
  router.delete('/users/:id', owner, requireFreshCode, (req, res) => {
    const u = target(req, res); if (!u) return;
    if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account.' });
    if (!u.disabled) return res.status(400).json({ error: 'Switch the account off first.' });
    db.sql.run('DELETE FROM push_subs WHERE user_id = ?', u.id);
    db.remove('users', u.id);
    note(`Pulse login removed: ${u.email}`, req.user.email, 'info');
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createUsers, tempPassword };
