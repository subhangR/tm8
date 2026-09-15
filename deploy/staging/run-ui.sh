#!/usr/bin/env bash
# tm8 STAGING UI — 8888, vite dev with HMR over packages/tm8-ui.
#
# NOT `vite preview` and NOT a built bundle: prod serves a frozen dist, staging
# serves the source. Edit a .tsx and the browser updates.
#
# --port/--strictPort on the CLI override the charter-fixed 4612 in
# vite.config.ts. The proxy target comes from TM8_SERVER_ORIGIN (env.sh), which
# that config already reads — /v2 and /health, ws included, so the app stays
# same-origin. tm8-server sends no CORS headers; this proxy is load-bearing.
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

cd "$TM8_STAGING_ROOT/packages/tm8-ui"
exec node_modules/.bin/vite --port 8888 --strictPort --host 127.0.0.1
