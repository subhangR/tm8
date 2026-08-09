#!/usr/bin/env bash
# tm8 PROD UI — 7777, `vite preview` over the built packages/tm8-ui/dist.
#
# Not a dev server: this serves the bundle deploy.sh produced and nothing else.
# /v2 and /health proxy to 7778 with ws:true — the app must stay same-origin
# because tm8-server sends no CORS headers, and /v2 carries both the workspace
# event stream and the per-session PTY socket.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

if [[ ! -f "$TM8_PROD_ROOT/packages/tm8-ui/dist/index.html" ]]; then
  echo "run-ui.sh: no UI bundle at $TM8_PROD_ROOT/packages/tm8-ui/dist — run deploy/prod/deploy.sh" >&2
  exit 78   # EX_CONFIG: supervise.sh gives up rather than looping on it
fi

if [[ ! -x "$TM8_PROD_ROOT/packages/tm8-ui/node_modules/.bin/vite" ]]; then
  echo "run-ui.sh: no vite at $TM8_PROD_ROOT/packages/tm8-ui/node_modules/.bin/vite — the snapshot's" >&2
  echo "  node_modules did not come across; run deploy/prod/deploy.sh" >&2
  exit 78
fi

if [[ -z "$TM8_NODE_BIN" || ! -x "$TM8_NODE_BIN" ]]; then
  echo "run-ui.sh: no node 22 found — install one (brew install node@22), or point at it:" >&2
  echo "  TM8_NODE_BIN=/path/to/node $0" >&2
  exit 78
fi

cd "$TM8_PROD_ROOT/packages/tm8-ui"

# Run vite under the SAME node the server resolved, not the `#!/usr/bin/env node`
# in its bin shim. The shim's node is whatever the ambient PATH answers, which is
# a different runtime from prod's on any machine with more than one — and it does
# not even have to be a working one. Installing node@22 here upgraded simdjson,
# which left the linked Homebrew node 25 unable to load libsimdjson.29: the UI
# aborted (134) on every start while the server on 7778 was perfectly healthy.
# One resolved binary for both halves means one thing to keep working.
exec "$TM8_NODE_BIN" node_modules/.bin/vite preview --config vite.preview.config.ts
