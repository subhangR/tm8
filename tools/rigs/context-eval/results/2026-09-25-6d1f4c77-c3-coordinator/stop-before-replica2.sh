#!/bin/bash
# Kill the c3 runner (exact PID 34612) at the first lane END after haiku45/turn-date#2 has STARTED,
# before the runner's next loop tick starts replica rep 2 (plan #35).
PID=34612; LOG=/private/tmp/ctxeval/node3/lanes.log
armed=0
tail -n +1 -F "$LOG" | while IFS= read -r line; do
  case "$line" in
    "c3/haiku45/turn-date#2 session "*) armed=1; echo "$(date +%T) ARMED: $line";;
    c3/*"#"*" session "*) [ $armed = 1 ] && { echo "$(date +%T) TOO LATE, a lane started after arming: $line"; kill $PID; exit 0; };;
    c3/*"#"[0-9]" "*) if [ $armed = 1 ]; then ps -p $PID -o command= | grep -q "lanes.mjs --slice c3 --node 4623" && kill $PID && echo "$(date +%T) KILLED runner $PID after: $line"; exit 0; fi;;
  esac
done
