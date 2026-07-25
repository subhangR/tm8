#!/usr/bin/env bash
# tm8 migration gate.
#
# Two layers, both cheap:
#   A. static  — naming, ordering, duplicate numbering, and the "no legacy
#                references" law (zero Firebase/Supabase/UID-bypass residue, T-D3).
#                Runs everywhere, always.
#   B. apply   — apply the whole sequence to a throwaway database and roll it back.
#                Runs only when a Postgres is reachable; otherwise SKIPS LOUDLY.
#
# Until db/migrations has content (W1, Cygnus) this is a passing placeholder that
# says so out loud. It is wired into tools/ci/check.sh from day one so the gate
# exists before the migrations do.
#
#   bash tools/ci/migrations-check.sh
#
# Connection resolution for layer B (first that works):
#   $TM8_MIGRATION_DATABASE_URL  →  $DATABASE_URL  →  postgres://localhost:$TM8_PG_PORT/postgres

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

MIGRATIONS_DIR="db/migrations"
: "${TM8_PG_PORT:=5442}"

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
  echo "postgres://postgres@localhost:${TM8_PG_PORT}/postgres"
}

if ! command -v psql >/dev/null 2>&1; then
  warn "psql not found — SKIPPING the apply check (static checks only)"
  note "install the postgres client, or run this in CI where the service container provides it"
  exit "$FAILED"
fi

ADMIN_URL="$(resolve_url)"
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
exit "$FAILED"
