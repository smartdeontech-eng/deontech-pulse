# DeonTech Pulse — runbook

Every command here is run **by you**, from your Mac's Terminal or on the server
after `ssh -t deploy@track.pcg-aotc.com`. Use the hostname, not the bare IP
(the phone hotspot's IPv6 can't reach the IP). Secrets are typed on the
server at hidden prompts — never pasted into a chat.

---

## 0. Before the first install (once)

1. **DNS** — at Namecheap, add an **A record**: host `monitor`, value
   `172.93.52.195`, TTL automatic. Check from the Mac after a few minutes:

   ```bash
   dig +short monitor.smartdeontech.com      # should print 172.93.52.195
   ```

2. **SMS** — in mNotify, request sender ID `DeonPulse` (max 11 characters) and
   have the API key ready. Until it's approved, urgent alerts still go by push
   and email.

3. **Email** — an SMTP login for the mailbox that sends alerts (for Gmail: an
   *app password*, with 2-Step Verification on the account).

## 1. First install

On the **Mac**, from the project folder (on local disk):

```bash
bash scripts/pack.sh
scp dist/deontech-pulse-0.1.0.tgz deploy@track.pcg-aotc.com:/tmp/
```

On the **server**:

```bash
ssh -t deploy@track.pcg-aotc.com
cd /tmp && tar xzf deontech-pulse-0.1.0.tgz && cd deontech-pulse
sudo bash deploy/provision.sh
```

`provision.sh` checks Node (needs 22.13+, the server has 22.23.3) and that port
3201 is free; creates the `pulse` user (groups `adm`, `systemd-journal`, no
sudo); writes `/etc/pulse.env` with a fresh JWT secret, VAPID push keys and a
hook token; installs the code to `/opt/pulse`, the systemd units and the Apache
site; runs the first inventory scan; and starts everything. It does not touch
the other apps, and it refuses to reload Apache if the config test fails.

Then, still on the server:

```bash
# HTTPS (after DNS resolves)
sudo certbot --apache -d monitor.smartdeontech.com --redirect

# Your login — password typed at a hidden prompt
cd /opt/pulse && sudo -u pulse node scripts/create-owner.js <your-email> "<Your Name>"

# Trust the MacBook's deploy key, so your own logins are quiet
cd /opt/pulse && sudo -u pulse node scripts/trust.js key "MacBook (deploy key)" SHA256:X2tY9YuOanjDRtQ/mNbIleOleGfZLJt0qZew+N2rePk

# Mail and SMS secrets (hidden prompts), then restart
sudo bash /opt/pulse/scripts/set-secret.sh SMTP_HOST      # e.g. smtp.gmail.com
sudo bash /opt/pulse/scripts/set-secret.sh SMTP_USER
sudo bash /opt/pulse/scripts/set-secret.sh SMTP_PASS
sudo bash /opt/pulse/scripts/set-secret.sh NOTIFY_EMAIL
sudo bash /opt/pulse/scripts/set-secret.sh SMS_API_KEY
sudo systemctl restart pulse
```

## 2. First sign-in (phone and Mac)

1. Open **https://monitor.smartdeontech.com** and sign in.
2. Set up two-factor (scan the QR with your authenticator app) and **save the
   backup codes**.
3. **Settings → Where alerts go**: your phone (+233…) and email. Save. Press
   **Send an urgent test** — you should get push, SMS and email.
4. **iPhone**: Safari → Share → **Add to Home Screen**, open Pulse from the
   icon, then **Settings → Turn on notifications**. Add a passkey (Face ID).
5. **Mac**: Safari → File → **Add to Dock**, then the same two buttons.
6. **Access** page: your MacBook key should show *trusted*. Add **Home Wi-Fi**
   etc. as networks if you like (needs a 2FA code; it raises an alert, by
   design).

## 3. Outside pinger (the dead-man's switch)

Pulse can't tell you the whole server is down — it would be down too. Create a
free monitor somewhere **off this VPS** (e.g. UptimeRobot or Better Stack free
tier, or Uptime Kuma on another machine):

- URL: `https://monitor.smartdeontech.com/healthz`
- Every 5 minutes; alert after 2 failures; to your phone/email.

