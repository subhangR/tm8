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
#   E2E_PREPROVISIONED=1 — skip node-admin signup (required on secured Utho)
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="${TM8_CLI:-$REPO/packages/cli/dist/index.js}"
TARGET="${TARGET:-https://tm8-server.tail28ac62.ts.net:8888}"
TARGET_ORIGIN="$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$TARGET")"
CRED="$(mktemp -d)/credentials.json"
USER_NAME="${E2E_USER:-identity1b-e2e}"
PASS="${E2E_PASS:-utho-e2e-Correct-7}"
PREPROVISIONED="${E2E_PREPROVISIONED:-0}"
FAILURES=0

H() {
  env -u TM8_SESSION_ID -u TM8_TEAM_MEMBER_ID -u TM8_AGENT_TOKEN -u TM8_SPACE_ID \
      -u TM8_MANIFEST_PATH -u TM8_JOURNAL_PATH -u TM8_TASK_IDS -u TM8_PROJECT_ID \
      TM8_BASE_URL="$TARGET" TM8_CREDENTIALS_PATH="$CRED" \
      node "$CLI" "$@"
}

expect_ok() {
  local label="$1"
  shift
  echo "== $label =="
  if "$@"; then
    echo "PASS: $label"
  else
    local status=$?
    echo "FAIL: $label (exit=$status)"
    FAILURES=$((FAILURES + 1))
  fi
}

if [ "$PREPROVISIONED" = "1" ]; then
  echo "== signup skipped: account was provisioned on-box by the node admin =="
else
  expect_ok "signup (local/admin topology only)" \
    H auth signup "$USER_NAME" --password "$PASS" --display-name "Identity 1b E2E"
fi

echo "== login (stores per origin) =="
LOGIN_OUT="$(H auth login "$USER_NAME" --password "$PASS" 2>&1)"
LOGIN_STATUS=$?
printf '%s\n' "$LOGIN_OUT"
if [ "$LOGIN_STATUS" -eq 0 ] && ! printf '%s' "$LOGIN_OUT" | grep -q 'tm8s_'; then
  echo "PASS: login stores without printing the pass"
else
  echo "FAIL: login exit=$LOGIN_STATUS or printed a pass"
  FAILURES=$((FAILURES + 1))
fi

echo "== stored origins + perms =="
if python3 -c "import json;d=json.load(open('$CRED'));assert list(d['credentials']) == ['$TARGET_ORIGIN'];print('STORED ORIGINS:', list(d['credentials']))"; then
  echo "PASS: credential is keyed by the target origin"
else
  echo "FAIL: credential store origin"
  FAILURES=$((FAILURES + 1))
fi
PERMS="$(stat -f '%Lp' "$CRED" 2>/dev/null || stat -c '%a' "$CRED")"
if [ "$PERMS" = "600" ]; then
  echo "PASS: credential file mode is 0600"
else
  echo "FAIL: credential file mode is $PERMS"
  FAILURES=$((FAILURES + 1))
fi

expect_ok "auth session (bearer via store, over TLS)" H auth session
expect_ok "logout (revokes + removes)" H auth logout

echo "== store file after logout (must be gone) =="
if [ ! -e "$CRED" ]; then
  echo "PASS: empty credential store was removed"
else
  echo "FAIL: credential store still exists"
  FAILURES=$((FAILURES + 1))
fi

echo "== auth session after logout =="
if H auth session; then
  echo "FAIL: revoked credential fell through to remote auto-owner"
  FAILURES=$((FAILURES + 1))
else
  echo "PASS: revoked/absent credential gets no remote auto-owner"
fi

echo "== ${FAILURES} failure(s) =="
exit "$FAILURES"
