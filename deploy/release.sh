#!/usr/bin/env bash
# Install a new Pulse release into /opt/pulse and restart it, keeping the
# previous one in /opt/pulse.prev for an instant rollback.
#
#   sudo bash deploy/release.sh /tmp/deontech-pulse          # from an unpacked release
#   sudo bash /opt/pulse/deploy/release.sh --rollback        # back to the previous release
#
# Pulse is a single instance (no blue/green): it monitors, it does not serve
# anyone, so a few seconds of restart cost nothing. Data lives in
# /var/lib/pulse and is never touched here.
set -euo pipefail
die() { echo "STOP: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"

health() {
  for i in $(seq 1 25); do
    if curl -fsS --max-time 3 http://127.0.0.1:3201/healthz >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

if [ "${1:-}" = "--rollback" ]; then
  [ -d /opt/pulse.prev ] || die "no previous release to roll back to"
  mv /opt/pulse /opt/pulse.failed.$(date +%s)
  mv /opt/pulse.prev /opt/pulse
  systemctl restart pulse
  health && echo "rolled back; Pulse is healthy" || die "rolled back but Pulse is not answering — journalctl -u pulse -n 50"
  exit 0
fi

SRC="${1:?usage: release.sh <unpacked release dir> | --rollback}"
[ -f "$SRC/server.js" ] || die "$SRC is not a Pulse release"

STAGE=/opt/pulse.new
rm -rf "$STAGE"
mkdir -p "$STAGE"
# Code only: never data, never secrets, never a node_modules built elsewhere.
tar -C "$SRC" --exclude=./node_modules --exclude=./data --exclude=./.env --exclude=./.git -cf - . | tar -C "$STAGE" -xf -
( cd "$STAGE" && tar xzf vendor/node_modules.tgz && /usr/bin/node scripts/vendor-deps.js --check )
chown -R root:root "$STAGE"
# Permissions are set here, not inherited from the tarball: a release packed
# from a private folder on the Mac arrives as 0700/0600, which the pulse user
# cannot enter (systemd then fails with status=200/CHDIR).
chmod -R u=rwX,go=rX "$STAGE"
chmod 0755 "$STAGE"/scripts/*.sh "$STAGE"/deploy/*.sh

if [ -d /opt/pulse ] && [ -f /opt/pulse/server.js ]; then
  rm -rf /opt/pulse.prev
  mv /opt/pulse /opt/pulse.prev
else
  rm -rf /opt/pulse
fi
mv "$STAGE" /opt/pulse
echo "installed $(node -p "require('/opt/pulse/package.json').version") into /opt/pulse"

# Keep the system side in step with the code: units, folders, timers. Safe to
# repeat; this is how a release that changes a unit file takes effect.
install -d -o pulse -g pulse -m 0750 /var/lib/pulse
install -d -o root -g pulse -m 0750 /var/lib/pulse-scan
# Restart / Switch line from Pulse: requests in (pulse writes), results out (root writes).
install -d -o pulse -g pulse -m 0750 /var/lib/pulse/actions
install -d -o root -g pulse -m 0750 /var/lib/pulse-scan/actions
install -d -o root -g pulse -m 0750 /var/lib/pulse-scan/backups   # backup results Pulse reads
install -d -o root -g root -m 0700 /var/backups/pulse              # the archives: root only
chmod 0755 /opt/pulse/scripts/pulse-action.sh
install -m 0644 /opt/pulse/deploy/pulse.service /opt/pulse/deploy/pulse-scan.service /opt/pulse/deploy/pulse-scan.timer \
  /opt/pulse/deploy/pulse-geoip.service /opt/pulse/deploy/pulse-geoip.timer \
  /opt/pulse/deploy/pulse-action.service /opt/pulse/deploy/pulse-action.path /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pulse-action.path >/dev/null 2>&1 || echo "warning: pulse-action.path did not start — Restart/Switch buttons will wait" >&2
# A scan in the new format, before the app that reads it starts.
systemctl start pulse-scan.service || echo "warning: inventory scan failed — journalctl -u pulse-scan -n 30" >&2

[ "${2:-}" = "--no-restart" ] && exit 0

systemctl restart pulse
if health; then
  echo "Pulse is healthy."
else
  echo "New release is not answering; rolling back." >&2
  journalctl -u pulse -n 30 --no-pager >&2 || true
  if [ -d /opt/pulse.prev ]; then
    mv /opt/pulse "/opt/pulse.failed.$(date +%s)"
    mv /opt/pulse.prev /opt/pulse
    systemctl restart pulse
    health && echo "Rolled back to the previous release; it is healthy." >&2 || echo "Rolled back, but Pulse is still not answering — journalctl -u pulse -n 50" >&2
  else
    echo "No previous release to roll back to (first install?). Check: journalctl -u pulse -n 50" >&2
  fi
  exit 1
fi
