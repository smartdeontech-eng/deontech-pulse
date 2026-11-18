// The morning digest: one email a day with what didn't deserve a push —
// logins from new networks in usual countries, how many quiet logins there
// were, failed-login noise, releases, and anything still open.
'use strict';
const { fmtTimes } = require('./channels');

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function digestHtml(d, zones) {
  const li = (arr) => (arr.length ? `<ul>${arr.join('')}</ul>` : '<p style="color:#667085">None.</p>');
  const l = d.latest;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#101828;max-width:600px">
  <h2 style="font-weight:600;margin:0 0 4px">DeonTech Pulse — morning digest</h2>
  <p style="color:#667085;margin:0 0 16px">Last 24 hours, to ${esc(fmtTimes(Date.now(), zones))}</p>
  ${l ? `<p>Now: CPU ${l.cpu}% · memory ${l.mem}% · disk ${l.disk}% · swap ${l.swap}%</p>` : ''}
  <h3>Still open (${d.active.length})</h3>
  ${li(d.active.map((a) => `<li><b>${esc(a.severity)}</b> — ${esc(a.title)}</li>`))}
  <h3>Logins worth a glance</h3>
  ${li(d.digestLines.map((e) => `<li>${esc(fmtTimes(e.ts, zones))}: ${esc(e.user)} from ${esc(e.ip)}${e.country ? ` (${esc(e.country)})` : ''} — ${esc(e.reason)}</li>`))}
  <p>${d.quietLogins} quiet login${d.quietLogins === 1 ? '' : 's'} from trusted sources; ${d.releaseEvents} access event${d.releaseEvents === 1 ? '' : 's'} during releases.</p>
  <p>${d.failed.n} failed SSH attempt${d.failed.n === 1 ? '' : 's'} from ${d.failed.ips} address${d.failed.ips === 1 ? '' : 'es'}.</p>
  <h3>Releases (${d.deploys.length})</h3>
  ${li(d.deploys.map((x) => `<li>${esc(fmtTimes(x.started_at, zones))}: ${esc(x.app === '*' ? 'release' : x.app)} (${esc(x.source)})</li>`))}
  <h3>Alerts opened (${d.opened.length})</h3>
  ${li(d.opened.map((a) => `<li>${esc(a.title)} — ${esc(a.status)}</li>`))}
  <h3>To tidy up</h3>
  ${li((d.findings || []).map((f) => `<li>${esc(f.title)}</li>`))}
  </div>`;
}

// Fires once a day at settings.digestTime in the first time zone.
function createDigestScheduler({ monitor, channels, getSettings, zones = null, log = console }) {
  let lastSentDay = null;
  function tick(now = Date.now()) {
    const s = getSettings();
    const tz = (s.timezones || ['Africa/Accra'])[0];
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(now));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    const day = `${p.year}-${p.month}-${p.day}`;
    const hm = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
    if (hm >= (s.digestTime || '07:00') && lastSentDay !== day) {
      lastSentDay = day;
      const d = monitor.digest();
      channels.email(`Pulse digest — ${day}`, digestHtml(d, zones ? zones() : [(s.timezones || [])[0] || 'Africa/Accra'])).catch((e) => log.error('[digest]', e.message));
      return true;
    }
    return false;
  }
  // Don't send a digest the moment the app starts after 07:00.
  tick.prime = (now = Date.now()) => {
    const s = getSettings();
    const tz = (s.timezones || ['Africa/Accra'])[0];
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
    if (hm >= (s.digestTime || '07:00')) lastSentDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  };
  return tick;
}

module.exports = { digestHtml, createDigestScheduler };
