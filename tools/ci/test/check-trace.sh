#!/usr/bin/env bash
# Trace harness for tools/ci/check.sh. It proves, by diff rather than by "it still
# passes", that a change to check.sh leaves every no-flag path unchanged, and it
# asserts what --only / --shard do.
#
#   bash tools/ci/test/check-trace.sh [<base-ref>]      (default base: FETCH_HEAD)
#
# Each case runs check.sh in a `git archive <base-ref>` export whose bun, tsc
# and migrations-check.sh are stubs. A stub logs its argv and cwd, and exits 1
# when that log line matches the case's TRACE_FAIL regex, so a stage can be made
# to fail. node is real, because check.sh reads package.json with it.
#
# Part 1 (equivalence) runs the BASE ref's check.sh and the WORKING TREE's
# check.sh through the same matrix of legacy flags x CI x conformance gate x
# injected failure, then diffs the stage order, the stubbed commands, the
# summary and the exit code. Any difference fails. The conformance gate is
# pinned both ways (advisory, blocking), because check.sh otherwise probes
# localhost and the answer depends on the box, not on the script.
#
# Part 2 (new flags) asserts exit codes and stub logs for the working tree only.
#
# Exit 0 only if every comparison is empty and every assertion holds.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE="${1:-FETCH_HEAD}"
NEW_CHECK="$REPO/tools/ci/check.sh"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
git -C "$REPO" show "$BASE:tools/ci/check.sh" > "$WORK/check.base.sh" || { echo "cannot read check.sh at $BASE" >&2; exit 2; }
mkdir -p "$WORK/tree"
git -C "$REPO" archive "$BASE" | tar -x -C "$WORK/tree" || exit 2
mkdir -p "$WORK/tree/.stub" "$WORK/tree/node_modules/.bin"

# run <check.sh> <outfile> <mutate-fn|-> [args...]  (env TRACE_FAIL, CI, TM8_CONFORMANCE_GATE pass through)
run() {
  local check="$1" out="$2" mutate="$3"; shift 3
  # One shared export; a case that mutates the tree gets its own copy.
  local t="$WORK/tree"
  if [ "$mutate" != - ]; then t="$(mktemp -d "$WORK/t.XXXX")"; cp -a "$WORK/tree/." "$t/"; fi
  cp "$check" "$t/tools/ci/check.sh"
  local name path
  for spec in "bun:$t/.stub/bun" "tsc:$t/node_modules/.bin/tsc" "migrations-check.sh:$t/tools/ci/migrations-check.sh"; do
    name="${spec%%:*}"; path="${spec#*:}"
    cat > "$path" <<STUB
#!/usr/bin/env bash
[ "$name" = bun ] && [ "\${1:-}" = --version ] && { echo 1.2.0; exit 0; }
line="$name \$* @\${PWD#$t}"
echo "  [stub] \$line"
if [ -n "\${TRACE_FAIL:-}" ] && [[ "\$line" =~ \$TRACE_FAIL ]]; then exit 1; fi
exit 0
STUB
    chmod +x "$path"
  done
  [ "$mutate" = - ] || "$mutate" "$t"
  ( cd "$t" && NO_COLOR=1 PATH="$t/.stub:$PATH" bash tools/ci/check.sh "$@" ) > "$out" 2>&1
  echo "exit=$?" >> "$out"
  [ "$t" = "$WORK/tree" ] || rm -rf "$t"
}

FAILED=0
bad() { echo "FAIL: $*"; FAILED=$((FAILED + 1)); }

# --- part 1: no new flags == base ------------------------------------------
echo "== part 1: equivalence against $BASE ($(git -C "$REPO" rev-parse --short "$BASE"))"
FAILS=(
  ""                                   # all green
  "^tsc -b packages/server "           # a typecheck fails mid-list
  "^bun run test @/packages/cli$"      # a test stage fails
  "^bun run test @/tools/conformance$" # conformance red: advisory vs blocking branch
  "^migrations-check.sh"               # migrations fail
  "^bun install"                       # install fails
)
n=0
for args in "" "--fast" "--no-migrations" "--no-install" "--no-install --no-migrations"; do
  for ci in "" 1; do
    for gate in advisory blocking; do
      for f in "${FAILS[@]}"; do
        n=$((n + 1))
        # shellcheck disable=SC2086
        CI="$ci" TM8_CONFORMANCE_GATE="$gate" TRACE_FAIL="$f" run "$WORK/check.base.sh" "$WORK/base.out" - $args
        # shellcheck disable=SC2086
        CI="$ci" TM8_CONFORMANCE_GATE="$gate" TRACE_FAIL="$f" run "$NEW_CHECK" "$WORK/new.out" - $args
        if ! diff -u "$WORK/base.out" "$WORK/new.out" > "$WORK/d"; then
          bad "args='$args' CI='$ci' gate=$gate fail='$f' differs:"; cat "$WORK/d"
        fi
      done
    done
  done
done
echo "   $n cases compared (full stdout+stderr, including the exit code)"
echo "   sample (args='--fast' gate=advisory fail=cli test), branch output:"
TM8_CONFORMANCE_GATE=advisory TRACE_FAIL="^bun run test @/packages/cli$" run "$NEW_CHECK" "$WORK/s" - --fast
sed -n '/==> summary/,$p' "$WORK/s" | sed 's/^/     /'

