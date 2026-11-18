/* DeonTech Pulse — the dashboard. Plain JS, no build step, no CDN.
 *
 * Every piece of server data reaches the page through textContent (the h()
 * helper below), never innerHTML, so a hostile hostname, cron line or log
 * message can't inject markup into the owner's session. */
'use strict';

// ===================================================================== version
// This copy of Pulse. Kept equal to package.json (npm test checks, and the
// service worker's cache name too); when the server runs a newer one, Pulse
// says so and offers to reload into it.
const APP_VERSION = '0.1.14';
// Every update, newest first, as the About page shows it.
const CHANGES = [
  ['0.1.14', 'Blue/green apps: right after a release Pulse checks the new live line at once (its port is read from the service), and never reports the stopped idle line as the app being down. PostgreSQL is one card, checked on its main port, instead of a card per cluster plus Ubuntu’s wrapper service that always looked down.'],
  ['0.1.13', 'The More sheet has a close button, and you can drag it like in Find My: up to make it tall, down to make it short, further down to close it. Backups: Pulse backs itself up (its database and settings, never its secrets), and SQL Server can be backed up and copied off-site once it has a backup login. On Backups, the nightly time and its Save button no longer sit on top of each other on a phone.'],
  ['0.1.12', 'Opens straight away from the copy on your phone, like Budget, then checks the server: a newer Pulse downloads with the bar at the top and offers Reload. Ubuntu’s own services (ldconfig, snapd and the like) are no longer listed as apps. Budget can now report its sign-ins to Pulse.'],
  ['0.1.11', 'Pulse finds new apps by itself and tells you: “New app found: Budget”, once, with what runs it and where. Apps started with PM2, Docker or by hand are found too, named after the folder they run from. A new service, site or port is noticed in about a minute, not an hour. Apps that report a version show it, and each new version is a release on their timeline. This About page, with the update bar.'],
  ['0.1.10', 'Clocks follow where you are: Accra always, and a second clock only while you’re away.'],
  ['0.1.9', 'Phones: a More tab opens every page (Errors, Sign-ins, Access, Server, Inventory, Settings, People) and the theme. Backups in the tab bar.'],
  ['0.1.8', 'Backups: every app’s backups in one place, Back up now (checked, optionally off-site), nightly backups by Pulse, correct backup alerts.'],
  ['0.1.7', 'Errors: every app error grouped by kind, with its stack, the log lines around it, the page that failed, and what to do.'],
  ['0.1.6', 'Restart an app, switch its live line, read its log, see what uses memory. More than one phone on the same account. Trusting a network asks for how long.'],
  ['0.1.5', 'Scripts to connect your apps, so Pulse can show who is signed in to each.'],
  ['0.1.4', 'Sign-ins: who is signed in to each app, history, failed attempts and alerts.'],
  ['0.1.3', 'A monitoring switch for each app. People: owner, admin and viewer logins, each with its own on/off switch.'],
  ['0.1.2', 'The premium look: health ring, gauges with sparklines, uptime strips, light/dark/auto.'],
  ['0.1.1', 'Lighter on the server: readings taken in-process, about 1% CPU.'],
  ['0.1.0', 'First release: live server readings, apps found by themselves, sign-in alerts with trusted sources, alerts by push, SMS and email.'],
];

// ===================================================================== helpers
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; } }
    else if (k === 'html') throw new Error('no innerHTML');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Inline SVG icons (paths only; drawn with currentColor).
const ICONS = {
  overview: 'M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z',
  server: 'M4 4h16v6H4zm0 10h16v6H4zM7 7h.01M7 17h.01',
  apps: 'M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z',
  access: 'M12 2a5 5 0 0 1 5 5v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1V7a5 5 0 0 1 5-5zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3z',
  alerts: 'M12 2a6 6 0 0 0-6 6v4l-2 4h16l-2-4V8a6 6 0 0 0-6-6zm-2 17a2 2 0 0 0 4 0z',
  inventory: 'M4 5h16M4 12h16M4 19h16',
  cpu: 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm3 5h4v4h-4z',
  mem: 'M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M5 16v3M19 16v3',
  disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3zM4 6c0 1.7 3.6 3 8 3s8-1.3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
  net: 'M12 3v14M7 12l5 5 5-5M5 21h14',
  people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9c0-3.3 3.1-6 7-6s7 2.7 7 6zm14.5-9a3.5 3.5 0 1 0-1.4-6.7 6 6 0 0 1 0 6.4c.4.2.9.3 1.4.3zm1.3 2.2A7.6 7.6 0 0 1 21 20h2c0-2.9-2-5.4-5.2-6.8z',
  more: 'M5 5h4v4H5zM15 5h4v4h-4zM5 15h4v4H5zM15 15h4v4h-4z',
  backups: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 7v5c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12v5c0 1.7 3.6 3 8 3 1 0 2-.1 2.9-.2M17 17l2 2 3-4',
  errors: 'M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9M6 13H2M6 17l-3 2M18 13h4M18 17l3 2',
  signins: 'M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || '');
  const stroked = ['server', 'inventory', 'cpu', 'mem', 'disk', 'swap', 'net', 'signins', 'errors', 'backups', 'more'].includes(name);
  p.setAttribute('fill', stroked ? 'none' : 'currentColor');
  if (stroked) { p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); }
  svg.append(p);
  return svg;
}

