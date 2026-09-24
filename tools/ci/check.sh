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
#   bash tools/ci/check.sh --only <stage>[,<stage>...]
#                                           run ONLY the named stages (repeatable), in this script's
#                                           own order. Stages: install, migrations, typecheck,
#                                           typecheck:<project>, test, test:<package> — e.g.
#                                           --only typecheck:packages/cli,test:packages/cli
#                                           Every stage not selected is reported as skipped. An
#                                           unknown name exits 2. Not combinable with the flags above.
#   bash tools/ci/check.sh --only test:packages/server --shard 2/4
#                                           forward `--shard=2/4` to vitest. Needs --only, and every
#                                           selected test stage's script must be exactly `vitest run`.
#
#   TM8_VITEST_JSON_DIR=<dir> bash tools/ci/check.sh ...
#                                           ALSO write each suite's vitest JSON report to
#                                           <dir>/<pkg-with-dashes>[.shard-i-n].json. <dir> must be
#                                           inside the repo; a relative one resolves against its root.
#                                           The console output stays vitest's default reporter.
#                                           CI sets it so a run's test-ID/status set can be diffed.
#
# With none of --only/--shard/TM8_VITEST_JSON_DIR the script behaves exactly as it did
# before they existed: the pre-push hook depends on that.
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
LEGACY_FLAGS=0
ONLY=()
SHARD=""
while [ "$#" -gt 0 ]; do
  arg="$1"; shift
  case "$arg" in
    --fast) FAST=1; DO_INSTALL=0; LEGACY_FLAGS=1 ;;
    # Skips the migration stage WITHOUT skipping install. `--fast` cannot serve
    # a fresh CI runner: it also drops install, and every later stage then dies
    # as `vitest: command not found` / `Cannot find module '@tm8/contract'`.
    --no-migrations) FAST=1; LEGACY_FLAGS=1 ;;
    --no-install) DO_INSTALL=0; LEGACY_FLAGS=1 ;;
    --only|--shard)
      [ "$#" -gt 0 ] || { echo "$arg needs a value" >&2; exit 2; }
      if [ "$arg" = --only ]; then ONLY+=("$1"); else SHARD="$1"; fi
      shift ;;
    --only=*) ONLY+=("${arg#--only=}") ;;
    --shard=*) SHARD="${arg#--shard=}" ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- stage catalogue ----------------------------------------------------------
# Defined up here, ahead of every stage, so that --only / --shard are validated
# before anything runs. Their comments stay with the loops that use them below.
TSC_PROJECTS=(
  packages/contract
  # packages/jev is the Launch Advisor's pure Jev client. Named here rather
  # than left to the server's project reference, so a lane that drops that
  # reference cannot silently stop typechecking it.
  packages/jev
  # mcp before server: the post-#188 server REQUIRES @tm8/mcp/dist at boot,
  # and a project absent from this list is a dist CI never builds — every
  # cli integration suite then dies at server start, masking real reds.
  packages/mcp
  packages/server
  packages/execution
  packages/cli
  tools/conformance
)
UI_PROJECT=packages/tm8-ui
TEST_PACKAGES=(
  packages/contract
  # packages/jev is the Launch Advisor's Jev client (wire, client, rank, model,
  # cost). Its absence here would not show up as a red build — only as a
  # package whose whole suite never ran, which is the exact shape of the
  # packages/tm8-ui gap documented below.
  packages/jev
  packages/server
  packages/execution
  packages/cli
  # packages/tm8-ui was ABSENT here until 2026-08-18, and had been since the
  # package was created. The gate typechecked it (above) and never ran a line
  # of its ~4,960 tests across 363 files — so every UI test in this repo was,
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
  # when the product UI moved. 2026-09-03: the product UI moved BACK and this
  # entry did NOT follow it, so for twelve days the suite that ran was the
  # ALTERNATE bundle's — a real check, on a real bundle, but not the one
  # viewers landed on. That gap was held open by 8 pre-existing React-19
  # act/flush failures in this package's suite.
  #
  # 2026-09-15: the alternate package is deleted, those 8 are FIXED, and the
  # entry is back where it belongs. There is no longer a second suite to hide
  # behind — if this one is red, the gate is red.
  packages/tm8-ui
  tools/conformance
)

