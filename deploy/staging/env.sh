#!/usr/bin/env bash
# tm8 STAGING environment — the LIVE tree.
#
# Staging is not a build. It runs straight out of this working tree, so an edit
# to packages/server or packages/tm8-ui shows up on staging without a deploy.
# That is the whole point of it: prod (7777/7778) is a frozen snapshot under
# ~/.local/share/tm8-stable and never reloads; staging is where you watch your
# changes land.
#
#   staging UI      http://127.0.0.1:8888   (vite dev, HMR, packages/tm8-ui)
#   staging server  http://127.0.0.1:8887   (node + tsc -b --watch, auto-restart)
#   staging DB      tm8_staging @ 5442      (created fresh 2026-07-31, migrated from 001)
#   staging data    ~/.tm8-staging          (ISOLATED — shares nothing with prod)
#
# Sourced by run-server.sh and run-ui.sh. Do not run directly.

TM8_STAGING_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export TM8_STAGING_ROOT

export TM8_ENV=dev
export TM8_BIND=127.0.0.1
export TM8_PORT=8887
export TM8_UI_PORT=8888
export TM8_PG_PORT=5442

export TM8_DATABASE_URL="postgres://tm8@127.0.0.1:5442/tm8_staging"
export TM8_DELIVERY_DATABASE_URL="postgres://tm8_delivery_worker@127.0.0.1:5442/tm8_staging"

# Isolated on purpose. Prod and the old :4610 service share
# ~/.local/share/tm8/data; staging must not be able to touch either, so its
# blobs, spawn manifests and agent workspace all live under ~/.tm8-staging.
export TM8_DATA_DIR="$HOME/.tm8-staging/data"
export TM8_PROJECT_DIR="$HOME/.tm8-staging/workspace"

export TM8_LAUNCH_BOOTSTRAP=1
export TM8_SESSION_CAP=unlimited
export TM8_LOG_LEVEL=debug

# Same two switches the stable build documents, for the same reasons:
#   TM8_IDEMPOTENCY_ENABLED=0 — the ledger gate refuses saves from the authoring
#     lane's resetting `au-<n>` clientMutationIds.
#   TM8_PREVIEW_ENABLED=0 — TM8_PREVIEW_PORT is a FIXED 4613 already held
#     elsewhere, AND setting config.preview deletes `localhost` from this node's
#     own host allowlist, which breaks reaching the UI as localhost:8888.
export TM8_IDEMPOTENCY_ENABLED=0
export TM8_PREVIEW_ENABLED=0

# The vite dev proxy target (packages/tm8-ui/vite.config.ts reads this).
export TM8_SERVER_ORIGIN="http://127.0.0.1:8887"