// ---- Clocks ----
// The phone or computer sets its own time zone from where it is, so the
// device's zone is "where I am now". Home comes from Pulse's settings.
const DEVICE_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();
let HOME_TZ = (() => { try { return localStorage.getItem('pulse:home') || 'Africa/Accra'; } catch { return 'Africa/Accra'; } })();
function setHome(z) { if (z && z !== HOME_TZ) { HOME_TZ = z; try { localStorage.setItem('pulse:home', z); } catch { /* */ } } }
function zoneName(z) { return String(z).split('/').pop().replace(/_/g, ' '); }
function clockOf(z, ts) { try { return new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', day: 'numeric', hourCycle: 'h23' }).format(new Date(ts)); } catch { return null; } }
function clockZones(ts = Date.now()) {
  const away = DEVICE_TZ && DEVICE_TZ !== HOME_TZ && clockOf(DEVICE_TZ, ts) !== clockOf(HOME_TZ, ts) ? DEVICE_TZ : null;
  return away ? [HOME_TZ, away] : [HOME_TZ];
}
// Tell Pulse where this device is (at most hourly), so texts and emails sent
// while away show both clocks too.
let tzToldAt = 0;
function reportZone() {
  if (!DEVICE_TZ || !S.me || S.needs2fa || Date.now() - tzToldAt < 3600_000) return;
  tzToldAt = Date.now();
  api('/me/timezone', { method: 'POST', body: { tz: DEVICE_TZ } }).then((r) => { if (r && r.home) setHome(r.home); }).catch(() => { tzToldAt = 0; });
}

const fmt = {
  pct: (v) => (v == null ? '—' : `${Math.round(v)}%`),
  bytes(b, d = 1) {
    if (b == null || !Number.isFinite(b)) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i && b < 10 ? d : 0)} ${u[i]}`;
  },
  rate: (b) => (b == null ? '—' : `${fmt.bytes(b)}/s`),
  ms: (v) => (v == null ? '—' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`),
  ago(ts) {
    if (!ts) return '—';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 0) return 'just now';
    if (s < 45) return 'just now';
    if (s < 90) return '1 min ago';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    if (hr < 36) return `${hr} h ago`;
    return `${Math.round(hr / 24)} days ago`;
  },
  dur(ms) {
    if (ms == null) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m} min`;
    const hr = Math.floor(m / 60);
    if (hr < 48) return `${hr} h ${m % 60} min`;
    return `${Math.floor(hr / 24)} days`;
  },
  // Home (Accra) always; the time where this device is, only when that clock differs.
  time(ts, withDate = false) {
    if (!ts) return '—';
    return clockZones(ts).map((z) => {
      const opts = { timeZone: z, hour: '2-digit', minute: '2-digit', hour12: false };
      if (withDate) Object.assign(opts, { day: 'numeric', month: 'short' });
      return `${new Intl.DateTimeFormat('en-GB', opts).format(new Date(ts))} ${zoneName(z)}`;
    }).join(' · ');
  },
  short(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('on'), 3200);
}

class ApiError extends Error { constructor(msg, status, body) { super(msg); this.status = status; this.body = body; } }

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError('No connection to the server.', 0, null);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) { S.me = null; render(); }
    if (res.status === 403 && data && data.needs2fa) { S.needs2fa = true; render(); }
    throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}

// Last good copy of each GET, for the offline view.
const cache = {
  put(k, v) { try { localStorage.setItem(`pulse:${k}`, JSON.stringify({ ts: Date.now(), v })); } catch { /* storage off */ } },
  get(k) { try { const x = JSON.parse(localStorage.getItem(`pulse:${k}`)); return x; } catch { return null; } },
};
async function load(path, key = path) {
  try {
    const v = await api(path);
    cache.put(key, v);
    S.offline = false;
    return v;
  } catch (e) {
    if (e.status === 0) {
      const c = cache.get(key);
      S.offline = true;
      if (c) { c.v.__cachedAt = c.ts; return c.v; }
    }
    throw e;
  }
}

// ===================================================================== state
const S = {
  me: undefined,          // undefined = not checked yet, null = signed out
  needs2fa: false,
  overview: null,
  latest: null,
  ring: [],
  processes: [],
  counts: { critical: 0, warning: 0, unacked: 0 },
  stream: null,
  streamOk: false,
  offline: false,
  charts: [],
  route: '',
};

// What the signed-in account may do. The server checks again; this only
// decides which buttons to show.
const ROLE_PERMS = { owner: ['monitor.view', 'monitor.manage', 'staff.manage', 'settings.manage'], admin: ['monitor.view', 'monitor.manage'], viewer: ['monitor.view'] };
function can(p) {
  if (!S.me) return false;
  if (S.me.role === 'owner') return true;
  return (S.me.permissions || ROLE_PERMS[S.me.role] || []).includes(p);
}

// ===================================================================== theme
(function theme() {
  try { const t = localStorage.getItem('pulse:theme'); if (t) document.documentElement.dataset.theme = t; } catch { /* */ }
})();
function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function setTheme(t) {
  if (t === 'system') { delete document.documentElement.dataset.theme; try { localStorage.removeItem('pulse:theme'); } catch { /* */ } }
  else { document.documentElement.dataset.theme = t; try { localStorage.setItem('pulse:theme', t); } catch { /* */ } }
  if (S.me && !S.needs2fa) softRefresh(); else rerenderCharts();
}

// ===================================================================== WebAuthn (no library)
const b64u = {
  toBuf(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; },
  fromBuf(b) { return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
};
function credToJSON(c) {
  const r = c.response;
  const out = { id: c.id, rawId: b64u.fromBuf(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}, authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: b64u.fromBuf(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = b64u.fromBuf(r.attestationObject); out.response.transports = r.getTransports ? r.getTransports() : []; }
  if (r.authenticatorData) { out.response.authenticatorData = b64u.fromBuf(r.authenticatorData); out.response.signature = b64u.fromBuf(r.signature); if (r.userHandle) out.response.userHandle = b64u.fromBuf(r.userHandle); }
  return out;
}
async function passkeyRegister(deviceName, code) {
  const o = await api('/auth/passkey/register/options', { method: 'POST', body: { code } });
  const opts = { ...o, challenge: b64u.toBuf(o.challenge), user: { ...o.user, id: b64u.toBuf(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })) };
  const cred = await navigator.credentials.create({ publicKey: opts });
  return api('/auth/passkey/register/verify', { method: 'POST', body: { attResp: credToJSON(cred), deviceName } });
}
async function passkeyLogin() {
  const o = await api('/auth/passkey/login/options', { method: 'POST', body: { remember: true } });
  const opts = { ...o, challenge: b64u.toBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })) };
  const cred = await navigator.credentials.get({ publicKey: opts });
  return api('/auth/passkey/login/verify', { method: 'POST', body: { authResp: credToJSON(cred) } });
}

// ===================================================================== auth screens
function authFrame(title, sub, body) {
  return h('div', { class: 'auth' },
    h('img', { class: 'logo', src: '/icons/icon-192.png', alt: '' }),
    h('h1', null, title), sub ? h('p', { class: 'muted' }, sub) : null,
    h('div', { class: 'card' }, body));
}

function loginScreen() {
  const err = h('div', { class: 'err' });
  const email = h('input', { type: 'email', autocomplete: 'username webauthn', required: true, id: 'email' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, id: 'pw' });
  const remember = h('input', { type: 'checkbox', checked: true });
  const form = h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: email.value, password: pw.value, remember: remember.checked } });
      if (r.twoFactorRequired) return show(twoFactorStep(r.pendingToken));
      if (r.mustChangePassword) return show(changePasswordStep(r.pendingToken));
      await boot();
    } catch (x) { err.textContent = x.message; }
  } },
  h('label', { class: 'field', for: 'email' }, 'Email', email),
  h('label', { class: 'field', for: 'pw' }, 'Password', pw),
  h('label', { class: 'check small' }, remember, 'Keep me signed in on this device'),
  err,
  h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'));
  const pk = window.PublicKeyCredential ? h('button', { class: 'btn', type: 'button', style: { width: '100%', justifyContent: 'center', marginTop: '10px' }, onclick: async () => {
    err.textContent = '';
    try {
      const r = await passkeyLogin();
      if (r.mustChangePassword) return show(changePasswordStep(r.pendingToken));
      await boot();
    } catch (x) { err.textContent = x.name === 'NotAllowedError' ? 'Cancelled.' : x.message; }
  } }, 'Sign in with Face ID / Touch ID') : null;
  return authFrame('DeonTech Pulse', 'Private. Owner only.', [form, pk]);
}

function twoFactorStep(pendingToken) {
  const err = h('div', { class: 'err' });
  const code = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]*', id: 'code', autofocus: true });
  const backup = h('input', { type: 'text', autocomplete: 'off', id: 'backup', placeholder: 'or a backup code' });
  return authFrame('Two-factor code', 'From your authenticator app.', h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try {
      await api('/auth/login/verify-2fa', { method: 'POST', body: backup.value ? { pendingToken, backupCode: backup.value } : { pendingToken, code: code.value } });
      await boot();
    } catch (x) { err.textContent = x.message; }
  } }, h('label', { class: 'field', for: 'code' }, '6-digit code', code), h('details', null, h('summary', { class: 'small' }, 'Lost your phone?'), h('div', { style: { marginTop: '8px' } }, backup)), err, h('button', { class: 'btn primary', type: 'submit' }, 'Continue')));
}

function changePasswordStep(pendingToken) {
  const err = h('div', { class: 'err' });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', id: 'np' });
  return authFrame('Choose a new password', 'At least 12 characters, with upper and lower case, a number and a symbol.', h('form', { class: 'form', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('/auth/login/complete-password-change', { method: 'POST', body: { pendingToken, newPassword: pw.value } }); await boot(); } catch (x) { err.textContent = x.message; }
  } }, h('label', { class: 'field', for: 'np' }, 'New password', pw), err, h('button', { class: 'btn primary', type: 'submit' }, 'Save and continue')));
}

// 2FA is required. A signed-in account without it lands here and nowhere else.
function setup2faScreen() {
  const err = h('div', { class: 'err' });
  const box = h('div', { class: 'form' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', id: 'p2' });
  box.append(
    h('p', { class: 'small ink2' }, 'Pulse can see who logs into the server, so it needs more than a password. Confirm your password, then scan the code with an authenticator app (Google Authenticator, 1Password, Authy…).'),
    h('label', { class: 'field', for: 'p2' }, 'Your password', pw), err,
    h('button', { class: 'btn primary', onclick: async () => {
      err.textContent = '';
      try {
        const r = await api('/auth/2fa/setup', { method: 'POST', body: { password: pw.value, method: 'totp' } });
        const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', id: 'c2' });
        const err2 = h('div', { class: 'err' });
        box.replaceChildren(
          r.qrCodeDataUrl ? h('div', { class: 'qr' }, h('img', { src: r.qrCodeDataUrl, alt: 'QR code for your authenticator app' })) : null,
          h('details', null, h('summary', { class: 'small' }, "Can't scan? Type this key"), h('p', { class: 'fp' }, r.secret)),
          h('label', { class: 'field', for: 'c2' }, 'Code from the app', code), err2,
          h('button', { class: 'btn primary', onclick: async () => {
            err2.textContent = '';
            try {
              const done = await api('/auth/2fa/enable', { method: 'POST', body: { token: code.value } });
              box.replaceChildren(
                h('p', null, h('strong', null, 'Two-factor is on.'), ' Save these backup codes somewhere safe — each works once if you lose your phone.'),
                h('div', { class: 'codes' }, (done.backupCodes || []).map((c) => h('div', null, c))),
                h('button', { class: 'btn primary', onclick: async () => { S.needs2fa = false; await boot(); } }, "I've saved them — continue"));
            } catch (x) { err2.textContent = x.message; }
          } }, 'Turn on two-factor'));
      } catch (x) { err.textContent = x.message; }
    } }, 'Continue'));
  return authFrame('Set up two-factor sign-in', 'Required for every Pulse login.', [box, h('p', { class: 'tiny muted', style: { marginTop: '12px' } }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); logout(); } }, 'Sign out'))]);
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* */ }
  S.me = null;
  if (S.stream) S.stream.close();
  try { Object.keys(localStorage).filter((k) => k.startsWith('pulse:') && k !== 'pulse:theme').forEach((k) => localStorage.removeItem(k)); } catch { /* */ }
  render();
}

function show(node) { const app = $('#app'); destroyCharts(); app.replaceChildren(node); }

// ===================================================================== shell
const NAV = [
  ['overview', 'Overview', '#/'],
  ['server', 'Server', '#/server'],
  ['apps', 'Apps', '#/apps'],
  ['access', 'Access', '#/access'],
  ['alerts', 'Alerts', '#/alerts'],
  ['errors', 'Errors', '#/errors'],
  ['backups', 'Backups', '#/backups'],
  ['signins', 'Sign-ins', '#/signins'],
  ['inventory', 'Inventory', '#/inventory'],
  ['settings', 'Settings', '#/settings'],
  ['people', 'People', '#/people', 'staff.manage'],
];
const navItems = () => NAV.filter((n) => !n[3] || can(n[3]));

function shell(active, content) {
  const badge = (k) => (k === 'alerts' && (S.counts.critical || S.counts.warning)
    ? h('span', { class: `badge${S.counts.critical ? '' : ' warn'}` }, S.counts.critical + S.counts.warning)
    : k === 'errors' && S.openErrors ? h('span', { class: 'badge warn' }, S.openErrors) : null);
  const side = h('nav', { class: 'side', 'aria-label': 'Main' },
    h('div', { class: 'brand' }, h('img', { src: '/icons/icon-192.png', alt: '' }), 'DeonTech Pulse'),
    h('div', { class: 'nav' }, navItems().map(([k, label, href]) => h('a', { href, class: k === active ? 'on' : null, 'aria-current': k === active ? 'page' : null }, icon(k), label, badge(k)))),
    h('div', { class: 'foot' }, h('div', { class: `conn${S.streamOk ? '' : ' off'}`, id: 'conn' }, S.streamOk ? 'Live' : S.offline ? 'Offline — last readings' : 'Connecting…'), S.me ? h('div', { class: 'me-chip' }, avatar(S.me.name || S.me.email), h('div', null, h('b', null, S.me.name || S.me.email), h('span', null, roleName(S.me.role)))) : null, themeToggle(),
      h('a', { href: '#/about', class: `about-link${active === 'about' ? ' on' : ''}` }, `About Pulse · ${APP_VERSION}`, S.newVersion ? h('span', { class: 'badge warn' }, 'new') : null)));
  // Phones: four pages in the bar, everything else behind More.
  const main = TAB_MAIN.map((k) => navItems().find((n) => n[0] === k)).filter(Boolean);
  const inMore = !TAB_MAIN.includes(active) && active;
  const moreBadge = S.openErrors ? h('span', { class: 'badge warn' }, S.openErrors) : null;
  const tabs = h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    main.map(([k, label, href]) => h('a', { href, class: k === active ? 'on' : null, 'aria-current': k === active ? 'page' : null }, icon(k), label, badge(k))),
    // A link, not a button: the shared glass tab bar follows a finger across
    // links only, and hands a tap on anything else to the nearest link.
    h('a', { href: '#/more', role: 'button', class: `more-tab${inMore ? ' on' : ''}`, 'aria-haspopup': 'dialog', 'aria-label': 'More pages', draggable: 'false', onclick: (e) => { e.preventDefault(); openMore(active); } }, icon('more'), 'More', moreBadge));
  return h('div', { class: 'shell' }, side, h('main', { id: 'main' }, content), tabs);
}

function themeToggle() {
  const cur = document.documentElement.dataset.theme || 'system';
  const box = h('div', { class: 'theme-toggle', role: 'group', 'aria-label': 'Theme' });
  for (const [k, label] of [['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']]) {
    box.append(h('button', { type: 'button', class: k === cur ? 'on' : null, 'aria-pressed': String(k === cur), onclick: () => {
      setTheme(k);
      box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.textContent === label));
    } }, label));
  }
  return box;
}

const TAB_MAIN = ['overview', 'apps', 'alerts', 'backups'];

// The More sheet (phones): every page not in the bar, plus theme and account.
function openMore(active) {
  if (document.querySelector('.more-sheet')) return;
  const pages = navItems().filter(([k]) => !TAB_MAIN.includes(k));
  // The glass bar lit More when it was tapped; give the light back to the page's own tab.
  const relight = () => document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('on', a.classList.contains('more-tab') ? (!TAB_MAIN.includes(active) && !!active) : a.getAttribute('href') === (navItems().find((n) => n[0] === active) || [])[2]));
  const close = (e) => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 220); window.removeEventListener('hashchange', close); document.removeEventListener('keydown', esc); if (!e || e.type !== 'hashchange') relight(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const count = (k) => (k === 'errors' ? S.openErrors : 0);
  const sheet = h('div', { class: 'more-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'All pages' },
    h('div', { class: 'ms-head' },
      h('div', { class: 'ms-grip', 'aria-hidden': 'true' }),
      h('div', { class: 'ms-title' }, h('b', null, 'All pages'),
        h('button', { type: 'button', class: 'ms-close', 'aria-label': 'Close', onclick: () => close() }, '\u2715'))),
    h('div', { class: 'ms-grid' }, pages.map(([k, label, href]) => h('a', { href, class: `ms-tile${k === active ? ' on' : ''}` },
      h('span', { class: `ms-ic ic-${k}` }, icon(k)), h('span', null, label),
      count(k) ? h('span', { class: 'badge warn' }, count(k)) : null))),
    h('div', { class: 'ms-foot' },
      S.me ? h('div', { class: 'me-chip' }, avatar(S.me.name || S.me.email), h('div', null, h('b', null, S.me.name || S.me.email), h('span', null, roleName(S.me.role)))) : null,
      themeToggle(),
      h('a', { href: '#/about', class: 'about-link' }, `About Pulse · ${APP_VERSION}`, S.newVersion ? h('span', { class: 'badge warn' }, 'new') : null)));
  // A drag that ends over the dimmed backdrop must not count as a tap on it.
  const wrap = h('div', { class: 'more-wrap', onclick: (e) => { if (e.target === wrap && Date.now() - (sheet.draggedAt || 0) > 400) close(); } }, sheet);
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  sheetDrag(sheet, close);
  window.addEventListener('hashchange', close);
  document.addEventListener('keydown', esc);
  // Tapping the page you are already on just closes the sheet.
  sheet.querySelectorAll('.ms-tile.on').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); close(); }));
}

// A sheet you can drag, as in Find My: up to make it tall, down to make it
// short again, further down (or a quick flick) to close it. The handle and
// the title row always drag; the rest drags down only when scrolled to the top.
function sheetDrag(sheet, close) {
  const vh = () => window.innerHeight;
  const short = () => Math.min(sheet.scrollHeight, vh() * 0.62);
  const tall = () => vh() * 0.92;
  let start = null;
  const slide = 'transform .24s cubic-bezier(.2,.9,.25,1)';
  const setH = (px, animate) => { sheet.style.transition = animate ? `${slide}, height .28s cubic-bezier(.2,.8,.2,1)` : slide; sheet.style.height = `${Math.round(px)}px`; };
  requestAnimationFrame(() => { sheet.style.maxHeight = 'none'; setH(short(), false); });
  const down = (e) => {
    const onHead = e.target.closest('.ms-head') && !e.target.closest('.ms-close');
    if (!onHead && sheet.scrollTop > 0) return;
    start = { y: e.clientY, h: sheet.getBoundingClientRect().height, t: Date.now(), onHead, moved: false, id: e.pointerId };
    // The handle keeps the pointer even when it leaves the sheet (a mouse
    // dragged above it); a finger is kept anyway.
    if (onHead) { try { sheet.setPointerCapture(e.pointerId); } catch { /* */ } }
  };
  const move = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    if (!start.moved) {
      if (Math.abs(dy) < 6) return;
      if (!start.onHead && dy < 0) { start = null; return; }   // scrolling the list up
      start.moved = true;
      try { sheet.setPointerCapture(e.pointerId); } catch { /* */ }
    }
    e.preventDefault();
    setH(Math.max(60, Math.min(tall(), start.h - dy)), false);
  };
  const up = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const s = start; start = null;
    if (!s.moved) return;
    sheet.draggedAt = Date.now();
    const hNow = sheet.getBoundingClientRect().height;
    const speed = (hNow - s.h) / Math.max(1, Date.now() - s.t);   // px per ms: + grew (dragged up), - shrank
    if (speed < -0.8 || hNow < short() * 0.55) { close(); return; }
    const snap = speed > 0.8 ? tall() : speed < -0.3 ? short() : (Math.abs(hNow - tall()) < Math.abs(hNow - short()) ? tall() : short());
    setH(snap, true);
    sheet.classList.toggle('tall', snap === tall());
  };
  sheet.addEventListener('pointerdown', down);
  sheet.addEventListener('pointermove', move, { passive: false });
  sheet.addEventListener('pointerup', up);
  sheet.addEventListener('pointercancel', up);
}

function pageTop(title, ...actions) {
  return h('div', { class: 'top' }, h('h1', null, title), h('div', { class: 'actions' }, actions));
}

function offlineNote(d) {
  return d && d.__cachedAt ? h('div', { class: 'banner info' }, h('div', { class: 'b-body' }, h('strong', null, 'Offline'), `Showing the last readings, from ${fmt.ago(d.__cachedAt)}.`)) : null;
}

// ===================================================================== router
const ROUTES = [];
function route(re, fn) { ROUTES.push([re, fn]); }

async function render() {
  if (S.me === undefined) return;
  if (S.me === null) return show(loginScreen());
  if (S.needs2fa) return show(setup2faScreen());
  const hash = location.hash.replace(/^#/, '') || '/';
  S.route = hash;
  for (const [re, fn] of ROUTES) {
    const m = hash.match(re);
    if (m) {
      try { await fn(...m.slice(1)); } catch (e) {
        if (e.status === 401 || (e.body && e.body.needs2fa)) return;
        show(shell('', h('div', { class: 'banner critical' }, h('div', { class: 'b-body' }, h('strong', null, 'Could not load this page'), e.message))));
      }
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });

// ===================================================================== live stream
function connectStream() {
  if (S.stream) S.stream.close();
  const es = new EventSource('/api/stream');
  S.stream = es;
  es.addEventListener('hello', (e) => { const d = JSON.parse(e.data); S.streamOk = true; S.counts = d.counts; if (d.latest) S.latest = d.latest; paintConn(); });
  es.addEventListener('sample', (e) => {
    const s = JSON.parse(e.data);
    S.latest = s;
    S.ring.push({ ts: s.ts, cpu: s.cpu, mem: s.mem, swap: s.swap, disk: s.disk, rx: s.rx, tx: s.tx, rd: s.rd, wr: s.wr, load1: s.load1 });
    if (S.ring.length > 450) S.ring.shift();
    onLive(s);
  });
  es.addEventListener('processes', (e) => { S.processes = JSON.parse(e.data); onProcesses(); });
  es.addEventListener('alert', (e) => {
    const d = JSON.parse(e.data);
    const was = S.counts.critical + S.counts.warning;
    S.counts = d.counts;
    paintBadges();
    if (d.type === 'opened') toast(`${d.alert.severity === 'critical' ? 'Urgent' : 'Warning'}: ${d.alert.title}`);
    if (navigator.setAppBadge) { const n = S.counts.critical + S.counts.warning; (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); }
    if (/^\/(alerts)?$/.test(S.route) && was !== S.counts.critical + S.counts.warning) softRefresh();
  });
  es.addEventListener('checks', (e) => onChecks(JSON.parse(e.data)));
  es.addEventListener('signedout', () => { es.close(); S.me = null; render(); });
  es.addEventListener('backup', (e) => {
    const d = JSON.parse(e.data);
    if (d.state === 'done') toast(`Backup of ${d.app} done and checked`);
    if (d.state === 'failed') toast(`Backup of ${d.app} failed — see Backups`);
    if (/^\/(backups|apps\/)/.test(S.route)) softRefresh();
  });
  es.addEventListener('access', () => { if (S.route.startsWith('/access')) softRefresh(); });
  es.onerror = () => { S.streamOk = false; paintConn(); };
}
function paintConn() {
  const c = $('#conn');
  if (c) { c.className = `conn${S.streamOk ? '' : ' off'}`; c.textContent = S.streamOk ? 'Live' : S.offline ? 'Offline — last readings' : 'Reconnecting…'; }
}
function paintBadges() {
  document.querySelectorAll('a[href="#/alerts"]').forEach((a) => {
    a.querySelector('.badge')?.remove();
    const n = S.counts.critical + S.counts.warning;
    if (n) a.append(h('span', { class: `badge${S.counts.critical ? '' : ' warn'}` }, n));
  });
}
let refreshTimer = null;
function softRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { const y = window.scrollY; render().then(() => window.scrollTo(0, y)); }, 400); }

// Page hooks the live stream calls; pages set them, navigation clears them.
let onLive = () => {};
let onProcesses = () => {};
let onChecks = () => {};
function resetHooks() { onLive = () => {}; onProcesses = () => {}; onChecks = () => {}; }

// ===================================================================== boot
async function boot() {
  try {
    S.me = await api('/auth/me');
  } catch (e) {
    if (e.status === 0) {
      // Offline at launch: show the cached shell rather than a login form.
      const c = cache.get('me');
      S.me = c ? c.v : null;
      S.offline = !!c;
    } else S.me = null;
  }
  if (S.me) {
    cache.put('me', S.me);
    S.needs2fa = !S.me.twoFactorEnabled;
    if (!S.needs2fa) { connectStream(); reportZone(); setTimeout(checkVersion, 1500); }
  }
  render();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'navigate') location.hash = e.data.hash; });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.me && !S.needs2fa && (!S.stream || S.stream.readyState === 2)) connectStream(); if (document.visibilityState === 'visible') { reportZone(); if (S.me && !S.needs2fa) checkVersion(); } });
window.addEventListener('online', () => { S.offline = false; if (S.me) connectStream(); softRefresh(); });

// ===================================================================== charts
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function destroyCharts() { S.charts.forEach((c) => { try { c.u.destroy(); c.ro && c.ro.disconnect(); } catch { /* */ } }); S.charts = []; resetHooks(); }
function rerenderCharts() { S.charts.forEach((c) => c.rebuild && c.rebuild()); }

/**
 * One measure per chart (no dual axes). series: [{ key, label, color: '--series-1', fmt }]
 */
function lineChart(el, { series, rows, deploys = [], yMax = null, yFmt = (v) => v, height = 200, emptyText = null }) {
  const entry = { u: null, ro: null, rows, deploys };
  function data() {
    const r = entry.rows || [];
    return [r.map((x) => x.ts / 1000), ...series.map((s) => r.map((x) => (x[s.key] == null ? null : x[s.key])))];
  }
  function build() {
    if (entry.u) entry.u.destroy();
    el.replaceChildren();
    if (!entry.rows || entry.rows.length < 2) { el.append(h('div', { class: 'chart-empty' }, 'Collecting data…')); entry.u = null; return; }
    if (entry.rows.every((r) => series.every((s) => r[s.key] == null))) { el.append(h('div', { class: 'chart-empty' }, emptyText || 'No readings in this range.')); entry.u = null; return; }
    const ink = cssVar('--muted'), grid = cssVar('--line'), surface = cssVar('--surface');
    const width = Math.max(260, el.clientWidth || 600);
    const opts = {
      width, height,
      padding: [8, 8, 0, 0],
      cursor: { points: { size: 8, width: 2, stroke: surface }, drag: { x: false, y: false } },
      legend: { live: true },
      scales: { x: { time: true }, y: yMax ? { range: [0, yMax] } : { range: (u, mn, mx) => [0, Math.max(mx * 1.15, 1)] } },
      axes: [
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui', space: 70, values: (u, vals) => xLabels(vals) },
        { stroke: ink, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui', size: 54, values: (u, vals) => vals.map((v) => yFmt(v)) },
      ],
      series: [
        { value: (u, v) => (v == null ? '—' : new Date(v * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: entry.rows.length && entry.rows[1].ts - entry.rows[0].ts < 60000 ? '2-digit' : undefined })) },
        ...series.map((s) => ({
          label: s.label, stroke: cssVar(s.color), width: 2, points: { show: false },
          // A soft fade under each line: the "colour shading" look, drawn by the canvas itself.
          fill: (u) => {
            const top = u.bbox && u.bbox.top, hgt = u.bbox && u.bbox.height;
            if (!Number.isFinite(top) || !Number.isFinite(hgt) || hgt <= 0) return withAlpha(cssVar(s.color), 0.12);
            const g = u.ctx.createLinearGradient(0, top, 0, top + hgt);
            g.addColorStop(0, withAlpha(cssVar(s.color), series.length > 1 ? 0.22 : 0.32));
            g.addColorStop(1, withAlpha(cssVar(s.color), 0));
            return g;
          },
          value: (u, v) => (v == null ? '—' : (s.fmt || yFmt)(v)), spanGaps: false,
        })),
      ],
      hooks: {
        // With no pointer over the chart, the legend shows the latest values.
        ready: [(u) => u.setLegend({ idx: u.data[0].length - 1 })],
        setCursor: [(u) => { if (u.cursor.idx == null) u.setLegend({ idx: u.data[0].length - 1 }); }],
        draw: [(u) => {
          const ctx = u.ctx;
          ctx.save();
          ctx.strokeStyle = cssVar('--accent');
          ctx.globalAlpha = 0.55;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1 * devicePixelRatio;
          for (const d of entry.deploys || []) {
            const x = u.valToPos(d.started_at / 1000, 'x', true);
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue;
            ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke();
          }
          ctx.restore();
        }],
      },
    };
    entry.u = new uPlot(opts, data(), el);
  }
  entry.rebuild = build;
  entry.update = (rows, deploys) => {
    entry.rows = rows; if (deploys) entry.deploys = deploys;
    if (!entry.u) return build();
    entry.u.setData(data());
    if (entry.u.cursor.idx == null) entry.u.setLegend({ idx: entry.u.data[0].length - 1 });
  };
  build();
  entry.ro = new ResizeObserver(() => { if (entry.u && Math.abs(entry.u.width - el.clientWidth) > 4) entry.u.setSize({ width: el.clientWidth, height }); });
  entry.ro.observe(el);
  S.charts.push(entry);
  return entry;
}

function withAlpha(hex, a) {
  const m = String(hex).trim().match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

// Axis labels in local time: clock times within two days, dates beyond.
function xLabels(vals) {
  if (!vals.length) return [];
  const span = vals[vals.length - 1] - vals[0];
  return vals.map((v) => {
    const d = new Date(v * 1000);
    if (span > 2 * 86400) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
    if (span > 20 * 3600) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (d.getHours() === 0 && d.getMinutes() === 0 ? ` ${d.getDate()}/${d.getMonth() + 1}` : '');
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: span < 600 ? '2-digit' : undefined });
  });
}

function rangePicker(current, ranges, onPick) {
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' });
  for (const [k, label] of ranges) {
    seg.append(h('button', { type: 'button', class: k === current ? 'on' : null, 'aria-pressed': String(k === current), onclick: () => {
      seg.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.textContent === label); b.setAttribute('aria-pressed', String(b.textContent === label)); });
      onPick(k);
    } }, label));
  }
  return seg;
}

function meter(pct, warnAt = 85, critAt = 95) {
  const cls = pct >= critAt ? 'crit' : pct >= warnAt ? 'warn' : '';
  return h('div', { class: `meter ${cls}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct || 0) }, h('i', { style: { width: `${Math.min(100, Math.max(0, pct || 0))}%` } }));
}

function statusBadge(status) {
  const words = { up: 'Up', slow: 'Slow', down: 'Down', stopped: 'Stopped', unknown: 'Checking', off: 'Off' };
  return h('span', { class: `st ${status || 'unknown'}` }, words[status] || status || 'Checking');
}
function sevBadge(sev) {
  return h('span', { class: `st ${sev === 'critical' ? 'critical' : sev === 'warning' ? 'warning' : 'unknown'}` }, sev === 'critical' ? 'Urgent' : sev === 'warning' ? 'Warning' : 'Info');
}


// ===================================================================== Overview
const GAUGE = {
  cpu: { label: 'CPU', icon: 'cpu', cls: 'g-cpu', from: '#6366f1', to: '#a855f7', th: [80, 90] },
  mem: { label: 'Memory', icon: 'mem', cls: 'g-mem', from: '#06b6d4', to: '#3b82f6', th: [85, 90] },
  disk: { label: 'Disk', icon: 'disk', cls: 'g-disk', from: '#f59e0b', to: '#f97316', th: [85, 95] },
  swap: { label: 'Swap', icon: 'swap', cls: 'g-swap', from: '#ec4899', to: '#8b5cf6', th: [80, 90] },
};

function svgEl(tag, attrs) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}

// A ring gauge with a gradient stroke. Pure SVG: a few hundred bytes of DOM.
function arc(key, pct, { size = 56, stroke = 7, from, to, track } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' });
  const defs = svgEl('defs');
  const lg = svgEl('linearGradient', { id: `gr-${key}`, x1: '0', y1: '0', x2: '1', y2: '1' });
  lg.append(svgEl('stop', { offset: '0%', 'stop-color': from }), svgEl('stop', { offset: '100%', 'stop-color': to }));
  defs.append(lg);
  const bg = svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: track || cssVar('--surface-2'), 'stroke-width': stroke });
  const fg = svgEl('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: `url(#gr-${key})`, 'stroke-width': stroke, 'stroke-linecap': 'round', 'stroke-dasharray': `${(Math.max(0, Math.min(100, pct || 0)) / 100) * c} ${c}`, 'data-c': c });
  fg.style.transition = 'stroke-dasharray .8s cubic-bezier(.2,.8,.2,1)';
  svg.append(defs, bg, fg);
  return svg;
}

function gauge(key, val, sub) {
  const g = GAUGE[key];
  const lvl = val == null ? '' : val >= g.th[1] ? ' crit' : val >= g.th[0] ? ' warn' : '';
  return h('div', { class: `card gauge ${g.cls}${lvl}`, 'data-gauge': key },
    h('div', { class: 'gh' }, h('span', { class: 'chip' }, icon(g.icon)), h('span', { class: 'k' }, g.label)),
    h('div', { class: 'body' },
      h('div', { class: 'v num' }, val == null ? '—' : Math.round(val), h('small', null, '%')),
      h('div', { class: 'arc' }, arc(key, val, { from: g.from, to: g.to }))),
    h('div', { class: 'sub' }, sub || ''),
    h('div', { class: 'spark' }, sparkline(key, S.ring.slice(-90).map((r) => r[key]), { from: g.from, to: g.to })));
}

function paintGauge(key, val, sub) {
  const el = document.querySelector(`[data-gauge="${key}"]`);
  if (!el) return;
  const g = GAUGE[key];
  el.classList.toggle('warn', val != null && val >= g.th[0] && val < g.th[1]);
  el.classList.toggle('crit', val != null && val >= g.th[1]);
  el.querySelector('.v').firstChild.textContent = val == null ? '—' : Math.round(val);
  el.querySelector('.sub').textContent = sub || '';
  const fg = el.querySelector('circle[data-c]');
  if (fg) { const c = Number(fg.getAttribute('data-c')); fg.setAttribute('stroke-dasharray', `${(Math.max(0, Math.min(100, val || 0)) / 100) * c} ${c}`); }
  const sp = el.querySelector('.spark');
  if (sp) sp.replaceChildren(sparkline(key, S.ring.slice(-90).map((r) => r[key]), { from: g.from, to: g.to }));
}

function netGauge(l) {
  return h('div', { class: 'card gauge g-net', 'data-gauge': 'net' },
    h('div', { class: 'gh' }, h('span', { class: 'chip' }, icon('net')), h('span', { class: 'k' }, 'Network')),
    h('div', { class: 'body', style: { display: 'block' } },
      h('div', { class: 'v num', style: { fontSize: '19px' }, id: 'net-in' }, `↓ ${fmt.rate(l.rx)}`),
      h('div', { class: 'num ink2', style: { fontSize: '15px', fontWeight: 650, marginTop: '4px' }, id: 'net-out' }, `↑ ${fmt.rate(l.tx)}`)),
    h('div', { class: 'sub' }, 'in / out, right now'));
}

