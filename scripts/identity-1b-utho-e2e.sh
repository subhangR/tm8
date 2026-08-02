#!/bin/bash
# Identity 1b acceptance instrument — the CLI auth + per-server credential
# store flow against a REMOTE tm8 server over TLS. Named by the Identity Lead
# as the rerun gate once Identity 3 deploys staging forward.
#
# Blocked as of 2026-08-02: the deployed staging build injects
# clientMutationId into command bodies before validation and its strict auth
# DTOs refuse it ("Unrecognized key(s): 'clientMutationId'" even for an empty
# curl body). origin/main does not have this defect. After redeploy, this
# script must pass end to end — and additionally, an unauthenticated remote
# request must get NOTHING (the auto-owner exposure is an Identity 3
# acceptance criterion; this script only proves the credential flow).
#
#   TARGET   — server base URL   (default: Utho staging)
#   TM8_CLI  — built CLI entry   (default: this repo's packages/cli/dist)
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${TM8_CLI:-$REPO/packages/cli/dist/index.js}"
TARGET="${TARGET:-https://tm8-server.tail28ac62.ts.net:8888}"
CRED="$(mktemp -d)/credentials.json"
USER_NAME="${E2E_USER:-identity1b-e2e}"
PASS="${E2E_PASS:-utho-e2e-Correct-7}"

H() {
  env -u TM8_SESSION_ID -u TM8_TEAM_MEMBER_ID -u TM8_AGENT_TOKEN -u TM8_SPACE_ID \
      -u TM8_MANIFEST_PATH -u TM8_JOURNAL_PATH -u TM8_TASK_IDS -u TM8_PROJECT_ID \
      TM8_BASE_URL="$TARGET" TM8_CREDENTIALS_PATH="$CRED" \
      node "$CLI" "$@"
}

echo "== signup (idempotent if the account exists) =="
H auth signup "$USER_NAME" --password "$PASS" --display-name "Identity 1b E2E"; echo "exit=$?"
echo "== login (stores per origin) =="
H auth login "$USER_NAME" --password "$PASS"; echo "exit=$?"
echo "== stored origins + perms =="
python3 -c "import json;d=json.load(open('$CRED'));print('STORED ORIGINS:', list(d['credentials']))"
stat -f 'perms=%Lp' "$CRED" 2>/dev/null || stat -c 'perms=%a' "$CRED"
echo "== auth session (bearer via store, over TLS) =="
H auth session; echo "exit=$?"
echo "== logout (revokes + removes) =="
H auth logout; echo "exit=$?"
echo "== store file after logout (must be gone) =="
ls "$CRED" 2>&1
echo "== auth session after logout =="
H auth session; echo "exit=$? (non-loopback: must NOT be auto-owner once Identity 3 closes the exposure)"
