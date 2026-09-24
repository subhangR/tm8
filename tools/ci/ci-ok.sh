#!/usr/bin/env bash
# tools/ci/ci-ok.sh — the verdict of ci.yml's `ci-ok` job (design §2, Wave 2 semantics).
#
#   env: NEEDS=${{ toJSON(needs) }}  EVENT_NAME=${{ github.event_name }}
#        FORCE_ALL=${{ inputs.force_all }}      (via env: never inline in run:)
#   bash tools/ci/ci-ok.sh
#
# Green only if ALL of these hold:
#   1. `needs` is exactly the pinned job set below (a job added to ci.yml without a row
#      here is red until it gets one);
#   2. changes.result == success, and its `modules` output parses as a non-empty set of
#      known modules that contains typecheck; all=true means that set is every module;
#   2b. all=true whenever the run must be full: any event but pull_request, or the
#      a caller's FORCE_ALL. A wrapper that narrows a main push is red here, not green;
#   3. no job is failure or cancelled — ever, affected or not;
#   4. every job whose module is in the set (and every always-required job) is success;
#   5. a job whose module is NOT in the set is skipped (or success).
# So "skipped" is green only for an unaffected module. A failed `changes` job skips every
# gated job, and rule 2 makes that red rather than skip-green.
# Modules with no job yet (NO_JOB) may be in the set without a job; any OTHER module
# without a job is red, so a new affected.sh key cannot pass unmapped.
# Prints a per-job table on stdout (append it to $GITHUB_STEP_SUMMARY); exits 1 when red.

set -Eeuo pipefail
shopt -s inherit_errexit
trap 'printf "RED: internal error at line %s (malformed input?)\nci-ok: RED\n" "$LINENO"; exit 1' ERR

# job id -> module; "*" = required on every run
JOBS='{
  "changes": "*",
  "ci-scripts": "*",
  "typecheck": "typecheck",
  "test-server": "server",
  "test-cli": "cli",
  "test-execution": "execution",
  "test-ui": "ui",
  "test-small": "small",
  "migrations": "migrations"
}'
PINNED_COUNT=9
KNOWN='["typecheck","server","cli","execution","ui","small","migrations"]'
NO_JOB='[]'   # empty since W3 folded mcp, prompt, pty-protocol into small; keep for the next new module

[[ -n ${NEEDS:-} ]] || { printf "RED: NEEDS is empty\nci-ok: RED\n"; exit 1; }

verdict=$(jq -r -n --argjson needs "$NEEDS" --argjson jobs "$JOBS" --argjson pinned "$PINNED_COUNT" \
      --argjson known "$KNOWN" --argjson nojob "$NO_JOB" \
      --arg event "${EVENT_NAME:-}" --arg force "${FORCE_ALL:-}" '
  def fail($m): {ok: false, msg: $m};
  ($needs | keys) as $got
  | ($jobs | keys) as $want
  | ($needs.changes.outputs.modules // "" | try fromjson catch null) as $mods
  | ($needs.changes.outputs.all // "") as $all
  | [
      (if ($got | length) != $pinned then fail("needs has \($got | length) jobs, pinned \($pinned)") else empty end),
      (if $got != $want then fail("needs \($got) != pinned set \($want)") else empty end),
      (if $needs.changes.result != "success" then fail("changes.result is \($needs.changes.result // "missing")") else empty end),
      (if ($mods | type) != "array" or ($mods | length) == 0 or (($mods | index("typecheck")) == null)
          or ([$mods[] | strings] | length) != ($mods | length) or (($mods - $known) | length) > 0
       then fail("modules output is not a non-empty known set with typecheck: \($needs.changes.outputs.modules // "missing")")
       else empty end),
      (if $all != "true" and $all != "false" then fail("all output is \($all)") else empty end),
      (if $all == "true" and $mods != $known then fail("all=true but modules is not every module") else empty end),
      (if ($event != "pull_request" or $force == "true") and $all != "true"
       then fail("event \($event) force_all=\($force) must run everything, but all=\($all)") else empty end),
      (($nojob - ($nojob - [$jobs[]])) | .[] | fail("NO_JOB lists \(.), which has a job")),
      (($mods // []) - $nojob - [$jobs[]] | .[] | fail("module \(.) is affected but has no job")),
      ($got[] as $j
        | ($needs[$j].result // "missing") as $r
        | ($jobs[$j] // null) as $m
        | (if $m == null then false elif $m == "*" then true else ((($mods // []) | index($m)) != null) end) as $req
        | if $r == "failure" or $r == "cancelled" then fail("\($j): \($r)")
          elif $req and $r != "success" then fail("\($j): \($r), but its module \($m) is affected")
          elif ($req | not) and $r != "skipped" and $r != "success" then fail("\($j): \($r)")
          else empty end)
    ] as $fails
  | "| job | module | affected | result |",
    "|---|---|---|---|",
    ($got[] as $j | ($jobs[$j] // "?") as $m
      | "| \($j) | \($m) | \(if $m == "*" then "always" elif (($mods // []) | index($m)) != null then "yes" else "no" end) | \($needs[$j].result // "missing") |"),
    "",
    "event=\($event) force_all=\($force) modules=\($needs.changes.outputs.modules // "missing") all=\($all) reason=\($needs.changes.outputs.reason // "")",
    "",
    (if ($fails | length) == 0 then "ci-ok: GREEN" else ($fails[] | "RED: \(.msg)"), "ci-ok: RED" end)
')
printf '%s\n' "$verdict"
if [[ $(tail -n 1 <<<"$verdict") != "ci-ok: GREEN" ]]; then exit 1; fi
