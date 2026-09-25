#!/bin/bash
# D9: stop the c1 runner at the first lane END after the last non-replica rep-2 cell (haiku45/turn-date#2) has started,
# i.e. before it can start any rep-2 replica lane. Kills ONE pid, verified.
PID=19336
LOG=/private/tmp/ctxeval/node1/lanes.log
armed=0
tail -n +1 -f "$LOG" | while IFS= read -r line; do
  case "$line" in
    *"c1/haiku45/turn-date#2 session"*) armed=1; echo "$(date +%T) armed: $line";;
    *"#2 session"*replica*|*"replica"*"#2 session"*) echo "$(date +%T) REPLICA STARTED BEFORE STOP: $line";;
  esac
  if [ $armed = 1 ] && echo "$line" | grep -Eq ' (idle|done|timeout|no-transcript|spawn-error|auth-error|resume-failed) '; then
    if ps -p $PID -o command= | grep -q "lanes.mjs --slice c1 --node 4621 --reps 2"; then kill $PID && echo "$(date +%T) killed runner $PID after: $line"; fi
    pkill -P $$ tail; exit 0
  fi
done
