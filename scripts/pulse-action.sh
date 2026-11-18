#!/usr/bin/env bash
# DeonTech Pulse — the few things Pulse may ask root to do.
#
# Pulse itself runs unprivileged (NoNewPrivileges, no sudo). When the owner
# presses Restart or Switch line in Pulse (after a fresh 2FA code), Pulse drops
# a one-line request in /var/lib/pulse/actions/<id>.req; pulse-action.path
# notices and runs this script as root. It does exactly these things:
#
#   restart <unit>.service     only units defined in /etc/systemd/system
#                              (the apps), never ssh or Pulse itself
#   switch  <app> blue|green   only aotc-track and ifaima, by running that
#                              app's own switch.sh — and only if root owns it
#   scan                       runs the read-only inventory scan now
#                              (pulse-scan.service), when Pulse sees something
#                              new between the hourly scans
#   backup  <app> 0|1          scripts/pulse-backup.sh: what is backed up for
#                              each app is fixed in that script (Pulse names an
#                              app, never a path); 1 = also copy off-site
#
# Anything else is refused. The request text is never echoed back (Pulse could
# point a request at a file it shouldn't read). Results go to
# /var/lib/pulse-scan/actions/<id>.out: owned by root, readable by pulse.
set -uo pipefail
export LC_ALL=C
REQ_DIR="${PULSE_ACTION_REQ:-/var/lib/pulse/actions}"
OUT_DIR="${PULSE_ACTION_OUT:-/var/lib/pulse-scan/actions}"
UNIT_DIR="${PULSE_ACTION_UNIT_DIR:-/etc/systemd/system}"
SYSTEMCTL="${PULSE_ACTION_SYSTEMCTL:-systemctl}"
ROOT_UID="${PULSE_ACTION_ROOT_UID:-0}"     # tests run as a normal user
SW="${PULSE_ACTION_SWITCH_ROOT:-}"         # tests point this at a fake /opt
declare -A SWITCH=(
  [aotc-track]="$SW/opt/aotc-lines/switch.sh"
  [ifaima]="$SW/opt/ifaima/%s/deploy/switch.sh"
)

[ "$(stat -c %u "$OUT_DIR")" = "$ROOT_UID" ] || { echo "$OUT_DIR must be owned by root" >&2; exit 1; }

say() { logger -t pulse-action -- "$*" 2>/dev/null || true; }

# A file root will execute: a real file, owned by root, writable by nobody
# else, in a folder only root can change.
root_owned() {
  local f="$1" d
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  for d in "$f" "$(dirname "$f")"; do
    [ "$(stat -c %u "$d")" = "$ROOT_UID" ] || return 1
    [ $(( 0$(stat -c %a "$d") & 022 )) -eq 0 ] || return 1
  done
}

do_restart() {
  local unit="$1" frag
  [[ $unit =~ ^[A-Za-z0-9][A-Za-z0-9@._-]{0,80}\.service$ ]] || { echo "Not a service name."; return 2; }
  case "$unit" in ssh.service|sshd.service|pulse*.service|systemd-*|dbus*|apache2.service|nginx.service) echo "Pulse may not restart $unit."; return 2 ;; esac
  frag=$("$SYSTEMCTL" show -p FragmentPath --value "$unit" 2>/dev/null)
  case "$frag" in "$UNIT_DIR"/*) ;; *) echo "$unit is not one of the apps (not defined in $UNIT_DIR)."; return 2 ;; esac
  say "restart $unit"
  timeout 90 "$SYSTEMCTL" restart "$unit" 2>&1 | tail -n 20
  local rc=${PIPESTATUS[0]}
  sleep 2
  echo "$unit is $("$SYSTEMCTL" is-active "$unit" 2>/dev/null)"
  return "$rc"
}

do_switch() {
  local app="$1" line="$2" pattern script
  [[ $line == blue || $line == green ]] || { echo "The line must be blue or green."; return 2; }
  pattern="${SWITCH[$app]:-}"
  [ -n "$pattern" ] || { echo "Pulse can switch lines only for: ${!SWITCH[*]}."; return 2; }
  # shellcheck disable=SC2059
  script=$(printf "$pattern" "$line")
  root_owned "$script" || { echo "$script is missing or not owned by root only, so Pulse will not run it. Switch by hand: sudo bash $script $line"; return 2; }
  say "switch $app to $line"
  timeout 150 bash "$script" "$line" 2>&1 | tail -n 30
  return "${PIPESTATUS[0]}"
}

shopt -s nullglob
for f in "$REQ_DIR"/*.req; do
  id=$(basename "$f" .req)
  if [[ ! $id =~ ^[a-z0-9]{8,32}$ ]] || [ -L "$f" ] || [ ! -f "$f" ]; then rm -f -- "$f"; continue; fi
  line=$(head -c 200 -- "$f" | head -n 1)
  rm -f -- "$f"
  read -r verb a1 a2 extra <<<"$line"
  TMP=$(mktemp "$OUT_DIR/.out.XXXXXX")
  {
    if [ -n "${extra:-}" ]; then echo "Refused."; rc=2
    elif [ "$verb" = restart ] && [ -n "${a1:-}" ] && [ -z "${a2:-}" ]; then do_restart "$a1"; rc=$?
    elif [ "$verb" = switch ] && [ -n "${a1:-}" ] && [ -n "${a2:-}" ]; then do_switch "$a1" "$a2"; rc=$?
    elif [ "$verb" = scan ] && [ -z "${a1:-}" ]; then
      say "inventory scan"
      timeout 150 "$SYSTEMCTL" start pulse-scan.service 2>&1 | tail -n 5; rc=${PIPESTATUS[0]}
      [ "$rc" = 0 ] && echo "Scan done."
    elif [ "$verb" = backup ] && [[ ${a1:-} =~ ^[a-z0-9-]{1,40}$ ]] && [[ ${a2:-} == 0 || ${a2:-} == 1 ]]; then
      say "backup $a1 offsite=$a2"
      timeout 1800 bash "$(dirname "$(readlink -f "$0")")/pulse-backup.sh" "$a1" "$a2" "$id" 2>&1 | tail -n 40; rc=${PIPESTATUS[0]}
    else echo "Refused: not an action Pulse may ask for."; rc=2
    fi
    echo "exit=$rc"
  } > "$TMP" 2>&1
  chmod 0640 "$TMP"
  [ "$ROOT_UID" = 0 ] && chgrp pulse "$TMP"
  mv -f "$TMP" "$OUT_DIR/$id.out"
done
# Results older than a day are no longer waited for.
find "$OUT_DIR" -maxdepth 1 -name '*.out' -mmin +1440 -delete 2>/dev/null || true
exit 0
