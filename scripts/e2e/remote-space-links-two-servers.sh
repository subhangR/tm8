#!/usr/bin/env bash
# W9c end to end: two real tm8 servers on this machine, linked across servers.
#
#   S1 (home, space A) and S2 (target, space B), each with its own database,
#   both with TM8_REMOTE_SPACE_LINKS=on and the DEV-only loopback switch.
#
#   1. grant on S2 -> pairing code; claim it from S1 (add server, add link, login);
#      the code is single use
#   2. invoke through the link: query, create, patch; the refused set holds
#   3. spawn in B through the link (W9C_E2E_SPAWN=1: launches a real agent);
#      provenance on S2, the child pinned to B and stamped with the link
#   4. audit on both sides; B's admins see the inbound link and its calls
#   5. S2 admin revoke -> S1's next call gets 401 -> S1 row signed_out
#   6. S1 logout -> the session minted on S2 is revoked there
#   7. S2 switch off -> S1 gets "does not support remote space links", row stays signed_in
#   8. S1 switch off -> today's behaviour (space_link_remote_disabled)
#
# Needs: a built tree (npm run build), psql/createdb on PATH, and a Postgres
# you own with a MIGRATED template database (db/migrate.mjs up). Never point
# it at a live node's cluster.
#
#   scripts/e2e/remote-space-links-two-servers.sh <pg-port> <template-db> [s1-port] [s2-port]
set -euo pipefail

PG_PORT=${1:?pg port}; TEMPLATE=${2:?migrated template db}; P1=${3:-7791}; P2=${4:-7792}
ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/w9c-e2e.XXXXXX")
DB1="w9c_e2e_s1_$$"; DB2="w9c_e2e_s2_$$"
PGURL="postgres://$USER@127.0.0.1:$PG_PORT"
PASS=0

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "  ok  $*"; }
need() { grep -q -- "$2" <<<"$1" || fail "$3 (got: ${1:0:400})"; }

for p in "$P1" "$P2"; do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then fail "port $p is busy"; fi
done

