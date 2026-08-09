#!/usr/bin/env bash
# tm8 PROD server — 7778, from the frozen build this script sits inside.
#
# Runs under plain node (node-pty needs it), NOT bun and NOT tsc --watch. ROOT
# comes from this script's own path, so the deploy rotation (next → live → prev)
# needs no edits and a rehearsal copy runs itself.
#
# Exit 78 (EX_CONFIG) means "this machine is misconfigured, restarting will not
# help" — supervise.sh gives up on it instead of looping. Everything else is a
# crash and stays restartable.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

if [[ ! -f "$TM8_PROD_ROOT/packages/server/dist/index.js" ]]; then
  echo "run-server.sh: no build at $TM8_PROD_ROOT/packages/server/dist/index.js — run deploy/prod/deploy.sh" >&2
  exit 78
fi

# env.sh resolves TM8_NODE_BIN by PROBING for a node 22 and leaves it EMPTY when
# there is none, so this is not paranoia about an unset variable: a `brew upgrade`
# that moves the bare node off 22, or a keg that was never installed, empties it.
# Without this check the exec below runs `exec "" …` and dies at 127 —
# which the supervisor then retries forever, and the caller only ever sees
# "server did not report db:ok within 90s". Name the actual cause instead.
if [[ -z "$TM8_NODE_BIN" || ! -x "$TM8_NODE_BIN" ]]; then
  echo "run-server.sh: no node 22 found (server+execution load node-pty, broken under bun)." >&2
  echo "  env.sh probes ~/.local/bin/node, the node@22 keg, then PATH." >&2
  echo "  Install one:  brew install node@22" >&2
  echo "  Or point at it:  TM8_NODE_BIN=/path/to/node $0" >&2
  exit 78
fi

mkdir -p "$TM8_PROJECT_DIR" "$TM8_DATA_DIR"
cd "$TM8_PROJECT_DIR"
exec "$TM8_NODE_BIN" --enable-source-maps "$TM8_PROD_ROOT/packages/server/dist/index.js"