`/healthz` answers 200 only if Pulse is up **and** sampled the server in the
last 30 seconds. It is public and read-only and shows no data.

## 4. Updating Pulse

**The source** is `~/deontech-pulse` on the MacBook (gideonadjei account), a git
repository whose online copy is **github.com/smartdeontech-eng/deontech-pulse**
(private). Set up 18 Nov 2026 from Pulse 0.1.14 exactly as it runs on the server.
Every change is made here, committed and pushed, then released — never edited on
the server, or the next release undoes it. The folder lives on local disk, not
OneDrive (SQLite fails on synced folders); OneDrive keeps only a copy
(`Projects/Software/DeonTech Pulse/deontech-pulse-0.1.14`, the 18 Nov snapshot).

Every release, in this order:

```bash
# 1. Mac: change the code, bump the version (four places, see below), test
cd ~/deontech-pulse
tar xzf vendor/node_modules.tgz          # once, so the tests can run
npm test

# 2. Mac: commit and push, so GitHub always holds what is released
git add -A && git commit -m "0.1.x: what changed" && git push

# 3. Mac: build the tarball and copy it up
bash scripts/pack.sh && scp dist/deontech-pulse-$(node -p "require('./package.json').version").tgz deontech-vps:/tmp/

# 4. Server: install it (keeps the previous one, rolls back by itself)
ssh -t deontech-vps "cd /tmp && sudo rm -rf deontech-pulse && tar xzf deontech-pulse-*.tgz && sudo bash deontech-pulse/deploy/release.sh /tmp/deontech-pulse"
```

Run these from `~/deontech-pulse`. Each app has its own release script; running
`deploy/push.sh` from another app's folder releases THAT app (17 Nov 2026: a
Pulse/AOTC release run from the RondoQ folder released RondoQ).

`deontech-vps` is the Mac's SSH alias for `deploy@track.pcg-aotc.com`.

`release.sh` keeps the previous version in `/opt/pulse.prev`, restarts, and
**rolls back by itself** if `/healthz` doesn't answer within 25 s. Manual
rollback: `sudo bash /opt/pulse/deploy/release.sh --rollback`.

It also installs and enables `pulse-action.path` / `pulse-action.service` (the
root helper behind Restart and Switch) and creates `/var/lib/pulse/actions` and
`/var/lib/pulse-scan/actions`. Check the version afterwards:
`https://monitor.smartdeontech.com/healthz` shows `"version"`. Open Pulse on the
phone: the update bar downloads the new version and offers **Reload**; About shows
the version and build (commit) that is running.

**Every release:** bump the version in four places that `npm test` checks agree:
`package.json` (`version` and `released`), `APP_VERSION` and the top of `CHANGES`
in `public/app.js`, and `VERSION` in `public/sw.js` (`pulse-<version>`). The last
one is what makes phones notice the update. `pack.sh` writes `build.json`.

Deploy from the MacBook (it carries the code, the deploy key and its
passphrase). Phones and the iPad are for watching, logs, restarts and
rollbacks through Pulse.

### SQL Server and Pulse backups (0.1.13)

Pulse backs itself up like any app (Backups → DeonTech Pulse): its database
and settings, never `/etc/pulse.env`. SQL Server needs a backup login once:

```bash
sudo apt install mssql-tools18 unixodbc-dev     # only if sqlcmd is missing
sudo bash /opt/pulse/scripts/set-mssql-login.sh   # asks for the sa password once
```

It creates `pulse_backup` (db_backupoperator in each user database only) and
stores that login in `/etc/pulse-mssql.cnf` (root 0600). Run it again after
adding a database. Then Backups → SQL Server → Back up now (tick Copy to
OneDrive), or switch on its nightly backup.

## 5. Everyday checks

