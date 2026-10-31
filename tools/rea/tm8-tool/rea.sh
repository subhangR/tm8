#!/usr/bin/env bash
# rea: tm8's space tool for the RE Lab. It runs REA (rea-agents) through rea-sandbox, so every
# call happens in a fresh gVisor container with no network (tools/rea/README.md).
#
# The tool's runs share one warm REA per case, role and profile: the first call on a case pays
# for the analysis (a cold Ghidra call takes ~40 s), and later runs on the same case reuse the
# open binary until `--command stop` or 15 idle minutes end it.
set -euo pipefail
sandbox=/home/tm8/rea-lab/bin/rea-sandbox
if [ ! -x "$sandbox" ]; then
  echo "rea: $sandbox is not installed on this host; see tools/rea/README.md" >&2
  exit 2
fi
# Key the warm REA by case, not by this run's session, so the next run finds it.
unset TM8_SESSION_ID
opts=()
[ -z "${REA_CASE:-}" ] || opts+=(--case "$REA_CASE")
[ -z "${REA_ROLE:-}" ] || opts+=(--role "$REA_ROLE")
case $REA_CMD in
  call|tools|stop) [ "${REA_PROFILE:-static}" = static ] || opts+=(--profile "$REA_PROFILE") ;;
esac

case $REA_CMD in
  call)
    if [ -z "${REA_TOOL_NAME:-}" ]; then
      echo "rea: --tool is required with --command call (--command tools lists them)" >&2
      exit 64
    fi
    exec "$sandbox" "${opts[@]}" call "$REA_TOOL_NAME" "${REA_TOOL_ARGS:-{\}}" ;;
  tools)
    if [ -n "${REA_TOOL_NAME:-}" ]; then
      exec "$sandbox" "${opts[@]}" tools "$REA_TOOL_NAME"
    fi
    exec "$sandbox" "${opts[@]}" tools ;;
  intake)
    srcs=()
    [ -z "${REA_SOURCE:-}" ] || srcs+=("$REA_SOURCE")
    [ -z "${REA_URL:-}" ] || srcs+=("$REA_URL")
    if [ ${#srcs[@]} -eq 0 ]; then
      echo "rea: --command intake needs --source <file> or --url <https-url>" >&2
      exit 64
    fi
    exec "$sandbox" "${opts[@]}" intake "${srcs[@]}" ;;
  doctor) exec "$sandbox" "${opts[@]}" doctor ;;
  engines|scope|ps|stop) exec "$sandbox" "${opts[@]}" "$REA_CMD" ;;
  *)
    echo "rea: unknown --command $REA_CMD" >&2
    exit 64 ;;
esac
