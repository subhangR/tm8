#!/usr/bin/env bash
# =============================================================================
# tm8 DESKTOP — the one command. Builds this checkout and opens it as an app.
#
#   bun run desktop               # build server + UI → vendor Postgres → open the app
#   bun run desktop --no-build    # open the app on whatever is already built
#
# The app is apps/desktop: an Electron window around the SAME server bundle
# (packages/server/dist) and the SAME UI build (packages/tm8-ui/dist) that
# `bun run local` serves. Nothing desktop-only is compiled; the shell forks the
# server and loads whatever URL it reports.
#
# It is its own node, not a window onto 7777/7778: its own Postgres 18 (bundled,
# socket-only, so it cannot collide with the 5442 cluster), its own data under
# ~/Library/Application Support/tm8, and an ephemeral HTTP port. The first
# launch runs initdb + every migration (~10 s); later launches take ~2 s.
# Quitting the app stops its server and its Postgres; nothing else is touched.
#
# macOS arm64 only for now (the vendored Postgres is aarch64-apple-darwin).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"

BOLD=$'\033[1m'; OFF=$'\033[0m'
step() { printf '%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }

DO_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)/$(uname -m)" != Darwin/arm64 ]]; then
  echo "tm8 desktop currently runs on macOS arm64 only (got $(uname -s)/$(uname -m))." >&2
  exit 1
fi

cd "$ROOT"

# --- 1. dependencies ---------------------------------------------------------
if [[ ! -d "$DESKTOP/node_modules/electron" ]]; then
  step "installing dependencies (adds electron)"
  bun install
fi

# Electron's postinstall unzips its binary with extract-zip, which under recent
# Node stops mid-archive and exits 0 — leaving a ~240 KB husk and no path.txt.
# The zip it downloaded is intact in the cache, so unpack that with ditto.
ELECTRON_PKG="$(cd "$DESKTOP/node_modules/electron" && pwd -P)"
if ! node -e "require('$ELECTRON_PKG')" >/dev/null 2>&1; then
  step "unpacking the electron binary"
  ( cd "$ELECTRON_PKG" && node install.js ) || true
  if ! node -e "require('$ELECTRON_PKG')" >/dev/null 2>&1; then
    version="$(node -p "require('$ELECTRON_PKG/package.json').version")"
    zip="$(find "$HOME/Library/Caches/electron" -name "electron-v$version-darwin-arm64.zip" 2>/dev/null | head -1)"
    if [[ -z "$zip" ]]; then
      echo "electron $version was not downloaded; rerun after 'rm -rf $ELECTRON_PKG && bun install'." >&2
      exit 1
    fi
    rm -rf "$ELECTRON_PKG/dist" && mkdir "$ELECTRON_PKG/dist"
    ditto -x -k "$zip" "$ELECTRON_PKG/dist"
    printf 'Electron.app/Contents/MacOS/Electron' > "$ELECTRON_PKG/path.txt"
  fi
fi

# --- 2. build ------------------------------------------------------------------
if [[ "$DO_BUILD" == 1 ]]; then
  step "building server + CLI"
  bun run build
  step "building UI"
  ( cd packages/tm8-ui && bun run build )
fi

# --- 3. bundled Postgres (cached; a no-op once vendored) -----------------------
node "$DESKTOP/scripts/vendor-pg.mjs"

# --- 4. open -------------------------------------------------------------------
step "opening tm8 desktop (quit the app to stop it)"
cd "$DESKTOP"
exec "$(node -p "require('$ELECTRON_PKG')")" .