function heroCard(d, l) {
  const score = d.health.score;
  const apps = d.apps.filter((a) => a.kind === 'app' && a.watched !== false);
  const up = apps.filter((a) => a.status === 'up' || a.status === 'slow').length;
  const down = apps.filter((a) => a.status === 'down').length;
  const mood = score >= 85 && !down ? 'ok' : score >= 60 ? 'warn' : 'bad';
  const headline = mood === 'ok' ? 'All systems normal' : down ? `${down} app${down > 1 ? 's' : ''} down` : 'Needs attention';
  const ring = h('div', { class: 'score-ring' },
    arc('hero', score, { size: 92, stroke: 9, from: '#ffffff', to: '#c7d2fe', track: 'rgba(255,255,255,.22)' }),
    h('div', { class: 'n' }, h('div', null, String(score), h('small', null, 'health'))));
  const srv = d.server || {};
  return h('div', { class: `hero ${mood}` },
    ring,
    h('div', null,
      h('div', { class: 't1' }, srv.hostname || 'Server'),
      h('div', { class: 't2' }, headline),
      h('div', { class: 't3' }, d.health.why.length ? d.health.why.join(' · ') : 'CPU, memory, disk and every app are within limits.')),
    h('div', { class: 'facts' },
      h('div', null, h('span', { class: `live-dot`, id: 'hero-live' }, S.streamOk ? 'Live' : 'Connecting')),
      h('div', null, h('b', null, `${up}/${apps.length}`), ' apps up'),
      d.online != null ? h('div', null, h('a', { href: '#/signins', class: 'hero-link' }, h('b', null, String(d.online)), d.online === 1 ? ' person online' : ' people online')) : null,
      h('div', null, 'Up ', h('b', { id: 'hero-uptime' }, fmt.dur(((l && l.uptime) || 0) * 1000))),
      srv.distro ? h('div', null, srv.distro) : null));
}

// Up, then down, then the rest — each alphabetical.
function groupApps(list) {
  const by = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const st = (a) => (a.summary ? a.summary.status : a.status);
  const off = (a) => (a.summary ? a.summary.watched : a.watched) === false;
  const on = list.filter((a) => !off(a));
  return {
    up: on.filter((a) => ['up', 'slow'].includes(st(a))).sort(by),
    down: on.filter((a) => st(a) === 'down').sort(by),
    other: on.filter((a) => !['up', 'slow', 'down'].includes(st(a))).sort(by),
    off: list.filter(off).sort(by),
  };
}

const AVATAR_GRADS = [
  'linear-gradient(135deg,#6366f1,#a855f7)', 'linear-gradient(135deg,#06b6d4,#3b82f6)', 'linear-gradient(135deg,#10b981,#06b6d4)',
  'linear-gradient(135deg,#f59e0b,#f97316)', 'linear-gradient(135deg,#ec4899,#8b5cf6)', 'linear-gradient(135deg,#0ea5e9,#6366f1)',
  'linear-gradient(135deg,#84cc16,#10b981)', 'linear-gradient(135deg,#f43f5e,#f59e0b)',
];
function avatar(name) {
  let n = 0;
  for (const ch of String(name)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  const initials = String(name).replace(/\(.*?\)/g, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  return h('span', { class: 'av', style: { '--av': AVATAR_GRADS[n % AVATAR_GRADS.length] } }, initials);
}

// Status-page style strip: one bar per recent check, newest on the right.
function uptimeStrip(hist, n = 30) {
  const pad = Array(Math.max(0, n - (hist || []).length)).fill(null);
  return h('div', { class: 'strip', title: hist && hist.length ? `${hist.filter(Boolean).length}/${hist.length} recent checks passed` : 'No checks yet' },
    [...pad, ...(hist || [])].map((v) => h('i', { class: v == null ? 'na' : v ? 'ok' : 'bad' })));
}

// A tiny area chart from the live ring, drawn as one SVG path.
function sparkline(key, values, { from, to, w = 120, h: ht = 30 } = {}) {
  const vals = values.filter((v) => v != null);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', class: 'spark-svg', 'aria-hidden': 'true' });
  if (vals.length < 2) return svg;
  const max = Math.max(100, ...vals) || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, ht - ((v == null ? 0 : v) / max) * (ht - 2) - 1]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const defs = svgEl('defs');
  const lg = svgEl('linearGradient', { id: `sp-${key}`, x1: '0', y1: '0', x2: '0', y2: '1' });
  lg.append(svgEl('stop', { offset: '0%', 'stop-color': from, 'stop-opacity': '0.35' }), svgEl('stop', { offset: '100%', 'stop-color': to, 'stop-opacity': '0' }));
  defs.append(lg);
  svg.append(defs,
    svgEl('path', { d: `${line}L${w},${ht}L0,${ht}Z`, fill: `url(#sp-${key})` }),
    svgEl('path', { d: line, fill: 'none', stroke: from, 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  return svg;
}

function appSection(title, list, cls, render) {
  if (!list.length) return null;
  return [
    h('div', { class: 'sec-h' }, h('h2', null, title), h('span', { class: `count ${cls}` }, list.length)),
    h('div', { class: 'app-grid' }, list.map(render)),
  ];
}

// An iOS-style on/off switch. Inside a card link it must not follow the link.
function toggleSwitch(on, onChange, { label = '', disabled = false } = {}) {
  const b = h('button', { type: 'button', role: 'switch', class: `switch${on ? ' on' : ''}`, 'aria-checked': String(!!on), 'aria-label': label, title: label, disabled });
  b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!b.disabled) onChange(!on, b); });
  return b;
}

// Monitoring on/off for one app. Off asks why (kept with the app); on is instant.
function setWatch(a, on) {
  const go = async (note) => {
    await api(`/apps/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { watch: on, note } });
    toast(on ? `Watching ${a.name} again` : `${a.name} switched off — no checks, no alerts`);
    softRefresh();
  };
  if (on) return go().catch((e) => toast(e.message));
  const note = h('input', { type: 'text', id: 'wn', maxlength: 140, placeholder: 'e.g. not live yet' });
  const err = h('div', { class: 'err' });
  modal(`Stop watching ${a.name}?`, h('div', { class: 'form' },
    h('p', { class: 'small ink2', style: { margin: 0 } }, 'Pulse will stop checking it and won\u2019t alert on it. It stays listed under “Switched off”, and one tap turns it back on.'),
    h('label', { class: 'field', for: 'wn' }, 'Why? (optional)', note), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => { try { await go(note.value.trim()); close(); } catch (e) { err.textContent = e.message; } } }, 'Switch off'),
  ]);
  setTimeout(() => note.focus(), 50);
}
function watchSwitch(a) {
  const on = (a.summary ? a.summary.watched : a.watched) !== false;
  return can('monitor.manage') ? toggleSwitch(on, (v) => setWatch(a, v), { label: on ? `Monitoring ${a.name}: on` : `Monitoring ${a.name}: off` }) : null;
}

// The "Switched off" row: quiet chips, each with its own switch.
function offSection(list) {
  if (!list.length) return null;
  return [
    h('div', { class: 'sec-h' }, h('h2', null, 'Switched off'), h('span', { class: 'count' }, list.length), h('span', { class: 'tiny muted' }, 'not checked · no alerts')),
    h('div', { class: 'off-row' }, list.map((a) => {
      const w = a.summary ? a.summary.watchOff : a.watchOff;
      return h('a', { class: 'off-chip', href: `#/apps/${encodeURIComponent(a.id)}`, title: w && w.note ? w.note : 'Monitoring switched off' },
        avatar(a.name), h('span', { class: 'nm' }, a.name), w && w.note ? h('span', { class: 'why' }, w.note) : null, watchSwitch(a));
    })),
  ];
}

const roleName = (r) => ({ owner: 'Owner', admin: 'Admin', viewer: 'Viewer' }[r] || r || '');

route(/^\/$/, async () => {
  const d = await load('/overview');
  if (!S.ring.length) { try { const lv = await api('/live'); S.ring = lv.ring || []; } catch { /* offline */ } }
  S.overview = d;
  S.counts = d.alerts;
  S.openErrors = d.errors || 0;
  if (d.home) setHome(d.home);
  const l = S.latest || d.latest || {};
  const cores = (d.server && d.server.cores) || '?';

  // 1. Health first: the hero and the gauges.
  const gauges = h('div', { class: 'gauges' },
    gauge('cpu', l.cpu, `${cores} cores · load ${l.load1 ?? '—'}`),
    gauge('mem', l.mem, l.memTotal ? `${fmt.bytes(l.memUsed)} of ${fmt.bytes(l.memTotal)}` : ''),
    gauge('disk', l.disk, diskSub(l, d.forecast)),
    gauge('swap', l.swap, l.swapTotal ? `${fmt.bytes(l.swapUsed)} of ${fmt.bytes(l.swapTotal)}` : 'no swap'),
    netGauge(l));

  // 2. Then what needs attention.
  const attn = [];
  if (d.maintenance) attn.push(h('div', { class: 'attn warn' }, h('span', { class: 'ic' }, '⏸'), h('div', { class: 'tx' }, h('b', null, `Maintenance until ${fmt.time(Date.parse(d.maintenance.until))}`), h('span', null, d.maintenance.note || 'Service alerts are held; access alerts still go out.'))));
  for (const a of d.activeAlerts.slice(0, 4)) {
    attn.push(h('a', { class: `attn${a.severity === 'critical' ? '' : ' warn'}`, href: `#/alerts/${a.id}` },
      h('span', { class: 'ic' }, '!'),
      h('div', { class: 'tx' }, h('b', null, a.title), h('span', null, `${(a.detail && a.detail.summary) || ''}${(a.detail && a.detail.summary) ? ' · ' : ''}${fmt.ago(a.updated_at)}`)),
      h('span', { class: 'go' }, '›')));
  }
  if (d.activeAlerts.length > 4) attn.push(h('a', { href: '#/alerts', class: 'small', style: { paddingLeft: '4px' } }, `All ${d.activeAlerts.length} open alerts →`));
  if (!d.scan.ts) attn.push(h('div', { class: 'attn warn' }, h('span', { class: 'ic' }, '…'), h('div', { class: 'tx' }, h('b', null, 'Waiting for the first inventory scan'), h('span', null, 'Ports and keys are not attributed yet.'))));

  // 3. Chart.
  const chartEl = h('div', { class: 'chart' });
  let range = '1h';
  const chartCard = h('div', { class: 'card', style: { marginTop: '14px' } },
    h('div', { class: 'card-h' }, h('h2', null, 'CPU and memory'), rangePicker(range, [['15m', 'Live'], ['1h', '1 h'], ['24h', '24 h'], ['7d', '7 d']], async (r) => { range = r; await loadChart(); })),
    chartEl, h('div', { class: 'legend-note' }, 'Dashed lines mark releases.'));
  let chart = null;
  async function loadChart() {
    let m = range === '15m' ? { rows: S.ring.length ? S.ring : (await api('/metrics?range=15m')).rows, deploys: d.deploys } : await load(`/metrics?range=${range}`);
    if (range !== '15m' && m.rows.length < 3 && S.ring.length > 2) m = { ...m, rows: S.ring };
    if (!chart) chart = lineChart(chartEl, { series: [{ key: 'cpu', label: 'CPU', color: '--series-1' }, { key: 'mem', label: 'Memory', color: '--series-2' }], rows: m.rows, deploys: m.deploys, yMax: 100, yFmt: (v) => `${Math.round(v)}%` });
    else chart.update(m.rows, m.deploys);
  }

  // 4. Apps: up, then down, each A–Z.
  const g = groupApps(d.apps.filter((a) => a.kind === 'app'));
  const dbs = d.apps.filter((a) => a.kind === 'database');

  const events = h('ul', { class: 'list' }, d.events.length ? d.events.slice(0, 12).map(eventItem) : h('li', { class: 'empty' }, 'Quiet. Nothing has happened in the last 24 hours.'));
  const findings = h('ul', { class: 'list' }, d.findings.length ? d.findings.map((f) => h('li', null, h('span', { class: `dot ${f.severity}` }), h('div', { class: 'what small' }, f.title))) : h('li', { class: 'empty' }, 'Nothing to tidy up.'));

  show(shell('overview', [
    pageTop('Overview'),
    offlineNote(d),
    heroCard(d, l),
    gauges,
    attn.length ? h('div', { class: 'attention' }, attn) : null,
    chartCard,
    appSection('Apps up', g.up, 'up', appRow),
    appSection('Apps down', g.down, 'down', appRow),
    appSection('Not running', g.other, '', appRow),
    offSection(g.off),
    dbs.length ? [h('div', { class: 'sec-h' }, h('h2', null, 'Databases'), h('span', { class: 'count' }, dbs.length)),
      h('div', { class: 'row wrap' }, dbs.map((x) => h('a', { class: 'pill', href: `#/apps/${encodeURIComponent(x.id)}`, style: { padding: '6px 12px' } }, x.name, ' ', statusBadge(x.status))))] : null,
    h('div', { class: 'grid g2', style: { marginTop: '22px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Timeline'), h('span', { class: 'tiny muted' }, 'last 24 h')), events),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'To tidy up')), findings)),
  ]));
  await loadChart();

  onLive = (s) => {
    paintGauge('cpu', s.cpu, `${cores} cores · load ${s.load1}`);
    paintGauge('mem', s.mem, `${fmt.bytes(s.memUsed)} of ${fmt.bytes(s.memTotal)}`);
    paintGauge('disk', s.disk, diskSub(s, d.forecast));
    paintGauge('swap', s.swap, s.swapTotal ? `${fmt.bytes(s.swapUsed)} of ${fmt.bytes(s.swapTotal)}` : 'no swap');
    const ni = document.getElementById('net-in'); if (ni) ni.textContent = `↓ ${fmt.rate(s.rx)}`;
    const no = document.getElementById('net-out'); if (no) no.textContent = `↑ ${fmt.rate(s.tx)}`;
    const up = document.getElementById('hero-uptime'); if (up) up.textContent = fmt.dur(s.uptime * 1000);
    const lv = document.getElementById('hero-live'); if (lv) lv.textContent = 'Live';
    if (range === '15m' && chart) chart.update(S.ring);
  };
  // A status change moves an app between groups, so redraw rather than patch.
  const before = JSON.stringify(d.apps.map((a) => [a.id, a.status]));
  onChecks = (c) => {
    const now = JSON.stringify(d.apps.map((a) => [a.id, (c.results.find((r) => r.app === a.id) || a).status]));
    if (now !== before) softRefresh();
    for (const r of c.results) {
      const row = document.querySelector(`[data-app="${CSS.escape(r.app)}"] [data-ms]`);
      if (row) row.textContent = r.ok ? fmt.ms(r.ms) : (r.error || 'failing');
    }
  };
});

function diskSub(l, f) {
  const free = l.disks && l.disks[0] ? `${fmt.bytes(l.disks[0].size - l.disks[0].used)} free` : '';
  return f ? `${free} · full in ~${f.daysLeft} days` : free;
}


// How Pulse found an app on the server — nothing about an app is typed in.
function foundAs(a) {
  if (a.runner === 'pm2') return `PM2 app "${a.runnerName}"${a.runnerUnit ? ` (in ${a.runnerUnit})` : ''}`;
  if (a.runner === 'docker') return `Docker container "${a.runnerName}"`;
  if (a.runner === 'process') return `${a.runnerName || 'a program'} running from ${a.cwd}`;
  if ((a.units || []).length) return `its service, ${a.units.map((u) => u.unit).join(', ')}`;
  if ((a.domains || []).length) return 'its Apache site';
  return 'a listening port';
}

function appRow(a) {
  const dom = (a.domains || []).find((x) => !x.startsWith('*')) || (a.ports && a.ports.length ? `port ${a.ports.join(', ')}` : '');
  return h('a', { class: `app${a.status === 'down' ? ' down' : ''}${['stopped', 'unknown'].includes(a.status) ? ' muted' : ''}`, href: `#/apps/${encodeURIComponent(a.id)}`, 'data-app': a.id },
    h('div', { class: 'nm' }, avatar(a.name), h('span', null, a.name)),
    statusBadge(a.status),
    h('div', { class: 'meta' },
      h('span', null, dom),
      a.liveLine ? h('span', { class: 'pill live' }, `live: ${a.liveLine}`) : null,
      a.version ? h('span', { class: 'pill' }, `v${String(a.version).replace(/^v/, '')}`) : null,
      h('span', { 'data-ms': '' }, a.ok ? fmt.ms(a.ms) : (a.error || '')),
      trafficBits(a),
      a.kind === 'app' && !a.hasBackups ? h('span', { class: 'pill warn' }, 'no backups') : null),
    a.kind === 'app' ? uptimeStrip(a.history) : null);
}

// "1,204 req/h · 0.4% errors" and a pill for errors in the app's own log.
function trafficBits(s) {
  const out = [];
  if (s.requests1h) {
    const pct = (s.errors5xx1h / s.requests1h) * 100;
    out.push(h('span', null, `${s.requests1h.toLocaleString()} req/h${s.errors5xx1h ? ` · ${pct < 1 ? pct.toFixed(1) : Math.round(pct)}% 5xx` : ''}`));
  }
  if (s.logErrors1h) out.push(h('span', { class: 'pill warn' }, `${s.logErrors1h} log error${s.logErrors1h === 1 ? '' : 's'} /h`));
  return out;
}

function eventItem(e) {
  const cls = e.kind === 'deploy' ? 'deploy' : e.severity;
  return h('li', null, h('span', { class: `dot ${cls}` }), h('div', { class: 'what' }, h('div', { class: 'small' }, e.title), h('div', { class: 'tiny muted' }, `${fmt.time(e.ts)} · ${e.kind}`)));
}

