#!/usr/bin/env bash
# tm8 PROD environment — the single source of truth for the 7777/7778 instance.
#
# Prod is a FROZEN BUILD, not the working tree: `deploy/prod/deploy.sh` snapshots
# whatever is checked out, builds it with `tsc -b --force` + `vite build`, and
# rotates the result into $TM8_PROD_DIR. Nothing here reloads on a source edit —
# that is staging's job (8888/8887, deploy/staging/env.sh).
#
#   prod UI      http://127.0.0.1:7777   (vite preview over packages/tm8-ui/dist)
#   prod server  http://127.0.0.1:7778   (node packages/server/dist/index.js)
#   prod DB      tm8_stable @ 5442
#   prod data    ~/.local/share/tm8/data
#
# Sourced by deploy.sh, run-server.sh and run-ui.sh. Do not run directly.
#
# ROOT is derived from THIS FILE's location, so the same scripts work in the repo
# and inside the rotated snapshot without editing a path. That is why the launch
# scripts live in-repo now: the previous prod kept run-server.sh / run-ui.sh /
# supervise.sh / vite.preview.config.ts ONLY inside the deployed directory, so a
# plain rsync of the tree did not carry them and the UI supervisor crash-looped.

TM8_PROD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export TM8_PROD_ROOT

# --- where the frozen build lives -------------------------------------------
# Overridable so a rehearsal deploy can target a scratch directory.
export TM8_PROD_DIR="${TM8_PROD_DIR:-$HOME/.local/share/tm8-stable}"
export TM8_PROD_NEXT="${TM8_PROD_DIR}-next"
export TM8_PROD_PREV="${TM8_PROD_DIR}-prev"
export TM8_PROD_BACKUP_DIR="${TM8_PROD_BACKUP_DIR:-$HOME/.local/share/tm8-prod-backups}"

# --- runtime ----------------------------------------------------------------
export TM8_ENV=prod
export TM8_BIND=127.0.0.1
# Overridable only so a rehearsal deploy can run on scratch ports; prod is 7778/7777.
export TM8_PORT="${TM8_PORT:-7778}"
export TM8_UI_PORT="${TM8_UI_PORT:-7777}"
export TM8_PG_PORT=5442

# Deliberately NOT `${TM8_DATABASE_URL:-…}`: an ambient TM8_DATABASE_URL left
# over from a staging or migration shell must never silently repoint prod. The
# escape hatch is a distinct name that nothing else exports, so a rehearsal
# deploy has to ask for it on purpose.
export TM8_DATABASE_URL="${TM8_PROD_DB_URL:-postgres://tm8@127.0.0.1:5442/tm8_stable}"
export TM8_DELIVERY_DATABASE_URL="${TM8_PROD_DELIVERY_DB_URL:-postgres://tm8_delivery_worker@127.0.0.1:5442/tm8_stable}"

# Shared with the old live instance ON PURPOSE: prod's rows were cloned from
# tm8_dev and their blobs / spawn manifests already point in here, and the store
# is content-addressed. Staging is the one that must stay isolated.
export TM8_DATA_DIR="${TM8_DATA_DIR:-$HOME/.local/share/tm8/data}"
export TM8_PROJECT_DIR="${TM8_PROJECT_DIR:-$HOME/.local/share/tm8/workspace}"

export TM8_LAUNCH_BOOTSTRAP=1
export TM8_SESSION_CAP=unlimited
export TM8_LOG_LEVEL=info

# Idempotency ledger OFF (2026-07-31). The ledger gate refuses saves from the
# authoring lane's `au-<n>` clientMutationIds, which reset every page load and
# walk back onto ids already bound to a different operation. Note this also
# re-hides the silent-replay path; the real fix is unique ids upstream.
export TM8_IDEMPOTENCY_ENABLED=0

# Artifact-preview listener OFF. TM8_PREVIEW_PORT is a FIXED 4613 that another
# instance holds, so the listener dies with EADDRINUSE anyway; worse, setting
# config.preview makes http/security.ts DELETE `localhost` from this node's own
# host allowlist, and every browser reaching the UI as localhost:7777 is then
# refused with `Host "localhost:7777" is not this node`.
export TM8_PREVIEW_ENABLED=0

# Serve the same bundle 7777 serves, so :7778 is a same-origin fallback.
export TM8_UI_DIR="$TM8_PROD_ROOT/packages/tm8-ui/dist"

# The vite preview proxy target (packages/tm8-ui/vite.preview.config.ts reads it).
export TM8_SERVER_ORIGIN="http://127.0.0.1:7778"

# node, never bun: packages/server and packages/execution load node-pty, which
# does not work under bun (README "Hard rules"). node-pty 1.1.0 ships N-API
# prebuilds — see node_modules/.bun/node-pty@*/node_modules/node-pty/prebuilds/
# — so nothing is compiled against a particular binary and any node of the
# right MAJOR will load it. What must not drift is the major: CI builds and
# tests on 22 (.github/workflows/ci.yml NODE_VERSION), so prod runs 22 too.
#
# Hence: pin the major, resolve the path. An absolute path here encodes one
# machine's layout — it broke the moment Homebrew node was uninstalled, and it
# fails as "no node at …" rather than "wrong node". Candidates are tried in
# order and the first one reporting major 22 wins; a login shell's bare `node`
# is the LAST resort, not the first.
#
# Override for a deliberate off-major run:  TM8_NODE_BIN=/path/to/node ./deploy.sh
_tm8_find_node() {
  local c
  for c in "$HOME/.local/bin/node" \
           /opt/homebrew/opt/node@22/bin/node \
           "$(command -v node || true)"; do
    [[ -n "$c" && -x "$c" ]] || continue
    [[ "$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == 22 ]] \
      && { echo "$c"; return 0; }
  done
  return 0                      # let deploy.sh's preflight report it, not a sourced file
}
export TM8_NODE_BIN="${TM8_NODE_BIN:-$(_tm8_find_node)}"
unset -f _tm8_find_node

# Postgres 18 CLIENT binaries, explicitly. Homebrew keeps postgresql@18 keg-only,
# so a machine that also has an older postgresql formula answers bare `psql` and
# `pg_dump` from THAT one — /opt/homebrew/bin/psql is whichever version got
# linked, not the one the sidecar speaks. psql tolerates the skew; pg_dump does
# not (step 5 dies with "server version mismatch"), and db/migrate.mjs tries
# bare `psql` before the keg, so it inherits the wrong client too. Setting this
# short-circuits both (migrate.mjs findPsql() reads TM8_PSQL first).
_tm8_find_psql() {
  local c
  for c in /opt/homebrew/opt/postgresql@18/bin/psql \
           /usr/local/opt/postgresql@18/bin/psql \
           /usr/lib/postgresql/18/bin/psql \
           "$(command -v psql || true)"; do
    [[ -n "$c" && -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 0
}
export TM8_PSQL="${TM8_PSQL:-$(_tm8_find_psql)}"
unset -f _tm8_find_psql
