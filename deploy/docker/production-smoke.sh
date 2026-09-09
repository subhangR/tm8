#!/usr/bin/env bash
set -euo pipefail
test "$(id -un)" = tm8
test "$(id -G)" = 1000
test ! -S /var/run/docker.sock
test ! -e /var/lib/postgresql/data
test -r /workspace/tm8/packages/server/dist/index.js
bash deploy/docker/production.sh > /tmp/tm8-production-smoke.log 2>&1 &
task_server=$!
cleanup() { kill -TERM "$task_server" 2>/dev/null || true; wait "$task_server" 2>/dev/null || true; }
trap cleanup EXIT
for task_attempt in {1..30}; do
  if bash deploy/docker/healthcheck.sh 2>/dev/null; then
    node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const page = await fetch('http://127.0.0.1:4610/');
assert.equal(page.status, 200); assert.match(await page.text(), /<html/);
const anonymous = await fetch('http://127.0.0.1:4610/v2/workspaces/me');
assert.equal(anonymous.status, 401);
console.log('PASS: production UI/API, required sign-in, isolated system user and private service mounts');
JS
    exit 0
  fi
  kill -0 "$task_server" 2>/dev/null || break
  sleep 1
done
echo 'Production smoke failed; private logs are in /tmp/tm8-production-smoke.log' >&2
exit 1