// ===================================================================== Server
route(/^\/server$/, async () => {
  const [ov, live] = await Promise.all([load('/overview'), load('/live')]);
  S.overview = ov;
  if (!S.ring.length && live.ring) S.ring = live.ring;
  if (!S.processes.length && live.processes) S.processes = live.processes;
  const l = S.latest || live.latest || {};
  const srv = ov.server || {};
  let range = '15m';

  const specs = [
    { id: 'cpu', title: 'CPU', series: [{ key: 'cpu', label: 'CPU', color: '--series-1' }], yMax: 100, yFmt: (v) => `${Math.round(v)}%` },
    { id: 'mem', title: 'Memory and swap', series: [{ key: 'mem', label: 'Memory', color: '--series-1' }, { key: 'swap', label: 'Swap', color: '--series-2' }], yMax: 100, yFmt: (v) => `${Math.round(v)}%` },
    { id: 'net', title: 'Network', series: [{ key: 'rx', label: 'In', color: '--series-1' }, { key: 'tx', label: 'Out', color: '--series-2' }], yFmt: (v) => fmt.rate(v) },
    { id: 'io', title: 'Disk activity', series: [{ key: 'rd', label: 'Read', color: '--series-1' }, { key: 'wr', label: 'Write', color: '--series-2' }], yFmt: (v) => fmt.rate(v) },
  ];
  const els = Object.fromEntries(specs.map((s) => [s.id, h('div', { class: 'chart' })]));
  const charts = {};
  async function loadCharts() {
    let m = range === '15m' ? { rows: S.ring, deploys: ov.deploys } : await load(`/metrics?range=${range}`);
    if (range !== '15m' && m.rows.length < 3 && S.ring.length > 2) m = { ...m, rows: S.ring };
    for (const s of specs) {
      if (!charts[s.id]) charts[s.id] = lineChart(els[s.id], { series: s.series, rows: m.rows, deploys: m.deploys, yMax: s.yMax, yFmt: s.yFmt, height: 180 });
      else charts[s.id].update(m.rows, m.deploys);
    }
  }

  const cores = h('div', { class: 'cores' });
  function paintCores(s) {
    cores.replaceChildren(...(s.cores || []).map((c, i) => h('div', { class: 'core' }, h('div', { class: 'row' }, h('span', null, `Core ${i + 1}`), h('span', { class: 'spacer' }), h('span', { class: 'num' }, `${Math.round(c)}%`)), meter(c, 80, 95))));
  }
  const disks = h('div');
  function paintDisks(s) {
    disks.replaceChildren(h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Mount'), h('th', null, 'Device'), h('th', { class: 'n' }, 'Used'), h('th', { class: 'n' }, 'Free'), h('th', { class: 'n' }, 'Size'))),
      h('tbody', null, (s.disks || []).map((d) => h('tr', null, h('td', null, d.mount), h('td', { class: 'mono' }, d.fs), h('td', { class: 'n' }, `${d.pct}%`), h('td', { class: 'n' }, fmt.bytes(d.size - d.used)), h('td', { class: 'n' }, fmt.bytes(d.size))))))));
  }
  const procs = h('div');
  let procBy = 'cpu';
  const procSeg = h('div', { class: 'seg' }, [['cpu', 'By CPU'], ['mem', 'By memory']].map(([k, t]) => h('button', { type: 'button', class: k === procBy ? 'on' : null, onclick: async (e) => {
    procBy = k; e.target.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
    if (k === 'mem') await paintMem(); else paintProcs();
  } }, t)));
  // Memory: what is holding it right now, and the service it belongs to.
  async function paintMem() {
    procs.replaceChildren(h('div', { class: 'empty' }, 'Checking…'));
    try {
      const r = await api('/server/top');
      const L = r.latest || {};
      procs.replaceChildren(
        h('p', { class: 'small ink2', style: { margin: '0 0 8px' } }, `Memory ${L.mem == null ? '—' : `${Math.round(L.mem)}%`} used · swap ${L.swap == null ? '—' : `${Math.round(L.swap)}%`}${L.swapTotal ? ` (${fmt.bytes(L.swapUsed)} of ${fmt.bytes(L.swapTotal)})` : ''}. Swap that is full but not busy is fine; slow apps plus high memory is the warning sign.`),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Program'), h('th', null, 'Service'), h('th', { class: 'n' }, 'Memory'), h('th', { class: 'n' }, 'CPU'), h('th', { class: 'n' }, 'PID'))),
          h('tbody', null, r.processes.map((p) => h('tr', null, h('td', null, p.name), h('td', { class: 'muted' }, p.unit ? p.unit.replace(/\.service$/, '') : '—'), h('td', { class: 'n' }, fmt.bytes(p.rss)), h('td', { class: 'n' }, `${p.cpu}%`), h('td', { class: 'n muted' }, p.pid)))))));
    } catch (e) { procs.replaceChildren(h('div', { class: 'err' }, e.message)); }
  }
  function paintProcs() {
    if (procBy !== 'cpu') return;
    procs.replaceChildren(h('div', { class: 'tablewrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Process'), h('th', null, 'User'), h('th', { class: 'n' }, 'CPU'), h('th', { class: 'n' }, 'Memory'), h('th', { class: 'n' }, 'PID'))),
      h('tbody', null, S.processes.map((p) => h('tr', null, h('td', null, h('div', null, p.name), h('div', { class: 'tiny muted mono' }, p.command)), h('td', null, p.user), h('td', { class: 'n' }, `${p.cpu}%`), h('td', { class: 'n' }, fmt.bytes(p.rss)), h('td', { class: 'n muted' }, p.pid)))))));
  }

  show(shell('server', [
    pageTop('Server', rangePicker(range, [['15m', 'Live'], ['1h', '1 h'], ['6h', '6 h'], ['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d']], async (r) => { range = r; await loadCharts(); })),
    offlineNote(live),
    h('div', { class: 'grid g4' },
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Load (1 / 5 / 15 min)'), h('div', { class: 'v num', id: 'load' }, (l.load || [l.load1]).map((x) => (x == null ? '—' : x)).join(' / ')), h('div', { class: 'sub' }, `${srv.cores || '?'} cores — above ${srv.cores || 2} means queued work`)),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Up for'), h('div', { class: 'v num', id: 'uptime' }, fmt.dur((l.uptime || 0) * 1000)), h('div', { class: 'sub' }, srv.kernel ? `kernel ${srv.kernel}` : '')),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Swap'), h('div', { class: 'v num', id: 'swapv' }, l.swap == null ? '—' : Math.round(l.swap), h('small', null, '%')), h('div', { class: 'sub', id: 'swaps' }, l.swapTotal ? `${fmt.bytes(l.swapUsed)} of ${fmt.bytes(l.swapTotal)}` : 'no swap')),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Network now'), h('div', { class: 'v num small', id: 'netv', style: { fontSize: '20px' } }, `↓ ${fmt.rate(l.rx)}  ↑ ${fmt.rate(l.tx)}`), h('div', { class: 'sub' }, srv.cpu || ''))),
    h('div', { class: 'grid g2', style: { marginTop: '14px' } }, specs.map((s) => h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, s.title)), els[s.id]))),
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Per core')), cores),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Disks')), disks)),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Top processes'), procSeg), procs),
  ]));
  paintCores(l); paintDisks(l); paintProcs();
  await loadCharts();
  onLive = (s) => {
    paintCores(s);
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.firstChild.textContent = v; };
    set('load', (s.load || []).join(' / '));
    set('uptime', fmt.dur(s.uptime * 1000));
    set('swapv', Math.round(s.swap || 0));
    const sw = document.getElementById('swaps'); if (sw && s.swapTotal) sw.textContent = `${fmt.bytes(s.swapUsed)} of ${fmt.bytes(s.swapTotal)}`;
    const nv = document.getElementById('netv'); if (nv) nv.textContent = `↓ ${fmt.rate(s.rx)}  ↑ ${fmt.rate(s.tx)}`;
    if (range === '15m') for (const c of Object.values(charts)) c.update(S.ring);
  };
  onProcesses = paintProcs;
});

// ===================================================================== Apps
route(/^\/apps$/, async () => {
  const d = await load('/apps');
  const certBy = {};
  for (const c of d.certs || []) (certBy[c.app] = certBy[c.app] || []).push(c);
  const card = (a) => {
    const s = a.summary;
    const certs = certBy[a.id] || [];
    const soonest = certs.filter((c) => c.daysLeft != null).sort((x, y) => x.daysLeft - y.daysLeft)[0];
    const off = s.watched === false;
    if (off) {
      const w = s.watchOff || {};
      return h('a', { class: 'app off', href: `#/apps/${encodeURIComponent(a.id)}`, 'data-app': a.id },
        h('div', { class: 'nm' }, avatar(a.name), h('span', null, a.name)), h('div', { class: 'app-r' }, statusBadge('off'), watchSwitch(a)),
        h('div', { class: 'meta' },
          h('span', null, (a.domains || []).filter((x) => !x.startsWith('*'))[0] || `port ${a.ports.join(', ') || '?'}`),
          h('span', null, `Switched off${w.at ? ` ${fmt.ago(Date.parse(w.at))}` : ''}${w.by ? ` by ${w.by.split('@')[0]}` : ''}`),
          w.note ? h('span', { class: 'pill' }, w.note) : null));
    }
    return h('a', { class: `app${s.status === 'down' ? ' down' : ''}${['stopped', 'unknown'].includes(s.status) ? ' muted' : ''}`, href: `#/apps/${encodeURIComponent(a.id)}`, 'data-app': a.id },
      h('div', { class: 'nm' }, avatar(a.name), h('span', null, a.name)), h('div', { class: 'app-r' }, statusBadge(s.status), watchSwitch(a)),
      h('div', { class: 'meta' },
        h('span', null, (a.domains || []).filter((x) => !x.startsWith('*'))[0] || `port ${a.ports.join(', ') || '?'}`),
        a.ports.length ? h('span', null, `:${a.checkPort || a.ports[0]}`) : null,
        a.lines && a.lines.length ? h('span', null, a.lines.map((l) => `${l.line}${l.line === a.liveLine ? ' (live)' : ''}`).join(' · ')) : null,
        h('span', { 'data-ms': '' }, s.ok ? fmt.ms(s.ms) : (s.error || '')),
        s.restarts ? h('span', null, `${s.restarts} restarts`) : null,
        trafficBits(s),
        soonest ? h('span', { class: soonest.daysLeft <= 14 ? 'pill warn' : null }, `cert ${soonest.daysLeft} d`) : null,
        s.dataBytes ? h('span', null, `${fmt.bytes(s.dataBytes)} of data`) : null,
        !a.hasBackups && (a.kind === 'app' || (a.listening && a.listening.length)) ? h('span', { class: 'pill warn' }, 'no backups') : a.hasBackups && !a.offsite && a.kind === 'app' ? h('span', { class: 'pill' }, 'not off-site') : null),
      uptimeStrip(s.history));
  };
  const apps = d.apps.filter((a) => a.kind === 'app');
  const dbs = d.apps.filter((a) => a.kind === 'database');
  show(shell('apps', [
    pageTop('Apps', h('span', { class: 'tiny muted' }, 'Found automatically · checked every 30 s')),
    offlineNote(d),
    can('monitor.manage') ? h('div', { class: 'hint-bar' }, h('span', { class: 'switch on demo', 'aria-hidden': 'true' }), h('span', null, 'Use the switch on a card to stop watching an app that isn\u2019t live yet. It moves to “Switched off” — no checks, no alerts — until you switch it back on.')) : null,
    apps.length ? null : h('div', { class: 'empty' }, 'No apps found yet.'),
    (() => { const g = groupApps(apps); return [appSection('Up', g.up, 'up', card), appSection('Down', g.down, 'down', card), appSection('Not running', g.other, '', card), appSection('Switched off', g.off, '', card)]; })(),
    (() => { const g = groupApps(dbs); return dbs.length ? [h('div', { class: 'sec-h', style: { marginTop: '30px' } }, h('h2', null, 'Databases'), h('span', { class: 'count' }, dbs.length)),
      h('div', { class: 'app-grid' }, [...g.up, ...g.down, ...g.other, ...g.off].map(card))] : null; })(),
    (d.hidden || []).length && can('monitor.manage') ? [h('div', { class: 'sec-h', style: { marginTop: '30px' } }, h('h2', null, 'Hidden'), h('span', { class: 'count' }, d.hidden.length)),
      h('div', { class: 'row wrap' }, d.hidden.map((x) => h('span', { class: 'pill', style: { padding: '6px 6px 6px 12px' } }, x.name, h('button', { class: 'btn small', onclick: async () => { try { await api(`/apps/${encodeURIComponent(x.id)}`, { method: 'PUT', body: { ignore: false } }); toast(`${x.name} is back`); render(); } catch (e) { toast(e.message); } } }, 'Show again'))))] : null,
  ]));
  onChecks = () => softRefresh();
});

route(/^\/apps\/(.+)$/, async (id) => {
  const d = await load(`/apps/${id}`);
  const a = d.app;
  const c = d.check || {};
  const rows = d.checks.map((x) => ({ ts: x.ts, ms: x.ok ? x.ms : null }));
  const up = d.checks.length ? Math.round((d.checks.filter((x) => x.ok).length / d.checks.length) * 1000) / 10 : null;
  const chartEl = h('div', { class: 'chart' });
  const trafficEl = h('div', { class: 'chart' });
  const hasTraffic = (d.traffic || []).length > 0;
  const nameIn = h('input', { type: 'text', value: a.name, id: 'appname' });
  const pathIn = h('input', { type: 'text', value: (a.healthPaths || [''])[0] || '', placeholder: '/healthz', id: 'apppath' });

  show(shell('apps', [
    pageTop(a.name, statusBadge(a.watched === false ? 'off' : (c.status || 'unknown')), can('monitor.manage') ? h('label', { class: 'switch-label' }, watchSwitch(a), h('span', null, a.watched === false ? 'Not watching' : 'Watching')) : null),
    offlineNote(d),
    a.watched === false ? h('div', { class: 'banner info' }, h('div', { class: 'b-body' }, h('strong', null, 'Monitoring is switched off'),
      `Pulse isn\u2019t checking ${a.name} or alerting on it${a.watchOff && a.watchOff.note ? ` — ${a.watchOff.note}` : ''}. Switch it on when it goes live.`)) : null,
    c.ok === false && a.watched !== false ? h('div', { class: 'banner critical' }, h('div', { class: 'b-body' }, h('strong', null, 'Failing'), c.error || '', h('div', { class: 'tiny' }, `${c.failures} check${c.failures === 1 ? '' : 's'} in a row`))) : null,
    a.kind === 'app' && can('monitor.manage') ? appActions(a) : null,
    h('div', { class: 'grid g4' },
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Response'), h('div', { class: 'v num' }, c.ok ? fmt.ms(c.ms) : '—'), h('div', { class: 'sub' }, c.path ? `GET ${c.path} on :${c.port}` : c.port ? `TCP :${c.port}` : '')),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Up, last 24 h'), h('div', { class: 'v num' }, up == null ? '—' : up, up == null ? null : h('small', null, '%')), h('div', { class: 'sub' }, `${d.checks.length} checks`)),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Restarts'), h('div', { class: 'v num' }, c.restarts ?? '—'), h('div', { class: 'sub' }, 'since the unit started')),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Memory'), h('div', { class: 'v num', style: { fontSize: '22px' } }, fmt.bytes(c.memory)), h('div', { class: 'sub' }, 'as systemd counts it'))),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Response time, 24 h'), h('span', { class: 'tiny muted' }, 'gaps are failed checks')), chartEl),
    a.kind === 'app' ? h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Traffic, 24 h'), h('span', { class: 'tiny muted' }, 'requests per 5 minutes, from Apache')), hasTraffic ? trafficEl : h('div', { class: 'chart-empty' }, a.domains.length ? 'No requests recorded yet.' : 'Not served through Apache.')),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Errors in its log'), h('a', { class: 'tiny', href: `#/errors?app=${encodeURIComponent(a.id)}` }, 'All errors →')),
        (d.errorGroups || []).length ? h('div', { class: 'err-mini' }, d.errorGroups.map((g) => h('a', { class: `em-row st-${g.status}`, href: `#/errors/${g.id}` },
          h('div', { class: 'em-t' }, h('b', null, g.title), h('span', null, g.message || '')),
          errBars(g.trend, 'small'),
          h('div', { class: 'em-n' }, h('b', null, String(g.last24h)), h('span', null, fmt.ago(g.last_seen))))))
          : (d.errors || []).length ? h('ul', { class: 'list' }, d.errors.map((e) => h('li', null, h('span', { class: 'when' }, fmt.short(e.ts)), h('div', { class: 'what mono', style: { fontSize: '12px' } }, e.message)))) : h('div', { class: 'empty' }, 'None recorded.'))) : null,
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Details')),
        h('dl', { class: 'kv' },
          h('dt', null, 'Kind'), h('dd', null, a.kind),
          d.version ? [h('dt', null, 'Version'), h('dd', null, h('b', { class: 'num' }, d.version.version), d.version.prev ? h('span', { class: 'muted' }, ` · updated from ${d.version.prev} ${fmt.ago(d.version.changedAt)}`) : null)] : null,
          h('dt', null, 'Found as'), h('dd', null, foundAs(a)),
          h('dt', null, 'Domains'), h('dd', null, a.domains.join(', ') || '—'),
          h('dt', null, 'Ports'), h('dd', { class: 'num' }, a.ports.join(', ') || '—'),
          h('dt', null, 'Services'), h('dd', null, a.units.map((u) => `${u.unit} (${u.active})`).join(', ') || '—'),
          a.lines.length ? [h('dt', null, 'Lines'), h('dd', null, (c.lines || a.lines).map((l) => h('div', null, `${l.line} :${l.port || '—'} `, l.live || l.line === a.liveLine ? h('span', { class: 'pill live' }, 'live') : null, ' ', l.ok === false ? h('span', { class: 'pill' }, 'not answering') : l.ok ? h('span', { class: 'pill' }, fmt.ms(l.ms)) : null)))] : null,
          h('dt', null, 'Backups'), h('dd', null, a.backups ? `newest ${fmt.ago(a.backups.newestTs)} (${a.backups.dir})${a.offsite ? ' · off-site nightly' : ' · not off-site'} · ` : 'none found · ', h('a', { href: `#/backups` }, 'Backups →')),
          d.certs.length ? [h('dt', null, 'Certificates'), h('dd', null, d.certs.map((x) => h('div', null, `${x.domain}: ${x.daysLeft == null ? (x.error || '?') : `${x.daysLeft} days left`}`)))] : null)),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Recent')),
        h('ul', { class: 'list' }, [...d.events].slice(0, 12).map(eventItem).concat(d.events.length ? [] : [h('li', { class: 'empty' }, 'Nothing recorded yet.')])))),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('details', null, h('summary', null, 'Name and health check'),
      h('div', { class: 'form', style: { marginTop: '12px', maxWidth: '420px' } },
        h('label', { class: 'field', for: 'appname' }, 'Display name', nameIn),
        h('label', { class: 'field', for: 'apppath' }, 'Health path (blank = try /healthz, /api/healthz, then /)', pathIn),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: async () => { try { await api(`/apps/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { name: nameIn.value, healthPath: pathIn.value } }); toast('Saved'); render(); } catch (e) { toast(e.message); } } }, 'Save'),
          h('button', { class: 'btn', onclick: async () => { if (!confirm(`Hide ${a.name} completely? Use the switch instead if it just isn\u2019t live yet. Hidden apps can be shown again from the bottom of the Apps page.`)) return; try { await api(`/apps/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { ignore: true } }); location.hash = '#/apps'; } catch (e) { toast(e.message); } } }, 'Hide this app'))))),
  ]));
  lineChart(chartEl, { series: [{ key: 'ms', label: 'Response', color: '--series-1' }], rows, deploys: d.deploys, yFmt: (v) => fmt.ms(v), height: 180, emptyText: 'No successful checks in the last 24 hours.' });
  if (hasTraffic) lineChart(trafficEl, { series: [{ key: 'n', label: 'Requests', color: '--series-1' }, { key: 's5', label: 'Server errors (5xx)', color: '--series-2' }], rows: d.traffic, deploys: d.deploys, yFmt: (v) => `${Math.round(v)}`, height: 180 });
});

// ===================================================================== Access
route(/^\/access$/, async () => {
  const d = await load('/access');
  const grades = { urgent: ['Urgent', 'crit'], normal: ['Alerted', 'warn'], digest: ['Digest', ''], quiet: ['Quiet', ''], release: ['Release', 'live'] };
  const rows = d.events.map((e) => {
    const g = grades[e.grade] || [e.grade, ''];
    return h('li', null,
      h('span', { class: `dot ${e.grade === 'urgent' ? 'critical' : e.grade === 'normal' ? 'warning' : ''}` }),
      h('div', { class: 'what' },
        h('div', { class: 'small' }, accessTitle(e), ' ', h('span', { class: `pill ${g[1]}` }, g[0])),
        h('div', { class: 'tiny muted' }, `${fmt.time(e.ts, true)}${e.reason ? ` · ${e.reason}` : ''}`),
        e.fingerprint ? h('div', { class: 'fp muted' }, e.fingerprint) : null));
  });

  const srcList = h('ul', { class: 'list' }, d.sources.length ? d.sources.map((s) => h('li', null,
    h('div', { class: 'what' }, h('div', { class: 'small' }, h('strong', null, s.label), ' ', h('span', { class: 'pill' }, s.kind), s.expired ? h('span', { class: 'pill warn' }, 'expired') : s.expires_at ? h('span', { class: 'pill' }, `until ${new Date(s.expires_at).toLocaleDateString()}`) : null),
      h('div', { class: 'fp muted' }, s.value)),
    h('button', { class: 'btn small danger', onclick: () => withCode(`Remove "${s.label}" from the trusted list?`, (code) => api(`/trusted/${s.id}`, { method: 'DELETE', body: { code } })) }, 'Remove'))) : h('li', { class: 'empty' }, 'No trusted sources yet — every login will alert. Add your MacBook\'s key below.'));

  const keysOnServer = (d.keys || []).map((k) => {
    const trusted = d.sources.some((s) => s.kind === 'key' && s.value === k.fingerprint);
    return h('li', null, h('div', { class: 'what' }, h('div', { class: 'small' }, h('strong', null, k.user), ` · ${k.type || ''} · ${k.comment || ''} `, trusted ? h('span', { class: 'pill live' }, 'trusted') : h('span', { class: 'pill warn' }, 'not trusted')), h('div', { class: 'fp muted' }, k.fingerprint)),
      trusted ? null : h('button', { class: 'btn small', onclick: () => addTrusted({ kind: 'key', value: k.fingerprint, label: k.comment && k.comment.includes('MacBook') ? 'MacBook (deploy key)' : `${k.user} key` }) }, 'Trust'));
  });

  show(shell('access', [
    pageTop('Access', h('button', { class: 'btn', onclick: () => addTrusted({}) }, 'Add trusted source')),
    offlineNote(d),
    d.authWatch ? null : h('div', { class: 'banner warning' }, h('div', { class: 'b-body' }, h('strong', null, 'Not watching logins'), 'The journal follower is not running. Check that the pulse user is in the systemd-journal and adm groups.')),
    nowCard(),
    h('div', { class: 'grid g3' },
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Quiet logins, 7 days'), h('div', { class: 'v num' }, d.quietWeek), h('div', { class: 'sub' }, 'trusted key + trusted network, or a release')),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Failed attempts, 24 h'), h('div', { class: 'v num' }, d.failed24h.n), h('div', { class: 'sub' }, `from ${d.failed24h.ips} address${d.failed24h.ips === 1 ? '' : 'es'}`)),
      h('div', { class: 'card tile' }, h('div', { class: 'k' }, 'Trusted sources'), h('div', { class: 'v num' }, d.sources.filter((s) => !s.expired).length), h('div', { class: 'sub' }, 'keys first, networks second'))),
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Who got in'), h('span', { class: 'tiny muted' }, `7 days · ${rows.length}`)), shortList(rows, 10, 'No logins recorded yet.')),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Trusted sources')), srcList,
          h('p', { class: 'tiny muted' }, 'Changing this list needs a fresh 2FA code, and raises an alert.')),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'SSH keys on the server')), h('ul', { class: 'list' }, keysOnServer.length ? keysOnServer : h('li', { class: 'empty' }, 'Waiting for the inventory scan.'))),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Most failed attempts, 24 h')),
          d.topFailed.length ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Address'), h('th', null, 'Country'), h('th', { class: 'n' }, 'Tries'), h('th', null, 'Last'))),
            h('tbody', null, d.topFailed.map((f) => h('tr', null, h('td', { class: 'mono' }, f.ip), h('td', null, f.country || '—'), h('td', { class: 'n' }, f.n), h('td', { class: 'muted' }, fmt.ago(f.last))))))) : h('div', { class: 'empty' }, 'None.'),
          d.geoip ? h('p', { class: 'tiny muted' }, 'Country data: IP to Country Lite by DB-IP (CC BY 4.0), looked up on the server.') : h('p', { class: 'tiny muted' }, 'Countries unknown until the GeoIP file is downloaded (scripts/geoip-update.sh).')))),
  ]));
});

