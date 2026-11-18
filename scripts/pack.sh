#!/usr/bin/env bash
# On the Mac: build the release tarball to copy to the server.
#   bash scripts/pack.sh            -> dist/deontech-pulse-<version>.tgz
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
node scripts/vendor-deps.js --check
mkdir -p dist
# The build the About page shows beside the version: commit and date.
printf '{"version":"%s","commit":"%s","builtAt":"%s"}\n' "$V" "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo '+')" "$(date -u +%Y-%m-%dT%H:%MZ)" > build.json
OUT="dist/deontech-pulse-$V.tgz"
NAME="$(basename "$PWD")"
COPYFILE_DISABLE=1 tar -C .. \
  --exclude="$NAME/node_modules" --exclude="$NAME/data" --exclude="$NAME/.env" \
  --exclude="$NAME/.git" --exclude="$NAME/dist" --exclude='._*' --exclude='.DS_Store' \
  -czf "$OUT" "$NAME"
echo "$OUT ($(du -h "$OUT" | cut -f1))"
echo "Copy it:  scp $OUT deploy@track.pcg-aotc.com:/tmp/"
