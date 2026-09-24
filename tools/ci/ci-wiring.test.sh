#!/usr/bin/env bash
# Wiring test: every stage check.sh defines runs in some ci.yml job, and every module
# affected.sh emits has exactly one job. Needs bash, awk, grep; no network, no install.
#   bash tools/ci/ci-wiring.test.sh
#
# Each CI job narrows check.sh with `--only <stage>,...`. A project added to TSC_PROJECTS or
# a package added to TEST_PACKAGES is therefore checked by the pre-push hook and `bun run
# check`, and by NO CI job, until someone also appends it to a job's --only list. Nothing
# goes red when they forget. This test reads the lists from check.sh itself (never from a
# copy here) and fails when:
#   (a) set(TSC_PROJECTS) + UI_PROJECT  !=  union of typecheck:<p> across all --only lists
#   (b) set(TEST_PACKAGES)              !=  union of test:<p> across all --only lists
#   (c) a module in `affected.sh --all` does not map to exactly one job id in ci.yml
# It fails CLOSED: a parse that yields no jobs, no --only list, or an empty array is red.
# The controls at the end mutate scratch copies and must turn it red.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CHECK_SH="${CHECK_SH:-$HERE/check.sh}"
CI_YML="${CI_YML:-$REPO/.github/workflows/ci.yml}"
AFFECTED="${AFFECTED:-$HERE/affected.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0

array_of() { # <file> <NAME>: the entries of a top-level bash array literal NAME=( ... )
  awk -v n="$2" '
    $0 ~ "^" n "=\\(" { on = 1; next }
    on && /^\)/ { exit }
    on { sub(/#.*/, ""); for (i = 1; i <= NF; i++) print $i }' "$1"
}

jobs_of() { # <ci.yml>: one line per job, "<job-id> <its non-comment lines joined by spaces>"
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; next }
    in_jobs && /^[^[:space:]#]/ { in_jobs = 0 }
    !in_jobs { next }
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      if (job != "") print job, body
      job = $1; sub(/:$/, "", job); body = ""; next
    }
    /^[[:space:]]*#/ { next }
    { body = body " " $0 }
    END { if (job != "") print job, body }' "$1"
}

