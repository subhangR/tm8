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

# env.sh's node probe returns EMPTY rather than failing, on purpose: a sourced
# file must not exit its caller, so it defers the complaint. deploy.sh's preflight
# makes that complaint — but this script is also launched directly, by supervise.sh
# and by systemd, where nothing has run that preflight. Without this guard an
# empty TM8_NODE_BIN reaches `exec ""`, and the supervisor crash-loops on a
# message that names nothing.
if [[ -z "${TM8_NODE_BIN:-}" || ! -x "$TM8_NODE_BIN" ]]; then
  echo "run-server.sh: no node 22 found. env.sh probes ~/.local/bin/node, the node@22" >&2
  echo "  keg, then PATH. Install one, or set TM8_NODE_BIN=/path/to/node." >&2
  exit 1
fi

mkdir -p "$TM8_PROJECT_DIR" "$TM8_DATA_DIR"
cd "$TM8_PROJECT_DIR"
exec "$TM8_NODE_BIN" --enable-source-maps "$TM8_PROD_ROOT/packages/server/dist/index.js"
