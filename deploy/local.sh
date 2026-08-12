#!/usr/bin/env bash
# =============================================================================
# tm8 LOCAL — the one command. Boots the database, then the whole product on 7777.
#
#   bun run local                # postgres → build this checkout → serve 7777/7778
#   bun run local:status         # what is actually running, database included
#   bun run local:stop           # stop tm8 (the cluster stays up, see below)
#
#   ./deploy/local.sh --restart      # restart the current build, no rebuild
#   ./deploy/local.sh --rollback     # swap the previous build back in
#   ./deploy/local.sh --build-only   # compile only; nothing is stopped
#   ./deploy/local.sh --no-pg        # skip the database step entirely
#
# Any other flag is passed straight through to deploy/prod/deploy.sh.
#
# WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT CHANGE
#
# `deploy/prod/deploy.sh` was already a good one-command deploy: it builds before
# it stops anything, rotates so rollback is one mv, and verifies on the wire. Its
# one gap was that step 1 ASSERTS Postgres on 5442 is reachable and dies if not —
# nothing on this machine ever started it. This wrapper closes exactly that gap
# and changes nothing else.
#
# 7777 keeps its frozen-snapshot semantics (ruled 2026-08-05). It serves a built
# copy at ~/.local/share/tm8-stable, NOT the working tree, and it does not reload
# when you edit source. That is the point: it is the instance you can trust while
# you break things. If you want your edit to appear as you type it, that is
# staging — `deploy/staging/run-server.sh` + `run-ui.sh` on 8887/8888.
#
# Stopping tm8 leaves the cluster running, on purpose. That one cluster holds
# tm8_staging and ~130 test databases besides prod's tm8_stable, so stopping it
# to stop prod would take unrelated work down with it. Stop it explicitly with
# `./deploy/pg/ensure-cluster.sh --stop`.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BOLD=$'\033[1m'; OFF=$'\033[0m'

DO_PG=1
PASSTHRU=()
MODE=deploy

for arg in "$@"; do
  case "$arg" in
    --no-pg)   DO_PG=0 ;;
    --status)  MODE=status;  PASSTHRU+=("$arg") ;;
    --stop)    MODE=stop;    PASSTHRU+=("$arg") ;;
    -h|--help) sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) PASSTHRU+=("$arg") ;;
  esac
done

# --- 1. the database ---------------------------------------------------------
# Before the deploy, because the deploy's own preflight is a hard assertion.
# Read prod's env for the port and database NAME rather than restating them —
# two sources of truth for a database name is how a deploy migrates the wrong one.
if [[ "$DO_PG" == 1 && "$MODE" != stop ]]; then
  # A subshell: env.sh exports TM8_DATABASE_URL and friends, and we must not leak
  # those into deploy.sh's environment. It deliberately reads TM8_PROD_DB_URL and
  # not TM8_DATABASE_URL so an ambient value cannot silently repoint prod.
  read -r pg_port pg_db < <(
    # shellcheck source=deploy/prod/env.sh
    source "$HERE/prod/env.sh"
    echo "$TM8_PG_PORT" "$(basename "${TM8_DATABASE_URL##*/}")"
  )

  if [[ "$MODE" == status ]]; then
    TM8_PG_PORT="$pg_port" "$HERE/pg/ensure-cluster.sh" --status
  else
    printf '\n%s[0] database%s\n' "$BOLD" "$OFF"
    TM8_PG_PORT="$pg_port" "$HERE/pg/ensure-cluster.sh" --db "$pg_db"
  fi
fi

# --- 2. everything else ------------------------------------------------------
# `${PASSTHRU[@]}` unguarded is an UNBOUND VARIABLE under `set -u` on bash 3.2 —
# which is the only bash macOS ships. That makes the no-argument `bun run local`
# (the headline command) the one invocation that always dies here, while every
# flagged form works, because a flag is what makes the array non-empty.
exec "$HERE/prod/deploy.sh" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