# The usage/refusal path for an unknown option must stay byte-identical too.
run "$WORK/check.base.sh" "$WORK/base.out" - --bogus
run "$NEW_CHECK" "$WORK/new.out" - --bogus
if diff -u "$WORK/base.out" "$WORK/new.out" > "$WORK/d"; then echo "   unknown option: identical ($(tail -1 "$WORK/new.out"))"
else bad "unknown option differs:"; cat "$WORK/d"; fi

echo "   --help (the one EXPECTED difference: the header documents the new flags):"
run "$WORK/check.base.sh" "$WORK/hb" - --help
run "$NEW_CHECK" "$WORK/hn" - --help
diff -u "$WORK/hb" "$WORK/hn" | sed 's/^/     /'

# --- part 2: the new flags -------------------------------------------------
echo "== part 2: --only / --shard"
# expect <exit> <description> [grep-must-match...] -- [grep-must-not-match...]  (checks $WORK/o)
expect() {
  local want="$1" desc="$2"; shift 2
  local got; got="$(sed -n 's/^exit=//p' "$WORK/o")"
  [ "$got" = "$want" ] || { bad "$desc: exit $got, want $want"; sed 's/^/     /' "$WORK/o"; return; }
  local mode=must p
  for p in "$@"; do
    if [ "$p" = -- ]; then mode=mustnot; continue; fi
    if [ "$mode" = must ]; then grep -qE -- "$p" "$WORK/o" || { bad "$desc: missing /$p/"; sed 's/^/     /' "$WORK/o"; return; }
    else ! grep -qE -- "$p" "$WORK/o" || { bad "$desc: unexpected /$p/"; sed 's/^/     /' "$WORK/o"; return; }
    fi
  done
  echo "   ok  $desc"
}
drop_jev_tests() { find "$1/packages/jev" -name '*.test.ts' -delete; }
conformance_plain_vitest() { node -e "const f='$1/tools/conformance/package.json',p=require(f);p.scripts.test='vitest run';require('fs').writeFileSync(f,JSON.stringify(p))"; }

run "$NEW_CHECK" "$WORK/o" - --only typecheck:packages/server,test:packages/server --shard 2/4
expect 0 "W1 server shard: builds in full, shards only the test" \
  "^  \[stub\] tsc -b packages/server @$" "^  \[stub\] bun run test --shard=2/4 @/packages/server$" \
  "SKIP  install \(not selected by --only\)" "SKIP  migrations \(not selected by --only\)" "SKIP  test packages/cli \(not selected" \
  -- "tsc -b packages/contract" "@/packages/cli" "bun install" "migrations-check"
TRACE_FAIL="^bun run test --shard=2/4 @/packages/server$" run "$NEW_CHECK" "$WORK/o" - --only typecheck:packages/server --only test:packages/server --shard=2/4
expect 1 "a failing selected stage still fails the run (repeated --only, --shard=)" "FAIL  test packages/server"
run "$NEW_CHECK" "$WORK/o" - --only test:packages/cli,typecheck:packages/execution,typecheck:packages/cli
order="$(sed -n 's/^  \[stub\] //p' "$WORK/o" | tr '\n' '|')"
if [ "$order" = "tsc -b packages/execution @|tsc -b packages/cli @|bun run test @/packages/cli|" ]; then
  expect 0 "canonical order, not argv order"
else
  bad "canonical order: stubs ran as $order"
fi
CI=1 run "$NEW_CHECK" "$WORK/o" - --only install,migrations
expect 0 "install + migrations only" "^  \[stub\] bun install --frozen-lockfile @$" "^  \[stub\] migrations-check.sh  ?@$" -- "tsc " "run test"
run "$NEW_CHECK" "$WORK/o" - --only typecheck
expect 0 "group name selects every typecheck" "tsc -p packages/tm8-ui/tsconfig.json" "tsc -b tools/conformance" -- "run test"
run "$NEW_CHECK" "$WORK/o" - --only test:packages/tm8-ui --shard 1/2
expect 0 "ui shard" "^  \[stub\] bun run test --shard=1/2 @/packages/tm8-ui$"
run "$NEW_CHECK" "$WORK/o" drop_jev_tests --only test:packages/jev
expect 1 "explicitly selected stage that would SKIP fails (no vacuous green)" "FAIL  test packages/jev \(no test files yet\)"
run "$NEW_CHECK" "$WORK/o" drop_jev_tests --only test
expect 0 "the same skip under a group name stays a reported skip" "SKIP  test packages/jev \(no test files yet\)"
run "$NEW_CHECK" "$WORK/o" conformance_plain_vitest --only test:tools/conformance --shard 1/2
expect 0 "shardability is keyed to the script, not a name list" "bun run test --shard=1/2 @/tools/conformance"

for bad_args in "--only typechek" "--only test:packages/nope" "--only ," "--only" \
                "--only test:packages/server --fast" "--fast --only test:packages/server" \
                "--only test:packages/server --no-install" "--only migrations --no-migrations" \
                "--shard 1/4" "--only test:tools/conformance --shard 1/2" "--only test --shard 1/2" \
                "--only typecheck:packages/server --shard 1/2" "--only test:packages/server --shard 0/4" \
                "--only test:packages/server --shard 5/4" "--only test:packages/server --shard x" \
                "--only test:packages/server --shard"; do
  # shellcheck disable=SC2086
  run "$NEW_CHECK" "$WORK/o" - $bad_args
  expect 2 "refused: $bad_args" -- "\[stub\]"
done

echo
if [ "$FAILED" -gt 0 ]; then echo "check-trace: $FAILED failure(s)"; exit 1; fi
echo "check-trace: all green"
