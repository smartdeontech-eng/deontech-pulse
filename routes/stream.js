// Live data over Server-Sent Events: /api/stream.
//
// One long GET per open dashboard. Apache must pass it through unbuffered —
// deploy/apache-monitor.conf has `flushpackets=on` and no compression on this
// path, placed before the general ProxyPass. A comment line every 25 s keeps
// proxies and phones from deciding the connection is idle.
'use strict';
const express = require('express');
const bus = require('../core/bus');
const db = require('../utils/db');
const { requireAuth, require2fa, requirePermission } = require('../middleware/auth');

function createStream({ monitor }) {
  const router = express.Router();
  let clients = 0;

  router.get('/stream', requireAuth, require2fa, requirePermission('monitor.view'), (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    clients++;
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    send('hello', { latest: monitor.collector.latest(), counts: monitor.alerts.counts(), serverTime: Date.now() });

    let n = 0;
    const onSample = (s) => {
      send('sample', s);
      if (++n % 5 === 0) send('processes', monitor.collector.processes());
    };
    const onAlert = (e) => send('alert', { type: e.type, alert: e.alert, counts: monitor.alerts.counts() });
    const onChecks = (e) => send('checks', { ts: e.ts, results: e.results.map((r) => ({ app: r.app, ok: r.ok, status: r.status, ms: r.ms, error: r.error, lines: r.lines })) });
    const onAccess = (e) => send('access', e);
    const onInventory = (e) => send('inventory', e);
    const onBackup = (e) => send('backup', e);
    bus.on('sample', onSample);
    bus.on('alert', onAlert);
    bus.on('checks', onChecks);
    bus.on('access', onAccess);
    bus.on('inventory', onInventory);
    bus.on('backup', onBackup);
    // The keep-alive also re-checks the account, so switching someone off (or
    // changing their role) cuts an open dashboard within 25 seconds.
    const beat = setInterval(() => {
      const u = db.findById('users', req.user.id);
      if (!u || u.disabled || (u.sessionVersion || 0) !== (req.user.sv || 0)) { send('signedout', {}); return res.end(); }
      res.write(': keep-alive\n\n');
    }, 25_000);

    req.on('close', () => {
      clients--;
      clearInterval(beat);
      bus.off('sample', onSample);
      bus.off('alert', onAlert);
      bus.off('checks', onChecks);
      bus.off('access', onAccess);
      bus.off('inventory', onInventory);
      bus.off('backup', onBackup);
    });
  });

  router.clients = () => clients;
  return router;
}

module.exports = { createStream };
