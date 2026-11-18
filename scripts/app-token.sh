#!/usr/bin/env bash
# Give an app its Pulse token: finds the app's env file from its systemd unit
# and writes PULSE_APP / PULSE_APP_TOKEN into it (replacing old ones). Run as root:
#
#   sudo bash /opt/pulse/scripts/app-token.sh aotc-track
#
# It does not restart the app. The app's next release (or a restart) picks it up.
set -euo pipefail
APP="${1:?usage: app-token.sh <app-id>   e.g. aotc-track, ifaima, smart-deontech, ginasangel}"
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
case "$APP" in *[!a-z0-9._-]*|pulse) echo "Bad app id: $APP"; exit 1;; esac

# Not "LINES": bash overwrites that with the terminal height.
TOKEN_LINES=$(cd /opt/pulse && sudo -u pulse node scripts/app-token.js "$APP")

# Every service unit whose name starts with the app id (blue/green lines included).
UNITS=$(systemctl list-units "${APP}*" --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1}')
[ -n "$UNITS" ] || UNITS=$(systemctl list-unit-files "${APP}*" --type=service --no-legend 2>/dev/null | awk '{print $1}' | grep -v '@\.service$' || true)
[ -n "$UNITS" ] || { echo "No systemd service found starting with '$APP'. Run: systemctl list-units --type=service | grep -i ${APP%%-*}"; exit 1; }

FILES=""
for U in $UNITS; do
  for F in $(systemctl show -p EnvironmentFiles --value "$U" | sed -E 's/ \(ignore_errors=[a-z]+\)//g'); do FILES="$FILES ${F#-}"; done
  if [ -z "$FILES" ]; then
    WD=$(systemctl show -p WorkingDirectory --value "$U")
    [ -n "$WD" ] && [ -f "$WD/.env" ] && FILES="$FILES $WD/.env"
  fi
done
FILES=$(echo $FILES | tr ' ' '\n' | sort -u | grep -v '^$' || true)
# Blue/green: the idle line is stopped, so systemd only shows the live one.
# Give its twin the token too, or the next release would come up without it.
for F in $FILES; do
  for T in "${F/blue/green}" "${F/green/blue}"; do [ "$T" != "$F" ] && [ -f "$T" ] && FILES="$FILES
$T"; done
done
FILES=$(echo "$FILES" | sort -u | grep -v '^$' || true)
[ -n "$FILES" ] || { echo "Found units ($UNITS) but no env file. Add these two lines to the app's environment by hand:"; echo "$TOKEN_LINES"; exit 1; }

for F in $FILES; do
  [ -f "$F" ] || { echo "skip (missing): $F"; continue; }
  cp -p "$F" "$F.before-pulse"
  sed -i '/^PULSE_APP=/d; /^PULSE_APP_TOKEN=/d' "$F"
  printf '%s\n' "$TOKEN_LINES" >> "$F"
  echo "✓ $F  (backup: $F.before-pulse)"
done
echo
echo "Units: $(echo $UNITS)"
echo "Not restarted. Release the app (with the reporter in it) or restart it to start reporting."
