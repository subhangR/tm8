#!/usr/bin/env bash
# tools/ci/changes.sh — the `changes` job of ci.yml: decide which diff to hand affected.sh,
# then refuse to pass on anything but a well-formed block.
#
# ENV (all from the workflow; nothing else is read)
#   EVENT_NAME     github.event_name
#   FORCE_ALL      "true" when ci.yml runs as the shadow's full gate (workflow_call input)
#   EXPECTED_SHA   github.sha: the PR merge commit on pull_request
#   PR_HEAD_SHA    github.event.pull_request.head.sha (empty on other events)
#   AFFECTED       optional: another affected.sh (tests)
#
# OUTPUT: affected.sh's block, validated, on stdout (append it to $GITHUB_OUTPUT as is).
# stderr carries the diagnostics and the ::warning::/::notice:: annotations; a line naming
# the event, the path taken and the result is appended to $GITHUB_STEP_SUMMARY when set.
#
# Only `pull_request` without FORCE_ALL is ever narrowed, and only when HEAD is exactly the
# merge commit the event names: two parents, the second being the PR head. Then the diff is
# HEAD^1..HEAD, which is what merging the PR changes. Every other event — push, schedule,
# workflow_dispatch, the shadow, any event added later — is ALL.
#
# Fail-safe: whatever goes wrong here (an assert, affected.sh exiting non-zero, a block
# that does not validate), the block written is ALL. This script exits 0 whenever it has
# printed a block; a non-zero exit means it could not even do that, and the job fails,
# which ci-ok reads as red (it never reads a failed `changes` as "nothing affected").

set -Eeuo pipefail
shopt -s inherit_errexit

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AFFECTED="${AFFECTED:-$HERE/affected.sh}"
MODULES=(typecheck server cli execution ui small migrations)

all_block() { # <reason>
  local m json="" sep=""
  for m in "${MODULES[@]}"; do json+="$sep\"$m\""; sep=,; done
  printf 'all=true\nmodules=[%s]\n' "$json"
  for m in "${MODULES[@]}"; do printf '%s=true\n' "$m"; done
  printf 'reason=%s\n' "${1//$'\n'/ }"
}

summary() { # <line>
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then printf '%s\n\n' "$1" >>"$GITHUB_STEP_SUMMARY" || true; fi
}
PATH_TAKEN=""
MAIN_PID=$BASHPID
fallback() { # <reason>: our OWN ALL block, loudly, and stop. W4 counts these reasons.
  # set -E hands the ERR trap to every $(...) subshell. A fallback there would print its
  # block into the substitution and the caller would fall back AGAIN with that block as its
  # reason: two warnings, a garbled reason. Only the main shell falls back; a subshell just
  # fails, and the main shell's own ERR trap names the command that failed.
  [[ $BASHPID == "$MAIN_PID" ]] || exit 1
  local why=${1//$'\n'/ }
  echo "::warning title=changes fallback::filtering is OFF for this run — $why" >&2
  summary "**changes: FALLBACK to ALL** — event=\`${EVENT_NAME:-}\` force_all=\`${FORCE_ALL:-}\` path=\`${PATH_TAKEN:-none}\` — $why"
  all_block "fallback: $why"
  exit 0
}
trap 'fallback "error at line $LINENO: $BASH_COMMAND"' ERR

# validate <block>: the exact shape affected.sh promises, or non-zero with a reason on stdout
validate() {
  local out=$1 m n mods all
  local keys=(all modules "${MODULES[@]}" reason)
  for m in "${keys[@]}"; do
    n=$(grep -c "^$m=" <<<"$out" || true)
    [[ $n == 1 ]] || { echo "key $m appears $n times"; return 1; }
  done
  n=$(grep -c '' <<<"$out" || true)
  [[ $n == "${#keys[@]}" ]] || { echo "expected ${#keys[@]} lines, got $n"; return 1; }
  all=$(sed -n 's/^all=//p' <<<"$out")
  [[ $all == true || $all == false ]] || { echo "all=$all"; return 1; }
  mods=$(sed -n 's/^modules=//p' <<<"$out")
  local known
  known=$(printf '%s\n' "${MODULES[@]}" | jq -R . | jq -sc .)
  jq -e --argjson known "$known" \
    'type == "array" and length > 0 and all(.[]; type == "string")
     and (index("typecheck") != null) and ((. - $known) | length == 0)
     and (unique | length) == length' <<<"$mods" >/dev/null \
    || { echo "modules is not a non-empty set of known modules with typecheck: $mods"; return 1; }
  for m in "${MODULES[@]}"; do
    local flag want
    flag=$(sed -n "s/^$m=//p" <<<"$out")
    if jq -e --arg m "$m" 'index($m) != null' <<<"$mods" >/dev/null; then want=true; else want=false; fi
    [[ $all == true ]] && want=true
    [[ $flag == "$want" ]] || { echo "$m=$flag but modules/all say $want"; return 1; }
  done
  if [[ $all == true ]]; then
    [[ $(jq -c . <<<"$mods") == "$known" ]] || { echo "all=true but modules is not the full set"; return 1; }
  fi
}

command -v jq >/dev/null || fallback "jq not found"

if [[ ${EVENT_NAME:-} == pull_request && ${FORCE_ALL:-} != true ]]; then
  PATH_TAKEN="diff HEAD^1..HEAD"
  [[ -n ${EXPECTED_SHA:-} && -n ${PR_HEAD_SHA:-} ]] || fallback "pull_request without EXPECTED_SHA/PR_HEAD_SHA"
  head=$(git rev-parse HEAD)
  [[ $head == "$EXPECTED_SHA" ]] || fallback "HEAD $head is not github.sha $EXPECTED_SHA"
  parents=$(git rev-list --parents -n 1 HEAD)
  read -r -a p <<<"$parents"
  [[ ${#p[@]} == 3 ]] || fallback "HEAD is not a two-parent merge commit: $parents"
  [[ ${p[2]} == "$PR_HEAD_SHA" ]] || fallback "HEAD^2 ${p[2]} is not the PR head $PR_HEAD_SHA"
  rc=0
  out=$(bash "$AFFECTED" --base HEAD^1 --head HEAD) || rc=$?
  [[ $rc == 0 ]] || fallback "affected.sh exited $rc"
else
  PATH_TAKEN="--all"
  rc=0
  out=$(bash "$AFFECTED" --all) || rc=$?
  [[ $rc == 0 ]] || fallback "affected.sh --all exited $rc"
fi

rc=0
why=$(validate "$out") || rc=$?
[[ $rc == 0 ]] || fallback "affected.sh block rejected: $why"
all=$(sed -n 's/^all=//p' <<<"$out")
[[ $all == true || $PATH_TAKEN != --all ]] || fallback "affected.sh --all returned all=$all"
reason=$(sed -n 's/^reason=//p' <<<"$out")
# ALL on the diff path is legitimate (a global or unknown path) but it is also how
# affected.sh reports its own errors: say which, so a run that filtered nothing is visible.
if [[ $all == true && $PATH_TAKEN != --all ]]; then
  echo "::notice title=changes ALL::every job runs — $reason" >&2
fi
summary "**changes** — event=\`${EVENT_NAME:-}\` force_all=\`${FORCE_ALL:-}\` path=\`$PATH_TAKEN\` all=\`$all\` modules=\`$(sed -n 's/^modules=//p' <<<"$out")\` — $reason"
printf '%s\n' "$out"
