#!/bin/sh
# Recompile every fixture PDF from its .tex source, reproducibly (fixed timestamps and IDs).
# Usage: scripts/build-fixtures.sh [name…]   (default: all fixtures)
set -eu
cd "$(dirname "$0")/../fixtures"
export SOURCE_DATE_EPOCH=1767225600   # 2026-01-01T00:00:00Z
export FORCE_SOURCE_DATE=1
names=${*:-$(ls -d */ | tr -d /)}
for name in $names; do
  [ -f "$name/$name.tex" ] || continue
  echo "building $name"
  (cd "$name" && latexmk -pdf -interaction=nonstopmode -halt-on-error -quiet "$name.tex" >/dev/null && latexmk -c "$name.tex" >/dev/null)
done
