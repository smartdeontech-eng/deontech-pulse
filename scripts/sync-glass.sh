#!/bin/sh
# Copy the shared look and feel (@deontech/glass) from deontech-core into this
# app. Run from the repository root after deontech-core's glass changes:
#   sh scripts/sync-glass.sh [path/to/deontech-core]
set -e
CORE="${1:-../Software/deontech-core}"
[ -d "$CORE/packages/glass" ] || { echo "deontech-core not found at $CORE (pass its path)"; exit 1; }
mkdir -p public/vendor/glass
cp "$CORE/packages/glass/glass.css" "$CORE/packages/glass/glass.js" public/vendor/glass/
echo "glass $(node -p "require('$CORE/packages/glass/package.json').version" 2>/dev/null || echo '') copied into public/vendor/glass"