// Who is on the server right now: every open session, the key it used and
// how long it has been open. Refreshes every 30 s while the Access page shows.
function nowCard() {
  const body = h('div', null, h('div', { class: 'empty' }, 'Checking…'));
  const stamp = h('span', { class: 'tiny muted' });
  const paint = async () => {
    try {
      const r = await api('/access/now');
      stamp.textContent = `as of ${fmt.time(r.ts)}`;
      if (r.error) { body.replaceChildren(h('div', { class: 'empty' }, r.error)); return; }
      if (!r.sessions.length) { body.replaceChildren(h('div', { class: 'empty' }, 'Nobody is logged into the server.')); return; }
      body.replaceChildren(h('ul', { class: 'list' }, r.sessions.map((x) => h('li', null,
        h('span', { class: `dot ${x.key && x.key.trusted ? 'ok' : x.remote ? 'warning' : ''}` }),
        h('div', { class: 'what' },
          h('div', { class: 'small' }, h('strong', null, x.user || '?'), x.remote ? ` from ${x.ip || '?'}${x.country && x.country !== 'LAN' ? ` (${x.country})` : ''}` : ` on the console${x.tty ? ` (${x.tty})` : ''}`, ' ',
            x.key ? h('span', { class: `pill ${x.key.trusted ? 'live' : 'warn'}` }, x.key.label) : x.remote ? h('span', { class: 'pill warn' }, x.method && x.method !== 'publickey' ? x.method : 'key unknown') : null),
          h('div', { class: 'tiny muted' }, x.since ? `since ${fmt.time(x.since, true)} · ${fmt.dur(Date.now() - x.since)}` : 'open', x.tty ? ` · ${x.tty}` : ' · no terminal (a command)'))))));
    } catch (e) { body.replaceChildren(h('div', { class: 'err' }, e.message)); }
  };
  const timer = setInterval(() => { if (!body.isConnected) clearInterval(timer); else paint(); }, 30_000);
  setTimeout(paint, 0);
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'card-h' }, h('h2', null, 'On the server now'), h('button', { class: 'btn small', onclick: paint }, 'Refresh')), body,
    h('p', { class: 'tiny muted', style: { margin: '8px 0 0' } }, 'Every open login, with the key it came in with: green is a trusted key, amber one Pulse doesn’t know. ', stamp));
}

function accessTitle(e) {
  const where = e.ip ? ` from ${e.ip}${e.country && e.country !== 'LAN' ? ` (${e.country})` : ''}` : '';
  switch (e.kind) {
    case 'ssh_login': return `SSH: ${e.user}${where}${e.method && e.method !== 'publickey' ? ` · ${e.method}` : ''}`;
    case 'sudo': return `sudo · ${e.user}: ${String(e.command || '').slice(0, 90)}`;
    case 'sudo_failed': return `Failed sudo · ${e.user}`;
    case 'dashboard_login': return `Pulse sign-in · ${e.user}${where}`;
    case 'ssh_failed': return `Failed SSH · ${e.user || '?'}${where}`;
    default: return `${e.kind.replace(/_/g, ' ')} · ${e.user || ''}`;
  }
}

// The buttons on an app's page: restart it, switch its live line, read its log.
// Restart and Switch ask for a fresh 2FA code and raise an alert; the server
// side can do only those two things (scripts/pulse-action.sh).
function appActions(a) {
  // Any app with a live file has two lines, even when the idle one is stopped (AOTC stops it).
  const other = a.liveLine === 'blue' ? 'green' : a.liveLine === 'green' ? 'blue' : null;
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'card-h' }, h('h2', null, 'Actions')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: () => showLogs(a) }, 'Show log'),
      h('button', { class: 'btn', onclick: () => runAction(`Restart ${a.name}?`, `It will be unavailable for a few seconds while it starts again${a.liveLine ? ` (the live ${a.liveLine} line)` : ''}.`, (code) => api(`/apps/${encodeURIComponent(a.id)}/restart`, { method: 'POST', body: { code } }), 'Restarted') }, 'Restart'),
      other ? h('button', { class: 'btn', onclick: () => runAction(`Switch ${a.name} to ${other}?`, `The site moves from ${a.liveLine} to ${other}. ${other} is checked first; if it isn’t healthy nothing changes. To undo, switch back.`, (code) => api(`/apps/${encodeURIComponent(a.id)}/switch`, { method: 'POST', body: { code, line: other } }), `Now on ${other}`) }, `Switch to ${other}`) : null),
    h('p', { class: 'tiny muted', style: { margin: '10px 0 0' } }, 'Restart and Switch need your 2FA code and raise an alert, so nobody can do them quietly.'));
}

// Code → run → show what the server said.
function runAction(question, note, call, okText) {
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 11, autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', id: 'ac', placeholder: '6-digit code or a backup code' });
  const err = h('div', { class: 'err' });
  const out = h('pre', { class: 'mono tiny', style: { display: 'none', whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto', margin: '8px 0 0', padding: '10px', borderRadius: '10px', background: 'rgba(127,127,127,.12)' } });
  const go = h('button', { class: 'btn primary' }, 'Confirm');
  const dlg = modal(question, h('div', { class: 'form' }, h('p', { class: 'small ink2', style: { margin: 0 } }, note), h('label', { class: 'field', for: 'ac' }, 'Code from your authenticator app', code), err, out), (close) => [h('button', { class: 'btn', onclick: () => { close(); render(); } }, 'Close'), go]);
  go.onclick = async () => {
    err.textContent = ''; go.disabled = true; go.textContent = 'Working…';
    try {
      const r = await call(code.value);
      out.style.display = 'block'; out.textContent = r.output || '';
      go.remove(); toast(okText);
    } catch (e) {
      err.textContent = e.message; go.disabled = false; go.textContent = 'Confirm';
      if (e.body && e.body.output) { out.style.display = 'block'; out.textContent = e.body.output; }
    }
  };
  setTimeout(() => code.focus(), 50);
  return dlg;
}

async function showLogs(a) {
  const pre = h('pre', { class: 'mono', style: { fontSize: '11px', lineHeight: '1.45', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '62vh', overflow: 'auto', margin: 0, padding: '10px', borderRadius: '10px', background: 'rgba(127,127,127,.12)' } }, 'Loading…');
  let n = 60;
  const more = h('button', { class: 'btn' }, 'Older lines');
  const load = async () => {
    try { const r = await api(`/apps/${encodeURIComponent(a.id)}/logs?n=${n}`); pre.textContent = r.text; pre.scrollTop = pre.scrollHeight; }
    catch (e) { pre.textContent = e.message; }
  };
  more.onclick = () => { n = Math.min(500, n + 140); load(); };
  const dlg = modal(`${a.name} — log`, pre, (close) => [more, h('button', { class: 'btn', onclick: load }, 'Refresh'), h('button', { class: 'btn primary', onclick: close }, 'Close')]);
  dlg.style.maxWidth = '900px';
  await load();
}

// A list that shows the first few and folds the rest behind "Show N more".
function shortList(rows, first = 10, emptyText = 'Nothing yet.') {
  const ul = h('ul', { class: 'list' });
  if (!rows.length) { ul.append(h('li', { class: 'empty' }, emptyText)); return ul; }
  let open = false;
  const more = h('button', { class: 'btn small', type: 'button', style: { marginTop: '8px' } });
  const paint = () => {
    ul.replaceChildren(...(open ? rows : rows.slice(0, first)));
    more.textContent = open ? 'Show fewer' : `Show ${rows.length - first} more`;
  };
  more.onclick = () => { open = !open; paint(); if (!open) ul.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  paint();
  return rows.length > first ? h('div', null, ul, more) : ul;
}

// A small modal built from <dialog>.
function modal(title, body, actions) {
  const dlg = h('dialog', { class: 'card', style: { maxWidth: '440px', width: 'calc(100vw - 32px)', border: '0', padding: '18px' } },
    h('h2', { style: { marginBottom: '10px' } }, title), body, h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'flex-end' } }, actions(() => dlg.close())));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

function withCode(question, fn) {
  const code = h('input', { type: 'text', maxlength: 11, autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', id: 'fc', placeholder: '6-digit code or a backup code' });
  const err = h('div', { class: 'err' });
  modal(question, h('div', { class: 'form' }, h('label', { class: 'field', for: 'fc' }, 'Code from your authenticator app', code), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => { try { await fn(code.value); close(); toast('Done'); render(); } catch (e) { err.textContent = e.message; } } }, 'Confirm'),
  ]);
  setTimeout(() => code.focus(), 50);
}

// Authenticators: the same account on more than one phone. Each phone gets
// its own key, so a lost one can be taken off without touching the others.
function authenticatorList() {
  const list = S.me.authenticators || [];
  const t = (v) => (typeof v === 'string' ? Date.parse(v) : v);
  const used = (a) => a.lastUsedAt ? `last used ${fmt.ago(t(a.lastUsedAt))}` : a.createdAt ? `added ${fmt.short(t(a.createdAt))}` : 'set up when you turned on 2FA';
  return h('div', { class: 'auth-list' },
    h('div', { class: 'small ink2', style: { marginBottom: '6px' } }, `Authenticator apps (${list.length})`),
    list.length ? h('ul', { class: 'list' }, list.map((a) => h('li', null,
      h('div', { class: 'what small' }, a.name, h('div', { class: 'tiny muted' }, used(a))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => renameAuthenticator(a) }, 'Rename'),
        list.length > 1 ? h('button', { class: 'btn small', onclick: () => withCode(`Take “${a.name}” off your account?`, async (code) => {
          await api(`/auth/2fa/authenticators/${encodeURIComponent(a.id)}/remove`, { method: 'POST', body: { code } });
          S.me = await api('/auth/me');
        }) }, 'Remove') : null)))) : null,
    h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: addAuthenticator }, 'Add another phone'));
}

function renameAuthenticator(a) {
  const name = h('input', { type: 'text', id: 'an', value: a.name, maxlength: 40 });
  const err = h('div', { class: 'err' });
  modal('Rename authenticator', h('div', { class: 'form' }, h('label', { class: 'field', for: 'an' }, 'Name', name), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await api(`/auth/2fa/authenticators/${encodeURIComponent(a.id)}/rename`, { method: 'POST', body: { name: name.value } }); S.me = await api('/auth/me'); close(); render(); } catch (e) { err.textContent = e.message; }
    } }, 'Save'),
  ]);
  setTimeout(() => name.select(), 50);
}

function addAuthenticator() {
  const err = h('div', { class: 'err' });
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', id: 'ac1', placeholder: '6-digit code' });
  const box = h('div', { class: 'form' },
    h('p', { class: 'small ink2', style: { margin: 0 } }, 'Set up this account on a second phone, so you can sign in with either. First, the current code from a phone that already has it.'),
    h('label', { class: 'field', for: 'ac1' }, 'Code from your current phone', code), err);
  let step = 1;
  const dlg = modal('Add another phone', box, (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', id: 'acgo', onclick: () => (step === 1 ? next() : finish()) }, 'Continue'),
  ]);
  setTimeout(() => code.focus(), 50);
  const go = () => dlg.querySelector('#acgo');
  let name, code2;
  async function next() {
    err.textContent = '';
    try {
      const r = await api('/auth/2fa/authenticators/setup', { method: 'POST', body: { code: code.value } });
      step = 2;
      name = h('input', { type: 'text', id: 'ac2n', maxlength: 40, placeholder: 'e.g. Work iPhone, iPad' });
      code2 = h('input', { type: 'text', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', id: 'ac2c', placeholder: '6-digit code' });
      box.replaceChildren(
        h('p', { class: 'small ink2', style: { margin: 0 } }, 'On the other phone, open the authenticator app and scan this.'),
        r.qrCodeDataUrl ? h('div', { class: 'qr' }, h('img', { src: r.qrCodeDataUrl, alt: 'QR code for the other phone' })) : null,
        h('details', null, h('summary', { class: 'small' }, "Can't scan? Type this key"), h('p', { class: 'fp' }, r.secret)),
        h('label', { class: 'field', for: 'ac2n' }, 'Name this phone', name),
        h('label', { class: 'field', for: 'ac2c' }, 'Code now showing on the other phone', code2), err);
      go().textContent = 'Add phone';
      setTimeout(() => name.focus(), 50);
    } catch (e) { err.textContent = e.message; }
  }
  async function finish() {
    err.textContent = '';
    try {
      await api('/auth/2fa/authenticators/enable', { method: 'POST', body: { token: code2.value, name: name.value } });
      S.me = await api('/auth/me');
      dlg.close(); toast('Added — either phone now works, and an alert was raised.'); render();
    } catch (e) { err.textContent = e.message; }
  }
}

function addTrusted(pre) {
  const kind = h('select', { id: 'tk' }, h('option', { value: 'key' }, 'SSH key (fingerprint)'), h('option', { value: 'network' }, 'Network (IP or range)'));
  kind.value = pre.kind || 'key';
  const label = h('input', { type: 'text', id: 'tl', value: pre.label || '', placeholder: 'e.g. MacBook (deploy key), Home Wi-Fi' });
  const value = h('input', { type: 'text', id: 'tv', value: pre.value || '', placeholder: 'SHA256:… or 41.66.12.0/24' });
  const days = h('select', { id: 'td' }, h('option', { value: '' }, 'Always'), h('option', { value: '1' }, '1 day'), h('option', { value: '7' }, '7 days (e.g. hotel Wi-Fi)'), h('option', { value: '30' }, '30 days'));
  const code = h('input', { type: 'text', maxlength: 11, autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', id: 'tc', placeholder: '6-digit code or a backup code' });
  const err = h('div', { class: 'err' });
  modal('Add a trusted source', h('div', { class: 'form' },
    h('label', { class: 'field', for: 'tk' }, 'Kind', kind), h('label', { class: 'field', for: 'tl' }, 'Name', label), h('label', { class: 'field', for: 'tv' }, 'Value', value),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Key fingerprint on your Mac: ssh-keygen -lf ~/.ssh/id_ed25519.pub'),
    h('label', { class: 'field', for: 'td' }, 'For how long', days), h('label', { class: 'field', for: 'tc' }, '2FA code', code), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await api('/trusted', { method: 'POST', body: { kind: kind.value, label: label.value, value: value.value, days: days.value, code: code.value } }); close(); toast('Added — and an alert was raised, as it should be.'); render(); } catch (e) { err.textContent = e.message; }
    } }, 'Add'),
  ]);
}

// ===================================================================== Alerts
route(/^\/alerts$/, async () => {
  let status = 'active';
  const list = h('div', { class: 'stack' });
  const d0 = await load('/alerts');
  async function paint(d) {
    S.counts = d.counts; paintBadges();
    list.replaceChildren(...(d.alerts.length ? d.alerts.map(alertCard) : [h('div', { class: 'empty' }, status === 'active' ? 'All clear. Nothing open.' : 'Nothing here.')]));
  }
  show(shell('alerts', [
    pageTop('Alerts', rangePicker(status, [['active', 'Open'], ['resolved', 'Resolved'], ['all', 'All']], async (s) => { status = s; await paint(await load(`/alerts?status=${s}`)); })),
    offlineNote(d0),
    list,
    h('div', { class: 'card', style: { marginTop: '18px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Rules and channels'), h('a', { href: '#/settings', class: 'small' }, 'Edit')),
      h('p', { class: 'small ink2', style: { margin: 0 } }, 'Urgent: push + SMS (+ WhatsApp once approved) + email. Warning: push + email. Info: timeline only. Each alert re-notifies at most every 30 min (urgent) or 6 h (warning) and sends one message when it clears.'),
      d0.deliveries && d0.deliveries.length ? h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small' }, 'Recent deliveries'), h('ul', { class: 'list' }, d0.deliveries.slice(0, 15).map((x) => h('li', null, h('span', { class: `dot ${x.ok ? '' : 'critical'}` }), h('div', { class: 'what small' }, `${x.channel} · ${x.info}`), h('span', { class: 'when' }, fmt.ago(x.ts)))))) : null),
  ]));
  await paint(d0);
});

function alertCard(a) {
  const det = a.detail || {};
  const acts = [];
  if (a.status !== 'resolved') {
    if (a.rule === 'access' && !a.answer) {
      acts.push(h('button', { class: 'btn small primary', onclick: () => answer(a, true, false) }, 'Yes, it was me'));
      acts.push(h('button', { class: 'btn small', onclick: () => answer(a, true, true) }, 'Yes — trust this network'));
      acts.push(h('button', { class: 'btn small danger', onclick: () => answer(a, false) }, 'No'));
    } else {
      if (a.status !== 'acknowledged') acts.push(h('button', { class: 'btn small', onclick: async () => { await api(`/alerts/${a.id}/ack`, { method: 'POST', body: {} }); render(); } }, 'Acknowledge'));
      // Snooze only while it is still asking for attention; once acknowledged it no longer notifies.
      if (a.status === 'open') acts.push(h('button', { class: 'btn small', onclick: async () => { await api(`/alerts/${a.id}/snooze`, { method: 'POST', body: { minutes: 60 } }); toast('Snoozed for an hour'); render(); } }, 'Snooze 1 h'));
      acts.push(h('button', { class: 'btn small', onclick: async () => { await api(`/alerts/${a.id}/close`, { method: 'POST', body: {} }); toast('Closed. If it is still a problem, it will come back.'); render(); } }, 'Close'));
    }
  }
  return h('div', { class: `alert ${a.status === 'resolved' ? '' : a.severity}` },
    h('div', { class: 'row' }, sevBadge(a.severity), h('span', { class: 'pill' }, a.status), a.answer ? h('span', { class: `pill ${a.answer === 'no' ? 'crit' : 'live'}` }, a.answer === 'no' ? 'not me' : 'confirmed') : null, h('span', { class: 'spacer' }), h('span', { class: 'tiny muted' }, fmt.ago(a.updated_at))),
    h('a', { class: 't', href: `#/alerts/${a.id}`, style: { color: 'inherit' } }, a.title),
    det.summary ? h('div', { class: 'small ink2' }, det.summary) : null,
    det.groupId ? h('a', { class: 'btn small primary', href: `#/errors/${det.groupId}`, style: { justifySelf: 'start' } }, 'Open the error and its logs →') : null,
    h('div', { class: 'tiny muted' }, `Opened ${fmt.time(a.opened_at, true)}${a.occurrences > 1 ? ` · seen ${a.occurrences}×` : ''}${a.resolved_at ? ` · resolved ${fmt.ago(a.resolved_at)}` : ''}`),
    acts.length ? h('div', { class: 'acts' }, acts) : null);
}

// "Yes — trust this network": for how long. A hotel or airport network
// should lapse by itself (7 days); home or office can be Always.
function trustNetworkDialog(a) {
  const days = h('select', { id: 'tnd' }, h('option', { value: '1' }, '1 day'), h('option', { value: '7' }, '7 days (a trip, hotel Wi-Fi)'), h('option', { value: '30' }, '30 days'), h('option', { value: '0' }, 'Always (home or office)'));
  days.value = '7';
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 11, autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', id: 'tnc', placeholder: '6-digit code or a backup code' });
  const err = h('div', { class: 'err' });
  modal('Trust the network this login came from?', h('div', { class: 'form' },
    h('p', { class: 'small ink2', style: { margin: 0 } }, 'Logins with your key from this network will stop alerting until it lapses. Everyone else on that network is still alerted on if they use a key Pulse doesn’t know.'),
    h('label', { class: 'field', for: 'tnd' }, 'For how long', days),
    h('label', { class: 'field', for: 'tnc' }, 'Code from your authenticator app', code), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      try {
        const r = await api(`/alerts/${a.id}/answer`, { method: 'POST', body: { yes: true, trust: true, code: code.value, days: Number(days.value) } });
        close(); render();
        const t = r.trusted;
        const until = t && (t.expiresAt ? `until ${new Date(t.expiresAt).toLocaleDateString()}` : 'always');
        setTimeout(() => toast(!t ? 'Marked as you.' : t.existed && !t.renewed ? `${t.cidr} was already trusted (${until}).` : `Trusted ${t.cidr} ${until}. (That raised an alert too, by design.)`), 300);
      } catch (e) { err.textContent = e.message; }
    } }, 'Trust'),
  ]);
  setTimeout(() => code.focus(), 50);
}