# --- --only / --shard ---------------------------------------------------------
# With neither flag given, nothing in this section changes what runs: selected()
# is true for every stage and TEST_ARGS stays empty. That is the pre-push hook's
# path (tools/ci/hooks/pre-push runs --fast) and `bun run check`'s.
ONLY_SET=0
SELECTED=()
TEST_ARGS=()
if [ "${#ONLY[@]}" -gt 0 ]; then
  ONLY_SET=1
  if [ "$LEGACY_FLAGS" -eq 1 ]; then
    echo "--only cannot be combined with --fast/--no-install/--no-migrations: select the stages you want instead" >&2
    exit 2
  fi
  known=(install typecheck test migrations "typecheck:$UI_PROJECT")
  for p in "${TSC_PROJECTS[@]}"; do known+=("typecheck:$p"); done
  for p in "${TEST_PACKAGES[@]}"; do known+=("test:$p"); done
  for list in "${ONLY[@]}"; do
    IFS=',' read -r -a names <<< "$list"
    for name in "${names[@]}"; do
      [ -n "$name" ] || continue
      ok=0
      for k in "${known[@]}"; do [ "$k" = "$name" ] && { ok=1; break; }; done
      # A typo must not become a green run that did nothing.
      if [ "$ok" -eq 0 ]; then
        echo "--only: unknown stage '$name'. Known stages: ${known[*]}" >&2
        exit 2
      fi
      SELECTED+=("$name")
    done
  done
  [ "${#SELECTED[@]}" -gt 0 ] || { echo "--only: no stage named" >&2; exit 2; }
fi

# selected <stage>: should this stage run? A group name (typecheck, test)
# selects every stage under it.
selected() {
  [ "$ONLY_SET" -eq 0 ] && return 0
  local s
  for s in "${SELECTED[@]}"; do
    [ "$s" = "$1" ] && return 0
    [ "$s" = "${1%%:*}" ] && return 0
  done
  return 1
}
# explicit <stage>: was this stage named on its own by --only (not via a group)?
explicit() {
  [ "$ONLY_SET" -eq 1 ] || return 1
  local s
  for s in "${SELECTED[@]}"; do [ "$s" = "$1" ] && return 0; done
  return 1
}
# A stage that --only NAMED is the whole point of the run: if it ends in a skip,
# the run did nothing and must not read as green. In a full run (or under a
# group name) a skip stays a reported skip, exactly as before.
skip_or_fail() {
  local stage_name="$1" label="$2" why="$3"
  if explicit "$stage_name"; then
    stage "$label"
    printf '%s    selected by --only, but it would be skipped: %s%s\n' "$C_RED" "$why" "$C_RESET"
    fail "$label ($why)"
  else
    skip "$label" "$why"
  fi
}

# run_tests <pkg>: the package's suite. Without --shard this is exactly the
# pre-flag `(cd "$pkg" && bun run test)`. With --shard, vitest exits 0 on a shard
# that received NO test files ("Test Files  no tests") — measured on vitest
# 2.1.9 with `--shard=8/8` over 6 files. A shard that tested nothing is not a
# pass, so the output is also captured (in memory: this script never writes
# outside the repo) and the run must end in a `Test Files ... (N)` summary with
# N >= 1 of which at least one PASSED, read from the LAST `Test Files` line
# (vitest's own final summary, whatever an earlier line looked like) (an all-skipped shard, "1 skipped (1)",
# tested nothing either). A missing or unrecognised summary fails too: the
# check is positive. A non-zero vitest exit is returned before any parsing.
# Under --shard vitest's stderr is merged into stdout (same order, same log).
run_tests() {
  local pkg="$1"
  # TM8_VITEST_JSON_DIR: the extra reporter args ride on the same command line.
  # bun appends script args to the script's LAST command, so tools/conformance's
  # `check:generated && vitest run ...` hands them to vitest, not check:generated.
  local args=("${TEST_ARGS[@]+"${TEST_ARGS[@]}"}")
  if [ -n "${VITEST_JSON_DIR:-}" ]; then
    local report="$VITEST_JSON_DIR/${pkg//\//-}${SHARD:+.shard-${SHARD/\//-}}.json"
    args+=(--reporter=default --reporter=json "--outputFile.json=$report")
  fi
  if [ -z "$SHARD" ]; then
    if [ "${#args[@]}" -eq 0 ]; then
      (cd "$pkg" && bun run test)
    else
      (cd "$pkg" && bun run test "${args[@]}")
    fi
    return
  fi
  local out rc summary files
  # Stream and capture. Not `tee /dev/fd/3`: opening /dev/fd/N re-opens the
  # target through /proc, which TRUNCATES it when stdout is a regular file
  # (`check.sh ... > log`) — caught by check-trace.sh. `>&3` duplicates instead.
  { out="$( (cd "$pkg" && bun run test "${args[@]}") 2>&1 \
      | while IFS= read -r l || [ -n "$l" ]; do printf '%s\n' "$l"; printf '%s\n' "$l" >&3; done
      exit "${PIPESTATUS[0]}" )"; rc=$?; } 3>&1
  [ "$rc" -eq 0 ] || return "$rc"
  summary="$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' \
    | grep -E '^[[:space:]]*Test Files[[:space:]]' | tail -n 1)"
  files="$(printf '%s\n' "$summary" | sed -n 's/.*(\([0-9][0-9]*\))[[:space:]]*$/\1/p')"
  if [ -z "$files" ] || [ "$files" -eq 0 ] || ! printf '%s\n' "$summary" | grep -qE '(^|[^0-9])[1-9][0-9]* passed'; then
    printf '%s    shard %s of %s passed no test files — a shard that tests nothing is not a pass%s\n' \
      "$C_RED" "$SHARD" "$pkg" "$C_RESET"
    return 1
  fi
}

