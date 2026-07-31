#!/usr/bin/env bash
# tm8 STAGING server — 8887, live-reloading from this working tree.
#
# scripts/dev.mjs does the reload half: `tsc -b --watch` over
# packages/{contract,server}/src and a SIGTERM+restart of the server whenever
# its dist changes. --server-only because dev.mjs's UI branch points at
# packages/ui (the legacy oracle); the product UI is packages/tm8-ui and is
# started by run-ui.sh instead.
#
# dev.mjs resolves env with the real process environment winning over every
# .env file and built-in default, so sourcing env.sh is sufficient to move it
# off the dev defaults (4610 / ~/.tm8-dev / tm8_dev).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

cd "$TM8_STAGING_ROOT"
exec /opt/homebrew/bin/node scripts/dev.mjs --server-only
