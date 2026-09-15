#!/usr/bin/env bash
# =============================================================================
# tm8 TOPOLOGY — the single source of truth for ports, databases and paths.
#
#   source deploy/environments.sh
#   tm8_env_load prod        # exports TM8_ENV_* for the prod slot
#   tm8_env_list             # print the whole table
#
# WHY THIS FILE EXISTS
#
# Until 2026-08-12 this repo described three different topologies and only one
# of them was real:
#
#   README.md            server 4610, UI 4611, pg 5442, data ~/.tm8
#   deploy/prod/env.sh   server 7778, UI 7777, db tm8_stable, ~/.local/share/tm8-stable
#   deploy/utho/deploy.sh  server 17777, nginx 7777, db tm8_prod, /opt/tm8/prod
#
# The third is what actually runs. The other two sent every new reader to a
# machine that did not exist — which is the whole onboarding bug. Subhang ruled
# on 2026-08-12: the live topology is canonical and the other two get corrected.
# So the numbers live HERE, once, and every script reads them from here.
#
# The `dev` row is not one of the three. It is the row that was MISSING: a slot
# for a fresh clone on someone's laptop that collides with nothing above.
#
# BASH 3.2. No associative arrays — macOS ships bash 3.2 and always will, so the
# table is a `case`, not a `declare -A`. Same reason deploy/local.sh guards its
# array expansion.
# =============================================================================

# ---------------------------------------------------------------------------
# The table.
#
#  env      server   proxy   vite-dev   pg     database       unit(s)
#  -------- -------- ------- ---------- ------ -------------- ---------------------------
#  dev      4610     —       4611       5442   tm8_dev        (none — foreground)
#  staging  8887     8888    18888      5443   tm8_staging    tm8-staging,tm8-staging-ui
#  prod     17777    7777    —          5442   tm8_prod       tm8-prod
#  private  7779     —       —          5444   tm8_private    tm8-private
#
# `proxy` is the port a human opens (nginx, or vite preview). `server` is the
# node process — always loopback-only, never exposed directly.
#
# dev shares the 5442 CLUSTER with prod but not its DATABASE. That is deliberate
# and matches how the box already works: one cluster on 5442 holds tm8_prod plus
# ~130 scratch databases. On a laptop there is no prod and 5442 is simply free.
# staging and private have their own clusters (5443, 5444) because that is how
# they were built; this file records reality rather than tidying it.
# ---------------------------------------------------------------------------

# Load one environment slot into TM8_ENV_* variables.
# Usage: tm8_env_load <dev|staging|prod|private>
tm8_env_load() {
  local slot="${1:-}"
  case "$slot" in
    dev)
      TM8_ENV_NAME=dev
      TM8_ENV_SERVER_PORT=4610
      TM8_ENV_PROXY_PORT=4611          # vite dev doubles as the thing you open
      TM8_ENV_VITE_PORT=4611
      TM8_ENV_PG_PORT=5442
      TM8_ENV_PG_CLUSTER=main
      TM8_ENV_DATABASE=tm8_dev
      TM8_ENV_UNITS=""                 # foreground; no service is installed
      TM8_ENV_BUILD_UI=0               # vite dev serves source
      TM8_ENV_LOG_LEVEL=debug
      TM8_ENV_SERVER_ENV=dev
      ;;
    staging)
      TM8_ENV_NAME=staging
      TM8_ENV_SERVER_PORT=8887
      TM8_ENV_PROXY_PORT=8888
      TM8_ENV_VITE_PORT=18888
      TM8_ENV_PG_PORT=5443
      TM8_ENV_PG_CLUSTER=staging
      TM8_ENV_DATABASE=tm8_staging
      TM8_ENV_UNITS="tm8-staging,tm8-staging-ui"
      TM8_ENV_BUILD_UI=0               # staging runs vite DEV against source
      TM8_ENV_LOG_LEVEL=debug
      TM8_ENV_SERVER_ENV=dev
      ;;
    prod)
      TM8_ENV_NAME=prod
      TM8_ENV_SERVER_PORT=17777
      TM8_ENV_PROXY_PORT=7777
      TM8_ENV_VITE_PORT=""             # prod serves a built bundle, no vite
      TM8_ENV_PG_PORT=5442
      TM8_ENV_PG_CLUSTER=prod
      TM8_ENV_DATABASE=tm8_prod
      TM8_ENV_UNITS="tm8-prod"
      TM8_ENV_BUILD_UI=1               # prod serves packages/tm8-ui/dist
      TM8_ENV_LOG_LEVEL=info
      TM8_ENV_SERVER_ENV=prod
      ;;
    private)
      TM8_ENV_NAME=private
      TM8_ENV_SERVER_PORT=7779
      TM8_ENV_PROXY_PORT=""
      TM8_ENV_VITE_PORT=""
      TM8_ENV_PG_PORT=5444
      TM8_ENV_PG_CLUSTER=private
      TM8_ENV_DATABASE=tm8_private
      TM8_ENV_UNITS="tm8-private"
      TM8_ENV_BUILD_UI=1
      TM8_ENV_LOG_LEVEL=info
      TM8_ENV_SERVER_ENV=prod
      ;;
    *)
      echo "environments.sh: unknown environment '${slot:-<empty>}' (dev|staging|prod|private)" >&2
      return 2
      ;;
  esac

  # --- derived: the Postgres major tm8 standardises on ----------------------
  # 16, ruled 2026-08-12. Docs used to say 18 and CI pinned 17; the three live
  # clusters run 16 and nothing needed 18, so 16 is the number. It is a DEFAULT,
  # not an assertion: the installer accepts a newer server, because a client can
  # always talk to an older one and pg_dump refuses only the reverse.
  TM8_ENV_PG_MAJOR="${TM8_PG_MAJOR:-16}"

  # --- derived: connection URLs --------------------------------------------
  # The superuser URL owns the schema and runs migrations. The app URL is what
  # the server authenticates as for graph reads/writes. The delivery URL must
  # AUTHENTICATE as tm8_delivery_worker — not merely be able to SET ROLE to it
  # (packages/server/src/facade/services/w2/execution.ts asserts this), which is
  # why loopback trust is a real install step and not a nicety.
  TM8_ENV_SUPERUSER="${TM8_PG_SUPERUSER:-tm8}"
  TM8_ENV_SUPERUSER_URL="postgres://${TM8_ENV_SUPERUSER}@127.0.0.1:${TM8_ENV_PG_PORT}/${TM8_ENV_DATABASE}"
  TM8_ENV_MAINTENANCE_URL="postgres://${TM8_ENV_SUPERUSER}@127.0.0.1:${TM8_ENV_PG_PORT}/postgres"
  TM8_ENV_DATABASE_URL="$TM8_ENV_SUPERUSER_URL"
  TM8_ENV_DELIVERY_URL="postgres://tm8_delivery_worker@127.0.0.1:${TM8_ENV_PG_PORT}/${TM8_ENV_DATABASE}"

  export TM8_ENV_NAME TM8_ENV_SERVER_PORT TM8_ENV_PROXY_PORT TM8_ENV_VITE_PORT \
         TM8_ENV_PG_PORT TM8_ENV_PG_CLUSTER TM8_ENV_DATABASE TM8_ENV_UNITS \
         TM8_ENV_BUILD_UI TM8_ENV_LOG_LEVEL TM8_ENV_SERVER_ENV TM8_ENV_PG_MAJOR \
         TM8_ENV_SUPERUSER TM8_ENV_SUPERUSER_URL TM8_ENV_MAINTENANCE_URL \
         TM8_ENV_DATABASE_URL TM8_ENV_DELIVERY_URL
}