test_script_of() {
  node -e "const p=require('./$1/package.json');process.stdout.write(p.scripts&&p.scripts.test||'')"
}

if [ -n "$SHARD" ]; then
  if [ "$ONLY_SET" -eq 0 ]; then
    echo "--shard needs --only: a full run cannot be split" >&2; exit 2
  fi
  if ! [[ "$SHARD" =~ ^([0-9]+)/([0-9]+)$ ]] \
     || [ "${BASH_REMATCH[1]}" -lt 1 ] || [ "${BASH_REMATCH[1]}" -gt "${BASH_REMATCH[2]}" ]; then
    echo "--shard: expected i/n with 1 <= i <= n, got '$SHARD'" >&2; exit 2
  fi
  # Only the TEST stages shard; typecheck/install/migrations run in full. A
  # package is shardable iff its test script is exactly `vitest run`, because
  # the flag is appended to that script's command line: tools/conformance's
  # `bun run check:generated && vitest run ...` would hand it to check:generated.
  # Keyed to the script rather than a list of names, so a script change fails
  # here instead of silently running every test in every shard.
  sharded=0
  for pkg in "${TEST_PACKAGES[@]}"; do
    selected "test:$pkg" || continue
    script="$(test_script_of "$pkg" 2>/dev/null)"
    if [ "$script" != "vitest run" ]; then
      echo "--shard: test:$pkg cannot be sharded (its test script is '$script', not 'vitest run')" >&2
      exit 2
    fi
    sharded=1
  done
  [ "$sharded" -eq 1 ] || { echo "--shard: no test stage selected to shard" >&2; exit 2; }
  TEST_ARGS=("--shard=$SHARD")
