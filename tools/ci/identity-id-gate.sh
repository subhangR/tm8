#!/usr/bin/env bash
# tm8 identity_id() gate (plan 01a0d9eb §3 W3, F7).
#
# Every function that reads the caller's identity decides for itself whether the
# caller may act, and so is a place where the space boundary can be bypassed
# (the pinned-session claim is only honoured where a helper intersects with it).
# This gate lists them from the LIVE CATALOG of a migrated database, not by
# grepping the migrations, so a function that was later replaced or dropped does
# not count, and one created by a DO block or a dynamic EXECUTE does.
#
# What counts as a reader (review 5324130793 B1-B3):
#   ROOTS      internal.identity_id(), and the two wrappers that hand the identity
#              on: internal.require_identity() and internal.current_account_id().
#   BY SOURCE  a function whose body names a root, case-insensitively and with or
#              without quotes (IDENTITY_ID(), "identity_id"()), read from prosrc AND
#              from a BEGIN ATOMIC body (prosqlbody, where prosrc is empty); or
#              whose body reads the raw setting tm8.identity_id (reader `setting`).
#   BY CATALOG anything pg_depend records as depending on a root: RLS policies,
#              column defaults, views, BEGIN ATOMIC functions.
# Each line is `<root|setting> <object>`: a function as schema.name(identity args),
# anything else as pg_describe_object prints it with an empty search_path.
#
# SCOPE. Callers of the two wrappers are covered BY NAME: a new one fails the
# gate. The callers that existed when this was added are one generated,
# grandfathered block in the allow-list, owned by audit task 01a0db76-8571,
# which extends the gate transitively (every identity-returning wrapper found by
# query) and classifies each caller. Until then a wrapper not named above is not
# a root.
#
# The gate FAILS when:
#   - a reader is not on tools/ci/identity-id-allowlist.txt (review it for the
#     space pin, then add its line in the same PR), or
#   - a line on the allow-list no longer matches a live reader (delete it), so the
#     list stays exactly the live set and a removed line cannot hide a new reader
#     that reuses the name.
#
#   bash tools/ci/identity-id-gate.sh --list <database-url>   prints the live set
#   bash tools/ci/identity-id-gate.sh <database-url>
#
# Called by tools/ci/migrations-check.sh against its scratch database after the
# full sequence applies clean. Never point it at a production database: it only
# reads pg_proc, but the url carries credentials into the process table.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALLOWLIST="${TM8_IDENTITY_ID_ALLOWLIST:-$REPO_ROOT/tools/ci/identity-id-allowlist.txt}"

LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then LIST_ONLY=1; shift; fi
if [ "$#" -ne 1 ]; then
  echo "usage: identity-id-gate.sh [--list] <database-url>" >&2
  exit 2
fi
URL="$1"

if [ ! -f "$ALLOWLIST" ]; then
  echo "identity_id() gate: allow-list not found at $ALLOWLIST" >&2
  exit 1
fi

QUERY="
set search_path to '';
with roots(reader, fn, pat) as (values
  ('identity_id',        to_regprocedure('internal.identity_id()'),        '\"?identity_id\"?[[:space:]]*\\([[:space:]]*\\)'),
  ('require_identity',   to_regprocedure('internal.require_identity()'),   '\"?require_identity\"?[[:space:]]*\\('),
  ('current_account_id', to_regprocedure('internal.current_account_id()'), '\"?current_account_id\"?[[:space:]]*\\(')
),
fns as (
  select p.oid,
         n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as obj,
         coalesce(p.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(p.oid), '') as body
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname not in ('pg_catalog', 'information_schema')
     and n.nspname !~ '^pg_toast'
)
select r.reader || ' ' || f.obj from roots r join fns f on f.body ~* r.pat
union
select 'setting ' || f.obj from fns f where f.body ~* 'tm8\\.identity_id'
union
select r.reader || ' ' || coalesce(f.obj, pg_describe_object(d.classid, d.objid, d.objsubid))
  from roots r
  join pg_depend d on d.refclassid = 'pg_proc'::regclass and d.refobjid = r.fn
  left join fns f on d.classid = 'pg_proc'::regclass and f.oid = d.objid
order by 1"

LIVE="$(psql "$URL" -X -q -v ON_ERROR_STOP=1 -At -c "$QUERY")" || {
  echo "identity_id() gate: could not read pg_proc" >&2
  exit 1
}

if [ "$LIST_ONLY" -eq 1 ]; then
  printf '%s\n' "$LIVE" | grep -v '^$' | LC_ALL=C sort -u
  exit 0
fi

# Comments (#) and blank lines are ignored; everything else is one exact line.
LISTED="$(sed -e 's/#.*$//' -e 's/[[:space:]]*$//' "$ALLOWLIST" | grep -v '^$' | LC_ALL=C sort -u)"
LIVE="$(printf '%s\n' "$LIVE" | grep -v '^$' | LC_ALL=C sort -u)"

UNLISTED="$(LC_ALL=C comm -23 <(printf '%s\n' "$LIVE") <(printf '%s\n' "$LISTED") | grep -v '^$')"
STALE="$(LC_ALL=C comm -13 <(printf '%s\n' "$LIVE") <(printf '%s\n' "$LISTED") | grep -v '^$')"

live_count="$(printf '%s\n' "$LIVE" | grep -c . || true)"
FAILED=0

if [ -n "$UNLISTED" ]; then
  FAILED=1
  echo "identity_id() gate: these read the caller's identity and are NOT on the allow-list:" >&2
  printf '%s\n' "$UNLISTED" | sed 's/^/      /' >&2
  echo "    Each one decides for itself whether the caller may act. Check that it honours" >&2
  echo "    the pinned space (internal.session_space_id(), 227) or cannot reach another" >&2
  echo "    space, then add its line to tools/ci/identity-id-allowlist.txt in the same PR." >&2
fi

if [ -n "$STALE" ]; then
  FAILED=1
  echo "identity_id() gate: these allow-list lines match no live reader; delete them:" >&2
  printf '%s\n' "$STALE" | sed 's/^/      /' >&2
fi

if [ "$FAILED" -eq 0 ]; then
  echo "identity_id() gate: $live_count live reader(s), all on the allow-list"
fi
exit "$FAILED"
