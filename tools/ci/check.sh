#!/usr/bin/env bash
# tm8 CI — the merge gate. Same script locally, in the pre-push hook, and in GitHub Actions.
#
#   bash tools/ci/check.sh                  full run (install + typecheck + tests + migrations)
#   bash tools/ci/check.sh --fast           skip install AND the migration check (pre-push default:
#                                           a local tree already has node_modules)
#   bash tools/ci/check.sh --no-migrations  skip ONLY the migration check, still install. This is the
#                                           CI `check` job's shape: a fresh runner has no node_modules,
#                                           and the separate `migrations` job owns the migration apply.
#   bash tools/ci/check.sh --no-install
#
# Rules this script enforces structurally:
#   * per-package SCOPED `tsc -b`, run sequentially — never a parallel vite build
#     (concurrent vite builds SIGTERM each other; old-repo lesson)
#   * a skipped stage is always REPORTED as skipped, never silently passed
#   * it never runs git, never writes outside the repo, never touches ~/.tm8*
#
# Exit code is non-zero if any stage failed. Stages run to completion so one run
# surfaces every problem, not just the first.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FAST=0
DO_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1; DO_INSTALL=0 ;;
    # Skips the migration stage WITHOUT skipping install. `--fast` cannot serve
    # a fresh CI runner: it also drops install, and every later stage then dies
    # as `vitest: command not found` / `Cannot find module '@tm8/contract'`.
    --no-migrations) FAST=1 ;;
    --no-install) DO_INSTALL=0 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- output helpers ---------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BOLD=""
fi

FAILURES=0
SUMMARY=()

stage() { printf '\n%s==> %s%s\n' "$C_BOLD" "$1" "$C_RESET"; }
pass()  { SUMMARY+=("${C_GREEN}PASS${C_RESET}  $1"); }
fail()  { SUMMARY+=("${C_RED}FAIL${C_RESET}  $1"); FAILURES=$((FAILURES + 1)); }
skip()  { SUMMARY+=("${C_YELLOW}SKIP${C_RESET}  $1 ${C_DIM}($2)${C_RESET}"); printf '%s    skipped: %s%s\n' "$C_DIM" "$2" "$C_RESET"; }
# A red result that does NOT fail the run — used only where red is the expected,
# designed state (the conformance suite before G1). Always printed loudly.
advise() { SUMMARY+=("${C_YELLOW}RED (advisory)${C_RESET}  $1 ${C_DIM}($2)${C_RESET}"); }

# Run a command, record pass/fail under a label, keep going either way.
run_stage() {
  local label="$1"; shift
  stage "$label"
  printf '%s    $ %s%s\n' "$C_DIM" "$*" "$C_RESET"
  if "$@"; then pass "$label"; else fail "$label"; fi
}

