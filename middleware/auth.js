// ---- Permissions and roles ----
//
// Three roles, as in AOTC Track: the role seeds the permissions, the checks
// read the permissions.
//   owner   everything, including people and where alerts go
//   admin   runs the monitor day to day: alerts, apps on/off, trusted list,
//           maintenance, thresholds — but not people or alert destinations
//   viewer  sees everything, changes nothing
// An account can be switched off (disabled) without being deleted; it then
// cannot sign in and any open session ends on its next request.
const jwt = require('jsonwebtoken');
const db = require('../utils/db');

const JWT_SECRET = process.env.JWT_SECRET;

const PERMISSIONS = {
  'monitor.view': 'See the dashboard, apps, access log and alerts',
  'monitor.manage': 'Acknowledge alerts, edit the trusted list, alert rules and maintenance mode',
  'staff.manage': 'Create and remove logins',
  'settings.manage': 'Change channels, phone numbers and settings',
};

// Rights never given by role shortcut: they must be the owner's.
const RESERVED_PERMISSIONS = new Set(['staff.manage', 'settings.manage']);

const ROLE_DEFAULT_PERMISSIONS = {
  owner: Object.keys(PERMISSIONS),
  admin: ['monitor.view', 'monitor.manage'],
  viewer: ['monitor.view'],
};
const ROLES = Object.keys(ROLE_DEFAULT_PERMISSIONS);
const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', viewer: 'Viewer (read-only)' };
const ROLE_TIERS = { owner: 4, admin: 3, viewer: 1 };

const guards = require('@deontech/auth').createAuth({
  db,
  jwt,
  jwtSecret: JWT_SECRET,
  adminRole: 'owner',
  secondaryAdminRoles: [],
  adminOnlyPermissions: [...RESERVED_PERMISSIONS],
});

// The core's session check, plus: a switched-off account is signed out on its
// very next request (its sessionVersion is also bumped when it is switched off).
let activityHook = null;
function requireAuth(req, res, next) {
  guards.requireAuth(req, res, () => {
    const u = db.findById('users', req.user.id);
    if (u && u.disabled) {
      res.clearCookie('token');
      return res.status(401).json({ error: 'This account has been switched off. Ask the owner.', disabled: true });
    }
    if (activityHook) { try { activityHook(req, u); } catch { /* never blocks a request */ } }
    next();
  });
}
requireAuth.onActivity = (fn) => { activityHook = fn; };

// Two-factor is not optional here. A session for an account without 2FA can
// reach the sign-in routes (to set 2FA up) and nothing else.
function require2fa(req, res, next) {
  const u = db.findById('users', req.user.id);
  if (!u) return res.status(401).json({ error: 'Account no longer exists.' });
  if (!u.twoFactorEnabled) return res.status(403).json({ error: 'Set up two-factor sign-in first.', needs2fa: true });
  next();
}

module.exports = {
  ...guards,
  requireAuth,
  require2fa,
  JWT_SECRET, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, ROLES, ROLE_LABELS, RESERVED_PERMISSIONS, ROLE_TIERS,
};