async function answer(a, yes, trustIt) {
  if (!yes && !confirm('Mark this as NOT you? It will be escalated to urgent and you will get the next steps.')) return;
  if (trustIt) {
    // Trusting a network changes the trusted list: same fresh-code rule as the Access page.
    return trustNetworkDialog(a);
  }
  try {
    const r = await api(`/alerts/${a.id}/answer`, { method: 'POST', body: { yes, trust: false } });
    toast(yes ? (r.trusted ? `Thanks — ${r.trusted.label || 'network'} is now trusted.` : 'Thanks — marked as you.') : 'Escalated. See the steps on the alert.');
    if (!yes) location.hash = `#/alerts/${a.id}`; else render();
  } catch (e) { toast(e.message); }
}

route(/^\/alerts\/(\d+)$/, async (id) => {
  const d = await load(`/alerts/${id}`);
  const a = d.alert;
  const det = a.detail || {};
  const steps = a.answer === 'no' || (a.rule === 'access' && a.severity === 'critical') ? h('div', { class: 'card', style: { marginTop: '14px' } }, h('h2', null, 'If this was not you'),
    h('ol', { class: 'small', style: { paddingLeft: '20px', lineHeight: 1.7 } },
      h('li', null, 'From your Mac: ', h('code', null, 'ssh -t deploy@track.pcg-aotc.com'), ' then ', h('code', null, 'who; last -n 20'), ' to see who is on now.'),
      h('li', null, 'Check the keys: ', h('code', null, 'sudo cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys'), ' and remove anything you did not add.'),
      h('li', null, 'Block the address: ', h('code', null, `sudo fail2ban-client set sshd banip ${(d.access && d.access.ip) || '<IP>'}`), '.'),
      h('li', null, 'Rotate your deploy key and the passwords of anyone with sudo; check ', h('code', null, 'sudo journalctl _COMM=sudo --since -1d'), '.'),
      h('li', null, 'Pulse never changes the server itself. These steps are for you to run.'))) : null;
  show(shell('alerts', [
    pageTop(a.title),
    alertCard(a),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('h2', null, 'Details'),
      h('dl', { class: 'kv', style: { marginTop: '10px' } },
        h('dt', null, 'Rule'), h('dd', null, a.rule),
        h('dt', null, 'Opened'), h('dd', null, fmt.time(a.opened_at, true)),
        h('dt', null, 'Last seen'), h('dd', null, fmt.time(a.updated_at, true)),
        Object.entries(det).filter(([k, v]) => k !== 'summary' && v != null && typeof v !== 'object').map(([k, v]) => [h('dt', null, k), h('dd', { class: /fingerprint|command|ip/.test(k) ? 'mono' : null }, String(v))]),
        d.access ? [h('dt', null, 'Log line'), h('dd', { class: 'mono' }, d.access.raw || '—')] : null)),
    steps,
  ]));
});

// ===================================================================== Inventory
route(/^\/inventory$/, async () => {
  const d = await load('/inventory');
  const s = d.scan || {};
  const t = (head, rows) => h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, head.map((x) => h('th', { class: x.endsWith('#') ? 'n' : null }, x.replace(/#$/, ''))))), h('tbody', null, rows)));
  const appUnits = (d.units || []).filter((u) => !/^(systemd-|user@|getty@|modprobe@)/.test(u.base));
  show(shell('inventory', [
    pageTop('Inventory', h('span', { class: 'tiny muted' }, s.ts ? `root scan ${fmt.ago(s.ts)}` : `root scan: ${d.scanError || 'not yet'}`)),
    offlineNote(d),
    d.findings && d.findings.length ? h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'To tidy up')), h('ul', { class: 'list' }, d.findings.map((f) => h('li', null, h('span', { class: `dot ${f.severity}` }), h('div', { class: 'what small' }, f.title))))) : null,
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Listening ports')),
      s.ports ? t(['Port#', 'Address', 'Process', 'Service', 'App'], s.ports.slice().sort((a, b) => a.port - b.port).map((p) => h('tr', null, h('td', { class: 'n num' }, p.port), h('td', { class: 'mono' }, p.addr), h('td', null, p.proc || '—'), h('td', { class: 'mono' }, p.unit || '—'), h('td', null, ((d.apps || []).find((a) => a.ports.includes(p.port)) || {}).name || '')))) : h('div', { class: 'empty' }, 'Needs the root scan.')),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Websites (Apache)')),
      t(['Domain', 'Backend', 'Certificate', 'File'], (d.sites || []).map((x) => h('tr', null, h('td', null, [x.serverName, ...x.aliases].filter(Boolean).join(', ')), h('td', { class: 'mono' }, x.proxies.map((p) => `${p.path} → :${p.port}`).join(', ') || '—'), h('td', null, x.certFile ? 'yes' : '—'), h('td', { class: 'mono muted' }, (x.file || '').split('/').pop()))))),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Services')),
      t(['Unit', 'State', 'Description'], appUnits.map((u) => h('tr', null, h('td', { class: 'mono' }, u.unit), h('td', null, h('span', { class: `st ${u.active === 'active' ? 'up' : u.active === 'failed' ? 'down' : 'stopped'}` }, `${u.active} (${u.sub})`)), h('td', { class: 'muted' }, u.description || ''))))),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Login users')),
        s.users ? t(['User', 'UID#', 'sudo', 'Home'], s.users.map((u) => h('tr', null, h('td', null, u.name), h('td', { class: 'n' }, u.uid), h('td', null, u.sudo ? 'yes' : ''), h('td', { class: 'mono muted' }, u.home)))) : h('div', { class: 'empty' }, 'Needs the root scan.')),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Backups')),
        s.backups && s.backups.length ? t(['Folder', 'Newest', 'Files#', 'Size#'], s.backups.map((b) => h('tr', null, h('td', { class: 'mono' }, b.dir), h('td', null, fmt.ago(b.newestTs)), h('td', { class: 'n' }, b.count), h('td', { class: 'n' }, fmt.bytes(b.bytes))))) : h('div', { class: 'empty' }, 'None found.'))),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Scheduled jobs')),
        s.cron ? t(['Owner', 'Job'], s.cron.map((c) => h('tr', null, h('td', null, c.owner), h('td', { class: 'mono' }, c.line)))) : null,
        d.timers ? h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small' }, `${d.timers.length} systemd timers`), t(['Timer', 'Runs', 'Next'], d.timers.map((x) => h('tr', null, h('td', { class: 'mono' }, x.unit), h('td', { class: 'mono muted' }, x.activates), h('td', null, x.next ? fmt.short(x.next) : '—'))))) : null),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Changes, 30 days')),
        h('ul', { class: 'list' }, (d.changes || []).length ? d.changes.slice(0, 30).map(eventItem) : h('li', { class: 'empty' }, 'No changes since Pulse started watching.')))),
  ]));
});

// ===================================================================== Settings
// ===================================================================== About & updates
function aboutDate(s) { try { return s ? new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; } catch { return ''; } }

route(/^\/about$/, async () => {
  let srv = null;
  try { srv = await api('/about'); } catch { /* offline: show this copy's version */ }
  const stale = !!(srv && srv.version && srv.version !== APP_VERSION);
  const row = (k, v, cls) => h('div', { class: 'ab-row' }, h('span', null, k), h('b', { class: `num${cls ? ` ${cls}` : ''}` }, v));
  const reload = h('button', { class: 'btn primary', onclick: (e) => updateNow(e.currentTarget) }, 'Reload');
  const check = h('button', { class: 'btn', onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
    const found = await checkVersion({ quiet: true });
    b.disabled = false; b.textContent = 'Check for updates';
    if (!found) toast(`Pulse ${APP_VERSION} is the newest version.`);
  } }, 'Check for updates');
  show(shell('about', [
    pageTop('About'),
    h('section', { class: 'card about-hero' },
      h('img', { src: '/icons/icon-192.png', alt: '', width: 84, height: 84 }),
      h('h2', null, 'DeonTech Pulse'),
      h('p', null, 'The live monitor for your server and every app on it.'),
      h('div', { class: 'ab-ver' }, h('span', { class: 'ab-num' }, `Version ${APP_VERSION}`), srv && srv.released ? h('span', { class: 'muted' }, ` · ${aboutDate(srv.released)}`) : null),
      stale ? h('div', { class: 'banner warning ab-new' }, h('div', { class: 'b-body' }, h('strong', null, `Version ${srv.version} is ready`), 'Reload to start using it.'), reload)
        : h('div', { class: 'ab-actions' }, check)),
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'This copy')),
        h('div', { class: 'ab-list' },
          row('App version', APP_VERSION),
          row('Server version', srv ? srv.version : '—', stale ? 'warn-ink' : ''),
          srv && srv.build ? row('Build', srv.build) : null,
          row('Running since', srv && srv.started ? `${aboutDate(new Date(srv.started).toISOString())} · ${fmt.ago(srv.started)}` : '—'),
          row('Node.js', srv ? srv.node : '—'),
          row('Address', location.host))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Developer')),
        h('div', { class: 'ab-list' }, row('Smart DeonTech', 'smartdeontech.com')),
        h('p', { class: 'small ink2', style: { margin: '12px 2px 0', lineHeight: 1.5 } }, 'Pulse runs on your own server, watching only that server. Nothing it sees is sent to anyone else; alerts go to the phones and addresses you set.'))),
    h('section', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'card-h' }, h('h2', null, 'What’s new')),
      h('div', { class: 'ab-changes' }, CHANGES.map(([v, t]) => h('div', { class: `ab-change${v === APP_VERSION ? ' now' : ''}` }, h('span', { class: 'pill' }, v), h('span', null, t))))),
    h('section', { class: 'card', style: { marginTop: '14px' } }, h('div', { class: 'card-h' }, h('h2', null, 'Built with')),
      h('p', { class: 'small ink2', style: { margin: 0, lineHeight: 1.5 } }, `Node.js${srv ? ` ${srv.node}` : ''}, Express, SQLite, uPlot, Web Push and SimpleWebAuthn — all open source — on the Smart DeonTech core.`)),
  ]));
});

// Reload into the new version: let the service worker fetch it whole, drop the
// old saved copy, then reload — so the old one can't come back and ask again.
async function updateNow(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  updateBar({ stage: 'reload' });
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) {
      await reg.update().catch(() => {});
      const w = reg.installing || reg.waiting;
      if (w && w.state !== 'activated') await new Promise((res) => { const t = setTimeout(res, 8000); w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); res(); } }); });
    }
    if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch { /* reload anyway */ }
  location.reload();
}

// The update bar: while a new version comes down, a thin bar at the top says
// how far it has got — checking → downloading (4 of 12) → installing → ready
// (with Reload). Only for updates, not the very first install.
function updateBar(st) {
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;
  let el = $('#updBar');
  if (!el) { el = h('div', { id: 'updBar', class: 'upd-bar', role: 'status' }, h('div', { class: 'upd-txt' }), h('div', { class: 'upd-track' }, h('i'))); document.body.append(el); }
  const pct = st.stage === 'check' ? 4 : st.stage === 'download' ? 8 + Math.round((st.done / Math.max(1, st.total)) * 72) : st.stage === 'install' ? 88 : st.stage === 'ready' || st.stage === 'reload' ? 100 : 0;
  const txt = { check: 'Checking for the new version…', download: `Downloading the new version · ${st.done} of ${st.total}`, install: 'Installing…', ready: `Pulse ${S.newVersion || 'update'} is ready`, reload: 'Opening the new version…', failed: 'Couldn’t download the new version — Pulse will try again next time you open it.' }[st.stage] || '';
  const t = $('.upd-txt', el);
  t.replaceChildren(h('span', null, txt), st.stage === 'ready' ? h('button', { class: 'upd-go', onclick: (e) => updateNow(e.currentTarget) }, 'Reload') : '');
  $('.upd-track i', el).style.width = `${pct}%`;
  el.classList.toggle('done', st.stage === 'ready');
  el.classList.toggle('bad', st.stage === 'failed');
  el.classList.add('show');
  if (st.stage === 'failed') setTimeout(() => el.classList.remove('show'), 6000);
}
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', async (e) => {
  if (!e.data || e.data.type !== 'update') return;
  S.updating = e.data.stage;
  // The download can finish before the page has asked which version it is.
  if (e.data.stage === 'ready' && !S.newVersion) { try { const a = await api('/about'); if (a.version !== APP_VERSION) S.newVersion = a.version; } catch { /* the bar still offers Reload */ } }
  updateBar(e.data);
});

// Waits for a newer version of Pulse to finish downloading onto this device.
async function newVersionReady(limit = 60000) {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  if (!reg) return;
  await reg.update().catch(() => {});
  const w = reg.installing || reg.waiting;
  if (w && w.state !== 'activated') await new Promise((res) => { const t = setTimeout(res, limit); w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); res(); } }); });
}

// If the server runs a newer Pulse than this copy, say so — once it is on the
// device, so Reload opens it straight away. At most every 10 minutes unless asked.
let versionCheckedAt = 0;
async function checkVersion({ quiet = false } = {}) {
  if (!quiet && Date.now() - versionCheckedAt < 10 * 60_000) return false;
  versionCheckedAt = Date.now();
  try {
    const a = await api('/about');
    if (!a.version || a.version === APP_VERSION) return false;
    S.newVersion = a.version;
    if (!S.updating) updateBar({ stage: 'check' });
    await newVersionReady();
    if ($('#updBar')) updateBar({ stage: 'ready' });
    else modal(`Pulse ${a.version} is ready`, h('p', { class: 'small' }, `You’re using ${APP_VERSION}. It’s downloaded — reload to start using it.`), (close) => [h('button', { class: 'btn', onclick: close }, 'Later'), h('button', { class: 'btn primary', onclick: (e) => updateNow(e.currentTarget) }, 'Reload')]);
    document.querySelectorAll('.about-link').forEach((x) => { if (!x.querySelector('.badge')) x.append(h('span', { class: 'badge warn' }, 'new')); });
    return true;
  } catch { return false; }
}

route(/^\/settings$/, async () => {
  const d = await load('/settings');
  const s = d.settings;
  const st = d.status;
  const th = s.thresholds;
  const num = (id, v) => h('input', { type: 'number', id, value: v, min: 1, max: 100000, style: { maxWidth: '110px' } });
  const f = {
    phone: h('input', { type: 'tel', id: 'ph', value: s.ownerPhone || '', placeholder: '+233 24 000 0000' }),
    email: h('input', { type: 'email', id: 'em', value: s.ownerEmail || '', placeholder: 'smartdeontech@gmail.com' }),
    push: h('input', { type: 'checkbox', checked: s.channels.push }),
    sms: h('input', { type: 'checkbox', checked: s.channels.sms }),
    mail: h('input', { type: 'checkbox', checked: s.channels.email }),
    wa: h('input', { type: 'checkbox', checked: s.channels.whatsapp }),
    qhOn: h('input', { type: 'checkbox', checked: s.quietHours.enabled }),
    qhA: h('input', { type: 'time', id: 'qa', value: s.quietHours.start }),
    qhB: h('input', { type: 'time', id: 'qb', value: s.quietHours.end }),
    digest: h('input', { type: 'time', id: 'dg', value: s.digestTime || '07:00' }),
    dw: num('dw', th.diskWarnPct), dc: num('dc', th.diskCritPct), mc: num('mc', th.memCritPct), cc: num('cc', th.cpuCritPct), sm: num('sm', th.sustainMinutes),
    sw: num('sw', th.swapWarnPct), bk: num('bk', th.backupMaxAgeHours), fb: num('fb', th.failedBurstCount), countries: h('input', { type: 'text', id: 'uc', value: (s.usualCountries || []).join(', ') }),
  };
  const ok = (b, what) => h('span', { class: `st ${b ? 'up' : 'stopped'}` }, b ? `${what} ready` : `${what} not set up`);
  const save = async (patch) => { try { await api('/settings', { method: 'PUT', body: patch }); toast('Saved'); } catch (e) { toast(e.message); } };
  const mm = h('select', { id: 'mm' }, [30, 60, 120, 240].map((m) => h('option', { value: m }, `${m} minutes`)));
  const mmNote = h('input', { type: 'text', id: 'mn', placeholder: 'What are you doing? (optional)' });

  show(shell('settings', [
    pageTop('Settings', h('a', { href: '#/about', class: 'btn' }, `About Pulse · ${APP_VERSION}`)),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'This device')),
        h('div', { class: 'form' },
          h('p', { class: 'small ink2', style: { margin: 0 } }, 'Get alerts as notifications with Yes/No buttons. On iPhone, first add Pulse to the Home Screen (Share → Add to Home Screen) and open it from there.'),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn primary', onclick: enablePush, disabled: !st.push }, 'Turn on notifications'),
            h('button', { class: 'btn', onclick: async () => { const r = await api('/push/test', { method: 'POST', body: {} }); toast(r.ok ? `Sent to ${r.ok} device${r.ok === 1 ? '' : 's'}` : 'No devices subscribed yet'); } }, 'Send a test')),
          !st.push ? h('p', { class: 'tiny muted' }, 'Push needs VAPID keys on the server (deploy/provision.sh makes them).') : null,
          d.devices.length ? h('ul', { class: 'list' }, d.devices.map((x) => h('li', null, h('div', { class: 'what small' }, x.label, h('div', { class: 'tiny muted' }, `added ${fmt.short(x.created_at)}${x.last_ok_at ? ` · last delivered ${fmt.ago(x.last_ok_at)}` : ''}`)), h('button', { class: 'btn small', onclick: () => withCode(`Stop sending alerts to ${x.label}?`, (code) => api(`/push/subscribe/${x.id}`, { method: 'DELETE', body: { code } })) }, 'Remove')))) : null,
          h('div', { class: 'row wrap' }, h('span', { class: 'small ink2' }, 'Theme'), h('div', { class: 'seg' }, ['system', 'light', 'dark'].map((t) => h('button', { type: 'button', class: (document.documentElement.dataset.theme || 'system') === t ? 'on' : null, onclick: (e) => { setTheme(t); e.target.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target)); } }, t[0].toUpperCase() + t.slice(1))))))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Your account')),
        h('div', { class: 'form' },
          h('div', { class: 'small' }, S.me.email, ' · ', S.me.role, ' · 2FA on'),
          h('div', { class: 'small muted' }, `${(S.me.passkeys || []).length} passkey${(S.me.passkeys || []).length === 1 ? '' : 's'}`),
          authenticatorList(),
          window.PublicKeyCredential ? h('button', { class: 'btn', onclick: () => withCode('Add a passkey on this device?', async (code) => {
            try { await passkeyRegister(deviceName(), code); S.me = await api('/auth/me'); setTimeout(() => toast('Passkey added — next time, sign in with Face ID / Touch ID.'), 300); }
            catch (e) { if (e.name === 'NotAllowedError') return; throw e; }
          }) }, 'Add a passkey (Face ID / Touch ID)') : null,
          h('button', { class: 'btn', onclick: logout }, 'Sign out')))),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Where alerts go')),
      h('div', { class: 'row wrap', style: { marginBottom: '12px' } }, ok(st.push, 'Push'), ok(st.sms, 'SMS'), ok(st.email, 'Email'), ok(st.whatsapp, 'WhatsApp')),
      h('p', { class: 'tiny muted', style: { marginTop: 0 } }, 'Changing these needs a fresh 2FA code and raises an alert — so nobody can quietly switch your alerts off.'),
      h('div', { class: 'grid g2' },
        h('label', { class: 'field', for: 'ph' }, 'Phone for urgent SMS', f.phone),
        h('label', { class: 'field', for: 'em' }, 'Email for warnings and the digest', f.email)),
      h('div', { class: 'row wrap', style: { margin: '12px 0' } },
        h('label', { class: 'check small' }, f.push, 'Push'), h('label', { class: 'check small' }, f.sms, 'SMS (urgent)'), h('label', { class: 'check small' }, f.mail, 'Email'), h('label', { class: 'check small' }, f.wa, 'WhatsApp (when approved)')),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', disabled: !d.canSettings, onclick: () => withCode('Change where alerts go?', (code) => api('/settings', { method: 'PUT', body: { code, ownerPhone: f.phone.value.trim(), ownerEmail: f.email.value.trim(), channels: { push: f.push.checked, sms: f.sms.checked, email: f.mail.checked, whatsapp: f.wa.checked } } })) }, 'Save'),
        h('button', { class: 'btn', onclick: async () => { await api('/alerts/test', { method: 'POST', body: { urgent: true } }); toast('Urgent test alert raised — check your phone.'); } }, 'Send an urgent test'))),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Thresholds')),
        h('div', { class: 'grid g2' },
          h('label', { class: 'field', for: 'dw' }, 'Disk warning %', f.dw), h('label', { class: 'field', for: 'dc' }, 'Disk urgent %', f.dc),
          h('label', { class: 'field', for: 'cc' }, 'CPU urgent %', f.cc), h('label', { class: 'field', for: 'mc' }, 'Memory urgent %', f.mc),
          h('label', { class: 'field', for: 'sm' }, '…for minutes', f.sm), h('label', { class: 'field', for: 'sw' }, 'Swap warning %', f.sw),
          h('label', { class: 'field', for: 'bk' }, 'Backup older than (h)', f.bk), h('label', { class: 'field', for: 'fb' }, 'Failed logins per 5 min', f.fb)),
        h('label', { class: 'field', for: 'uc', style: { marginTop: '12px' } }, 'Usual countries (a trusted key from elsewhere pushes)', f.countries),
        h('button', { class: 'btn primary', style: { marginTop: '12px' }, disabled: !d.canManage, onclick: () => save({
          thresholds: { diskWarnPct: +f.dw.value, diskCritPct: +f.dc.value, cpuCritPct: +f.cc.value, memCritPct: +f.mc.value, sustainMinutes: +f.sm.value, swapWarnPct: +f.sw.value, backupMaxAgeHours: +f.bk.value, failedBurstCount: +f.fb.value },
          usualCountries: f.countries.value.split(/[\s,]+/).filter(Boolean).map((x) => x.toUpperCase()),
        }) }, 'Save thresholds')),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Quiet hours and digest')),
          h('label', { class: 'check small' }, f.qhOn, 'Hold warnings during quiet hours (urgent always goes out)'),
          h('div', { class: 'grid g2', style: { marginTop: '10px' } }, h('label', { class: 'field', for: 'qa' }, `From (${zoneName(HOME_TZ)} time)`, f.qhA), h('label', { class: 'field', for: 'qb' }, 'Until', f.qhB)),
          h('label', { class: 'field', for: 'dg', style: { marginTop: '10px' } }, `Morning digest at (${zoneName(HOME_TZ)} time)`, f.digest),
          h('button', { class: 'btn primary', style: { marginTop: '12px' }, disabled: !d.canManage, onclick: () => save({ quietHours: { enabled: f.qhOn.checked, start: f.qhA.value, end: f.qhB.value }, digestTime: f.digest.value }) }, 'Save')),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Maintenance mode')),
          h('p', { class: 'small ink2', style: { marginTop: 0 } }, 'Holds service and health alerts while you work. Access alerts still go out.'),
          s.maintenanceUntil && Date.parse(s.maintenanceUntil) > Date.now()
            ? h('div', { class: 'row wrap' }, h('span', { class: 'small' }, `On until ${fmt.time(Date.parse(s.maintenanceUntil))}`), h('button', { class: 'btn', onclick: async () => { await api('/maintenance', { method: 'DELETE' }); toast('Maintenance off'); render(); } }, 'End now'))
            : h('div', { class: 'form' }, h('label', { class: 'field', for: 'mm' }, 'For', mm), mmNote, h('button', { class: 'btn', disabled: !d.canManage, onclick: async () => { await api('/maintenance', { method: 'POST', body: { minutes: +mm.value, note: mmNote.value } }); toast('Maintenance on'); render(); } }, 'Start maintenance'))))),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Status')),
      h('dl', { class: 'kv' },
        h('dt', null, 'Login watcher'), h('dd', null, st.authWatch || 'not running'),
        h('dt', null, 'Inventory scan'), h('dd', null, st.scan ? fmt.ago(st.scan) : 'not yet run'),
        h('dt', null, 'GeoIP'), h('dd', null, st.geoip ? 'loaded (DB-IP Lite, CC BY 4.0)' : 'not downloaded'))),
  ]));
});

