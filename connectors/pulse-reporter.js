// pulse-reporter.js — tells DeonTech Pulse who signs in to this app, and who
// is using it. Copy this one file into the app's utils/ folder. No
// dependencies, never throws, never slows a request: if Pulse is down the
// reports are simply dropped.
//
// Two lines in the app (scripts/connect-app.js in Pulse adds them):
//
//   // routes/auth.js, straight after createSession(...) and BEFORE `const { ... } = session`
//   const pulse = require('../utils/pulse-reporter');
//   pulse.wrapSession(session, { lookupUser: (id) => db.findById('users', id) });
//   // — or, in an app with its own sign-in code (Budget), after each attempt:
//   require('./pulse-reporter').report({ userId, email, success, reason, ip: req.ip, userAgent }, { lookupUser })
//   // and wherever it knows who is signed in: require('./pulse-reporter').touch(user, req)
//   // — or, in an app with its own `function logLogin(entry) {`, as its first line:
//   require('../utils/pulse-reporter').report(entry, { lookupUser: (id) => db.findById('users', id) });
//
//   // server.js, after cookieParser() and before the /api routes
//   app.use('/api', require('./utils/pulse-reporter').activity({ jwt: require('jsonwebtoken'), secret: process.env.JWT_SECRET }));
//
// And two lines in the app's env file on the server (the token comes from
// `cd /opt/pulse && sudo -u pulse node scripts/app-token.js <app-id>`):
//
//   PULSE_APP=aotc-track
//   PULSE_APP_TOKEN=…
//
// Without both, the reporter does nothing at all.
//
// What is sent: user id, name, email, role, IP, user-agent and times. Never a
// password, a token, a URL or anything from the app's own data.
'use strict';
const http = require('http');
const https = require('https');

const VERSION = '1';
const APP = process.env.PULSE_APP || '';
const TOKEN = process.env.PULSE_APP_TOKEN || '';
const URL_ = process.env.PULSE_URL || 'http://127.0.0.1:3201';
const ENABLED = !!(APP && TOKEN);

const events = [];            // sign-in attempts not yet sent
const seen = new Map();       // user id -> latest activity this minute
const tokenCache = new Map(); // cookie value -> decoded payload (skips re-verifying every request)
let warnedAt = 0;
let sendTimer = null;

function post(body) {
  if (!ENABLED) return;
  let u;
  try { u = new URL('/api/ingest/app-signins', URL_); } catch { return; }
  const data = Buffer.from(JSON.stringify({ app: APP, v: VERSION, ...body }));
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request(u, {
    method: 'POST', timeout: 3000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Pulse-App': APP, 'X-Pulse-App-Token': TOKEN },
  }, (res) => {
    res.resume();
    if (res.statusCode >= 400) warn(`Pulse answered ${res.statusCode}`);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', (e) => warn(e.message));
  req.end(data);
}

function warn(msg) {
  const t = Date.now();
  if (t - warnedAt < 10 * 60_000) return;
  warnedAt = t;
  console.warn(`[pulse-reporter] ${msg} (reports dropped; the app is unaffected)`);
}

function flush() {
  if (!events.length && !seen.size) return;
  const body = { events: events.splice(0, 500), presence: [...seen.values()] };
  seen.clear();
  post(body);
}

// Sign-ins go out within a couple of seconds, batched.
function soon() {
  if (sendTimer) return;
  sendTimer = setTimeout(() => { sendTimer = null; flush(); }, 2000);
  sendTimer.unref?.();
}

if (ENABLED) {
  const t = setInterval(flush, 60_000);
  t.unref?.();
}

// One login-log entry. Apps with their own logLogin() (AOTC Track) call this
// from inside it; apps on the core use wrapSession() below.
function report(entry, { lookupUser } = {}) {
  if (!ENABLED || !entry) return;
  try {
    let name = null, role = null;
    if (entry.userId != null && lookupUser) { const u = lookupUser(entry.userId); if (u) { name = u.name || null; role = u.role || null; } }
    events.push({ ts: Date.now(), userId: entry.userId ?? null, email: entry.email || null, name, role, success: !!entry.success, reason: entry.reason || null, ip: entry.ip || null, ua: entry.userAgent || null });
    if (events.length > 1000) events.splice(0, events.length - 1000);
    soon();
  } catch { /* never breaks sign-in */ }
}

// Behind Apache, req.ip is 127.0.0.1 unless the app trusts the proxy. Apache
// APPENDS the address it saw to X-Forwarded-For, so the last entry is the real
// one (the first can be anything the client typed).
function realIp(req) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (!/^(::ffff:)?127\.|^::1$/.test(ip)) return ip;
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : ip;
}

// Mirror every login-log entry the core writes. Must run before anything
// destructures logLogin out of the session.
function wrapSession(session, { lookupUser } = {}) {
  if (!ENABLED || !session || typeof session.logLogin !== 'function' || session.logLogin.__pulse) return session;
  const core = session.logLogin;
  const wrapped = (entry) => {
    const r = core(entry);
    report(entry, { lookupUser });
    return r;
  };
  wrapped.__pulse = true;
  session.logLogin = wrapped;
  return session;
}

// Who used the app this minute, read from the session cookie the app already
// sets. Express middleware; costs one cached lookup per request.
function activity({ jwt, secret, cookie = 'token' } = {}) {
  return (req, res, next) => {
    if (ENABLED && jwt && secret) {
      try {
        const raw = req.cookies && req.cookies[cookie];
        if (raw) {
          let p = tokenCache.get(raw);
          if (p === undefined) {
            try { p = jwt.verify(raw, secret); } catch { p = null; }
            if (tokenCache.size > 500) tokenCache.clear();
            tokenCache.set(raw, p);
          }
          if (p && p.id != null && (!p.purpose || p.purpose === 'session') && (!p.exp || p.exp * 1000 > Date.now())) {
            seen.set(p.id, { userId: p.id, email: p.email || null, name: p.name || null, role: p.role || null, lastSeen: Date.now(), ip: realIp(req) || null, ua: req.get ? req.get('user-agent') : null });
          }
        }
      } catch { /* never breaks a request */ }
    }
    next();
  };
}

// For apps with their own sessions (no JWT cookie), e.g. Budget: call this
// wherever the app has worked out who is signed in for a request.
function touch(user, req) {
  if (!ENABLED || !user || user.id == null) return;
  try {
    seen.set(user.id, { userId: user.id, email: user.email || null, name: user.name || null, role: user.role || null, lastSeen: Date.now(), ip: (req && realIp(req)) || null, ua: req && req.get ? req.get('user-agent') : null });
    if (seen.size > 5000) seen.clear();
  } catch { /* never breaks a request */ }
}

module.exports = { wrapSession, report, activity, touch, flush, enabled: ENABLED, VERSION };
