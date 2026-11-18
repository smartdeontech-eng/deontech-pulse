# DeonTech Pulse

Private, installable web app that watches the Smart DeonTech VPS live — the
machine, every app on it, and who gets in — and tells the owner's phone when
something needs them. Built on the Smart DeonTech core (`@deontech/*` 0.5.1,
vendored), in the IFAIMA pattern. Current version: **0.1.6**.

**Address:** https://monitor.smartdeontech.com · **Owner only** (read-only
`viewer` logins are ready for later) · **2FA required** (one or more phones per
account), passkeys offered.

## What it does (phase 1)

| | |
|---|---|
| **Server** | CPU (per core), memory, swap, disks, network, disk IO, load, top processes — sampled every 2 s, kept 10 s/24 h, 1 min/30 days, 1 h/1 year. |
| **Apps** | Found automatically from systemd, Apache and listening ports — no hand-typed list. Apps started by PM2, Docker or by hand are found too, named after their PM2 name, container or the folder they run from. A new app raises one alert, **New app found: <name>**, within about a minute (services and sites are compared every minute; a new port asks root for a fresh scan). Apps whose health check reports a version show it, and each new version is a release on their timeline and charts. Health-checked every 30 s on the **live** line for blue/green apps; certificates checked every 6 h. |
| **Inventory** | Hourly read-only root scan: who owns each port, SSH keys (fingerprints only), login users, cron, backups, pending security updates. Every change becomes an event. |
| **Access** | Every SSH login, sudo, new user/key, failed-login burst and Pulse sign-in from a new device — graded by trusted **key first, network second**, so the MacBook stays quiet and a stranger is urgent. "Was this you?" with Yes/No on the notification. **On the server now** lists every open session with the key it used. Trusting a network asks for how long (1, 7, 30 days or always). |
| **Alerts** | Push for everything, SMS for urgent, email for warnings and a morning digest. Cool-downs, acknowledge, snooze (open alerts only), close, auto-resolve messages, quiet hours, maintenance mode. Releases are detected and don't page anyone. |
| **Actions** | On each app's page: **Show log**, **Restart**, and **Switch to blue/green** for blue/green apps. Restart and Switch need a fresh 2FA code and always raise an alert. Server page: top processes by CPU or by memory. |
| **App** | Installable PWA (iPhone Home Screen, Mac Dock): push with action buttons, badge count, offline shell with last readings, light/dark. **About** (sidebar foot, More sheet, Settings) shows the version, release date, build, server version and What's new; when the server runs a newer Pulse, an update bar shows it downloading and offers **Reload**. |

Pulse itself stays **unprivileged** (no sudo, `NoNewPrivileges`). Restart and
Switch line go through one small root helper, `scripts/pulse-action.sh`, started
by `pulse-action.path`. It can only restart an app's own service (never SSH,
Pulse, Apache or system services) or run AOTC Track's / IFAIMA's own `switch.sh`
when only root can change that script. Read it before trusting it; it is short.

## Layout

```
server.js            wiring only
core/                metrics, rollup, discovery, checks, authwatch, trust, geoip,
                     deploys, alerts, channels, digest, dashlogins, monitor, store, bus,
                     actions (restart/switch/log/top), sessions (who is on now)
routes/              auth (password + core passkey/2FA routers), api, stream (SSE), hooks
utils/               thin wrappers over @deontech/* (IFAIMA style)
middleware/auth.js   roles (owner, viewer), permissions, 2FA requirement
public/              the app: index.html, app.js, app.css, sw.js, manifest, icons, vendor/uPlot
scripts/             pulse-scan.sh (root, read-only), pulse-action.sh (root, restart/switch only),
                     create-owner, set-password, trust,
                     set-secret.sh, vapid-keys, geoip-update.sh, vendor-deps, pack.sh, dev-demo
deploy/              provision.sh, release.sh, systemd units, apache-monitor.conf
test/                node --test, against the real server's recorded inventory
```

## Run it on a laptop

```bash
npm run deps:restore     # or npm install
node scripts/dev-demo.js # fake backends + the real server's inventory; prints a 2FA code
open http://127.0.0.1:3201   # demo@pulse.local / Demo-Pulse-2026!
npm test
```

**Not from OneDrive.** SQLite's WAL fails on synced folders. Keep the repo in
OneDrive if you like; run a copy on local disk.

## Deploy

See **RUNBOOK.md**. In short: `bash scripts/pack.sh` on the Mac, `scp` the
tarball, `sudo bash deploy/provision.sh` once, then `deploy/release.sh` for
updates.

Country data: IP to Country Lite by [DB-IP](https://db-ip.com), CC BY 4.0.
Charts: [uPlot](https://github.com/leeoniya/uPlot), MIT.
