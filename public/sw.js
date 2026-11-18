/* DeonTech Pulse service worker.
 *
 *  - Offline shell: the app's own files are cached, so Pulse opens with no
 *    signal and shows the last readings (the page keeps those in storage).
 *  - API calls are never cached here: live data is either live or clearly
 *    marked as old by the page.
 *  - Push: shows the alert with its buttons; a button press calls the signed
 *    action link, so "Yes, it was me" works from the lock screen. */
// Equal to package.json's version (npm test checks), so every release changes
// this file — which is how a phone notices there is a new Pulse to fetch.
const VERSION = 'pulse-0.1.15';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/vendor/uPlot.iife.min.js', '/vendor/uPlot.min.css', '/vendor/glass/glass.css', '/vendor/glass/glass.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/badge-96.png'];

// Tell the open app how far an update has got (downloading 4 of 12 →
// installing → ready), for its progress bar. Only for an update — an older
// version is running — not the very first install.
const tell = async (msg) => { if (!self.registration.active && msg.stage !== 'ready') return; for (const c of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) c.postMessage({ type: 'update', ...msg }); };
let wasUpdate = false;

self.addEventListener('install', (e) => {
  wasUpdate = !!self.registration.active;
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    let done = 0;
    await tell({ stage: 'download', done, total: SHELL.length });
    for (const u of SHELL) {
      // Fresh from the server, never the browser's own cache, so a release is saved whole.
      const r = await fetch(new Request(u, { cache: 'reload' }));
      if (!r.ok) { await tell({ stage: 'failed' }); throw new Error(`Couldn't fetch ${u}`); }
      await c.put(u, r);
      done++;
      await tell({ stage: 'download', done, total: SHELL.length });
    }
    await tell({ stage: 'install' });
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()).then(() => wasUpdate && tell({ stage: 'ready' })));
});

// The app opens from the copy saved on this device — instantly, and with no
// signal — like Budget. A new release is fetched whole by the install step
// above (the page notices the server is newer, shows the update bar, and
// offers Reload), so the saved pieces never mix two versions. API calls are
// never cached here: live data is either live or clearly marked as old.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz' || url.pathname === '/sw.js') return;
  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    const hit = await c.match(e.request, { ignoreSearch: url.pathname === '/' || url.pathname === '/index.html' })
      || (e.request.mode === 'navigate' ? await c.match('/index.html') : null);
    if (hit) return hit;
    try { return await fetch(e.request); } catch { return (await c.match('/index.html')) || Response.error(); }
  })());
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'DeonTech Pulse', body: e.data && e.data.text() }; }
  const actions = (d.actions || []).slice(0, 2);
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'DeonTech Pulse', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      requireInteraction: !!d.requireInteraction,
      data: { url: d.url || '/#/alerts', actions },
      actions: actions.map((a) => ({ action: a.action, title: a.title })),
    });
    if (self.navigator.setAppBadge && d.severity && d.severity !== 'resolved') {
      const open = await self.registration.getNotifications();
      self.navigator.setAppBadge(open.length).catch(() => {});
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const act = (data.actions || []).find((a) => a.action === e.action);
  e.waitUntil((async () => {
    if (act && act.url) {
      // Answer in the background; open the app only if it fails.
      try {
        const r = await fetch(act.url, { headers: { Accept: 'application/json' }, credentials: 'include' });
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          await self.registration.showNotification('DeonTech Pulse', { body: j.message || 'Done.', tag: 'pulse-ack', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png' });
          return;
        }
      } catch { /* fall through to opening the app */ }
    }
    const target = new URL(data.url || '/#/alerts', self.location.origin).href;
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        w.postMessage({ type: 'navigate', hash: new URL(target).hash });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