// ===================================================================== Backups
const VERDICT = {
  ok: ['Protected', 'ok', 'Recent, checked, and copied off the server'],
  local: ['Not off-site', 'warn', 'Recent, but every copy is on this server — if the server is lost, so are they'],
  stale: ['Out of date', 'bad', 'The newest backup is older than it should be'],
  bad: ['Check failed', 'bad', 'The newest backup did not pass its check'],
  none: ['Not backed up', 'bad', 'There is no backup of this at all'],
};
const ROLE_DOT = { own: 'b-own', scheduled: 'b-sched', release: 'b-rel', pulse: 'b-pulse' };
function ageClass(ts, maxH) { if (!ts) return 'bad'; const h = (Date.now() - ts) / 3600_000; return h > maxH ? 'bad' : h > maxH * 0.75 ? 'warn' : 'ok'; }
function checkBadge(c) {
  if (!c) return null;
  if (c.result === 'ok') return h('span', { class: 'pill live' }, c.databases ? `database${c.databases === 1 ? '' : 's'} checked ✓` : 'checked ✓');
  if (c.result === 'bad') return h('span', { class: 'pill crit', title: c.detail || '' }, 'check failed');
  if (c.result === 'nodb') return h('span', { class: 'pill' }, 'no database inside');
  return null;
}

function backupCard(b, d) {
  const [vt, vc, vwhy] = VERDICT[b.verdict] || [b.verdict, '', ''];
  const maxH = d.maxAgeHours || 26;
  const plan = b.plan;
  const offOn = !b.offsite.nightly;   // default the tick on when nothing else takes it off-site
  const offBox = h('input', { type: 'checkbox', checked: offOn });
  const runBtn = h('button', { class: 'btn primary', disabled: !!b.running || !plan, onclick: async () => {
    runBtn.disabled = true;
    try { await api(`/backups/${encodeURIComponent(b.id)}/run`, { method: 'POST', body: { offsite: offBox.checked } }); toast(`Backing up ${b.name}…`); softRefresh(); }
    catch (e) { toast(e.message); runBtn.disabled = false; }
  } }, b.running ? 'Backing up…' : 'Back up now');
  const nightly = plan && d.canManage ? h('div', { class: 'bk-night' },
    toggleSwitch(b.schedule.nightly, async (v) => { try { await api(`/backups/${encodeURIComponent(b.id)}/schedule`, { method: 'PUT', body: { nightly: v, offsite: b.schedule.offsite } }); toast(v ? `${b.name} will be backed up every night at ${d.schedule.time}` : 'Nightly backup by Pulse off'); softRefresh(); } catch (e) { toast(e.message); } }, { label: 'Back up every night' }),
    h('div', null, h('b', null, 'Every night by Pulse'), h('span', null, b.schedule.nightly ? `at ${d.schedule.time}${b.schedule.offsite ? ', with an off-site copy' : ''}` : 'off')),
    b.schedule.nightly ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: b.schedule.offsite, onchange: async (e) => { try { await api(`/backups/${encodeURIComponent(b.id)}/schedule`, { method: 'PUT', body: { nightly: true, offsite: e.target.checked } }); softRefresh(); } catch (er) { toast(er.message); } } }), 'off-site too') : null) : null;

  const running = b.running ? h('div', { class: 'bk-running' }, h('div', { class: 'bk-bar' }, h('i')), h('span', { class: 'small' }, `Backing up${b.running.offsite ? ' and copying off-site' : ''} — started ${fmt.ago(b.running.startedAt)}${b.running.nightly ? ' (nightly)' : ''}`)) : null;

  const sources = b.sources.length ? h('div', { class: 'bk-sources' }, b.sources.sort((x, y) => (y.newestTs || 0) - (x.newestTs || 0)).map((x) => h('div', { class: 'bk-src' },
    h('span', { class: `bk-dot ${ROLE_DOT[x.role] || ''}` }),
    h('div', { class: 'bk-src-t' },
      h('b', null, x.label),
      h('span', { class: 'mono' }, x.dir),
      h('span', null, [x.count != null ? `${x.count} kept` : null, x.bytes ? fmt.bytes(x.bytes) : null, x.newest ? `newest ${x.newest}` : null].filter(Boolean).join(' · '))),
    h('div', { class: 'bk-src-r' },
      h('b', { class: `age ${x.role === 'release' ? '' : ageClass(x.newestTs, maxH)}` }, x.newestTs ? fmt.ago(x.newestTs) : '—'),
      checkBadge(x.check)))))
    : h('div', { class: 'bk-empty' }, plan ? 'No backups found on the server.' : 'No backups found, and Pulse has no plan for this one.');

  const off = b.offsite.nightly
    ? h('div', { class: 'bk-off ok' }, h('span', { class: 'bk-dot b-off' }), h('div', null, h('b', null, 'Off-site every night'), h('span', null, `OneDrive (${(b.offsite.nightly.remotes || []).join(' ')}) → ${b.offsite.nightly.folder}/Backups${b.offsite.nightly.cron && b.offsite.nightly.cron[0] ? ` · cron ${b.offsite.nightly.cron[0].schedule}` : ''}${b.offsite.nightly.lastRun ? ` · last ran ${fmt.ago(b.offsite.nightly.lastRun)}` : ''}`)))
    : b.offsite.pulse
      ? h('div', { class: 'bk-off ok' }, h('span', { class: 'bk-dot b-off' }), h('div', null, h('b', null, 'Copied off-site by Pulse'), h('span', null, `${fmt.ago(b.offsite.pulse.ts)} to ${b.offsite.pulse.remotes.join(' ')}`)))
      : h('div', { class: 'bk-off none' }, h('span', { class: 'bk-dot b-none' }), h('div', null, h('b', null, 'No off-site copy'), h('span', null, plan ? 'Back up now with “Copy to OneDrive” ticked, or switch on the nightly backup below.' : 'Nothing copies this off the server.')));

  const hist = b.history.length ? h('details', { class: 'bk-hist' }, h('summary', null, `Pulse backups (${b.history.length})`),
    h('div', { class: 'bk-hlist' }, b.history.slice(0, 8).map((r) => h('div', { class: `bk-h ${r.ok ? 'ok' : 'bad'}` },
      h('div', { class: 'bk-h-top' }, h('b', null, r.ok ? '✓' : '✗'), h('span', null, fmt.time(r.ts, true)), r.bytes ? h('span', { class: 'muted' }, fmt.bytes(r.bytes)) : null, r.seconds != null ? h('span', { class: 'muted' }, `${r.seconds} s`) : null,
        (r.offsite || []).map((o) => h('span', { class: `pill ${o.ok ? 'live' : 'crit'}`, title: o.error || '' }, `${o.remote} ${o.ok ? '✓' : '✗'}`))),
      h('ul', null, (r.checks || []).map((c) => h('li', null, c)), r.error ? h('li', { class: 'err-li' }, r.error) : null))))) : null;

  return h('div', { class: `bk-card v-${b.verdict}${b.watched ? '' : ' off'}`, id: `bk-${b.id}` },
    h('div', { class: 'bk-head' },
      avatar(b.name),
      h('div', { class: 'bk-title' }, h('b', null, b.name), h('span', { title: vwhy }, vwhy)),
      h('div', { class: 'bk-age' }, h('span', { class: `bk-verdict ${vc}` }, vt), h('span', { class: 'small muted' }, b.newestTs ? `newest ${fmt.ago(b.newestTs)}` : 'never'))),
    running,
    sources,
    off,
    plan ? h('details', { class: 'bk-plan' }, h('summary', null, 'What “Back up now” includes'), h('ul', null, plan.includes.map((x) => h('li', null, x))),
      h('p', { class: 'tiny muted' }, `Kept on the server in /var/backups/pulse/${b.id} (newest 14, readable by root only)${plan.folder ? `; off-site to OneDrive → ${plan.folder}/Backups` : ''}. Every backup is checked before it counts.`)) : null,
    b.note ? h('p', { class: 'small muted', style: { margin: 0 } }, b.note) : null,
    plan && d.canManage ? h('div', { class: 'bk-actions' }, runBtn, h('label', { class: 'check small' }, offBox, 'Copy to OneDrive too')) : null,
    nightly,
    hist);
}

route(/^\/backups$/, async () => {
  const d = await load('/backups');
  const n = (v) => d.apps.filter((b) => b.verdict === v).length;
  const off = d.offsite;
  const timeIn = h('input', { type: 'time', value: d.schedule.time, id: 'bt', style: { width: '100%' } });
  show(shell('backups', [
    pageTop('Backups', h('span', { class: 'tiny muted' }, d.scanTs ? `server checked ${fmt.ago(d.scanTs)}` : 'waiting for the first scan')),
    offlineNote(d),
    h('div', { class: 'bk-summary' },
      [['ok', 'Protected'], ['local', 'Not off-site'], ['stale', 'Out of date'], ['bad', 'Check failed'], ['none', 'Not backed up']].map(([k, label]) =>
        h('div', { class: `bk-sum v-${k}${n(k) ? '' : ' zero'}` }, h('b', null, String(n(k))), h('span', null, label)))),
    h('div', { class: 'grid g2', style: { marginTop: '12px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Off-site job')),
        off ? [h('p', { class: 'small', style: { margin: '0 0 6px' } }, `Every night ${off.cron[0] ? `(cron ${off.cron[0].schedule}, ${off.cron[0].command})` : ''} the server copies the newest backup of ${off.apps.map((x) => x.folder).join(', ')} to OneDrive (${off.remotes.join(' ')}).`),
          h('p', { class: 'tiny muted', style: { margin: 0 } }, `${off.scripts[0]}${off.lastRun ? ` · last ran ${fmt.ago(off.lastRun)}` : ''}. IFAIMA, Pledges and the databases are not in it — use “Copy to OneDrive too” or the nightly switch below.`)]
          : h('p', { class: 'small muted' }, 'No nightly off-site job found on the server.')),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Nightly backups by Pulse')),
        h('p', { class: 'small', style: { margin: '0 0 8px' } }, 'Apps you switch on below are backed up — and checked — every night, one after another.'),
        h('div', { class: 'row wrap field-row' }, h('label', { class: 'field', for: 'bt', style: { margin: 0, width: '150px' } }, `Time (${zoneName(HOME_TZ)} time)`, timeIn),
          d.canManage ? h('button', { class: 'btn', onclick: async () => { try { await api('/backups-time', { method: 'PUT', body: { time: timeIn.value } }); toast('Saved'); } catch (e) { toast(e.message); } } }, 'Save') : null))),
    h('div', { class: 'bk-grid' }, d.apps.map((b) => backupCard(b, d))),
  ]));
});

// ===================================================================== Errors
// 24 hourly bars, oldest left. Height is relative to the busiest hour.
function errBars(trend = [], size = '') {
  const max = Math.max(1, ...trend);
  return h('div', { class: `ebars ${size}`, title: `${trend.reduce((a, b) => a + b, 0)} in the last 24 h` },
    trend.map((n) => h('i', { class: n ? null : 'z', style: { height: `${n ? Math.max(12, Math.round((n / max) * 100)) : 6}%` } })));
}
const ERR_STATUS = { open: ['Open', 'crit'], known: ['Known', ''], fixed: ['Fixed', 'live'] };
function errStatus(st) { const [t, c] = ERR_STATUS[st] || [st, '']; return h('span', { class: `pill ${c}` }, t); }

route(/^\/errors(?:\?(.*))?$/, async (q) => {
  const qs = new URLSearchParams(q || '');
  const f = { app: qs.get('app') || S.errApp || '', status: S.errStatus || 'open', range: S.errRange || '7d' };
  const d = await load(`/errors?range=${f.range}${f.status !== 'all' ? `&status=${f.status}` : ''}${f.app ? `&app=${encodeURIComponent(f.app)}` : ''}`);
  const go = () => { S.errApp = f.app; S.errStatus = f.status; S.errRange = f.range; location.hash = f.app ? `#/errors?app=${encodeURIComponent(f.app)}` : '#/errors'; render(); };
  const tabs = h('div', { class: 'seg' }, [['open', 'Open'], ['known', 'Known'], ['fixed', 'Fixed'], ['all', 'All']].map(([k, label]) =>
    h('button', { type: 'button', class: f.status === k ? 'on' : null, onclick: () => { f.status = k; go(); } }, label)));
  const appSel = h('select', { 'aria-label': 'App', onchange: (e) => { f.app = e.target.value; go(); } }, h('option', { value: '' }, 'All apps'),
    [...new Map([...d.apps, ...(f.app && !d.apps.some((a) => a.id === f.app) ? [{ id: f.app, name: f.app }] : [])].map((a) => [a.id, a])).values()].map((a) => h('option', { value: a.id, selected: a.id === f.app }, a.name)));
  const total24 = d.groups.reduce((n, g) => n + g.last24h, 0);
  show(shell('errors', [
    pageTop('Errors', rangePicker(f.range, [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d']], (r) => { f.range = r; go(); })),
    offlineNote(d),
    h('div', { class: 'hint-bar' }, h('span', null, 'Each card is one ', h('b', null, 'kind'), ' of error, however many times it happened. Open one to see the full error, where in the code it happened, the log lines around it, the page that failed, and what to do.')),
    h('div', { class: 'row wrap filters', style: { margin: '6px 0 12px' } }, tabs, appSel, h('span', { class: 'tiny muted' }, `${d.groups.length} kind${d.groups.length === 1 ? '' : 's'} · ${total24} in the last 24 h`)),
    d.groups.length ? h('div', { class: 'err-list' }, d.groups.map((g) => h('a', { class: `err-card st-${g.status}`, href: `#/errors/${g.id}` },
      h('div', { class: 'ec-main' },
        h('div', { class: 'ec-top' }, h('span', { class: 'app-chip' }, g.appName), errStatus(g.status), h('span', { class: 'tiny muted' }, g.hint)),
        h('b', { class: 'ec-title' }, g.title),
        g.message ? h('div', { class: 'ec-msg' }, g.message) : null,
        g.frame ? h('div', { class: 'ec-frame mono' }, g.frame) : null),
      h('div', { class: 'ec-side' },
        h('div', { class: 'ec-n' }, h('b', null, String(g.last24h)), h('span', null, 'last 24 h')),
        errBars(g.trend),
        h('div', { class: 'tiny muted' }, `${g.total} in all · last ${fmt.ago(g.last_seen)}`)))))
      : h('div', { class: 'card empty' }, f.status === 'open' ? 'No open errors. Nicely done.' : 'Nothing here.'),
  ]));
});

function logLine(x, cls) {
  const t = x.ts ? new Date(x.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  return h('div', { class: `ll ${cls || ''}` }, h('span', { class: 'lt' }, t), h('span', { class: 'lx' }, x.text));
}
// The error block: app frames stand out, runtime frames fade.
function blockLines(e) {
  return e.block.split('\n').map((text) => {
    const frame = /^\s+at\s/.test(text);
    const app = frame && !/\s(System|Microsoft|Npgsql|MySql|lambda_method)|node_modules|node:|internal\//.test(text);
    return h('div', { class: `ll err${frame ? (app ? ' app' : ' lib') : ''}` }, h('span', { class: 'lt' }, ''), h('span', { class: 'lx' }, text));
  });
}
function occurrenceText(e) {
  return [...(e.before || []).map((x) => x.text), '', ...e.block.split('\n'), '', ...(e.after || []).map((x) => x.text)].join('\n');
}

route(/^\/errors\/(\d+)$/, async (id) => {
  const d = await load(`/errors/${id}`);
  const g = d.group;
  let sel = 0;
  const occBox = h('div');
  const picker = h('div', { class: 'occ-pick' });
  function paintOcc() {
    picker.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === sel));
    const e = g.events[sel];
    if (!e) { occBox.replaceChildren(h('div', { class: 'empty' }, 'The full text of this error is kept for 7 days; none is left for this one.')); return; }
    occBox.replaceChildren(
      e.requests && e.requests.length
        ? h('div', { class: 'occ-req' }, h('span', { class: 'small ink2' }, 'Failed at that moment:'), e.requests.map((r) => h('span', { class: 'req' }, h('b', null, r.method || '?'), ` ${r.path || '?'} `, h('span', { class: 'rs' }, String(r.status)), h('span', { class: 'rt' }, ` ${new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`))))
        : h('div', { class: 'occ-req muted small' }, 'No failed web request at that moment — it happened in the background, or the app is not served through Apache.'),
      h('div', { class: 'logview' },
        h('div', { class: 'lv-h' }, h('span', null, `${e.unit || g.app} · ${fmt.time(e.ts, true)}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(occurrenceText(e)); toast('Copied the log lines'); } catch { toast('Select and copy'); } } }, 'Copy')),
        h('div', { class: 'lv-body' },
          (e.before || []).length ? (e.before || []).map((x) => logLine(x, 'ctx')) : h('div', { class: 'll ctx' }, h('span', { class: 'lt' }, ''), h('span', { class: 'lx' }, '(nothing logged just before)')),
          blockLines(e),
          (e.after || []).map((x) => logLine(x, 'ctx')))),
      h('div', { class: 'cmd' }, h('div', { class: 'small ink2' }, 'See the full log around this moment, on the server:'),
        h('div', { class: 'cmd-row' }, h('code', null, e.command),
          h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(e.command); toast('Copied'); } catch { toast('Select and copy'); } } }, 'Copy'))));
    // Open the log at the error, with a few lines of lead-in above it.
    requestAnimationFrame(() => { const body = occBox.querySelector('.lv-body'); const first = body && body.querySelector('.ll.err'); if (body && first) body.scrollTop = Math.max(0, first.offsetTop - body.offsetTop - 70); });
  }
  g.events.forEach((e, i) => picker.append(h('button', { type: 'button', onclick: () => { sel = i; paintOcc(); } }, new Date(e.ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }))));

  const setStatus = (status, label) => {
    const note = h('input', { type: 'text', id: 'en', maxlength: 300, placeholder: status === 'known' ? 'e.g. harmless — users retry' : 'e.g. fixed in release 1.4' });
    const err = h('div', { class: 'err' });
    modal(label, h('div', { class: 'form' },
      h('p', { class: 'small ink2', style: { margin: 0 } }, status === 'known'
        ? 'Pulse will keep counting it but will not alert you about it again.'
        : status === 'fixed' ? 'If it ever happens again, it reopens and Pulse tells you.' : 'It goes back on the open list.'),
      h('label', { class: 'field', for: 'en' }, 'Note (optional)', note), err), (close) => [
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => { try { await api(`/errors/${g.id}`, { method: 'PUT', body: { status, note: note.value.trim() || null } }); close(); toast('Saved'); render(); } catch (e) { err.textContent = e.message; } } }, 'Save'),
    ]);
  };
  const actions = d.canManage ? h('div', { class: 'row wrap' },
    g.status !== 'fixed' ? h('button', { class: 'btn primary', onclick: () => setStatus('fixed', 'Mark as fixed?') }, 'Mark as fixed') : null,
    g.status !== 'known' ? h('button', { class: 'btn', onclick: () => setStatus('known', 'Mark as known?') }, 'Known — stop alerting') : null,
    g.status !== 'open' ? h('button', { class: 'btn', onclick: () => setStatus('open', 'Reopen?') }, 'Reopen') : null) : null;

  show(shell('errors', [
    pageTop(g.title, errStatus(g.status)),
    offlineNote(d),
    h('div', { class: 'err-hero' },
      h('div', { class: 'eh-main' },
        h('div', { class: 'ec-top' }, h('a', { class: 'app-chip', href: `#/apps/${encodeURIComponent(g.app)}` }, g.appName), g.type ? h('span', { class: 'pill mono' }, g.type) : null),
        g.message ? h('div', { class: 'eh-msg' }, g.message) : null,
        g.frame ? h('div', { class: 'eh-where' }, h('span', null, g.frame_is_app ? 'Where in the code' : 'Where'), h('code', null, g.frame)) : null,
        g.status !== 'open' && g.status_by ? h('div', { class: 'tiny muted' }, `Marked ${g.status} by ${String(g.status_by).split('@')[0]} ${g.status_at ? fmt.ago(g.status_at) : ''}${g.note ? ` — “${g.note}”` : ''}`) : null,
        actions),
      h('div', { class: 'eh-stats' },
        h('div', null, h('b', null, String(g.last24h)), h('span', null, 'last 24 h')),
        h('div', null, h('b', null, String(g.total)), h('span', null, 'in all')),
        h('div', null, h('b', null, fmt.ago(g.last_seen)), h('span', null, 'last seen')),
        h('div', null, h('b', null, fmt.short(g.first_seen)), h('span', null, 'first seen')),
        h('div', { class: 'eh-bars' }, errBars(g.trend, 'big'), h('span', { class: 'tiny muted' }, 'per hour, last 24 h')))),
    h('div', { class: 'grid g2', style: { marginTop: '14px' } },
      h('div', { class: 'card hint-card' }, h('div', { class: 'card-h' }, h('h2', null, 'What this usually means')),
        h('b', { class: 'hc-t' }, d.hint.title), h('p', { class: 'small ink2' }, d.hint.cause),
        h('h3', null, 'What to try'), h('ol', { class: 'small' }, d.hint.steps.map((x) => h('li', null, x)))),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'How to read the log below')),
        h('ul', { class: 'small ink2 legend-list' },
          h('li', null, h('span', { class: 'sw err' }), 'The error itself, as the app logged it.'),
          h('li', null, h('span', { class: 'sw app' }), h('span', null, h('b', null, 'Bold yellow'), ' lines are in your app’s own code — the top one is where it broke.')),
          h('li', null, h('span', { class: 'sw lib' }), 'Faded lines are inside .NET / Node or a library: usually not where to look.'),
          h('li', null, h('span', { class: 'sw ctx' }), 'Grey lines are what the app logged just before and after.')),
        h('p', { class: 'tiny muted' }, 'Passwords, tokens, emails and IP addresses are masked before anything is stored. Kept 7 days.'))),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-h' }, h('h2', null, 'Occurrences'), h('span', { class: 'tiny muted' }, g.events.length ? `latest ${g.events.length} kept in full` : '')),
      picker, occBox),
  ]));
  paintOcc();
});

