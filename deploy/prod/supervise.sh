#!/usr/bin/env bash
# Keep-alive supervisor for one prod process.
#
#   supervise.sh run-server.sh
#   supervise.sh run-ui.sh
#
# WHY: other lanes redeploy by pattern-killing every process matching
# `packages/server/dist/index.js`, which matches prod too. There is no launchd
# agent for this instance, so this loop is the restart policy.
#
# The trap kills ONLY its own child. The previous supervisor used `kill 0`
# (whole process group) and this machine's non-interactive shells do not put
# backgrounded `&` jobs in separate process groups — so stopping one supervisor
# silently took down the other one and its children too. Do not reintroduce it.
#
# Stop with: pkill -f 'deploy/prod/supervise.sh run-server.sh'
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:?usage: supervise.sh <run-server.sh|run-ui.sh>}"

child=""
stopping=0
shutdown() {
  stopping=1
  echo "[supervisor:$target] stopping"
  if [[ -n "$child" ]]; then kill "$child" 2>/dev/null || true; fi
  exit 0
}
trap shutdown TERM INT

# A process that dies FASTER than this never really started; it failed to boot.
# Restarting is the right policy for a process that ran and crashed, and the wrong
# one for a process that cannot start at all — the same 2s loop then runs until
# someone notices, and every one of its notices looks identical, so the log is
# longest exactly where it is least informative. Give a boot failure a bounded
# number of tries and then stop, leaving its last output as the final word.
FAST_EXIT_SECONDS="${TM8_SUPERVISE_FAST_EXIT_SECONDS:-10}"
MAX_FAST_EXITS="${TM8_SUPERVISE_MAX_FAST_EXITS:-5}"
fast_exits=0

while true; do
  echo "[supervisor:$target] starting at $(date '+%Y-%m-%d %H:%M:%S')"
  started=$SECONDS
  "$ROOT/$target" &
  child=$!
  wait "$child"
  code=$?
  ran_for=$((SECONDS - started))
  child=""
  [[ $stopping -eq 1 ]] && exit 0
  # 78 (EX_CONFIG) is the child saying "this machine is misconfigured" — no build,
  # no node 22. Restarting cannot fix any of those, and looping on them buries the
  # one line that names the cause under hundreds of identical restart notices
  # (a missing node@22 wrote ~30 of them in 30s and read as a server crash).
  if [[ $code -eq 78 ]]; then
    echo "[supervisor:$target] exited (78: configuration) at $(date '+%H:%M:%S') — not restarting."
    echo "[supervisor:$target] fix the cause reported above, then re-run deploy/prod/deploy.sh --restart"
    exit 78
  fi
  if (( ran_for < FAST_EXIT_SECONDS )); then
    fast_exits=$((fast_exits + 1))
    if (( fast_exits >= MAX_FAST_EXITS )); then
      echo "[supervisor:$target] exited ($code) after ${ran_for}s — ${fast_exits} failed starts in a row, giving up."
      echo "[supervisor:$target] this is a boot failure, not a crash; the cause is in the output above."
      echo "[supervisor:$target] fix it, then re-run deploy/prod/deploy.sh --restart"
      exit 75   # EX_TEMPFAIL: distinct from 78 so a caller can tell "never booted" from "misconfigured"
    fi
    echo "[supervisor:$target] exited ($code) after ${ran_for}s — failed start ${fast_exits}/${MAX_FAST_EXITS}, retrying in 2s"
  else
    fast_exits=0   # it ran; this is a crash, and the restart budget resets
    echo "[supervisor:$target] exited ($code) at $(date '+%H:%M:%S') after ${ran_for}s — restarting in 2s"
  fi
  sleep 2
done
