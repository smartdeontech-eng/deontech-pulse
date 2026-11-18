# DeonTech Pulse — handover

**Read this and RUNBOOK.md first.** RUNBOOK.md §4 is how every release is done.

## Where things are (18 Nov 2026)

| What | Where |
|---|---|
| Source (git) | `~/deontech-pulse` on the MacBook, gideonadjei account — local disk, not OneDrive |
| Online copy | github.com/smartdeontech-eng/deontech-pulse (private), branch `main` |
| Running | `/opt/pulse` on the VPS (previous release in `/opt/pulse.prev`), https://monitor.smartdeontech.com |
| Data | `/var/lib/pulse` (pulse.db, settings.json), secrets `/etc/pulse.env` |
| Snapshot in OneDrive | `Projects/Software/DeonTech Pulse/deontech-pulse-0.1.14` (copy only — do not work there) |
| Original plan (Oct 2026) | `Projects/Software/DeonTech Pulse/HANDOVER.md` in OneDrive |

## Version history kept here

- **Next release (not yet versioned)** — Access → Add trusted source accepts a
  key fingerprint typed as `sha256:…` (phones lower-case it) or the whole
  `ssh-keygen -lf` line. Add it to the About notes when the version is bumped.
- **0.1.15 (18 Nov 2026)** — Backups: RondoQ plan (runs `rondoq-backup.service`,
  copies its new dump + uploads, off-site left to RondoQ's encrypted copy, read
  from `/var/backups/rondoq/offsite-status`); PostgreSQL plan (all clusters,
  `rondoq` DB skipped); 30-day limit on copies with RondoQ data. Pulse's own
  Apache site (backend port 3201) is now the app `pulse` ("DeonTech Pulse")
  instead of a second card named after the site.
- **0.1.14 (16 Nov 2026)** — blue/green apps: a line's port is read from its
  service (`Environment=PORT`, `systemctl show`, no root), so the new live line is
  checked straight after a release and the stopped idle line is never reported
  as the app being down. PostgreSQL clusters (`postgresql@15-main`, `@16-main`)
  and Ubuntu's wrapper `postgresql.service` (always "active (exited)", no port)
  are one card, checked on 5432. Released on the server from 0.1.13 + the patch
  `pulse-0.1.14-bluegreen-postgres.patch`; the repo starts at this version
  (commit a5c6f13). Earlier history (0.1.0–0.1.13) was in another copy that is
  not in this repository.

## Rules

1. Change code only in `~/deontech-pulse`; commit and push before releasing.
2. Bump the version in the four places `npm test` checks (RUNBOOK §4).
3. Release only with RUNBOOK §4, run from this folder.
4. Never put secrets in the repo (`.env` is ignored; secrets live in `/etc/pulse.env`).
5. RondoQ needs `/opt/rondoq/live` and `/etc/apache2/rondoq-live.conf` readable
   (644) for Pulse to know its live line; RondoQ's deploy kit sets this since 16 Nov 2026.
6. Update this file at the end of every piece of work that changes what Pulse does.
