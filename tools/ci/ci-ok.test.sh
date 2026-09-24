#!/usr/bin/env bash
# Table test for tools/ci/changes.sh (the `changes` job) and tools/ci/ci-ok.sh (the verdict).
# Needs bash, jq and git; no network, no install.
#   bash tools/ci/ci-ok.test.sh
# ci.yml's `ci-scripts` job runs it beside affected.test.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CHANGES="${CHANGES:-$HERE/changes.sh}"   # overridable: mutation proofs
CIOK="${CIOK:-$HERE/ci-ok.sh}"
CIYML="${CIYML:-$REPO/.github/workflows/ci.yml}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset GITHUB_STEP_SUMMARY

ALL_MODULES='["typecheck","server","cli","execution","ui","small","migrations","mcp","prompt","pty-protocol"]'
PASS=0 FAIL=0
report() { # <name> <ok:0|1> <detail>
  if [[ $2 == 0 ]]; then PASS=$((PASS + 1)); echo "ok   $1"
  else FAIL=$((FAIL + 1)); echo "FAIL $1"; echo "     $3"; sed 's/^/     | /' <<<"$OUT"; fi
}

# ---- the three module lists are one list -------------------------------------------------
OUT=""
L1=$(sed -n 's/^MODULES=(\(.*\))$/\1/p' "$CHANGES" | tr ' ' '\n' | jq -R . | jq -sc .)
L2=$(sed -n "s/^KNOWN='\\(.*\\)'\$/\\1/p" "$CIOK" | jq -c .)
L3=$(bash "$HERE/affected.sh" --all 2>/dev/null | sed -n 's/^modules=//p')
OUT="changes.sh MODULES=$L1"$'\n'"ci-ok.sh KNOWN=$L2"$'\n'"affected.sh --all=$L3"
[[ -n $L1 && $L1 == "$L2" && $L2 == "$L3" ]]
report "changes.sh MODULES == ci-ok.sh KNOWN == affected.sh --all modules" $? "lists differ"

# ---- every ci.yml job is one ci-ok needs and one ci-ok.sh JOBS key ------------------------
# The pinned count only catches a job DROPPED from needs. A job ADDED to ci.yml but not to
# needs leaves the count alone, and ci-ok would stay green while it is red. So the expected
# set is READ from ci.yml: its top-level jobs keys minus ci-ok == ci-ok's needs == ci-ok.sh's
# JOBS keys, and PINNED_COUNT is their size. Keep ci-ok's needs a one-line [..] list: any
# other form reads as empty here, which is red.
Y_JOBS=$(awk '/^jobs:/ {j=1; next} j && /^[^ #]/ {j=0} j && /^  [A-Za-z0-9_-]+:/ {sub(/^  /,""); sub(/:.*/,""); print}' "$CIYML" \
  | grep -vx ci-ok | sort | jq -R . | jq -sc .)
Y_NEEDS=$(awk '/^  ci-ok:/ {c=1; next} c && /^  [A-Za-z0-9_-]+:/ {c=0} c && /^    needs: *\[/ {sub(/^    needs: *\[/,""); sub(/\].*/,""); print}' "$CIYML" \
  | tr ',' '\n' | tr -d ' ' | grep -v '^$' | sort | jq -R . | jq -sc .)
S_JOBS=$(sed -n "/^JOBS='{/,/^}'/p" "$CIOK" | sed "1s/^JOBS='//; \$s/'\$//" | jq -c 'keys | sort')
S_PIN=$(sed -n 's/^PINNED_COUNT=//p' "$CIOK")
OUT="ci.yml jobs - ci-ok=$Y_JOBS"$'\n'"ci-ok needs=$Y_NEEDS"$'\n'"ci-ok.sh JOBS=$S_JOBS"$'\n'"PINNED_COUNT=$S_PIN"
[[ $Y_JOBS != "[]" && $Y_JOBS == "$Y_NEEDS" && $Y_NEEDS == "$S_JOBS" && $S_PIN == "$(jq length <<<"$S_JOBS")" ]]
report "ci.yml jobs (minus ci-ok) == ci-ok needs == ci-ok.sh JOBS keys, PINNED_COUNT their size" $? "job sets differ"