fi
# Resolved to an absolute path once, here: run_tests cd's into each package.
VITEST_JSON_DIR=""
if [ -n "${TM8_VITEST_JSON_DIR:-}" ]; then
  case "$TM8_VITEST_JSON_DIR" in
    /*) VITEST_JSON_DIR="$TM8_VITEST_JSON_DIR" ;;
    *) VITEST_JSON_DIR="$REPO_ROOT/$TM8_VITEST_JSON_DIR" ;;
  esac
  # This script never writes outside the repo; the report dir is no exception.
  case "$VITEST_JSON_DIR/" in
    "$REPO_ROOT"/*/) ;;
    *) echo "TM8_VITEST_JSON_DIR must be a directory inside the repo, got '$TM8_VITEST_JSON_DIR'" >&2; exit 2 ;;
  esac
  case "/$TM8_VITEST_JSON_DIR/" in
    */../*) echo "TM8_VITEST_JSON_DIR must not contain '..', got '$TM8_VITEST_JSON_DIR'" >&2; exit 2 ;;
  esac
  mkdir -p "$VITEST_JSON_DIR" || { echo "TM8_VITEST_JSON_DIR: cannot create $VITEST_JSON_DIR" >&2; exit 2; }
fi
if [ "$ONLY_SET" -eq 1 ]; then
  selected install && DO_INSTALL=1 || DO_INSTALL=0
  selected migrations && FAST=0 || FAST=1
fi

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
elif [ "$ONLY_SET" -eq 1 ]; then
  skip "install" "not selected by --only"
else
  skip "install" "--fast/--no-install"
fi

# --- 2. typecheck: per-package scoped tsc -b, SEQUENTIAL --------------------
# Order matters: contract first (everything references it), then dependents.
#
# The two groups below (TSC_PROJECTS, then packages/tm8-ui) are mirrored by the
# root `bun run typecheck` shorthand, in this same order, as typecheck:core ->
# typecheck:ui. Keep them in step. The shorthand used to cover TSC_PROJECTS
# only, and a green there read as "my types are fine" while the UI went
# unchecked until push time — that gap cost two lanes a day in 2026-08 and
# produced a whole follow-up task built on the belief that the GATE had the
# hole. It did not; the shorthand did.
#
# The order is also load-bearing, not cosmetic: packages/tm8-ui resolves
# @tm8/contract through its BUILT dist/*.d.ts, so it must run after the
# contract is built or it reports errors for fields that exist in source.
for project in "${TSC_PROJECTS[@]}"; do
  if ! selected "typecheck:$project"; then
    skip "typecheck $project" "not selected by --only"
    continue
  fi
  if [ ! -f "$project/tsconfig.json" ]; then
    skip_or_fail "typecheck:$project" "typecheck $project" "no tsconfig.json yet"
    continue
  fi
  run_stage "typecheck $project" ./node_modules/.bin/tsc -b "$project"
done

# THE UI — the only UI package in this repo since 2026-09-15, when the Astryx
# redesign fork (packages/tm8_ui_2.0, the alternate at /ui-2.0/) and the legacy
# collab-v2 oracle (packages/ui) were deleted. It is typechecked here and its
# suite runs in TEST_PACKAGES below.
#
# The UI owns the launch builder. Keep it in the merge gate after the contract
# build so additions such as execution.spawn credential provenance cannot land
# on one side of the seam without the other.
#
# What ungating a served UI costs is not hypothetical, and is the argument for
# this stage: while nothing checked the then-frozen 1.0 snapshot, the contract
# gained a `codebrain` MenuViewRef and four of its exhaustive
# `Record<MenuViewRef, …>` tables silently stopped compiling. Nothing reported
# it, because nothing looked. A UI a viewer can reach has to be a UI something
# checks — and every viewer lands on this one.
if ! selected "typecheck:$UI_PROJECT"; then
  skip "typecheck $UI_PROJECT" "not selected by --only"
elif [ -f packages/tm8-ui/tsconfig.json ]; then
  run_stage "typecheck packages/tm8-ui" ./node_modules/.bin/tsc -p packages/tm8-ui/tsconfig.json --noEmit
else
  skip_or_fail "typecheck:$UI_PROJECT" "typecheck packages/tm8-ui" "the UI package is absent"
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
for pkg in "${TEST_PACKAGES[@]}"; do
  if ! selected "test:$pkg"; then
    skip "test $pkg" "not selected by --only"
    continue
  fi
  [ -f "$pkg/package.json" ] || { skip_or_fail "test:$pkg" "test $pkg" "no package.json"; continue; }

  test_script="$(test_script_of "$pkg")"
  if [ -z "$test_script" ]; then
    skip_or_fail "test:$pkg" "test $pkg" "no test script"
    continue
  fi
  case "$test_script" in
    echo*) skip_or_fail "test:$pkg" "test $pkg" "test script is a placeholder"; continue ;;
  esac

  test_count="$(find "$pkg" -type d -name node_modules -prune -o -type f \
    \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' \) -print 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$test_count" -eq 0 ]; then
    skip_or_fail "test:$pkg" "test $pkg" "no test files yet"
    continue
  fi

  stage "test $pkg (${test_count} file(s))"
  # ${TEST_ARGS[@]+...}: an empty array under `set -u` is an error on bash < 4.4.
  printf '%s    $ (cd %s && bun run test%s)%s\n' "$C_DIM" "$pkg" "${TEST_ARGS[@]+ ${TEST_ARGS[*]}}" "$C_RESET"

  if run_tests "$pkg"; then
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
if [ "$ONLY_SET" -eq 1 ] && [ "$FAST" -eq 1 ]; then
  skip "migrations" "not selected by --only"
elif [ "$FAST" -eq 1 ]; then
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
