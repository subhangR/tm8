#!/usr/bin/env bash
# Repair node-pty after any `bun install`.
#
# bun extracts npm tarballs without preserving the executable bit, so
# node-pty's `spawn-helper` lands as 0644 and every PTY spawn dies with
# "posix_spawnp failed". npm does not have this problem; bun does, every time.
#
# The root package.json runs this as `postinstall`, so it fires after every
# `bun install` without anyone remembering to. It stayed a documented MANUAL
# step for months, which meant it was skipped exactly when it mattered: a fresh
# worktree, installed and deployed by someone who had not read HOW-TO-TEST.md,
# whose PTY spawns then died as a bare 503. Run it by hand only after copying a
# node_modules in, or installing with --ignore-scripts.
#
# Confirm with `cd packages/execution && bun run harness` (expects 5/5).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
found=0

while IFS= read -r helper; do
  chmod +x "$helper"
  echo "  chmod +x $helper"
  found=$((found + 1))
done < <(find "$root" -path '*/node-pty/prebuilds/*/spawn-helper' -not -path '*/win32-*/*')

if [ "$found" -eq 0 ]; then
  # WARN, never fail. This script is the root package's `postinstall`, so a
  # non-zero exit here fails the entire `bun install` that invoked it — and
  # "no spawn-helper yet" is a perfectly ordinary state during one: a partial
  # workspace install, an `--ignore-scripts` run, a platform with no matching
  # prebuild, or simply a tree where node-pty has not been extracted yet.
  # Turning that into a hard install failure blocks the very command that would
  # have produced the file.
  #
  # Nothing is lost by warning: deploy/prod/deploy.sh and install.sh both ASSERT
  # the executable bit before they let a build reach a running server, so a
  # genuinely broken helper is still caught — at a point where failing is useful.
  echo "note: no node-pty spawn-helper found under $root (nothing to repair yet)." >&2
  echo "      If PTY spawns later fail with 'posix_spawnp failed', re-run this script." >&2
  exit 0
fi

echo "node-pty repaired ($found spawn-helper binaries made executable)"
