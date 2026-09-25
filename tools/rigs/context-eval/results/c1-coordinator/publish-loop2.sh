#!/bin/bash
# republish lane docs whenever the c1 results files grow; exits when the runner is gone and the last publish is done
R=/Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/01a0d958-19b5-7fc6-930f-7f1bb982152c/tools/rigs/context-eval/results
F1=$R/2026-09-25-6d1f4c77-c1-first.jsonl; F2=$R/2026-09-25-6d1f4c77-c1.jsonl; F3=$R/2026-09-25-6d1f4c77-c1-rep2.jsonl
last=-1
while true; do
  cur=$(cat "$F1" "$F2" "$F3" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$cur" != "$last" ]; then
    echo "$(date +%T) rows=$cur"; node /private/tmp/ctxeval/node1/publish-docs.mjs "$F1" "$F2" "$F3" 2>&1 | grep -v journal | tail -3
    last=$cur
  fi
  pgrep -f "rerun.sh" >/dev/null || { [ "$cur" = "$(cat "$F1" "$F2" "$F3" | wc -l | tr -d ' ')" ] && break; }
  sleep 60
done
echo loop-exit
