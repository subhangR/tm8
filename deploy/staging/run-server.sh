#!/usr/bin/env bash
# tm8 STAGING server — 8887, live-reloading from this working tree.
#
# scripts/dev.mjs does the reload half: `tsc -b --watch` over
# packages/{contract,server}/src and a SIGTERM+restart of the server whenever
# its dist changes. --server-only because dev.mjs's UI branch points at
# packages/ui (the legacy oracle); the product UI is packages/tm8_ui_2.0 and is
# started by run-ui.sh instead.
#
# dev.mjs resolves env with the real process environment winning over every
# .env file and built-in default, so sourcing env.sh is sufficient to move it
# off the dev defaults (4610 / ~/.tm8-dev / tm8_dev).
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/env.sh"

cd "$TM8_STAGING_ROOT"

# Resolve node; do not hardcode it. This line read `/opt/homebrew/bin/node`,
# which is a macOS-only path — so this script could not run on Linux at all,
# which is the platform staging actually runs on. An absolute path also fails as
# "no such file" rather than "wrong node" the day a package manager moves it.
TM8_NODE_BIN="${TM8_NODE_BIN:-$(command -v node || true)}"
[[ -n "$TM8_NODE_BIN" && -x "$TM8_NODE_BIN" ]] \
  || { echo "run-server.sh: no node on PATH (set TM8_NODE_BIN)" >&2; exit 1; }

exec "$TM8_NODE_BIN" scripts/dev.mjs --server-only
