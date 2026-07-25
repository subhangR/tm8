#!/usr/bin/env bash
# Repair node-pty after any `bun install`.
#
# bun extracts npm tarballs without preserving the executable bit, so
# node-pty's `spawn-helper` lands as 0644 and every PTY spawn dies with
# "posix_spawnp failed". npm does not have this problem; bun does, every time.
#
# Run this after ANY bun install/add anywhere in the workspace, then confirm
# with `cd packages/execution && bun run harness` (expects 5/5).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
found=0

while IFS= read -r helper; do
  chmod +x "$helper"
  echo "  chmod +x $helper"
  found=$((found + 1))
done < <(find "$root" -path '*/node-pty/prebuilds/*/spawn-helper' -not -path '*/win32-*/*')

if [ "$found" -eq 0 ]; then
  echo "no node-pty spawn-helper found under $root — is node-pty installed?" >&2
  exit 1
fi

echo "node-pty repaired ($found spawn-helper binaries made executable)"
