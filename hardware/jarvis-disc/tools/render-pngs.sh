#!/usr/bin/env bash
# Rasterise every SVG in drawings/ to PNG using Microsoft Edge (headless, throwaway profile).
# Run from hardware/jarvis-disc.
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PROFBASE="${TEMP:-/tmp}/jarvis-disc-edge"
size_of() { # width height read from the svg root element
  sed -n 's/.*<svg[^>]* width="\([0-9]*\)" height="\([0-9]*\)".*/\1 \2/p' "$1" | head -1
}
for svg in ${SVGS:-drawings/*.svg}; do
  name="$(basename "$svg" .svg)"
  read -r w h < <(size_of "$svg")
  timeout 90 "$EDGE" --headless=old --user-data-dir="$(cygpath -w "$PROFBASE-$name")" --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size="$w,$h" --screenshot="$(cygpath -w "$PWD/drawings/$name.png")" \
    "file:///$(cygpath -m "$PWD/$svg")" > /dev/null 2>&1
  sleep 1; echo "$name.png (${w}x${h})"
done
