#!/bin/sh
# Regenerate each fixture's reference annotation file from its ops.json, with pinned time and IDs.
# Usage: scripts/build-fixture-annotations.sh [name…]
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
margin="node $root/packages/cli/bin/margin.js"
export MARGIN_NOW=2026-11-08T12:00:00Z MARGIN_SEED=2026
cd "$root/fixtures"
names=${*:-$(ls -d */ | tr -d /)}
for name in $names; do
  [ -f "$name/ops.json" ] || continue
  echo "annotating $name"
  $margin init "$name/$name.pdf" --force >/dev/null
  $margin apply "$name/ops.json" --annot "$name/$name.annot.json" >/dev/null
done
