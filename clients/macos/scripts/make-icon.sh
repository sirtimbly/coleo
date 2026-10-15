#!/bin/bash
# Regenerate the checked-in macOS icon from its editable SVG master.
set -euo pipefail
require_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
require_cmd rsvg-convert
require_cmd sips
require_cmd iconutil
require_cmd python3
cd "$(dirname "$0")/.."
mkdir -p .build Artwork
WORK="$(mktemp -d .build/app-icon.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/AppIcon.iconset"
rsvg-convert -w 1024 -h 1024 Artwork/AppIcon.svg -o Artwork/AppIcon.png
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" Artwork/AppIcon.png --out "$WORK/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" Artwork/AppIcon.png --out "$WORK/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o Artwork/AppIcon.icns
python3 scripts/icon-layers.py
echo "Generated Artwork/AppIcon.png and Artwork/AppIcon.icns"
