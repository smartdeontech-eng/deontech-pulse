#!/usr/bin/env bash
# Downloads DB-IP "IP to Country Lite" (CC BY 4.0, https://db-ip.com) for this
# month into /var/lib/pulse. Pulse looks countries up locally; login IPs are
# never sent anywhere. Run monthly from pulse-geoip.timer (or by hand).
set -euo pipefail
DEST="${1:-/var/lib/pulse/dbip-country-lite.csv}"
MONTH="$(date -u +%Y-%m)"
URL="https://download.db-ip.com/free/dbip-country-lite-${MONTH}.csv.gz"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
if ! curl -fsSL --max-time 120 "$URL" -o "$TMP"; then
  # Early in the month the new file may not be out yet; last month's is fine.
  MONTH="$(date -u -d "$(date -u +%Y-%m-01) -1 day" +%Y-%m)"
  curl -fsSL --max-time 120 "https://download.db-ip.com/free/dbip-country-lite-${MONTH}.csv.gz" -o "$TMP"
fi
gunzip -c "$TMP" > "${DEST}.new"
[ "$(wc -l < "${DEST}.new")" -gt 100000 ] || { echo "download looks wrong" >&2; rm -f "${DEST}.new"; exit 1; }
mv -f "${DEST}.new" "$DEST"
echo "GeoIP: $(wc -l < "$DEST") ranges ($MONTH) -> $DEST"