| What | Command |
|---|---|
| Is it running? | `systemctl status pulse` · `curl -s localhost:3201/healthz` |
| Logs | `journalctl -u pulse -n 100 --no-pager` |
| Run the inventory scan now | `sudo systemctl start pulse-scan.service` |
| When does the scan run next? | `systemctl list-timers pulse-scan.timer` |
| Who is trusted? | `cd /opt/pulse && sudo -u pulse node scripts/trust.js list` |
| Hotel Wi-Fi for a week | On the login alert: **Yes — trust this network** → 7 days. Or `cd /opt/pulse && sudo -u pulse node scripts/trust.js network "Hotel" <IP> --days 7` |
| Locked out / lost 2FA | `cd /opt/pulse && sudo -u pulse node scripts/set-password.js you@… --reset-2fa` |
| Maintenance window | Pulse → Settings → Maintenance mode (holds service alerts, never access alerts) |
| Back up an app now | Pulse → Backups → **Back up now** (tick “Copy to OneDrive too” for an off-site copy). Archives: `/var/backups/pulse/<app>` (root only, newest 14); results: `/var/lib/pulse-scan/backups/<app>.jsonl`. What each app's backup holds is fixed in `scripts/pulse-backup.sh` |
| Back up every night | Pulse → Backups → **Every night by Pulse** on that app's card; the time is at the top of the page |
| Restore a Pulse backup | `sudo tar -xzf /var/backups/pulse/<app>/<file>.tar.gz -C /tmp/restore` → `databases/…` are SQLite snapshots, `mysql/*.sql.gz` are dumps (`gunzip -c x.sql.gz \| sudo mysql`), `files.tar` holds the folders. Stop the app before copying anything back |
| An app logged errors | Pulse → Errors: each card is one kind of error. Open it for the full error, the code line, the log lines around it, the page that failed, and the server command for the raw log. Mark it **known** (no more alerts) or **fixed** (alerts again if it comes back) |
| An app isn't live yet | Pulse → Apps → its switch off (no checks, no alerts); switch on when it goes live |
| Add someone | Pulse → People → Add person (owner only, needs your 2FA code); give them the one-time password by phone |
| Someone leaves / loses a phone | Pulse → People → switch them off (reason kept), or Reset password with "clear 2FA" (clears every phone) |
| Second phone for 2FA | Pulse → Settings → Your account → Authenticator apps → **Add another phone** (needs a current code); Rename / Remove there too |
| Who is on the server now | Pulse → Access → **On the server now** (key used, from where, since when) |
| Read an app's log | Pulse → Apps → the app → **Show log** |
| Restart an app | Pulse → Apps → the app → **Restart** (2FA code; raises an alert) |
| Roll back IFAIMA / AOTC | Pulse → Apps → the app → **Switch to blue/green** (2FA code; the other line is health-checked first) |
| What is using memory | Pulse → Server → Top processes → **By memory** |
| Is the action helper alive? | `systemctl status pulse-action.path` · `journalctl -t pulse-action -n 20` |

## 6. What lives where

| Path | What | Owner |
|---|---|---|
| `/opt/pulse` | code (replaced on each release) | root, read-only to pulse |
| `/var/lib/pulse/pulse.db` | history, alerts, access log, users | pulse |
| `/var/lib/pulse/settings.json` | thresholds, channels, quiet hours | pulse |
| `/var/lib/pulse-scan/inventory.txt` | latest root scan | root (folder root:pulse 0750 — pulse reads, never writes) |
| `/var/lib/pulse/actions/*.req` | Restart / Switch requests from Pulse | pulse |
| `/var/lib/pulse-scan/actions/*.out` | the helper's answers | root (pulse reads) |
| `/etc/systemd/system/pulse-action.{path,service}` | the root helper's units | root |
| `/var/lib/pulse/dbip-country-lite.csv` | GeoIP (monthly) | pulse |
| `/etc/pulse.env` | secrets | root:pulse 0640 |
| `/etc/apache2/sites-available/monitor.smartdeontech.com.conf` | proxy | root |

**Back up** `/var/lib/pulse` with the others (it is small). Losing it loses
history and the trusted list, not anything another app needs.

## 7. If an alert says "Not you"

First look at **Access → On the server now**: it shows every open session and
the key it came in with. Restart and Switch are the only changes Pulse makes;
everything below is for you:

```bash
who; last -n 20                                              # who is on now
sudo cat /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys   # remove what you didn't add
sudo fail2ban-client set sshd banip <IP>                     # block the address
sudo journalctl _COMM=sudo --since -1d                       # what was run with sudo
```