cleanup() {
  for p in "$P1" "$P2"; do
    pid=$(lsof -tnP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null || true); [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  sleep 1
  dropdb -h 127.0.0.1 -p "$PG_PORT" --if-exists "$DB1" >/dev/null 2>&1 || true
  dropdb -h 127.0.0.1 -p "$PG_PORT" --if-exists "$DB2" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

createdb -h 127.0.0.1 -p "$PG_PORT" -T "$TEMPLATE" "$DB1"
createdb -h 127.0.0.1 -p "$PG_PORT" -T "$TEMPLATE" "$DB2"

# S2 accepts any space-credential probe, so a dummy GitHub token can be B's
# default (a link spawn runs git only on it). E2E only.
cat >"$WORK/boot-probe-ok.mjs" <<EOF
import { bootstrap } from '$ROOT/packages/server/dist/main.js';
const { url } = await bootstrap({ startBackgroundJobs: true,
  spaceCredentialProbe: async () => ({ ok: true, displayLogin: 'e2e-dummy' }) });
console.log('listening on ' + url);
EOF

start() { # name port db switch entry
  mkdir -p "$WORK/data-$1" "$WORK/proj-$1"
  env -i PATH="$ROOT/packages/cli/dist:$PATH" HOME="$HOME" USER="$USER" \
    TM8_PORT="$2" TM8_HOST=127.0.0.1 \
    TM8_DATABASE_URL="$PGURL/$3" TM8_DELIVERY_DATABASE_URL="postgres://tm8_delivery_worker@127.0.0.1:$PG_PORT/$3" \
    TM8_DATA_DIR="$WORK/data-$1" TM8_PROJECT_DIR="$WORK/proj-$1" TM8_UI_DIR="$ROOT/packages/tm8-ui/dist" \
    TM8_REMOTE_SPACE_LINKS="$4" TM8_REMOTE_SPACE_LINKS_ALLOW_LOOPBACK=1 \
    node "$5" >"$WORK/$1.log" 2>&1 &
  for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$2/health" >/dev/null && return 0; sleep 1; done
  cat "$WORK/$1.log" >&2; fail "$1 did not start"
}
stop() { kill "$(lsof -tnP -iTCP:"$1" -sTCP:LISTEN)"; while lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; do sleep 1; done; }
cli() { local p=$1; shift; env -i PATH="$PATH" HOME="$WORK/home-$p" TM8_BASE_URL="http://127.0.0.1:$p" node "$ROOT/packages/cli/dist/index.js" "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
q1() { psql -h 127.0.0.1 -p "$PG_PORT" -d "$DB1" -Atc "$1"; }
q2() { psql -h 127.0.0.1 -p "$PG_PORT" -d "$DB2" -Atc "$1"; }

SERVER_JS="$ROOT/packages/server/dist/index.js"
start s1 "$P1" "$DB1" on "$SERVER_JS"
start s2 "$P2" "$DB2" on "$WORK/boot-probe-ok.mjs"
mkdir -p "$WORK/home-$P1" "$WORK/home-$P2"

A=$(cli "$P1" space create "Home A" --format json | json "d['space']['id']")
B=$(cli "$P2" space create "Target B" --format json | json "d['space']['id']")
invoke() { curl -s -X POST "http://127.0.0.1:$P1/v2/spaces/$A/space-links/b/invoke" -H 'content-type: application/json' -d "$1"; }

echo "1. grant, claim"
GRANT=$(cli "$P2" link grant "$A" --label "s1 e2e" --allow-spawn --space "$B")
CODE=$(grep -o 'tm8pair_[A-Za-z0-9_-]*' <<<"$GRANT") || fail "no pairing code printed"
ok "grant printed a pairing code"
cli "$P1" server add s2 --url "http://127.0.0.1:$P2" --space "$A" >/dev/null
need "$(cli "$P1" link add "$B" --target-server s2 --alias b --space "$A")" "signed_out" "link add"
need "$(cli "$P1" link login b --pairing-code "$CODE" --space "$A")" "signed_in" "login with the code"
ok "claimed: S1 row signed in"
need "$(q2 "select t.status, t.ciphertext is null, s.kind, s.space_id = '$B', s.via_link_id = t.link_id
  from space_link_tokens t join auth_sessions s on s.id = t.auth_session_id where t.remote_inbound")" "signed_in|t|link|t|t" "S2 inbound row"
ok "S2 holds a link session pinned to B, stamped with its link, and no sealed bytes"
need "$(cli "$P1" link login b --pairing-code "$CODE" --space "$A" 2>&1 || true)" "pairing" "reused code"
ok "the code is single use"

echo "2. invoke: query, create, patch, refused"
need "$(invoke "{\"op\":\"spaces.get\",\"params\":{\"spaceId\":\"$B\"}}")" '"name":"Target B"' "query"
ok "query"
CREATED=$(invoke "{\"op\":\"entities.create\",\"input\":{\"spaceId\":\"$B\",\"kind\":\"task\",\"title\":\"from S1\",\"clientMutationId\":\"e2e-create-$$\"}}")
E=$(json "d['data']['result']['entity']['id']" <<<"$CREATED") || fail "create: $CREATED"
ok "create (entity $E in B)"
need "$(invoke "{\"op\":\"entities.patch\",\"params\":{\"id\":\"$E\"},\"input\":{\"expectedVersion\":1,\"title\":\"patched from S1\",\"clientMutationId\":\"e2e-patch-$$\"}}")" '"title":"patched from S1"' "patch"
ok "patch"
need "$(invoke "{\"op\":\"credentials.space.list\",\"params\":{\"spaceId\":\"$B\"}}")" "credential_management" "refused set"
ok "refused set holds (credentials.*)"

echo "3. spawn"
if [ "${W9C_E2E_SPAWN:-0}" = 1 ]; then
  curl -s -X POST "http://127.0.0.1:$P2/v2/spaces/$B/credentials" -H 'content-type: application/json' \
    -d '{"provider":"github","shape":"token","label":"e2e dummy","secret":"ghp_e2edummy000000000000000000000000000000","spaceOwned":true,"clientMutationId":"e2e-gh"}' >/dev/null
  TM=$(cli "$P2" entity query --kind team_member --space "$B" --format json | json "[r['id'] for r in d['page']['items'] if r['title']=='TM8 Helper'][0]")
  SPAWNED=$(invoke "{\"op\":\"execution.spawn\",\"input\":{\"spaceId\":\"$B\",\"teamMemberId\":\"$TM\",\"title\":\"e2e remote spawn\",\"promptExtra\":\"Reply ok and stop.\",\"clientMutationId\":\"e2e-spawn-$$\"}}")
  WS=$(json "d['data']['result']['entity']['id']" <<<"$SPAWNED") || fail "spawn: $SPAWNED"
  need "$(q2 "select l.link_id is not null, s.kind, s.space_id = '$B' from space_link_spawns l
    join auth_sessions s on s.work_session_id = l.work_session_id and s.via_link_id = l.link_id where l.work_session_id = '$WS'")" "t|agent|t" "spawn provenance"
  ok "spawned $WS in B: provenance recorded, child pinned to B under the link"
  cli "$P2" session terminate "$WS" --force --yes --space "$B" >/dev/null || true
else
  echo "  skip spawn (set W9C_E2E_SPAWN=1 to launch a real agent on S2)"
fi

echo "4. audit on both sides"
need "$(q1 "select count(*) from cross_space_audit where result = 'ok'")" "^[3-9]" "S1 audit"
need "$(q2 "select count(*) from cross_space_audit where result = 'ok'")" "^[3-9]" "S2 audit"
need "$(cli "$P2" link inbound-audit --space "$B")" "entities.patch" "inbound audit"
ok "S1 and S2 both audit every call; B's admins read them"

echo "5. S2 admin revoke -> 401 -> S1 signed_out"
L2=$(q2 "select link_id from space_link_tokens where remote_inbound")
cli "$P2" link revoke "$L2" --space "$B" >/dev/null
need "$(invoke "{\"op\":\"spaces.get\",\"params\":{\"spaceId\":\"$B\"}}")" "space_link_signed_out" "after revoke"
need "$(cli "$P1" link list --space "$A")" "signed_out" "S1 marked stale"
ok "revoked on S2; S1 marked the link signed_out"

echo "6. S1 logout revokes on S2"
cli "$P2" link restore "$L2" --space "$B" >/dev/null
CODE=$(cli "$P2" link grant "$A" --allow-spawn --space "$B" | grep -o 'tm8pair_[A-Za-z0-9_-]*')
cli "$P1" link login b --pairing-code "$CODE" --space "$A" >/dev/null
LINK1=$(q1 "select link_id from space_link_tokens limit 1")
curl -s -X POST "http://127.0.0.1:$P1/v2/space-links/$LINK1/logout" -H 'content-type: application/json' -d '{"clientMutationId":"e2e-logout"}' >/dev/null
need "$(q2 "select count(*) from auth_sessions where kind = 'link' and revoked_at is null")" "^0$" "S2 sessions after logout"
ok "S1 logout ended the session on S2"

echo "7. S2 switch off -> unsupported, not signed_out"
CODE=$(cli "$P2" link grant "$A" --space "$B" | grep -o 'tm8pair_[A-Za-z0-9_-]*')
cli "$P1" link login b --pairing-code "$CODE" --space "$A" >/dev/null
stop "$P2"; start s2 "$P2" "$DB2" off "$SERVER_JS"
need "$(invoke "{\"op\":\"spaces.get\",\"params\":{\"spaceId\":\"$B\"}}")" "does not support remote space links" "unsupported"
need "$(cli "$P1" link list --space "$A")" "signed_in" "row untouched"
ok "an S2 without the switch reads as unsupported; the S1 row stays signed in"

echo "8. S1 switch off -> today's behaviour"
stop "$P1"; start s1 "$P1" "$DB1" off "$SERVER_JS"
need "$(invoke "{\"op\":\"spaces.get\",\"params\":{\"spaceId\":\"$B\"}}")" "space_link_remote_disabled" "S1 off invoke"
need "$(cli "$P1" link add "$B" --target-server s2 --space "$A" 2>&1 || true)" "space_link_remote_disabled" "S1 off add"
ok "switch off: remote links refuse exactly as before W9c"

echo "PASS: $PASS checks"
