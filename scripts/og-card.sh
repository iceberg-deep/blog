#!/usr/bin/env bash
# Generate a 1200x630 Open Graph card in the iceberg-deep terminal/goth style.
# Keeps every article's link preview on the same cadence.
#
# Usage:
#   scripts/og-card.sh SLUG "PROMPT" "TITLE 1" "TITLE 2" "SUBTITLE" "tag · tag · tag"
#
# Example:
#   scripts/og-card.sh everything-dies-eventually "cat everything-dies.md" \
#     "Everything Dies" "Eventually." "Your Encryption Just Has a Date." \
#     "post-quantum · cryptography · security"
#
# Output: assets/og/SLUG.png  (reference it as  image: /assets/og/SLUG.png)
set -euo pipefail

SLUG=${1:?slug required}
PROMPT=${2:?prompt text required}
T1=${3:?title line 1 required}
T2=${4:-}
SUB=${5:-}
TAGS=${6:-}

DIR="$(cd "$(dirname "$0")/.." && pwd)"
REG=/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf
BOLD=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf
OUT="$DIR/assets/og/$SLUG.png"

mkdir -p "$DIR/assets/og"
magick -size 2400x1260 radial-gradient:'#2b3f12'-'#0a0d0a' -crop 1200x630+300+510 +repage \
  -fill '#C2F761' -draw "rectangle 0,0 6,630" \
  -gravity NorthWest \
  -font "$REG"  -pointsize 27 -fill '#8aa07f' -annotate +78+70  "iceberg-deep:~\$ $PROMPT" \
  -font "$BOLD" -pointsize 88 -fill '#f1f6ec' -annotate +76+185 "$T1" \
  -font "$BOLD" -pointsize 88 -fill '#C2F761' -annotate +76+292 "$T2" \
  -font "$REG"  -pointsize 37 -fill '#9fcf4a' -annotate +80+430 "$SUB" \
  -font "$REG"  -pointsize 25 -fill '#6f8a5f' -annotate +80+545 "$TAGS" \
  -gravity NorthEast \
  -font "$REG"  -pointsize 25 -fill '#5f7550' -annotate +56+545 'Breaking ● Building ● working' \
  "$OUT"

echo "wrote $OUT  ($(identify -format '%wx%h' "$OUT"))"