# --- 0. toolchain -----------------------------------------------------------
stage "toolchain"
command -v bun >/dev/null 2>&1 || { echo "${C_RED}bun is not installed${C_RESET}" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "${C_RED}node is not installed${C_RESET}" >&2; exit 2; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
echo "    bun  $(bun --version)"
echo "    node $(node --version)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "${C_RED}    node >= 20 is required (packages/server + packages/execution run under node)${C_RESET}" >&2
  exit 2
fi

# --- 1. install -------------------------------------------------------------
if [ "$DO_INSTALL" -eq 1 ]; then
  if [ -n "${CI:-}" ]; then
    run_stage "install (frozen lockfile)" bun install --frozen-lockfile
  else
    run_stage "install" bun install
  fi
else
  skip "install" "--fast/--no-install"
fi

# --- 2. typecheck: per-package scoped tsc -b, SEQUENTIAL --------------------
# Order matters: contract first (everything references it), then dependents.
#
# The three groups below (TSC_PROJECTS, packages/ui, packages/tm8_ui_2.0) are
# mirrored by the root `bun run typecheck` shorthand, in this same order, as
# typecheck:core -> typecheck:ui -> typecheck:tm8-ui-2.0. Keep them in step. The
# shorthand used to cover TSC_PROJECTS only, and a green there read as "my
# types are fine" while both UIs went unchecked until push time — that gap
# cost two lanes a day in 2026-08 and produced a whole follow-up task built on
# the belief that the GATE had the hole. It did not; the shorthand did.
#
# The order is also load-bearing, not cosmetic: packages/tm8_ui_2.0 resolves
# @tm8/contract through its BUILT dist/*.d.ts, so it must run after the
# contract is built or it reports errors for fields that exist in source.
TSC_PROJECTS=(
  packages/contract
  # mcp before server: the post-#188 server REQUIRES @tm8/mcp/dist at boot,
  # and a project absent from this list is a dist CI never builds — every
  # cli integration suite then dies at server start, masking real reds.
  packages/mcp
  packages/server
  packages/execution
  packages/cli
  tools/conformance
)
for project in "${TSC_PROJECTS[@]}"; do
  if [ ! -f "$project/tsconfig.json" ]; then
    skip "typecheck $project" "no tsconfig.json yet"
    continue
  fi
  run_stage "typecheck $project" ./node_modules/.bin/tsc -b "$project"
done

# packages/ui is intentionally absent above: it arrives at W3/M2 and is verified
# with its own scoped `tsc -b` + a SINGLE vite build, never fanned out here.
if [ -f packages/ui/tsconfig.json ]; then
  run_stage "typecheck packages/ui" ./node_modules/.bin/tsc -b packages/ui
else
  skip "typecheck packages/ui" "UI arrives at W3/M2"
fi

# The production UI owns the launch builder. Keep it in the merge gate after
# the contract build so additions such as execution.spawn credential provenance
# cannot land on one side of the seam without the other.
#
# packages/tm8_ui_2.0 (the Astryx redesign) is the product UI; packages/tm8-ui
# is the 1.0 snapshot, now served beside it as the ALTERNATE UI at /ui-1.0/.
#
# THE 1.0 SNAPSHOT IS GATED AGAIN (2026-09-02). The note that used to sit here
# said gating would fail because the snapshot declares React 18 against a
# workspace pinned to 19. THAT NOTE WAS CORRECT — an earlier cut of this change
# claimed otherwise, on the strength of a dev box whose install hoisted a single
# `@types/react`. Under this job's frozen lockfile the snapshot pulls @types 18
# beside the hoisted 19 and fails on the spot, exactly as the note predicted.
#
# It is gateable now because the condition was FIXED, not re-read: the package
# declares React 19 to match the runtime the root `overrides` already forced on
# it, and the six `RefObject<T>` props React 19 widened to `RefObject<T | null>`
# are corrected.
#
# What ungating it cost in the meantime was real, and is the argument for this
# stage: while nothing checked it, the contract gained a `codebrain` MenuViewRef
# and four of the snapshot's exhaustive `Record<MenuViewRef, …>` tables silently
# stopped compiling. Nothing reported it, because nothing looked. A UI a viewer
# can switch to has to be a UI something checks.
if [ -f packages/tm8_ui_2.0/tsconfig.json ]; then
  run_stage "typecheck packages/tm8_ui_2.0" ./node_modules/.bin/tsc -p packages/tm8_ui_2.0/tsconfig.json --noEmit
else
  skip "typecheck packages/tm8_ui_2.0" "production UI is absent"
fi

# TYPECHECK ONLY, and the omission of its test suite is deliberate rather than
# an oversight. MEASURED 2026-09-02 on clean origin/main, before any of this
# lane's edits: 9 failures across 5 files (board, craft, files-explorer,
# transcript, router-mount) — React-19 act/flush timing in a suite written
# against React 18, unrelated to anything the version switch touches. Gating
# them today would make this stage red on arrival, and a stage that is red on
# arrival is a stage people learn to ignore.
#
# The typecheck has no such baseline: it is clean, and it is the check that
# would have caught the `codebrain` widening on the day it landed. Adding the
# test suite is its own task, and it starts by fixing those 9.
if [ -f packages/tm8-ui/tsconfig.json ]; then
  run_stage "typecheck packages/tm8-ui (1.0)" ./node_modules/.bin/tsc -p packages/tm8-ui/tsconfig.json --noEmit
else
  skip "typecheck packages/tm8-ui (1.0)" "the 1.0 snapshot is absent"
fi

# --- 3. tests ---------------------------------------------------------------
# The conformance suite is THE merge gate from G1 onward. Before G1 it runs against
# tools/conformance's own stub and is red by design — that red run IS gate G0's
# artifact ("the harness runs red against a stub server"). Hard-failing on it today
# would teach the team to ignore a permanently red gate, which is how gates die.
#
# It flips to blocking automatically the moment a real tm8-server answers at the
# base URL: from then on, red means a genuine contract regression. Override either
# way with TM8_CONFORMANCE_GATE=blocking|advisory.
CONFORMANCE_BASE_URL="${TM8_CONFORMANCE_BASE_URL:-http://localhost:${TM8_PORT:-4610}}"
if [ -n "${TM8_CONFORMANCE_GATE:-}" ]; then
  CONFORMANCE_GATE="$TM8_CONFORMANCE_GATE"
  CONFORMANCE_REASON="forced by TM8_CONFORMANCE_GATE=$CONFORMANCE_GATE"
elif node -e 'fetch(process.argv[1]).then(()=>process.exit(0),()=>process.exit(1))' \
       "$CONFORMANCE_BASE_URL" >/dev/null 2>&1; then
  CONFORMANCE_GATE="blocking"
  CONFORMANCE_REASON="a server answered at $CONFORMANCE_BASE_URL — red means a real regression"
else
  CONFORMANCE_GATE="advisory"
  CONFORMANCE_REASON="no tm8-server at $CONFORMANCE_BASE_URL, so the suite runs against its own stub (pre-G1)"
fi

# Only run a package's suite when it actually has test files: `vitest run` exits
# non-zero on "no test files found", and we must not turn that into a red gate
# while packages are still being authored.
TEST_PACKAGES=(
  packages/contract
  packages/server
  packages/execution
  packages/cli
  # packages/tm8-ui was ABSENT here until 2026-08-18, and had been since the
  # package was created. The gate typechecked it (above) and never ran a line
  # of its ~3,800 tests across 281 files — so every UI test in this repo was,
  # in effect, a local-only test.
  #
  # What that cost, concretely: `gate.test.tsx` sat red on main for the whole
  # life of the railless-Home design because its assertions still demanded a
  # menu rail the shell had deliberately stopped drawing, and nothing was
  # watching. A CI guard added to protect five panel hosts from drifting
  # (`views/panel-host-wiring.test.ts`) was likewise never executed by CI.
  #
  # It is also the only isolated machine this repo has. Local full-suite runs
  # on a shared dev box are not a substitute: measured at load average 139 on
  # 8 cores, the same commit produced anywhere from 6 to 94 failures, because
  # every test with a timeout loses that race eventually.
  #
  # 2026-08-29: the entry moved from packages/tm8-ui to packages/tm8_ui_2.0
  # when the product UI moved. tm8-ui is now the frozen 1.0 snapshot (React 18,
  # pre-Astryx) and is excluded for the same reason packages/ui is.
  packages/tm8_ui_2.0
  tools/conformance
)
for pkg in "${TEST_PACKAGES[@]}"; do
  [ -f "$pkg/package.json" ] || { skip "test $pkg" "no package.json"; continue; }

  test_script="$(node -e "const p=require('./$pkg/package.json');process.stdout.write(p.scripts&&p.scripts.test||'')")"
  if [ -z "$test_script" ]; then
    skip "test $pkg" "no test script"
    continue
  fi
  case "$test_script" in
    echo*) skip "test $pkg" "test script is a placeholder"; continue ;;
  esac

  test_count="$(find "$pkg" -type d -name node_modules -prune -o -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' \) -print 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$test_count" -eq 0 ]; then
    skip "test $pkg" "no test files yet"
    continue
  fi

  stage "test $pkg (${test_count} file(s))"
  printf '%s    $ (cd %s && bun run test)%s\n' "$C_DIM" "$pkg" "$C_RESET"

  if (cd "$pkg" && bun run test); then
    pass "test $pkg"
  elif [ "$pkg" = "tools/conformance" ] && [ "$CONFORMANCE_GATE" = "advisory" ]; then
    advise "test $pkg" "$CONFORMANCE_REASON"
    printf '\n%s    The conformance suite is RED — and before G1 that is the correct state:%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s    %s%s\n' "$C_YELLOW" "$CONFORMANCE_REASON" "$C_RESET"
    printf '%s    It does NOT fail this run yet. From G1 onward a red conformance run is a%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s    red merge — set TM8_CONFORMANCE_GATE=blocking to enforce that today.%s\n' "$C_YELLOW" "$C_RESET"
  else
    fail "test $pkg"
  fi
done

# --- 4. migrations ----------------------------------------------------------
if [ "$FAST" -eq 1 ]; then
  skip "migrations" "--fast/--no-migrations"
else
  run_stage "migrations" bash tools/ci/migrations-check.sh
fi

# --- summary ----------------------------------------------------------------
printf '\n%s==> summary%s\n' "$C_BOLD" "$C_RESET"
for line in "${SUMMARY[@]}"; do printf '    %s\n' "$line"; done

if [ "$FAILURES" -gt 0 ]; then
  printf '\n%s%d stage(s) failed%s\n' "$C_RED" "$FAILURES" "$C_RESET"
  exit 1
fi
printf '\n%sall stages green%s\n' "$C_GREEN" "$C_RESET"
