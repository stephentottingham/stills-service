#!/usr/bin/env bash
# Builds the Lambda layer with sharp (libvips) and heic-decode for linux-arm64.
# Works from any machine: npm fetches the arm64 Linux binaries.
set -euo pipefail
cd "$(dirname "$0")/.."
SHARP=$(node -p "require('./services/package.json').dependencies.sharp")
HEIC=$(node -p "require('./services/package.json').dependencies['heic-decode']")
OUT=layers/sharp/nodejs
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$OUT"
npm init -y >/dev/null
npm install --no-audit --no-fund --os=linux --cpu=arm64 --libc=glibc "sharp@$SHARP" "heic-decode@$HEIC" >/dev/null
echo "Layer ready: $(du -sh . | cut -f1) in layers/sharp/nodejs"
