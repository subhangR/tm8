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

while true; do
  echo "[supervisor:$target] starting at $(date '+%Y-%m-%d %H:%M:%S')"
  "$ROOT/$target" &
  child=$!
  wait "$child"
  code=$?
  child=""
  [[ $stopping -eq 1 ]] && exit 0
  echo "[supervisor:$target] exited ($code) at $(date '+%H:%M:%S') — restarting in 2s"
  sleep 2
done
