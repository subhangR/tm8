#!/usr/bin/env bash
set -euo pipefail
cd /workspace/tm8
test -f packages/server/dist/index.js
test -f packages/tm8-ui/dist/index.html
children=()
cleanup() { trap - EXIT INT TERM; kill -TERM "${children[@]}" 2>/dev/null || true; wait "${children[@]}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' INT TERM
socat TCP-LISTEN:14610,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:4610 & children+=("$!")
socat TCP-LISTEN:14611,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:4610 & children+=("$!")
node --enable-source-maps packages/server/dist/index.js & children+=("$!")
wait -n "${children[@]}"
