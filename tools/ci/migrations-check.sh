#!/usr/bin/env bash
# tm8 migration gate.
#
# Three layers, all cheap:
#   A. static  — naming, ordering, duplicate numbering, and the "no legacy
#                references" law (zero Firebase/Supabase/UID-bypass residue, T-D3).
#                Runs everywhere, always.
#   B. apply   — apply the whole sequence to a throwaway database and roll it back.
#                Runs only when a Postgres is reachable; otherwise SKIPS LOUDLY.
#   C. identity — on B's migrated database, fail on any function reading identity_id()
#                that is not on tools/ci/identity-id-allowlist.txt (identity-id-gate.sh).
#                Runs only when B ran and passed.
#
# Until db/migrations has content (W1, Cygnus) this is a passing placeholder that
# says so out loud. It is wired into tools/ci/check.sh from day one so the gate
# exists before the migrations do.
#
#   bash tools/ci/migrations-check.sh
#
# Connection resolution for layer B (first that works):
#   $TM8_MIGRATION_DATABASE_URL  →  $DATABASE_URL  →  postgres://localhost:$TM8_PG_PORT/postgres
#
# DB SAFETY (standing rule, 2026-09-25): there is NO default port. Layer B
# creates and drops a scratch database, and 5442 is the PROD cluster on the tm8
# host, so when the resolved port is 5442 or unset layer B is REFUSED: skipped
# loudly on a workstation (the pre-push path), and a hard failure under CI=true
# so a mis-set workflow can never pass by skipping. The one exception is a
# GitHub Actions runner (GITHUB_ACTIONS=true), whose 5442 is the job's own
# throwaway postgres container (.github/workflows/ci.yml).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

MIGRATIONS_DIR="db/migrations"
: "${TM8_PG_PORT:=}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_YELLOW=""
fi
note() { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
warn() { printf '    %s%s%s\n' "$C_YELLOW" "$1" "$C_RESET"; }
err()  { printf '    %s%s%s\n' "$C_RED" "$1" "$C_RESET" >&2; }

# Portable file collection: macOS still ships bash 3.2, which has no `mapfile` and
# treats an empty array as unset under `set -u` — hence the explicit counter.
MIGRATIONS=()
MIGRATION_COUNT=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  MIGRATIONS[$MIGRATION_COUNT]="$line"
  MIGRATION_COUNT=$((MIGRATION_COUNT + 1))
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' 2>/dev/null | sort)

if [ "$MIGRATION_COUNT" -eq 0 ]; then
  warn "no .sql files in $MIGRATIONS_DIR yet — migration gate is a placeholder"
  note "the one clean sequence lands at W1 (db/README.md groups 001-008); this check"
  note "goes live automatically the moment the first NNN_*.sql file appears."
  exit 0
fi

FAILED=0

# --- layer A: static --------------------------------------------------------
note "static checks over ${#MIGRATIONS[@]} migration file(s)"

seen_numbers=""
for path in "${MIGRATIONS[@]}"; do
  file="$(basename "$path")"

  if ! [[ "$file" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]]; then
    err "bad name: $file — expected NNN_lower_snake_case.sql (applied in lexical order)"
    FAILED=1
    continue
  fi

  number="${file:0:3}"
  case " $seen_numbers " in
    *" $number "*) err "duplicate migration number $number ($file)"; FAILED=1 ;;
    *) seen_numbers="$seen_numbers $number" ;;
  esac
done

# The no-legacy-references law (T-D3): the clean sequence must carry zero residue
# from the Supabase/Firebase branch it cribs from.
FORBIDDEN='supabase|firebase|auth\.uid\(\)|service_role|SUPABASE_'
if grep -rEin "$FORBIDDEN" "$MIGRATIONS_DIR" >/dev/null 2>&1; then
  err "legacy references found in $MIGRATIONS_DIR (T-D3 forbids Firebase/Supabase/UID-bypass residue):"
  grep -rEin "$FORBIDDEN" "$MIGRATIONS_DIR" >&2 | head -20
  FAILED=1
fi

