#!/usr/bin/env bash
# DEPENDS-ON — refuse to merge a PR whose stated dependency is not in main yet.
#
#   bash tools/ci/depends-on.sh <pr-number>
#
# WHY THIS EXISTS, with the real case that produced it:
#
# #389 moved the chat runtime to `bypassPermissions` — a full-trust shell. Its
# safety argument rested entirely on #376, which taught the secret redactor the
# tm8 token shape, because the chat runtime writes a live 24h `tm8s_` token into
# a per-thread mcp.json that a full-trust Bash can read. NOTHING RECORDED THAT
# DEPENDENCY. Not the board, not the PR, not a check. It was discovered only by
# reading the diff, and the two landed in the safe order purely because of the
# order they happened to go green.
#
# Reverse that order and main briefly carries a full-trust shell over an
# un-redacted token. That is not a wasted CI cycle; that is a security window
# nobody would have been warned about.
#
# So: a PR may state its dependencies, and if it does, they are ENFORCED.
#
#   Depends-on: #376
#   Depends-on: #376, #379
#
# The line is optional — most PRs have no cross-lane dependency and should not
# be made to write one. But an UNSTATED dependency is invisible, so the cost of
# stating it must be near zero and the cost of ignoring a stated one must be a
# red check.
#
# Exit 0 when every stated dependency is merged (or none is stated), 1 otherwise.
set -uo pipefail

PR="${1:-}"
if [ -z "$PR" ]; then
  echo "usage: bash tools/ci/depends-on.sh <pr-number>" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 2; }

BODY="$(gh pr view "$PR" --json body -q .body 2>/dev/null)" || {
  echo "could not read PR #$PR" >&2; exit 2; }

# Accept "Depends-on:", "Depends on:", "depends-on:" — and several per line.
# Deliberately anchored to line start so prose that merely mentions the phrase
# ("this depends on #376 landing first") does not become an enforced edge.
DEPS="$(printf '%s\n' "$BODY" \
  | grep -iE '^[[:space:]]*depends[-[:space:]]on:' \
  | grep -oE '#[0-9]+' \
  | tr -d '#' \
  | sort -u)"

if [ -z "$DEPS" ]; then
  echo "no 'Depends-on:' line — nothing to enforce."
  echo
  echo "If this PR's correctness or SAFETY relies on another PR being in main"
  echo "first, say so with a line like:    Depends-on: #376"
  exit 0
fi

echo "stated dependencies: $(echo "$DEPS" | tr '\n' ' ')"
echo

FAILED=0
for dep in $DEPS; do
  if [ "$dep" = "$PR" ]; then
    echo "  #$dep  SELF — a PR cannot depend on itself"
    FAILED=1
    continue
  fi
  state="$(gh pr view "$dep" --json state -q .state 2>/dev/null)" || state=""
  case "$state" in
    MERGED) echo "  #$dep  MERGED — satisfied" ;;
    CLOSED)
      echo "  #$dep  CLOSED WITHOUT MERGING — this dependency will never be satisfied."
      echo "        Either the dependency moved elsewhere (update the line) or this PR is unsafe to land."
      FAILED=1 ;;
    OPEN)
      echo "  #$dep  STILL OPEN — merge it first, then re-run this check."
      FAILED=1 ;;
    *)
      echo "  #$dep  UNKNOWN (could not read its state) — treating as unsatisfied rather than guessing."
      FAILED=1 ;;
  esac
done

echo
if [ "$FAILED" -ne 0 ]; then
  echo "REFUSING: a stated dependency is not in main."
  echo "This check exists because #389 (a full-trust shell) depended on #376 (token"
  echo "redaction) and nothing recorded it. The safe order happened by luck."
  exit 1
fi
echo "every stated dependency is merged."
