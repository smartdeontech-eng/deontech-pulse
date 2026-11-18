#!/usr/bin/env bash
# DeonTech Pulse — first-time install on the VPS. Run ONCE, as root, from the
# unpacked release folder:
#
#   cd /tmp/deontech-pulse && sudo bash deploy/provision.sh
#
# Safe to re-run: it never overwrites /etc/pulse.env or the database, and it
# changes nothing belonging to the other apps. It does NOT touch DNS or
# certbot — see RUNBOOK.md for those two steps.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT=3201
DOMAIN=monitor.smartdeontech.com
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run with sudo"
[ -f "$SRC/server.js" ] || die "run from the unpacked release folder"

say "Checking the server"
NODE=/usr/bin/node
[ -x "$NODE" ] || die "no $NODE (AOTC Track uses the system Node; expected v22)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)) process.exit(1)' || die "Node $("$NODE" -v) is too old; need 22.13+ for node:sqlite"
echo "node $("$NODE" -v)"
if ss -tlnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet pulse; then die "port $PORT is in use by something else"; fi
echo "port $PORT ok"

say "User and folders"
id pulse >/dev/null 2>&1 || useradd --system --home-dir /var/lib/pulse --no-create-home --shell /usr/sbin/nologin pulse
usermod -a -G adm,systemd-journal pulse
install -d -o pulse -g pulse -m 0750 /var/lib/pulse
# The root scan writes here; pulse may read, never write (see pulse-scan.sh).
install -d -o root -g pulse -m 0750 /var/lib/pulse-scan
install -d -o root -g root -m 0755 /opt/pulse

say "Secrets (/etc/pulse.env)"
if [ ! -f /etc/pulse.env ]; then
  JWT=$("$NODE" -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  HOOK=$("$NODE" -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  ( cd "$SRC" && [ -d node_modules ] || tar xzf vendor/node_modules.tgz )
  VAPID=$(cd "$SRC" && "$NODE" scripts/vapid-keys.js)
  umask 027
  cat > /etc/pulse.env <<ENV
# DeonTech Pulse secrets. Generated $(date -u +%F). root:pulse 0640.
# Add the mail and SMS secrets with:  sudo bash /opt/pulse/scripts/set-secret.sh KEY
NODE_ENV=production
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=/var/lib/pulse
APP_URL=https://$DOMAIN
WEBAUTHN_RP_ID=$DOMAIN
WEBAUTHN_ORIGIN=https://$DOMAIN
JWT_SECRET=$JWT
PULSE_HOOK_TOKEN=$HOOK
PULSE_SCAN_PATH=/var/lib/pulse-scan/inventory.txt
VAPID_SUBJECT=mailto:smartdeontech@gmail.com
$VAPID
# Email (warnings + digest)
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
MAIL_FROM='DeonTech Pulse <smartdeontech@gmail.com>'
NOTIFY_EMAIL=
# SMS (urgent) — mNotify
SMS_API_KEY=
SMS_SENDER_ID=DeonPulse
ENV
  chown root:pulse /etc/pulse.env
  chmod 0640 /etc/pulse.env
  echo "created /etc/pulse.env (JWT secret, VAPID keys and hook token generated here; never leave this server)"
else
  echo "kept existing /etc/pulse.env"
fi

say "Code"
bash "$SRC/deploy/release.sh" "$SRC" --no-restart

say "First inventory scan (read-only) — release.sh installed the units and ran it"
[ -f /var/lib/pulse-scan/inventory.txt ] && echo "scan ok: $(grep -c . /var/lib/pulse-scan/inventory.txt) lines"
systemctl start pulse-geoip.service || echo "(GeoIP download failed — countries will read 'unknown' until the monthly timer succeeds)"

say "Apache site"
a2enmod -q proxy proxy_http headers >/dev/null
if [ ! -f /etc/apache2/sites-available/$DOMAIN.conf ]; then
  install -m 0644 "$SRC/deploy/apache-monitor.conf" /etc/apache2/sites-available/$DOMAIN.conf
fi
a2ensite -q $DOMAIN >/dev/null
if apache2ctl configtest 2>&1 | grep -q 'Syntax OK'; then systemctl reload apache2; echo "apache reloaded"; else apache2ctl configtest; die "apache config test failed — nothing reloaded; the other sites are untouched"; fi

say "Start"
systemctl enable --now pulse-scan.timer pulse-geoip.timer pulse.service
for i in $(seq 1 20); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo "Pulse is up on 127.0.0.1:$PORT"; break; fi
  sleep 1
done
systemctl --no-pager --lines=5 status pulse || true

cat <<NEXT

Done. Next (see RUNBOOK.md):
  1. DNS: A record  monitor -> 172.93.52.195  (Namecheap), then
     sudo certbot --apache -d $DOMAIN --redirect
  2. Owner login (password typed at a hidden prompt):
     cd /opt/pulse && sudo -u pulse node scripts/create-owner.js YOU@EMAIL "Your Name"
  3. Trust the MacBook key so its logins are quiet:
     cd /opt/pulse && sudo -u pulse node scripts/trust.js key "MacBook (deploy key)" SHA256:...
  4. Mail/SMS secrets: sudo bash /opt/pulse/scripts/set-secret.sh SMTP_PASS   (and SMS_API_KEY, ...)
NEXT