# Where a slot's checkout, data and env file live.
#
# Two layouts, because a laptop and a server are genuinely different shapes and
# pretending otherwise is what produced `deploy/tm8-server.service` pointing at
# /home/ubuntu/tm8-workspace on a box where that path has never existed:
#
#   system  (root/systemd)  checkout /opt/tm8/<env>   env /etc/tm8/<env>.env
#   user    (a laptop)      checkout <the clone>      env <clone>/.env.<env>.local
#
# Usage: tm8_env_paths <slot> <system|user> [checkout-dir-for-user-layout]
tm8_env_paths() {
  local slot="$1" layout="$2" clone="${3:-}"
  case "$layout" in
    system)
      TM8_ENV_CHECKOUT="/opt/tm8/$slot"
      TM8_ENV_ENVFILE="/etc/tm8/$slot.env"
      TM8_ENV_DATA_DIR="/var/lib/tm8/$slot/data"
      TM8_ENV_PROJECT_DIR="/var/lib/tm8/$slot/workspace"
      TM8_ENV_RUN_USER="${TM8_RUN_USER:-tm8}"
      ;;
    user)
      [[ -n "$clone" ]] || { echo "environments.sh: user layout needs a checkout dir" >&2; return 2; }
      TM8_ENV_CHECKOUT="$clone"
      TM8_ENV_ENVFILE="$clone/.env.$slot.local"
      TM8_ENV_DATA_DIR="$HOME/.tm8-$slot/data"
      TM8_ENV_PROJECT_DIR="$HOME/.tm8-$slot/workspace"
      TM8_ENV_RUN_USER="$(id -un)"
      ;;
    *)
      echo "environments.sh: unknown layout '$layout' (system|user)" >&2
      return 2
      ;;
  esac
  export TM8_ENV_CHECKOUT TM8_ENV_ENVFILE TM8_ENV_DATA_DIR TM8_ENV_PROJECT_DIR TM8_ENV_RUN_USER
}

# Print the table. Kept next to the data so it cannot drift from it.
tm8_env_list() {
  printf '%-9s %-8s %-7s %-9s %-6s %-14s %s\n' \
    env server proxy vite-dev pg database units
  local slot
  for slot in dev staging prod private; do
    tm8_env_load "$slot" >/dev/null || continue
    printf '%-9s %-8s %-7s %-9s %-6s %-14s %s\n' \
      "$TM8_ENV_NAME" "$TM8_ENV_SERVER_PORT" "${TM8_ENV_PROXY_PORT:--}" \
      "${TM8_ENV_VITE_PORT:--}" "$TM8_ENV_PG_PORT" "$TM8_ENV_DATABASE" \
      "${TM8_ENV_UNITS:-(foreground)}"
  done
}

# Run directly for a quick look: `bash deploy/environments.sh`
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  tm8_env_list
fi
