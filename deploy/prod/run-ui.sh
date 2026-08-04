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
  exit 1
fi

cd "$TM8_PROD_ROOT/packages/tm8-ui"
exec node_modules/.bin/vite preview --config vite.preview.config.ts
