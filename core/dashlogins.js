// Pulse's own sign-ins, watched like SSH logins.
//
// The core raises onNewDevice only for a sign-in logged as reason 'ok' — but
// every Pulse sign-in goes through 2FA or a passkey ('ok-via-2fa',
// 'ok-via-passkey'), so that hook would never fire here. Instead this reads
// new successful rows from login_logs and treats an IP + browser pair never
// seen before on that account as a "new device" access event.
'use strict';

function createDashLoginWatcher({ db, onNewDevice }) {
  let lastId = null;
  function tick() {
    const all = db.findAll('login_logs', () => true);
    if (lastId === null) { lastId = all.reduce((m, r) => Math.max(m, r.id), 0); return []; }
    const fresh = all.filter((r) => r.id > lastId && r.success).sort((a, b) => a.id - b.id);
    const out = [];
    for (const r of fresh) {
      const seen = all.some((o) => o.id < r.id && o.success && o.userId === r.userId && o.ip === r.ip && o.userAgent === r.userAgent);
      if (!seen) { out.push(r); onNewDevice(r); }
    }
    lastId = all.reduce((m, r) => Math.max(m, r.id), lastId);
    return out;
  }
  return { tick };
}

module.exports = { createDashLoginWatcher };