[ "$FAILED" -eq 0 ] && note "static checks ok"

# --- layer B: apply to a throwaway database ---------------------------------
resolve_url() {
  if [ -n "${TM8_MIGRATION_DATABASE_URL:-}" ]; then echo "$TM8_MIGRATION_DATABASE_URL"; return; fi
  if [ -n "${DATABASE_URL:-}" ]; then echo "$DATABASE_URL"; return; fi
  if [ -n "${TM8_PG_PORT}" ]; then echo "postgres://postgres@localhost:${TM8_PG_PORT}/postgres"; return; fi
  echo ""
}

# The explicit port of a postgres URL, or "" when it has none. Strips the
# scheme, any userinfo, the path and the query, then takes what follows the
# last ':' of host:port (no IPv6 literals are used by this repo's URLs).
url_port() {
  local rest="${1#*://}"
  rest="${rest##*@}"
  rest="${rest%%/*}"
  rest="${rest%%\?*}"
  case "$rest" in
    *:*) echo "${rest##*:}" ;;
    *) echo "" ;;
  esac
}

# Refuse a URL on 5442 or with no explicit port. Returns 0 when it is safe.
test_port_ok() {
  local port
  port="$(url_port "$1")"
  [ -n "$port" ] || return 1
  [ "$port" != "5442" ] || [ "${GITHUB_ACTIONS:-}" = "true" ]
}

if ! command -v psql >/dev/null 2>&1; then
  warn "psql not found — SKIPPING the apply check (static checks only)"
  note "install the postgres client, or run this in CI where the service container provides it"
  exit "$FAILED"
fi

ADMIN_URL="$(resolve_url)"
if [ -z "$ADMIN_URL" ] || ! test_port_ok "$ADMIN_URL"; then
  found="port $(url_port "$ADMIN_URL")"; [ "$found" = "port " ] && found="no port (unset)"
  msg="refusing the apply check: the migration Postgres resolves to ${found}. 5442 is the PROD cluster on the tm8 host. Set TM8_PG_PORT=5443 or TM8_MIGRATION_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres — the test cluster is on 5443."
  if [ "${CI:-}" = "true" ]; then
    err "$msg"
    exit 1
  fi
  warn "$msg"
  warn "SKIPPING the apply check (static checks only)"
  exit "$FAILED"
fi
if ! psql "$ADMIN_URL" -c 'SELECT 1' >/dev/null 2>&1; then
  warn "no Postgres reachable at ${ADMIN_URL%%\?*} — SKIPPING the apply check (static checks only)"
  note "start the sidecar (\`bun run dev\`) or set TM8_MIGRATION_DATABASE_URL"
  exit "$FAILED"
fi

SCRATCH_DB="tm8_migcheck_$$"
note "applying the sequence to a scratch database: $SCRATCH_DB"

cleanup() {
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1
}
trap cleanup EXIT

if ! psql "$ADMIN_URL" -q -c "CREATE DATABASE $SCRATCH_DB" >/dev/null 2>&1; then
  err "could not create scratch database $SCRATCH_DB"
  exit 1
fi

SCRATCH_URL="${ADMIN_URL%/*}/$SCRATCH_DB"
for path in "${MIGRATIONS[@]}"; do
  note "  apply $(basename "$path")"
  if ! psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -f "$path"; then
    err "migration failed: $path"
    FAILED=1
    break
  fi
done

[ "$FAILED" -eq 0 ] && note "the full sequence applies clean to a fresh database"

# --- layer C: the identity_id() gate (plan 01a0d9eb W3, F7) -----------------
# Against the same freshly migrated catalog: every function that reads the
# caller's identity must be on tools/ci/identity-id-allowlist.txt.
if [ "$FAILED" -eq 0 ]; then
  note "identity_id() gate over the migrated catalog"
  if ! bash "$REPO_ROOT/tools/ci/identity-id-gate.sh" "$SCRATCH_URL"; then
    err "identity_id() gate failed (tools/ci/identity-id-gate.sh)"
    FAILED=1
  fi
fi
exit "$FAILED"
