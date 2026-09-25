#!/bin/bash
# D9: stop the c2 runner (pid 5240 ONLY) at the lane boundary before the first rep-2 replica lane.
# Trigger: the last non-replica lane (haiku45/turn-date#2) has STARTED, and then a new row is appended.
LOG=/private/tmp/ctxeval/node2/lanes.log
F=/Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/01a0d959-4ebe-7a64-8294-fb0d99f0d243/tools/rigs/context-eval/results/2026-09-25-6d1f4c77-c2.jsonl
PID=5240
until grep -q '^c2/haiku45/turn-date#2 session' "$LOG"; do
  kill -0 $PID 2>/dev/null || { echo "runner gone before trigger"; exit 1; }
  grep -q '^c2/[a-z0-9]*/replica-[0-9a-f]*#2 session' "$LOG" && { echo "replica already started?!"; exit 2; }
  sleep 1
done
N=$(wc -l < "$F"); echo "$(date +%T) armed: haiku45/turn-date#2 started, rows=$N"
while [ "$(wc -l < "$F")" -le "$N" ]; do kill -0 $PID 2>/dev/null || { echo "runner gone"; exit 1; }; sleep 0.3; done
ps -p $PID -o command= | grep -q 'lanes.mjs --slice c2 --node 4622' && kill $PID && echo "$(date +%T) killed runner $PID at rows=$(wc -l < "$F")"
sleep 5; grep -n 'replica-[0-9a-f]*#2 session' "$LOG" && echo "WARNING: a replica rep-2 lane started" || echo "no replica rep-2 lane started"
