#!/usr/bin/env bash
# Put one secret into /etc/pulse.env from a hidden prompt — so passwords and
# API keys are typed on the server, never pasted into a chat or a command line.
#
#   sudo bash /opt/pulse/scripts/set-secret.sh SMTP_PASS
#   sudo bash /opt/pulse/scripts/set-secret.sh SMS_API_KEY
#   sudo bash /opt/pulse/scripts/set-secret.sh SMTP_USER      (not secret, but same way)
set -euo pipefail
KEY="${1:?usage: set-secret.sh KEY}"
[[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "KEY must look like SMTP_PASS" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
F=/etc/pulse.env
read -r -s -p "$KEY: " VAL; echo
[ -n "$VAL" ] || { echo "empty — nothing changed"; exit 1; }
[[ "$VAL" != *"'"* ]] || { echo "values containing a single quote (') are not supported — choose another" >&2; exit 1; }
TMP="$(mktemp "$F.XXXX")"
grep -v "^$KEY=" "$F" > "$TMP" || true
# Single-quoted: literal for both systemd's EnvironmentFile and dotenv.
printf "%s='%s'\n" "$KEY" "$VAL" >> "$TMP"
chown root:pulse "$TMP"; chmod 0640 "$TMP"
mv -f "$TMP" "$F"
echo "$KEY saved. Restart to use it:  sudo systemctl restart pulse"
