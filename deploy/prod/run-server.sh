#!/usr/bin/env bash
# tm8 PROD server — 7778, from the frozen build this script sits inside.
#
# Runs under plain node (node-pty needs it), NOT bun and NOT tsc --watch. ROOT
# comes from this script's own path, so the deploy rotation (next → live → prev)
# needs no edits and a rehearsal copy runs itself.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

if [[ ! -f "$TM8_PROD_ROOT/packages/server/dist/index.js" ]]; then
  echo "run-server.sh: no build at $TM8_PROD_ROOT/packages/server/dist/index.js — run deploy/prod/deploy.sh" >&2
  exit 1
fi

mkdir -p "$TM8_PROJECT_DIR" "$TM8_DATA_DIR"
cd "$TM8_PROJECT_DIR"
exec "$TM8_NODE_BIN" --enable-source-maps "$TM8_PROD_ROOT/packages/server/dist/index.js"
