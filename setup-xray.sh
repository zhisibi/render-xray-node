#!/usr/bin/env bash
# Download the official Xray binary at build time (keeps the repo text-only,
# so no 35MB binary ever needs to be committed or uploaded).
set -euo pipefail
VER="v26.10.21"
ASSET="Xray-linux-64.zip"
URL="https://github.com/XTLS/Xray-core/releases/download/${VER}/${ASSET}"
cd "$(dirname "$0")"
if [ -x core/xray ]; then echo "xray already present, skipping download"; exit 0; fi
mkdir -p core
tmp="$(mktemp -d)"
curl -fsSL -o "$tmp/$ASSET" "$URL"
curl -fsSL -o "$tmp/$ASSET.dgst" "$URL.dgst"
expected="$(grep -i 'SHA2-256' "$tmp/$ASSET.dgst" | head -1 | sed 's/.*= *//;s/[^0-9a-fA-F]//g')"
actual="$(sha256sum "$tmp/$ASSET" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "sha256 verification FAILED for $ASSET" >&2; exit 1
fi
echo "sha256 verified: $actual"
unzip -o -q "$tmp/$ASSET" -d "$tmp/x"
cp "$tmp/x/xray" core/xray
chmod 755 core/xray
rm -rf "$tmp"
./core/xray version | head -1
