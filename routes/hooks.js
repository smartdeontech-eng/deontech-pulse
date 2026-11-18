// Optional: a deploy script can announce itself, so Pulse knows a release is
// happening even before sudo or the live file says so.
//
//   curl -fsS -X POST https://monitor.smartdeontech.com/api/hooks/deploy \
//        -H "X-Pulse-Token: $PULSE_HOOK_TOKEN" -H 'Content-Type: application/json' \
//        -d '{"app":"aotc-track","note":"v1.42"}'
//
// Not needed for anything to work: deploys are detected without it.
'use strict';
const express = require('express');
const crypto = require('crypto');
const { verifyAppToken } = require('../core/appsignins');

function createHooks({ monitor }) {
  const router = express.Router();
  router.post('/hooks/deploy', (req, res) => {
    const want = process.env.PULSE_HOOK_TOKEN || '';
    const got = String(req.get('x-pulse-token') || '');
    const a = Buffer.from(got), b = Buffer.from(want);
    if (!want || b.length < 24 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Bad or missing token.' });
    }
    const app = String((req.body && req.body.app) || '*').slice(0, 60);
    const r = monitor.deploys.mark({ app, source: 'hook', detail: { note: String((req.body && req.body.note) || '').slice(0, 200) } });
    res.json({ ok: true, ...r });
  });
  // Sign-ins and activity from the other apps (connectors/pulse-reporter.js).
  // Apps on this server post straight to 127.0.0.1:3201 — no Apache, no TLS.
  router.post('/ingest/app-signins', (req, res) => {
    const app = String(req.get('x-pulse-app') || (req.body && req.body.app) || '');
    if (!verifyAppToken(process.env.PULSE_HOOK_TOKEN, app, req.get('x-pulse-app-token'))) return res.status(401).json({ error: 'Bad or missing app token.' });
    if (app === 'pulse') return res.status(400).json({ error: 'Reserved.' });
    res.json({ ok: true, ...monitor.appSignins.ingest(app, req.body || {}) });
  });
  return router;
}

module.exports = { createHooks };
