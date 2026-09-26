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
# Two readers are listed:
#   identity_id   the body calls identity_id()  (internal.identity_id(), 001)
#   setting       the body reads the raw setting tm8.identity_id, skipping the helper
#
# The gate FAILS when:
#   - a function reads the identity and is not on tools/ci/identity-id-allowlist.txt
#     (review it for the space pin, then add its line in the same PR), or
#   - a line on the allow-list no longer matches a live function (delete it), so the
#     list stays exactly the live set and a removed line cannot hide a new function
#     that reuses the signature.
#
#   bash tools/ci/identity-id-gate.sh <database-url>
#
# Called by tools/ci/migrations-check.sh against its scratch database after the
# full sequence applies clean. Never point it at a production database: it only
# reads pg_proc, but the url carries credentials into the process table.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALLOWLIST="${TM8_IDENTITY_ID_ALLOWLIST:-$REPO_ROOT/tools/ci/identity-id-allowlist.txt}"

if [ "$#" -ne 1 ]; then
  echo "usage: identity-id-gate.sh <database-url>" >&2
  exit 2
fi
URL="$1"

if [ ! -f "$ALLOWLIST" ]; then
  echo "identity_id() gate: allow-list not found at $ALLOWLIST" >&2
  exit 1
fi

# One line per (reader, function). The signature is schema.name(identity args), the
# same string pg_get_function_identity_arguments prints, so overloads stay distinct.
QUERY="
select r.reader || ' ' || n.nspname || '.' || p.proname
       || '(' || pg_get_function_identity_arguments(p.oid) || ')'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral (
  select 'identity_id' as reader where p.prosrc ~ 'identity_id[[:space:]]*\\([[:space:]]*\\)'
  union all
  select 'setting' where p.prosrc ~ 'tm8\\.identity_id'
) r
where n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname !~ '^pg_toast'
order by 1"

LIVE="$(psql "$URL" -X -v ON_ERROR_STOP=1 -At -c "$QUERY")" || {
  echo "identity_id() gate: could not read pg_proc" >&2
  exit 1
}

# Comments (#) and blank lines are ignored; everything else is one exact line.
LISTED="$(sed -e 's/#.*$//' -e 's/[[:space:]]*$//' "$ALLOWLIST" | grep -v '^$' | LC_ALL=C sort -u)"
LIVE="$(printf '%s\n' "$LIVE" | grep -v '^$' | LC_ALL=C sort -u)"

UNLISTED="$(LC_ALL=C comm -23 <(printf '%s\n' "$LIVE") <(printf '%s\n' "$LISTED") | grep -v '^$')"
STALE="$(LC_ALL=C comm -13 <(printf '%s\n' "$LIVE") <(printf '%s\n' "$LISTED") | grep -v '^$')"

live_count="$(printf '%s\n' "$LIVE" | grep -c . || true)"
FAILED=0

if [ -n "$UNLISTED" ]; then
  FAILED=1
  echo "identity_id() gate: these functions read the caller's identity and are NOT on the allow-list:" >&2
  printf '%s\n' "$UNLISTED" | sed 's/^/      /' >&2
  echo "    Each one decides for itself whether the caller may act. Check that it honours" >&2
  echo "    the pinned space (internal.session_space_id(), 227) or cannot reach another" >&2
  echo "    space, then add its line to tools/ci/identity-id-allowlist.txt in the same PR." >&2
fi

if [ -n "$STALE" ]; then
  FAILED=1
  echo "identity_id() gate: these allow-list lines match no live function; delete them:" >&2
  printf '%s\n' "$STALE" | sed 's/^/      /' >&2
fi

if [ "$FAILED" -eq 0 ]; then
  echo "identity_id() gate: $live_count live reader(s), all on the allow-list"
fi
exit "$FAILED"