// ===================================================================== Sign-ins
function flag(cc) {
  if (!cc || cc === 'LAN' || !/^[A-Z]{2}$/.test(cc)) return cc === 'LAN' ? 'local' : '';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) + ' ' + cc;
}
const REASONS = { 'incorrect-credentials': 'wrong password', 'locked-out': 'locked out', 'account-switched-off': 'account switched off', 'ok-after-password-change': 'new password set', ok: 'signed in' };

function onlineRow(p, appName) {
  return h('div', { class: 'who' },
    h('span', { class: 'who-av' }, avatar(p.name || p.email || '?'), h('i', { class: 'pulse-dot' })),
    h('div', { class: 'who-id' }, h('b', null, p.name || p.email || `user ${p.user_id}`), h('span', null, p.name && p.email ? p.email : '')),
    h('div', { class: 'who-tags' }, h('span', { class: 'app-chip' }, appName(p.app)), p.role ? h('span', { class: 'pill' }, p.role) : null),
    h('div', { class: 'who-meta' }, h('span', null, [p.device, flag(p.country)].filter(Boolean).join(' · ')), h('b', null, fmt.ago(p.last_seen))));
}

route(/^\/signins$/, async () => {
  let range = S.signinRange || '24h';
  let filt = { app: S.signinApp || '', failed: false, q: '' };
  const d = await load(`/signins?range=${range}`);
  const names = Object.fromEntries(d.apps.map((a) => [a.id, a.name]));
  const appName = (id) => names[id] || id;

  const ordered = [...d.apps].sort((a, b) => (b.connected - a.connected) || (b.id === 'pulse') - (a.id === 'pulse') || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const tiles = h('div', { class: 'sign-apps' }, ordered.map((a) => h('button', { type: 'button', class: `sign-app${a.connected ? '' : ' off'}${filt.app === a.id ? ' on' : ''}`, 'data-app': a.id, onclick: () => { filt.app = filt.app === a.id ? '' : a.id; S.signinApp = filt.app; tiles.querySelectorAll('.sign-app').forEach((x) => x.classList.toggle('on', x.dataset.app === filt.app)); appSel.value = filt.app; paint(); } },
    h('div', { class: 'sa-top' }, avatar(a.name), h('b', null, a.name)),
    a.connected
      ? [h('div', { class: 'sa-n' }, h('span', { class: `num${a.online ? ' live' : ''}` }, String(a.online)), h('small', null, 'online now')),
        h('div', { class: 'sa-sub' }, `${a.ok} sign-in${a.ok === 1 ? '' : 's'}`, a.failed ? h('span', { class: 'bad' }, ` · ${a.failed} failed`) : null)]
      : [h('div', { class: 'sa-n' }, h('span', { class: 'num dim' }, '—'), h('small', null, 'not connected')), h('div', { class: 'sa-sub' }, 'Needs the Pulse reporter')])));

  const onlineBox = h('div', { class: 'who-list' });
  const histBody = h('div');
  const appSel = h('select', { id: 'sf-app', 'aria-label': 'App' }, h('option', { value: '' }, 'All apps'), d.apps.map((a) => h('option', { value: a.id, selected: a.id === filt.app }, a.name)));
  const failedOnly = h('input', { type: 'checkbox' });
  const search = h('input', { type: 'search', placeholder: 'Name, email or IP', 'aria-label': 'Search' });
  appSel.addEventListener('change', () => { filt.app = appSel.value; S.signinApp = filt.app; tiles.querySelectorAll('.sign-app').forEach((x) => x.classList.toggle('on', x.dataset.app === filt.app)); paint(); });
  failedOnly.addEventListener('change', () => { filt.failed = failedOnly.checked; paint(); });
  search.addEventListener('input', () => { filt.q = search.value.trim().toLowerCase(); paint(); });

  function paint() {
    const on = d.online.filter((p) => !filt.app || p.app === filt.app);
    onlineBox.replaceChildren(...(on.length ? on.map((p) => onlineRow(p, appName)) : [h('div', { class: 'empty' }, filt.app ? `Nobody is using ${appName(filt.app)} right now.` : 'Nobody is using the apps right now.')]));
    const rows = d.recent.filter((r) => (!filt.app || r.app === filt.app) && (!filt.failed || !r.ok)
      && (!filt.q || [r.email, r.name, r.ip].some((x) => x && x.toLowerCase().includes(filt.q))));
    histBody.replaceChildren(rows.length
      ? h('div', { class: 'tablewrap' }, h('table', { class: 'sign-table' },
        h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'App'), h('th', null, 'Result'), h('th', null, 'Device'), h('th', null, 'From'))),
        h('tbody', null, rows.slice(0, 200).map((r) => h('tr', { class: r.ok ? null : 'fail' },
          h('td', { class: 'muted nowrap' }, fmt.short(r.ts)),
          h('td', null, h('div', { class: 'cell-who' }, avatar(r.name || r.email || '?'), h('div', null, h('b', null, r.name || r.email || 'unknown'), r.name ? h('span', null, r.email) : null))),
          h('td', null, h('span', { class: 'app-chip' }, appName(r.app))),
          h('td', null, r.ok ? h('span', { class: 'st up' }, 'Signed in') : h('span', { class: 'st down' }, REASONS[r.reason] || r.reason || 'failed')),
          h('td', { class: 'muted' }, r.device || ''),
          h('td', { class: 'muted nowrap' }, h('span', { class: 'mono' }, r.ip || ''), r.country ? ` ${flag(r.country)}` : ''))))))
      : h('div', { class: 'empty' }, 'No sign-ins match.'));
    const n = document.getElementById('online-n'); if (n) n.textContent = on.length;
  }

  const notConnected = d.apps.filter((a) => !a.connected);
  show(shell('signins', [
    pageTop('Sign-ins', rangePicker(range, [['24h', '24 h'], ['7d', '7 d'], ['30d', '30 d']], (r) => { S.signinRange = r; render(); })),
    offlineNote(d),
    tiles,
    h('div', { class: 'sec-h' }, h('h2', null, 'Signed in now'), h('span', { class: 'count up', id: 'online-n' }, '0'), h('span', { class: 'tiny muted' }, `used an app in the last ${d.onlineWindowMin} minutes`)),
    h('div', { class: 'card' }, onlineBox),
    h('div', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'card-h' }, h('h2', null, 'History'), h('span', { class: 'tiny muted' }, 'newest first')),
      h('div', { class: 'hist-filters filters' }, appSel, search, h('label', { class: 'check small' }, failedOnly, 'Failed only')),
      histBody),
    notConnected.length ? h('p', { class: 'tiny muted', style: { marginTop: '14px' } }, `Not connected yet: ${notConnected.map((a) => a.name).join(', ')}. Each needs the small Pulse reporter added (see RUNBOOK §9). Only names, emails, role, IP, country and device are kept — never passwords or app data — for 90 days.`) : null,
  ]));
  paint();
});

// ===================================================================== People
const ROLE_INFO = {
  owner: { blurb: 'Everything: people, where alerts go, and all of the below.', can: ['Add and switch off people', 'Change where alerts go', 'Everything an Admin can do'] },
  admin: { blurb: 'Runs the monitor day to day.', can: ['Acknowledge and answer alerts', 'Switch apps on and off', 'Trusted list, thresholds, maintenance'] },
  viewer: { blurb: 'Sees everything, changes nothing.', can: ['Dashboard, apps and server', 'Access log and alerts', 'No buttons that change anything'] },
};

function codeField(id) {
  return h('input', { type: 'text', maxlength: 11, autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', id, placeholder: '6-digit code or a backup code' });
}

// Shown once. The owner passes it on by phone or in person — never by email.
function showTempPassword(email, pw, fresh) {
  const out = h('div', { class: 'temp-pw mono' }, pw);
  modal(fresh ? 'Login created' : 'New one-time password', h('div', { class: 'form' },
    h('p', { class: 'small ink2', style: { margin: 0 } }, `Give this to ${email} by phone or in person. It is shown only now.`),
    out,
    h('ol', { class: 'small ink2 steps' },
      h('li', null, 'They open monitor.smartdeontech.com and sign in with it.'),
      h('li', null, 'Pulse makes them choose their own password.'),
      h('li', null, 'Then they set up two-factor with an authenticator app.'))), (close) => [
    h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(pw); toast('Copied'); } catch { toast('Select it and copy'); } } }, 'Copy'),
    h('button', { class: 'btn primary', onclick: () => { close(); render(); } }, 'Done'),
  ]);
}

function addPerson(roles) {
  const name = h('input', { type: 'text', id: 'pn', maxlength: 60, placeholder: 'Full name' });
  const email = h('input', { type: 'email', id: 'pe', placeholder: 'name@example.com', autocapitalize: 'off' });
  let role = 'viewer';
  const picks = h('div', { class: 'role-pick' }, roles.map((r) => {
    const b = h('button', { type: 'button', class: `rp${r.key === role ? ' on' : ''}`, 'data-role': r.key, onclick: () => { role = r.key; picks.querySelectorAll('.rp').forEach((x) => x.classList.toggle('on', x.dataset.role === role)); } },
      h('b', null, roleName(r.key)), h('span', null, ROLE_INFO[r.key] ? ROLE_INFO[r.key].blurb : ''));
    return b;
  }));
  const code = codeField('pc');
  const err = h('div', { class: 'err' });
  modal('Add a person', h('div', { class: 'form' },
    h('label', { class: 'field', for: 'pn' }, 'Name', name), h('label', { class: 'field', for: 'pe' }, 'Email (their login)', email),
    h('div', { class: 'field' }, 'Role', picks),
    h('label', { class: 'field', for: 'pc' }, 'Your 2FA code', code),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Adding a login raises an alert, by design — so nobody can add one quietly.'), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => {
      try { const r = await api('/users', { method: 'POST', body: { name: name.value, email: email.value, role, code: code.value } }); close(); showTempPassword(r.user.email, r.tempPassword, true); }
      catch (e) { err.textContent = e.message; }
    } }, 'Create login'),
  ]);
  setTimeout(() => name.focus(), 50);
}

function switchOffPerson(u) {
  const reason = h('input', { type: 'text', id: 'pr', maxlength: 200, placeholder: 'e.g. left the company, phone lost' });
  const err = h('div', { class: 'err' });
  modal(`Switch off ${u.name}?`, h('div', { class: 'form' },
    h('p', { class: 'small ink2', style: { margin: 0 } }, 'They are signed out at once and cannot sign in. Their phone stops getting alerts. Nothing is deleted — you can switch them back on.'),
    h('label', { class: 'field', for: 'pr' }, 'Reason (kept with the account)', reason), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn danger-solid', onclick: async () => { try { await api(`/users/${u.id}/status`, { method: 'POST', body: { enabled: false, reason: reason.value } }); close(); toast(`${u.name} switched off`); render(); } catch (e) { err.textContent = e.message; } } }, 'Switch off'),
  ]);
  setTimeout(() => reason.focus(), 50);
}

function changeRole(u, roles) {
  const sel = h('select', { id: 'rr' }, roles.map((r) => h('option', { value: r.key, selected: r.key === u.role }, roleName(r.key))));
  const code = codeField('rc');
  const err = h('div', { class: 'err' });
  modal(`Role for ${u.name}`, h('div', { class: 'form' },
    h('label', { class: 'field', for: 'rr' }, 'Role', sel), h('label', { class: 'field', for: 'rc' }, 'Your 2FA code', code),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'They are signed out and sign in again with the new role.'), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => { try { await api(`/users/${u.id}`, { method: 'PUT', body: { role: sel.value, code: code.value } }); close(); toast('Role changed'); render(); } catch (e) { err.textContent = e.message; } } }, 'Save'),
  ]);
}

function resetPerson(u) {
  const clear = h('input', { type: 'checkbox' });
  const code = codeField('xc');
  const err = h('div', { class: 'err' });
  modal(`Reset ${u.name}’s password?`, h('div', { class: 'form' },
    h('p', { class: 'small ink2', style: { margin: 0 } }, 'They get a new one-time password and are signed out everywhere.'),
    h('label', { class: 'check small' }, clear, 'Also clear two-factor and passkeys (lost or new phone)'),
    h('label', { class: 'field', for: 'xc' }, 'Your 2FA code', code), err), (close) => [
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    h('button', { class: 'btn primary', onclick: async () => { try { const r = await api(`/users/${u.id}/reset`, { method: 'POST', body: { reset2fa: clear.checked, code: code.value } }); close(); showTempPassword(u.email, r.tempPassword, false); } catch (e) { err.textContent = e.message; } } }, 'Reset'),
  ]);
}

function personCard(u, me, roles) {
  const self = u.id === me;
  const state = u.disabled ? h('span', { class: 'pill crit' }, 'Switched off')
    : u.mustChangePassword ? h('span', { class: 'pill warn' }, 'Hasn’t signed in yet')
      : !u.twoFactorEnabled ? h('span', { class: 'pill warn' }, '2FA not set up')
        : h('span', { class: 'pill live' }, '2FA on');
  return h('div', { class: `person${u.disabled ? ' off' : ''}` },
    h('div', { class: 'p-top' },
      avatar(u.name),
      h('div', { class: 'p-id' }, h('b', null, u.name, self ? h('span', { class: 'you' }, 'you') : null), h('span', null, u.email)),
      self ? null : toggleSwitch(!u.disabled, (on) => (on
        ? withCode(`Switch ${u.name} back on?`, (code) => api(`/users/${u.id}/status`, { method: 'POST', body: { enabled: true, code } }))
        : switchOffPerson(u)), { label: u.disabled ? `Switch ${u.name} on` : `Switch ${u.name} off` })),
    h('div', { class: 'p-tags' }, h('span', { class: `role-tag r-${u.role}` }, roleName(u.role)), state,
      u.passkeys ? h('span', { class: 'pill' }, `${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}`) : null),
    u.disabled
      ? h('div', { class: 'p-why' }, `“${u.disabledReason || 'no reason given'}” — ${u.disabledBy ? u.disabledBy.split('@')[0] : ''}${u.disabledAt ? `, ${fmt.ago(Date.parse(u.disabledAt))}` : ''}`)
      : h('div', { class: 'p-meta' }, u.lastLogin ? `Last signed in ${fmt.ago(u.lastLogin)}` : 'Never signed in', u.createdBy ? ` · added by ${u.createdBy.split('@')[0]}` : ''),
    self ? null : h('div', { class: 'p-actions' },
      u.disabled ? null : h('button', { class: 'btn small', onclick: () => changeRole(u, roles) }, 'Change role'),
      u.disabled ? null : h('button', { class: 'btn small', onclick: () => resetPerson(u) }, 'Reset password'),
      u.disabled ? h('button', { class: 'btn small danger', onclick: () => withCode(`Remove ${u.name} for good?`, (code) => api(`/users/${u.id}`, { method: 'DELETE', body: { code } })) }, 'Remove for good') : null));
}

route(/^\/people$/, async () => {
  if (!can('staff.manage')) { location.hash = '#/'; return; }
  const d = await load('/users');
  const active = d.users.filter((u) => !u.disabled);
  const off = d.users.filter((u) => u.disabled);
  show(shell('people', [
    pageTop('People', h('button', { class: 'btn primary', onclick: () => addPerson(d.roles) }, '+ Add person')),
    offlineNote(d),
    h('div', { class: 'role-cards' }, d.roles.map((r) => {
      const info = ROLE_INFO[r.key] || { blurb: '', can: [] };
      const n = active.filter((u) => u.role === r.key).length;
      return h('div', { class: `role-card r-${r.key}` },
        h('div', { class: 'rc-h' }, h('b', null, roleName(r.key)), h('span', { class: 'rc-n' }, String(n))),
        h('p', null, info.blurb),
        h('ul', null, info.can.map((x) => h('li', null, x))));
    })),
    h('div', { class: 'sec-h' }, h('h2', null, 'Can sign in'), h('span', { class: 'count up' }, active.length)),
    h('div', { class: 'people-grid' }, active.map((u) => personCard(u, d.me, d.roles))),
    off.length ? [h('div', { class: 'sec-h' }, h('h2', null, 'Switched off'), h('span', { class: 'count' }, off.length)),
      h('div', { class: 'people-grid' }, off.map((u) => personCard(u, d.me, d.roles)))] : null,
    h('p', { class: 'tiny muted', style: { marginTop: '18px' } }, 'Everyone must use two-factor. Adding a login, raising a role or switching someone back on needs your code and raises an alert. Alerts by SMS and email still go to the numbers in Settings; each person can turn on push on their own phone.'),
  ]));
});

function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : 'This device';
}

async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast(/iPhone|iPad/.test(navigator.userAgent) ? 'Add Pulse to your Home Screen first, then open it from there.' : 'This browser cannot receive push notifications.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications were not allowed.');
    const { key } = await api('/push/key');
    const reg = await navigator.serviceWorker.ready;
    const raw = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4));
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), label: deviceName() } });
    toast('Notifications are on for this device.');
    render();
  } catch (e) { toast(e.message || 'Could not turn on notifications.'); }
}

boot();
