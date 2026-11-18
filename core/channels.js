// How an alert reaches the owner.
//
//   critical (urgent)  web push + SMS (+ WhatsApp once approved) + email
//   warning            web push + email
//   info               nothing — it is on the timeline
//   resolved           web push (and email, if the alert was critical)
//
// Every channel fails soft: a broken SMS gateway must never stop the push,
// and a delivery failure is itself written to the notification log.
'use strict';
const crypto = require('crypto');

// Home always; a second clock only while the owner is away (core/zones.js).
function fmtTimes(ts, zones = ['Africa/Accra']) {
  return (zones && zones.length ? zones : ['Africa/Accra']).map((z) => {
    const t = new Intl.DateTimeFormat('en-GB', { timeZone: z, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
    return `${t} ${z.split('/').pop().replace(/_/g, ' ')}`;
  }).join(' · ');
}

// Signed links for the buttons on a push notification, so "Yes, it was me"
// works from the lock screen without opening the app. One alert, one action,
// expires in 24 hours.
function actionToken(secret, alertId, action, ttlMs = 24 * 3600_000) {
  const exp = Date.now() + ttlMs;
  const body = `${alertId}.${action}.${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${Buffer.from(body).toString('base64url')}.${sig}`;
}

function verifyActionToken(secret, token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  let body;
  try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const wantBuf = Buffer.from(want), sigBuf = Buffer.from(sig);
  if (wantBuf.length !== sigBuf.length || !crypto.timingSafeEqual(wantBuf, sigBuf)) return null;
  const [alertId, action, exp] = body.split('.');
  if (Number(exp) < Date.now()) return null;
  return { alertId: Number(alertId), action };
}

function createChannels({ db, getSettings, sendMail, sendSms, webpush = null, secret, appUrl = '', canAct = () => true, canReceive = () => true, zones = null, log = console }) {
  const vapid = {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:smartdeontech@gmail.com',
  };
  if (webpush && vapid.publicKey && vapid.privateKey) {
    try { webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey); } catch (e) { log.error('[push] bad VAPID keys:', e.message); webpush = null; }
  } else webpush = null;

  const sent = [];   // last deliveries, for the Alerts page
  function record(channel, ok, info) {
    sent.unshift({ ts: Date.now(), channel, ok, info });
    if (sent.length > 50) sent.pop();
  }

  async function push(payload) {
    if (!webpush) return { skipped: 'no-vapid' };
    const subs = db.sql.all('SELECT * FROM push_subs').filter((x) => canReceive(x.user_id));
    let ok = 0;
    for (const s of subs) {
      // Answer buttons carry signed links; only people allowed to act get them.
      const body = payload.actions && payload.actions.length && !canAct(s.user_id) ? { ...payload, actions: [] } : payload;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, JSON.stringify(body), { TTL: 3600, urgency: payload.urgency || 'normal' });
        db.sql.run('UPDATE push_subs SET last_ok_at = ?, failures = 0 WHERE id = ?', Date.now(), s.id);
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) db.sql.run('DELETE FROM push_subs WHERE id = ?', s.id);
        else db.sql.run('UPDATE push_subs SET failures = failures + 1 WHERE id = ?', s.id);
        log.error('[push]', e.statusCode || '', e.message);
      }
    }
    record('push', ok > 0, `${ok}/${subs.length} devices`);
    return { ok, of: subs.length };
  }

  async function sms(text) {
    const s = getSettings();
    if (!s.channels.sms) return { skipped: 'disabled' };
    if (!s.ownerPhone) return { skipped: 'no-phone' };
    const r = await sendSms({ to: s.ownerPhone, message: text.slice(0, 300) });
    record('sms', !r.error && !r.skipped, r.error || r.skipped || 'sent');
    return r;
  }

  async function whatsapp(text) {
    const s = getSettings();
    if (!s.channels.whatsapp || !process.env.WHATSAPP_TOKEN) return { skipped: 'not-approved-yet' };
    // Phase 3: Meta Cloud API with the approved template. Until then SMS carries urgent alerts.
    log.log('[whatsapp] template sending not built yet:', text.slice(0, 80));
    return { skipped: 'not-built' };
  }

  async function email(subject, html) {
    const s = getSettings();
    if (!s.channels.email) return { skipped: 'disabled' };
    const to = s.ownerEmail || process.env.NOTIFY_EMAIL;
    if (!to) return { skipped: 'no-email' };
    const r = await sendMail({ to, subject, html });
    record('email', !r.error && !r.skipped, r.error || r.skipped || 'sent');
    return r;
  }

  function buttonsFor(alert) {
    if (alert.rule === 'access') {
      return [
        { action: 'yes', title: 'Yes, it was me', url: `${appUrl}/api/alerts/action?t=${actionToken(secret, alert.id, 'yes')}` },
        { action: 'no', title: 'No — not me', url: `${appUrl}/api/alerts/action?t=${actionToken(secret, alert.id, 'no')}` },
      ];
    }
    return [
      { action: 'ack', title: 'Acknowledge', url: `${appUrl}/api/alerts/action?t=${actionToken(secret, alert.id, 'ack')}` },
      { action: 'snooze', title: 'Snooze 1 h', url: `${appUrl}/api/alerts/action?t=${actionToken(secret, alert.id, 'snooze')}` },
    ];
  }

  // The one entry point the alert engine uses.
  async function deliver(alert, { resolved = false, quiet = false } = {}) {
    const s = getSettings();
    const when = fmtTimes(alert.updated_at || Date.now(), zones ? zones() : [(s.timezones || [])[0] || 'Africa/Accra']);
    const prefix = resolved ? 'Resolved' : alert.severity === 'critical' ? 'URGENT' : 'Warning';
    const title = `${prefix}: ${alert.title}`;
    const body = [alert.detail && typeof alert.detail === 'object' ? alert.detail.summary : alert.detail, when].filter(Boolean).join('\n');
    const tasks = [];
    const doPush = s.channels.push && !(quiet && alert.severity !== 'critical');
    if (doPush) {
      tasks.push(push({
        title, body, tag: `alert-${alert.key}`, alertId: alert.id, url: `/#/alerts/${alert.id}`,
        severity: resolved ? 'resolved' : alert.severity,
        urgency: alert.severity === 'critical' && !resolved ? 'high' : 'normal',
        requireInteraction: alert.severity === 'critical' && !resolved,
        actions: resolved ? [] : buttonsFor(alert),
      }));
    }
    if (!resolved && alert.severity === 'critical') {
      const text = `${s.shortName || 'Pulse'}: ${alert.title}. ${when}.${alert.rule === 'access' ? ' Was this you? Open Pulse to answer.' : ''}`;
      tasks.push(sms(text));
      tasks.push(whatsapp(text));
    }
    if (!quiet && (alert.severity === 'critical' || (alert.severity === 'warning' && !resolved) || (resolved && alert.severity === 'critical'))) {
      tasks.push(email(title, emailHtml({ alert, when, resolved, appUrl })));
    }
    const results = await Promise.allSettled(tasks);
    return results.map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason && r.reason.message }));
  }

  return { deliver, push, sms, email, whatsapp, recent: () => sent.slice(), vapidPublicKey: () => vapid.publicKey, pushReady: () => !!webpush };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function emailHtml({ alert, when, resolved, appUrl }) {
  const colour = resolved ? '#1f7a4d' : alert.severity === 'critical' ? '#b42318' : '#b54708';
  const d = alert.detail && typeof alert.detail === 'object' ? alert.detail : { summary: alert.detail };
  const rows = Object.entries(d).filter(([k, v]) => k !== 'summary' && v != null && typeof v !== 'object')
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#667085">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#101828;max-width:560px">
  <div style="border-left:4px solid ${colour};padding:4px 12px;margin-bottom:12px">
    <div style="font-size:12px;color:${colour};font-weight:600;text-transform:uppercase;letter-spacing:.04em">${resolved ? 'Resolved' : esc(alert.severity)}</div>
    <div style="font-size:17px;font-weight:600">${esc(alert.title)}</div>
    <div style="color:#667085">${esc(when)}</div>
  </div>
  ${d.summary ? `<p>${esc(d.summary)}</p>` : ''}
  ${rows ? `<table style="font-size:13px">${rows}</table>` : ''}
  ${appUrl ? `<p><a href="${esc(appUrl)}/#/alerts/${alert.id}" style="color:#1d4ed8">Open in DeonTech Pulse</a></p>` : ''}
  <p style="color:#98a2b3;font-size:12px">DeonTech Pulse · monitor.smartdeontech.com</p></div>`;
}

module.exports = { createChannels, actionToken, verifyActionToken, fmtTimes, emailHtml };