# check_wiring <check.sh> <ci.yml> <affected.sh>: prints each problem; exit 0 only if none.
check_wiring() {
  local check_sh=$1 ci_yml=$2 affected=$3 problems=0 ui jobs job body lists list s m want n mods
  local -A tsc=() tests=() got_tc=() got_test=() job_ids=()
  local p
  while IFS= read -r p; do [[ -n $p ]] && tsc[$p]=1; done < <(array_of "$check_sh" TSC_PROJECTS)
  while IFS= read -r p; do [[ -n $p ]] && tests[$p]=1; done < <(array_of "$check_sh" TEST_PACKAGES)
  ui=$(sed -n 's/^UI_PROJECT=//p' "$check_sh")
  [[ ${#tsc[@]} -gt 0 ]] || { echo "parsed no TSC_PROJECTS from $check_sh"; problems=1; }
  [[ ${#tests[@]} -gt 0 ]] || { echo "parsed no TEST_PACKAGES from $check_sh"; problems=1; }
  [[ -n $ui ]] || { echo "parsed no UI_PROJECT from $check_sh"; problems=1; }
  [[ -n $ui ]] && tsc[$ui]=1

  jobs=$(jobs_of "$ci_yml")
  [[ -n $jobs ]] || { echo "parsed no jobs from $ci_yml"; return 1; }
  lists=0
  while read -r job body; do
    job_ids[$job]=1
    # both `--only a,b` and a folded `--only` + newline + `a,b` join to "--only a,b"
    for list in $(grep -oE -- '--only[= ]+[^ ]+' <<<"$body" | sed -E 's/^--only[= ]+//'); do
      lists=$((lists + 1))
      IFS=',' read -r -a stages <<<"$list"
      for s in "${stages[@]}"; do
        case $s in
          typecheck) for p in "${!tsc[@]}"; do got_tc[$p]=1; done ;;
          test) for p in "${!tests[@]}"; do got_test[$p]=1; done ;;
          typecheck:*) got_tc[${s#typecheck:}]=1 ;;
          test:*) got_test[${s#test:}]=1 ;;
        esac
      done
    done
  done <<<"$jobs"
  [[ $lists -gt 0 ]] || { echo "found no check.sh --only list in $ci_yml"; problems=1; }

  for p in "${!tsc[@]}"; do [[ -n ${got_tc[$p]:-} ]] || { echo "(a) typecheck:$p is in check.sh but in no CI job's --only list"; problems=1; }; done
  for p in "${!got_tc[@]}"; do [[ -n ${tsc[$p]:-} ]] || { echo "(a) CI names typecheck:$p, which check.sh does not define"; problems=1; }; done
  for p in "${!tests[@]}"; do [[ -n ${got_test[$p]:-} ]] || { echo "(b) test:$p is in check.sh but in no CI job's --only list"; problems=1; }; done
  for p in "${!got_test[@]}"; do [[ -n ${tests[$p]:-} ]] || { echo "(b) CI names test:$p, which check.sh does not define"; problems=1; }; done

  # (c) module -> job: typecheck and migrations are jobs of that name, the rest test-<m>.
  mods=$(bash "$affected" --all 2>/dev/null | sed -n 's/^modules=\[\(.*\)\]$/\1/p' | tr -d '"' | tr ',' ' ')
  [[ -n $mods ]] || { echo "(c) affected.sh --all emitted no modules"; problems=1; }
  for m in $mods; do
    case $m in typecheck | migrations) want=$m ;; *) want=test-$m ;; esac
    n=$(grep -c "^$want " <<<"$jobs")
    [[ $n == 1 ]] || { echo "(c) module $m has $n jobs named $want in $ci_yml (want exactly 1)"; problems=1; }
  done
  return $problems
}

report() { # <name> <ok:0|1> <detail>
  if [[ $2 == 0 ]]; then PASS=$((PASS + 1)); echo "ok   $1"
  else FAIL=$((FAIL + 1)); echo "FAIL $1"; sed 's/^/     | /' <<<"$3"; fi
}

# ---- the real files ------------------------------------------------------------------------
out=$(check_wiring "$CHECK_SH" "$CI_YML" "$AFFECTED"); rc=$?
report "check.sh stages == ci.yml --only stages; every module has one job" $rc "$out"

# ---- controls: each mutation must turn the check red -----------------------------------------
control() { # <name> <check.sh copy> <ci.yml copy> [affected copy]
  local out rc
  out=$(check_wiring "$2" "$3" "${4:-$AFFECTED}"); rc=$?
  if [[ $rc != 0 ]]; then report "CONTROL $1 -> red" 0 ""
  else report "CONTROL $1 -> red" 1 "the check stayed green: it cannot see this defect"; fi
}
Y="$TMP/ci.yml" C="$TMP/check.sh"
cp "$CHECK_SH" "$C"
sed -E 's/(,)?test:packages\/mcp(,)?/\2/' "$CI_YML" >"$Y"
if cmp -s "$CI_YML" "$Y"; then report "CONTROL drop test:packages/mcp from ci.yml -> red" 1 "no test:packages/mcp in $CI_YML to drop"
else control "drop test:packages/mcp from ci.yml" "$C" "$Y"; fi
sed -E 's/typecheck:packages\/prompt,?//' "$CI_YML" >"$Y"
if cmp -s "$CI_YML" "$Y"; then report "CONTROL drop typecheck:packages/prompt from ci.yml -> red" 1 "no typecheck:packages/prompt in $CI_YML to drop"
else control "drop typecheck:packages/prompt from ci.yml" "$C" "$Y"; fi
cp "$CI_YML" "$Y"
awk '{ print } /^TEST_PACKAGES=\(/ { print "  packages/newpkg" }' "$CHECK_SH" >"$C"
control "a TEST_PACKAGES entry no job runs" "$C" "$Y"
awk '{ print } /^TSC_PROJECTS=\(/ { print "  packages/newpkg" }' "$CHECK_SH" >"$C"
control "a TSC_PROJECTS entry no job typechecks" "$C" "$Y"
cp "$CHECK_SH" "$C"
sed -E 's/^  test-small:/  test-smol:/' "$CI_YML" >"$Y"
control "the small module's job renamed away" "$C" "$Y"
printf 'name: ci\non: push\n' >"$Y"
control "a ci.yml with no jobs (fail closed)" "$C" "$Y"
sed -E 's/--only/--onyl/g' "$CI_YML" >"$Y"
control "no parsable --only list (fail closed)" "$C" "$Y"
sed -E '/^TEST_PACKAGES=\(/,/^\)/{/^TEST_PACKAGES=\(/!{/^\)/!d}}' "$CHECK_SH" >"$C"
control "an empty TEST_PACKAGES (fail closed)" "$C" "$CI_YML"

echo
echo "ci-wiring.test.sh: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