Then rotate the deploy key on the Mac (`ssh-keygen -t ed25519`), install the
new public key, remove the old one, and update the trusted key in Pulse.

## 8. Uninstall

```bash
sudo systemctl disable --now pulse pulse-scan.timer pulse-geoip.timer
sudo a2dissite monitor.smartdeontech.com && sudo systemctl reload apache2
sudo systemctl disable --now pulse-action.path
sudo rm -f /etc/systemd/system/pulse*.service /etc/systemd/system/pulse*.timer /etc/systemd/system/pulse*.path && sudo systemctl daemon-reload
# data and secrets are left in place: /var/lib/pulse, /etc/pulse.env
```

## 9. Connect an app to the Sign-ins page

**Budget** (its own sign-in code, not the core) was connected by hand in Budget
1.0.47: `lib/pulse-reporter.js`, `report()` after each sign-in attempt and
`touch()` in its API middleware. Its token: `sudo bash /opt/pulse/scripts/app-token.sh budget`.

Pulse shows its own sign-ins straight away. Each other app on the Smart DeonTech
core (AOTC Track, IFAIMA, Smart DeonTech, Gina's Angel) needs a small reporter
file and two settings. Nothing changes for that app's users, and if Pulse is
down, the app carries on as normal; its reports are simply dropped.

**1. Code — on the Mac, against the app's source folder (the one you deploy from):**

```bash
node ~/deontech-pulse/scripts/connect-app.js "/path/to/the/app" --check   # shows what it will change
node ~/deontech-pulse/scripts/connect-app.js "/path/to/the/app"
```

It copies `utils/pulse-reporter.js` into the app and adds one line each to
`routes/auth.js` and `server.js`, with backups (`*.before-pulse`). Running it
twice changes nothing. Then release the app the usual way.

**2. Token — on the server.** The app id is the one Pulse uses: `aotc-track`,
`ifaima`, `smart-deontech` or `ginasangel`.

```bash
sudo bash /opt/pulse/scripts/app-token.sh aotc-track
```

This finds the app's env file from its systemd unit and writes `PULSE_APP` and
`PULSE_APP_TOKEN` into it, keeping a backup. The app picks them up at its next
release or restart. Within a minute of that, its card on Sign-ins turns live.

**What is kept:** name, email, role, IP, country and device label, for 90 days.
Pulse never receives passwords, tokens, URLs or app data.

**Alerts it adds:**

- 10 failed sign-ins on one account in 15 minutes;
- 20 failures, or 5 accounts tried, from one IP in 15 minutes;
- an app admin signing in from a country outside "usual countries" for the first time in 30 days.

## 10. Keys and devices (as set up 12 Oct 2026)

| Device | Key on the server (`deploy`) | Notes |
|---|---|---|
| MacBook | ED25519 `SHA256:X2tY9Yu…` (`smartdeontech@Gideons-MacBook-Pro`) | trusted in Pulse as "MacBook (deploy key)"; deploys go from here |
| iPhone | ECDSA `SHA256:MWoy4UA…` (Termius, Face ID key in the Secure Enclave) | trust in Pulse as "iPhone (Face ID)" |
| iPad | — | give it its own key the same way; never copy keys between devices |
| Emergency | SSD Nodes dashboard → server → **Console** (root + the panel password) | works even if SSH is broken |

- Check the list: `ssh-keygen -lf ~/.ssh/authorized_keys` (as deploy). Each key once.
- Add a key: `echo 'PUBLIC-KEY-LINE' >> ~/.ssh/authorized_keys`; Pulse alerts on the new key; answer it and press Trust.
- Remove a lost device's key: delete its line, then remove it from Pulse's trusted list.
- Password logins over SSH are being turned off with `/etc/ssh/sshd_config.d/00-no-passwords.conf` (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`). The `00` matters: Ubuntu's `50-cloud-init.conf` turns passwords back on and the first value read wins. Keep a session open while changing it; test a new login before closing.
- Don't trust the hosting provider's range (172.93.52.0/24): neighbours share it.
