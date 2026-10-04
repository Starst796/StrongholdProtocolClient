#!/usr/bin/env sh
# Release entry point: run this by hand after the game repo (../Stronghold-Protocol) has been updated.
# It aligns this repo's version to the game's APP_VERSION, builds the desktop client + Android apk,
# commits the result and writes the packages to build/dist/. See docs/PACKAGING.md (section 13).
set -eu
cd "$(dirname "$0")"

if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x "../Stronghold-Protocol/.tools/node/node" ]; then
  NODE=../Stronghold-Protocol/.tools/node/node
else
  echo "[x] Node.js 22+ not found. Install it, or put the game repo's vendored node at ../Stronghold-Protocol/.tools/node/node" >&2
  exit 1
fi

exec "$NODE" tools/package-release.mjs "$@"