# ---- every job's `if:` gate is the module ci-ok.sh maps it to ------------------------------
# JOBS says which module a skip is excused by; the job's `if:` says which module skips it.
# Nothing else ties the two: a coherent mis-map (test-small gated on outputs.migrations AND
# JOBS test-small=migrations) passes every verdict row, and a small-only PR skips test-small
# green. So each gate is READ from ci.yml: a job mapped to module m (not "*", not typecheck)
# has exactly `if: needs.changes.outputs.m == 'true'`; every other job has no `if:`. And the
# changes job's outputs: must carry each gated module, or its gate is never true.
# The gate alone cannot catch a coherent SWAP (test-small gated on and mapped to migrations,
# migrations to small): gates match JOBS, every module has a job, and a small-only PR skips
# test-small green. So the module is also pinned to the job's NAME: JOBS[job] is the job id
# or the id without "test-". A swap then has to rename jobs, which a reviewer sees.
Y_IFS=$(awk '/^jobs:/ {j=1; next} j && /^[^ #]/ {j=0}
  j && /^  [A-Za-z0-9_-]+:/ {job=$1; sub(/:$/,"",job); gate[job]=""; order[++n]=job}
  j && /^    if:/ {l=$0; sub(/^    if: */,"",l); gate[job]=l}
  END {for (i=1;i<=n;i++) print order[i] "\t" gate[order[i]]}' "$CIYML" | grep -v '^ci-ok	')
Y_OUTS=$(awk '/^  changes:/ {c=1; next} c && /^  [A-Za-z0-9_-]+:/ {c=0} c && /^    outputs:/ {o=1; next}
  c && o && /^      [A-Za-z0-9_-]+:/ {k=$1; sub(/:$/,"",k); print k; next} c && o && /^    [^ ]/ {o=0}' "$CIYML")
S_MAP=$(sed -n "/^JOBS='{/,/^}'/p" "$CIOK" | sed "1s/^JOBS='//; \$s/'\$//" | jq -r 'to_entries[] | "\(.key)\t\(.value)"')
OUT="ci.yml gates:"$'\n'"$Y_IFS"$'\n'"changes outputs: $(tr '\n' ' ' <<<"$Y_OUTS")"
GATE_BAD=""
while IFS=$'\t' read -r job mod; do
  have=$(awk -F'\t' -v j="$job" '$1 == j {print $2; f=1} END {if (!f) print "<no such job>"}' <<<"$Y_IFS")
  [[ $mod == "*" || $mod == "$job" || $mod == "${job#test-}" ]] || GATE_BAD+="$job: JOBS maps it to $mod, not to its name; "
  if [[ $mod == "*" || $mod == typecheck ]]; then want=""
  else
    want="needs.changes.outputs.$mod == 'true'"
    grep -qx -- "$mod" <<<"$Y_OUTS" || GATE_BAD+="changes outputs lack $mod; "
  fi
  [[ $have == "$want" ]] || GATE_BAD+="$job: if is [$have], JOBS maps it to $mod so want [$want]; "
done <<<"$S_MAP"
OUT+=$'\n'"$GATE_BAD"
[[ -n $S_MAP && -z $GATE_BAD ]]
report "each ci.yml job's if: gates on the module ci-ok.sh JOBS maps it to, named by the job; changes outputs cover them" $? "gate/module mismatch"

# ==== changes.sh ==========================================================================
# A repo whose HEAD is a two-parent merge commit, the shape of refs/pull/N/merge.
G="$TMP/g"
mkdir -p "$G"
git -C "$G" init -q -b main
echo a >"$G/a"; git -C "$G" add -A; git -C "$G" commit -qm base
git -C "$G" checkout -qb pr; echo b >"$G/b"; git -C "$G" add -A; git -C "$G" commit -qm pr
PR_HEAD=$(git -C "$G" rev-parse HEAD)
git -C "$G" checkout -q main; echo c >"$G/c"; git -C "$G" add -A; git -C "$G" commit -qm main-moved
git -C "$G" merge -q --no-ff -m merge pr
MERGE=$(git -C "$G" rev-parse HEAD)

ARGS="$TMP/args"
stub() { # <name> <body...>: an affected.sh stand-in that logs its argv
  local f="$TMP/$1.sh"; shift
  { echo '#!/usr/bin/env bash'; echo "printf '%s\\n' \"\$*\" >\"$ARGS\""; printf '%s\n' "$@"; } >"$f"
  echo "$f"
}
NARROW='all=false
modules=["typecheck","ui"]
typecheck=true
server=false
cli=false
execution=false
ui=true
small=false
migrations=false
mcp=false
prompt=false
pty-protocol=false
reason=changed nodes: packages/tm8-ui'
GOOD=$(stub good "if [[ \$1 == --all ]]; then exec bash '$HERE/affected.sh' --all; fi" "cat <<'EOF'" "$NARROW" "EOF")

ch() { # <affected> <event> [force] [expected_sha] [pr_head]: run changes.sh in $G
  rm -f "$ARGS"
  OUT=$(cd "${CHDIR:-$G}" && AFFECTED=$1 EVENT_NAME=$2 FORCE_ALL=${3:-} EXPECTED_SHA=${4-$MERGE} PR_HEAD_SHA=${5-$PR_HEAD} \
        bash "$CHANGES" 2>"$TMP/err")
  RC=$?
}
is_all() { grep -qx 'all=true' <<<"$OUT" && grep -Fqx "modules=$ALL_MODULES" <<<"$OUT" && [[ $RC == 0 ]]; }
# exactly one warning and one clean block: a nested fallback (F1) prints two warnings and a
# reason that swallowed the first block
is_fallback() {
  is_all && [[ $(grep -c '' <<<"$OUT") == 13 && $(grep -c '^reason=fallback: ' <<<"$OUT") == 1 ]] \
    && [[ $(grep -c '::warning' "$TMP/err") == 1 ]] && ! grep -qF 'modules=[' <<<"$(grep '^reason=' <<<"$OUT")"
}
called_with() { [[ -f $ARGS && $(cat "$ARGS") == "$1" ]]; }

ch "$GOOD" pull_request
[[ $OUT == "$NARROW" && $RC == 0 ]] && called_with "--base HEAD^1 --head HEAD"
report "pull_request merge commit -> diff HEAD^1..HEAD, block passed through" $? "want the narrow block"
for ev in push schedule workflow_dispatch merge_group ""; do
  ch "$GOOD" "$ev"
  is_all && ! grep -q '^reason=fallback' <<<"$OUT" && called_with "--all"
  report "event '${ev}' -> affected.sh --all" $? "want --all"
done
ch "$(stub narrow-all "cat <<'EOF'" "$NARROW" "EOF")" push
is_fallback && called_with "--all"
report "push, but affected.sh --all answers narrow -> fallback ALL" $? "want fallback"
ch "$GOOD" pull_request true
is_all && called_with "--all"
report "pull_request with FORCE_ALL=true (the shadow) -> --all" $? "want --all"
ch "$GOOD" pull_request false
[[ $OUT == "$NARROW" ]]
report "pull_request with FORCE_ALL=false -> diff" $? "want narrow"

ch "$GOOD" pull_request "" 0000000000000000000000000000000000000000
is_fallback && [[ ! -f $ARGS ]]
report "HEAD is not github.sha -> fallback ALL, affected.sh never run" $? "want fallback"
ch "$GOOD" pull_request "" "$MERGE" 0000000000000000000000000000000000000000
is_fallback
report "HEAD^2 is not the PR head -> fallback ALL" $? "want fallback"
ch "$GOOD" pull_request "" "" ""
is_fallback
report "pull_request without shas -> fallback ALL" $? "want fallback"
git -C "$G" checkout -q main~1 2>/dev/null
ONE=$(git -C "$G" rev-parse HEAD)
ch "$GOOD" pull_request "" "$ONE"
is_fallback
report "HEAD is a one-parent commit -> fallback ALL" $? "want fallback"
git -C "$G" checkout -q main
mkdir -p "$TMP/norepo"
CHDIR="$TMP/norepo" GIT_CEILING_DIRECTORIES="$TMP" ch "$GOOD" pull_request
is_fallback && grep -q '^reason=fallback: error at line [0-9]*: head=' <<<"$OUT"
report "not a git repo (git fails inside \$(...)) -> ONE fallback, clean reason" $? "want one warning, one clean reason"

ch "$(stub exit1 "echo '$NARROW'" 'exit 1')" pull_request
is_fallback
report "affected.sh exits 1 after printing a narrow block -> fallback ALL" $? "want fallback"
ch "$(stub silent 'exit 0')" pull_request
is_fallback
report "affected.sh prints nothing -> fallback ALL" $? "want fallback"
bad() { # <name> <sed expr>: GOOD's block, edited
  local b; b=$(sed "$2" <<<"$NARROW")
  ch "$(stub "$1" "cat <<'EOF'" "$b" "EOF")" pull_request
  is_fallback
  report "block rejected: $1 -> fallback ALL" $? "want fallback"
}
bad dup-key '$a ui=true'
bad missing-key '/^cli=/d'
bad extra-line '$a extra=1'
bad no-typecheck 's/^modules=.*/modules=["ui"]/'
bad unknown-module 's/^modules=.*/modules=["typecheck","ui","nope"]/'
bad empty-modules 's/^modules=.*/modules=[]/'
bad unparseable 's/^modules=.*/modules=[typecheck/'
bad flag-says-no 's/^ui=true/ui=false/'
bad flag-says-yes 's/^server=false/server=true/'
bad all-true-narrow 's/^all=false/all=true/'
bad all-garbage 's/^all=false/all=maybe/'
bad dup-module 's/^modules=.*/modules=["typecheck","ui","ui"]/'

# ---- end to end with the real affected.sh -----------------------------------------------
E="$TMP/e2e"; mkdir -p "$E"
cp "$REPO/package.json" "$E/"
for f in "$REPO"/packages/*/package.json "$REPO"/tools/*/package.json; do
  [[ -f $f ]] || continue
  mkdir -p "$E/$(dirname "${f#"$REPO"/}")"; cp "$f" "$E/${f#"$REPO"/}"
done
git -C "$E" init -q -b main; git -C "$E" add -A; git -C "$E" commit -qm base
git -C "$E" checkout -qb pr; mkdir -p "$E/packages/tm8-ui/src"; echo x >"$E/packages/tm8-ui/src/x.tsx"
git -C "$E" add -A; git -C "$E" commit -qm ui; EH=$(git -C "$E" rev-parse HEAD)
git -C "$E" checkout -q main; mkdir -p "$E/docs"; echo d >"$E/docs/d.md"; git -C "$E" add -A; git -C "$E" commit -qm docs-on-main
git -C "$E" merge -q --no-ff -m merge pr; EM=$(git -C "$E" rev-parse HEAD)
OUT=$(cd "$E" && AFFECTED="$HERE/affected.sh" EVENT_NAME=pull_request EXPECTED_SHA=$EM PR_HEAD_SHA=$EH bash "$CHANGES" 2>/dev/null); RC=$?
grep -qx 'all=false' <<<"$OUT" && grep -qx 'modules=\["typecheck","ui"\]' <<<"$OUT"
report "e2e: ui-only PR merged over a base that moved (docs) -> [typecheck, ui]" $? "want ui only; base-side docs must not count"
OUT=$(cd "$E" && AFFECTED="$HERE/affected.sh" EVENT_NAME=push EXPECTED_SHA=$EM bash "$CHANGES" 2>/dev/null); RC=$?
is_all
report "e2e: push -> ALL" $? "want ALL"

# ==== ci-ok.sh ============================================================================
JOBS=(changes ci-scripts typecheck test-server test-cli test-execution test-ui test-small migrations)
declare -A MOD=([test-server]=server [test-cli]=cli [test-execution]=execution [test-ui]=ui [test-small]=small [migrations]=migrations)
needs() { # <all> <modules JSON>: every job as it would be: success if affected, else skipped
  local all=$1 mods=$2 j r json
  json=$(jq -nc --arg all "$all" --arg mods "$mods" \
    '{changes: {result: "success", outputs: {all: $all, modules: $mods, reason: "t"}}}')
  for j in "${JOBS[@]}"; do
    [[ $j == changes ]] && continue
    r=success
    if [[ -n ${MOD[$j]:-} ]] && ! jq -e --arg m "${MOD[$j]}" 'index($m) != null' <<<"$mods" >/dev/null 2>&1; then r=skipped; fi
    json=$(jq -c --arg j "$j" --arg r "$r" '.[$j] = {result: $r, outputs: {}}' <<<"$json")
  done
  echo "$json"
}
ok() { # <want:GREEN|RED> <name> <needs JSON> [event] [force]
  OUT=$(NEEDS=$3 EVENT_NAME=${4-pull_request} FORCE_ALL=${5-} bash "$CIOK" 2>&1); RC=$?
  local got=RED; [[ $RC == 0 ]] && got=GREEN
  [[ $got == "$1" && $(tail -n 1 <<<"$OUT") == "ci-ok: $got" ]]
  report "ci-ok $1: $2" $? "want $1, got $got (rc=$RC)"
}
edit() { jq -c "$2" <<<"$1"; }

UI=$(needs false '["typecheck","ui"]')
DOCS=$(needs false '["typecheck"]')
FULL=$(needs true "$ALL_MODULES")
ok GREEN "ui-only: test-ui success, the rest skipped" "$UI"
ok GREEN "docs-only: every test job skipped" "$DOCS"
ok GREEN "all=true, everything success" "$FULL"
ok GREEN "push, all=true" "$FULL" push
ok GREEN "shadow (force_all), all=true" "$FULL" pull_request true
ok GREEN "mcp affected, no job yet (NO_JOB)" "$(needs false '["typecheck","server","cli","small","mcp"]')"
ok GREEN "unaffected job ran anyway and passed" "$(edit "$UI" '."test-cli".result = "success"')"

ok RED "CONTROL changes failed, gated jobs skipped" \
  "$(edit "$DOCS" '.changes = {result: "failure", outputs: {}}')"
# a later step of `changes` failed after the outputs were written: they look fine, the job is not
ok RED "changes failed with well-formed outputs" "$(edit "$DOCS" '.changes.result = "failure"')"
ok RED "changes cancelled" "$(edit "$UI" '.changes.result = "cancelled"')"
ok RED "changes skipped" "$(edit "$UI" '.changes.result = "skipped"')"
ok RED "CONTROL affected job skipped (ui)" "$(edit "$UI" '."test-ui".result = "skipped"')"
ok RED "affected matrix job skipped under all=true (server)" "$(edit "$FULL" '."test-server".result = "skipped"')"
ok RED "affected job failed" "$(edit "$UI" '."test-ui".result = "failure"')"
ok RED "unaffected job failed" "$(edit "$UI" '."test-cli".result = "failure"')"
ok RED "unaffected job cancelled" "$(edit "$UI" '."test-cli".result = "cancelled"')"
ok RED "ci-scripts failed" "$(edit "$DOCS" '."ci-scripts".result = "failure"')"
ok RED "ci-scripts skipped" "$(edit "$DOCS" '."ci-scripts".result = "skipped"')"
ok RED "typecheck skipped" "$(edit "$DOCS" '.typecheck.result = "skipped"')"
ok RED "modules missing" "$(edit "$UI" 'del(.changes.outputs.modules)')"
ok RED "modules unparseable" "$(edit "$UI" '.changes.outputs.modules = "[typecheck"')"
ok RED "modules empty" "$(edit "$UI" '.changes.outputs.modules = "[]"')"
ok RED "modules an object" "$(edit "$UI" '.changes.outputs.modules = "{\"a\":1}"')"
ok RED "modules without typecheck" "$(edit "$UI" '.changes.outputs.modules = "[\"ui\"]"')"
ok RED "unknown module" "$(edit "$UI" '.changes.outputs.modules = "[\"typecheck\",\"ui\",\"nope\"]"')"
ok RED "all missing" "$(edit "$UI" 'del(.changes.outputs.all)')"
ok RED "all=true with a narrow set" "$(edit "$UI" '.changes.outputs.all = "true"')"
ok RED "CONTROL push narrowed (all=false) — must be full" "$UI" push
ok RED "schedule narrowed" "$UI" schedule
ok RED "event missing, narrowed" "$UI" ""
ok RED "CONTROL shadow narrowed (force_all=true, all=false)" "$UI" pull_request true
ok RED "a job missing from needs" "$(edit "$UI" 'del(.migrations)')"
ok RED "an unpinned job in needs" "$(edit "$UI" '.extra = {result: "success"}')"
ok RED "NEEDS empty" ""
ok RED "NEEDS not JSON" "nope"
# NO_JOB must never shadow a real job
sed 's/^NO_JOB=.*/NO_JOB='"'"'["mcp","prompt","pty-protocol","ui"]'"'"'/' "$CIOK" >"$TMP/ci-ok-nojob.sh"
OUT=$(NEEDS=$UI EVENT_NAME=pull_request bash "$TMP/ci-ok-nojob.sh" 2>&1); RC=$?
[[ $RC != 0 ]] && grep -q 'NO_JOB lists ui' <<<"$OUT"
report "ci-ok RED: NO_JOB naming a module that has a job" $? "want red"

echo
echo "ci-ok.test.sh: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]
