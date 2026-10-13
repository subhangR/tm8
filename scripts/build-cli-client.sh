#!/usr/bin/env bash
# build-cli-client.sh — the client-only tm8 CLI as ONE self-contained binary.
#
# A member who only needs to talk to a node (sign up from an invite, read and
# write the graph, spawn sessions) should not clone and build the monorepo.
# This compiles packages/cli with `bun build --compile`: the bun runtime, the
# CLI and its workspace deps (@tm8/contract, @tm8/prompt, the argv-only git
# helpers of @tm8/execution) in one file. No server, no Postgres, no UI.
#
#   scripts/build-cli-client.sh                       # host target -> dist-client/tm8
#   scripts/build-cli-client.sh --target bun-linux-x64
#   scripts/build-cli-client.sh --target bun-darwin-arm64 --out dist-client/tm8-darwin-arm64
#
# Needs: bun, and `bun install` done in this checkout (workspace links).
# Writes <out> and <out>.sha256. Install the result with
#   install -m 0755 dist-client/tm8 ~/.local/bin/tm8
# then point it at a node: docs/ops/CONNECT-CLI-TO-REMOTE-NODE.md.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TARGET=""
OUT=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --target) TARGET=${2:?--target needs a value, e.g. bun-linux-x64}; shift 2 ;;
    --target=*) TARGET=${1#--target=}; shift ;;
    --out) OUT=${2:?--out needs a path}; shift 2 ;;
    --out=*) OUT=${1#--out=}; shift ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "build-cli-client: unknown argument $1" >&2; exit 2 ;;
  esac
done
OUT=${OUT:-$ROOT/dist-client/tm8${TARGET:+-${TARGET#bun-}}}
[[ $OUT = /* ]] || OUT=$PWD/$OUT

command -v bun >/dev/null || { echo "build-cli-client: bun is required (https://bun.sh)" >&2; exit 1; }
[[ -e $ROOT/packages/cli/node_modules/@tm8/contract ]] \
  || { echo "build-cli-client: run \`bun install\` in $ROOT first" >&2; exit 1; }

# The workspace packages resolve through their package.json exports, i.e.
# their dist/. Build just the CLI's project references (contract, prompt,
# execution) — not the server or the UI.
(cd "$ROOT" && bunx tsc -b packages/cli)

mkdir -p "$(dirname "$OUT")"
# Version from the CLI package, so `tm8 --version` on a binary is traceable.
args=(build "$ROOT/packages/cli/src/index.ts" --compile --minify --sourcemap=none --outfile "$OUT")
[[ -n $TARGET ]] && args+=(--target "$TARGET")
(cd "$ROOT" && bun "${args[@]}")

if command -v sha256sum >/dev/null; then
  (cd "$(dirname "$OUT")" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256")
else
  (cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
fi
echo "built $OUT ($(du -h "$OUT" | cut -f1)); sha256 in $OUT.sha256"
