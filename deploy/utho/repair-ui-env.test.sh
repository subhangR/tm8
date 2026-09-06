#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/prod.env" <<'EOF'
TM8_UI_DIR=/opt/tm8/prod/packages/tm8_ui_2.0/dist-2.0
TM8_UI_1_0_DIR=/opt/tm8/prod/packages/tm8-ui/dist
TM8_UI_2_0_DIR=/opt/tm8/prod/packages/tm8-ui/dist
SOME_TM8_UI_DIR=leave-this-alone
EOF

bash "$ROOT/deploy/utho/repair-ui-env.sh" "$TMP/prod.env" /opt/tm8/prod
bash "$ROOT/deploy/utho/repair-ui-env.sh" "$TMP/prod.env" /opt/tm8/prod

cat > "$TMP/expected.env" <<'EOF'
TM8_UI_DIR=/opt/tm8/prod/packages/tm8-ui/redesign-1.0
TM8_UI_2_0_DIR=/opt/tm8/prod/packages/tm8_ui_2.0/dist-2.0
SOME_TM8_UI_DIR=leave-this-alone
EOF

diff -u "$TMP/expected.env" "$TMP/prod.env"

: > "$TMP/empty.env"
bash "$ROOT/deploy/utho/repair-ui-env.sh" "$TMP/empty.env" /srv/tm8
grep -Fx 'TM8_UI_DIR=/srv/tm8/packages/tm8-ui/redesign-1.0' "$TMP/empty.env" >/dev/null
grep -Fx 'TM8_UI_2_0_DIR=/srv/tm8/packages/tm8_ui_2.0/dist-2.0' "$TMP/empty.env" >/dev/null

echo 'deploy UI env repair: PASS'
