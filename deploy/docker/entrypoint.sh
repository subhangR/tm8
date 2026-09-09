#!/usr/bin/env bash
set -euo pipefail
cd /workspace/tm8

# `docker compose run --rm tm8 bash` is also a plain Ubuntu development shell.
if [[ "${1:-dev}" != dev ]]; then
  exec "$@"
fi
if (( $# > 0 )); then shift; fi

children=()
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( ${#children[@]} )); then
    kill -TERM "${children[@]}" 2>/dev/null || true
    wait "${children[@]}" 2>/dev/null || true
  fi
  if [[ "${TM8_DATABASE_MANAGED:-}" != external ]]; then bash deploy/pg/ensure-cluster.sh --stop || true; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo '[docker] Installing Linux dependencies from the mounted checkout'
bun install --frozen-lockfile

# A retained dependency volume can contain a failed build or a binary for an
# older Node ABI. Bun does not always rerun its install hook in that case.
if ! node -e 'require(require.resolve("node-pty", { paths: ["./packages/execution"] }))' >/dev/null 2>&1; then
  echo '[docker] Building node-pty for the container runtime'
  pty_dir=$(node -p 'require("node:path").dirname(require.resolve("node-pty/package.json", { paths: ["./packages/execution"] }))')
  (cd "$pty_dir" && node-gyp rebuild)
fi

if [[ "${TM8_DATABASE_MANAGED:-}" != external ]]; then
  bash deploy/pg/ensure-cluster.sh --db tm8_dev
  node db/migrate.mjs up
fi
bun run build

# Docker forwards to container interfaces, but tm8 and Vite bind loopback.
# Keep their existing configuration and relay TCP (including WebSockets).
socat TCP-LISTEN:14610,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:4610 &
children+=("$!")
socat TCP-LISTEN:14611,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:4611 &
children+=("$!")

node scripts/dev.mjs --no-build "$@" &
children+=("$!")
wait -n "${children[@]}"
