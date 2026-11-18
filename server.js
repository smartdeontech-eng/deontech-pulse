// DeonTech Pulse — wiring only. No monitoring logic lives in this file.
require('dotenv').config({ quiet: true });
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ---- Fail fast on a missing or weak secret ----
const WEAK_SECRETS = new Set(['change-this-secret-in-.env', 'replace-this-with-a-long-random-string', 'secret', 'changeme']);
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || WEAK_SECRETS.has(process.env.JWT_SECRET)) {
  console.error(
    '\nFATAL: JWT_SECRET is missing, too short, or a known placeholder.\n' +
    'Set a long random value in /etc/pulse.env (deploy/provision.sh generates one), e.g.:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n'
  );
  process.exit(1);
}

// ---- Who this app is ----
require('@deontech/config').configureApp({
  productName: 'DeonTech Pulse',
  legalName: 'Smart DeonTech Limited',
  domain: 'monitor.smartdeontech.com',
  dataDir: require('./utils/dataDir'),
});

const db = require('./utils/db');
const { getSettings } = require('./utils/settings');
const { sendMail } = require('./utils/mailer');
const { sendSms } = require('./utils/sms');
const notifications = require('./utils/notifications');
const { createChannels } = require('./core/channels');
const { createMonitor } = require('./core/monitor');
const { createDigestScheduler } = require('./core/digest');
const { createApi } = require('./routes/api');
const { createStream } = require('./routes/stream');
const { createHooks } = require('./routes/hooks');
const authRoutes = require('./routes/auth');
const { createUsers } = require('./routes/users');

const APP_URL = process.env.APP_URL || (IS_PRODUCTION ? 'https://monitor.smartdeontech.com' : '');
const { userHasPermission } = require('./middleware/auth');
const channels = createChannels({
  db, getSettings, sendMail, sendSms, webpush: require('web-push'), secret: process.env.JWT_SECRET, appUrl: APP_URL,
  canAct: (userId) => { const u = userId && db.findById('users', userId); return !!(u && !u.disabled && userHasPermission(u, 'monitor.manage', u)); },
  canReceive: (userId) => { if (userId == null) return true; const u = db.findById('users', userId); return !!(u && !u.disabled); },
  zones: () => require('./core/zones').displayZones(db, getSettings()),
});
const monitor = createMonitor({
  db, getSettings, channels,
  enableAuthWatch: process.env.PULSE_AUTHWATCH !== 'off',
  enableLogs: process.env.PULSE_LOGS ? process.env.PULSE_LOGS !== 'off' : undefined,
  // Something new between hourly scans: ask root for a fresh scan now.
  requestScan: () => actions.scan(),
});

// A failed SMS or email is itself something the owner should see.
notifications.setHook((n) => {
  if (n.level === 'error') monitor.alerts.raise({ key: `delivery:${n.source}`, rule: 'delivery', severity: 'warning', title: `${n.source === 'sms' ? 'SMS' : n.source === 'email' ? 'Email' : n.source} delivery is failing`, detail: { summary: n.message } });
});

// A Pulse sign-in from a new device is an access event like any other.
const dashLogins = require('./core/dashlogins').createDashLoginWatcher({
  db, onNewDevice: (entry) => monitor.handleAccess({ kind: 'dashboard_login', user: entry.email, ip: entry.ip, ts: Date.now(), raw: String(entry.userAgent || '').slice(0, 200) }),
});

// Pulse's own sign-ins and activity, on the Sign-ins page with the other apps.
authRoutes.onLogin((e) => {
  const u = e.userId ? db.findById('users', e.userId) : null;
  monitor.appSignins.ingest('pulse', { events: [{ ts: Date.now(), userId: e.userId, email: e.email, name: u && u.name, role: u && u.role, success: e.success, reason: e.reason, ip: e.ip, ua: e.userAgent }] });
});
{
  const lastTouch = new Map();
  require('./middleware/auth').requireAuth.onActivity((req, u) => {
    const t = Date.now();
    if (!u || t - (lastTouch.get(u.id) || 0) < 60_000) return;
    lastTouch.set(u.id, t);
    monitor.appSignins.touch('pulse', { userId: u.id, email: u.email, name: u.name, role: u.role, lastSeen: t, ip: req.ip, ua: req.get('user-agent') });
  });
}

// Security changes made through the sign-in routes (a passkey added) alert like any other.
authRoutes.onSecurityChange((c) => monitor.alerts.raise({ key: `security:${Date.now()}`, rule: 'settings', severity: 'warning', title: c.title, detail: { summary: `by ${c.by}` } }));

const app = express();
// req.ip must be what Apache saw, not what a client claims — the login log,
// new-device detection and the rate limiter all depend on it.
if (IS_PRODUCTION) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'worker-src': ["'self'"],
      'manifest-src': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use('/api/ingest', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
app.use('/api/hooks', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));
app.use('/api/ingest', rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/alerts/action', rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false }));

app.use('/api/auth', authRoutes);
app.use('/api', createHooks({ monitor }));
app.use('/api', createStream({ monitor }));
app.use('/api', createUsers({ monitor }));
// Restart / Switch line go to root through scripts/pulse-action.sh (see deploy/pulse-action.*).
const actions = require('./core/actions').createActions({
  reqDir: process.env.PULSE_ACTION_REQ || require('path').join(require('./utils/dataDir'), 'actions'),
  outDir: process.env.PULSE_ACTION_OUT || '/var/lib/pulse-scan/actions',
});
const backups = require('./core/backups').createBackups({ monitor, actions, db, getSettings, updateSettings: require('./utils/settings').updateSettings });
app.use('/api', createApi({ monitor, channels, secret: process.env.JWT_SECRET, actions, backups }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Read-only, public, and deliberately boring: the outside pinger hits this.
// "ok" means the web app answers AND the collector sampled recently.
app.get('/healthz', (req, res) => {
  const latest = monitor.collector.latest();
  const age = latest ? Date.now() - latest.ts : null;
  const ok = age !== null && age < 30_000;
  res.status(ok ? 200 : 503).json({ ok, sampleAgeMs: age, version: require('./package.json').version, uptime: Math.round(process.uptime()) });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) {
    if (p.endsWith('sw.js') || p.endsWith('.webmanifest') || p.endsWith('index.html')) res.set('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong.' });
});

const PORT = Number(process.env.PORT) || 3201;
const HOST = process.env.HOST || '127.0.0.1';
if (require.main === module) {
  monitor.start().catch((e) => console.error('[monitor] failed to start:', e));
  const digest = createDigestScheduler({ monitor, channels, getSettings, zones: () => require('./core/zones').displayZones(db, getSettings()) });
  digest.prime();
  setInterval(digest, 60_000).unref();
  setInterval(() => backups.tick().catch((e) => console.error('[backups]', e.message)), 60_000).unref();
  dashLogins.tick();
  setInterval(() => { try { dashLogins.tick(); } catch (e) { console.error('[dash-logins]', e.message); } }, 10_000).unref();
  app.listen(PORT, HOST, () => console.log(`DeonTech Pulse on http://${HOST}:${PORT}`));
}
module.exports = { app, monitor, channels, backups, actions };
