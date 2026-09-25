#!/bin/bash
# re-publish lane docs whenever the c2 results file grows; exit (after a final publish) when the runner is gone
F=/Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/01a0d959-4ebe-7a64-8294-fb0d99f0d243/tools/rigs/context-eval/results/2026-09-25-6d1f4c77-c2.jsonl
last=$(wc -l < "$F" 2>/dev/null || echo 0)
while true; do
  cur=$(wc -l < "$F" 2>/dev/null || echo 0)
  if [ "$cur" != "$last" ]; then
    echo "$(date +%T) rows $cur"; node /private/tmp/ctxeval/node2/scan-escape.mjs "$F" >/dev/null 2>&1; node /private/tmp/ctxeval/node2/publish-docs-c2.mjs "$F" 2>&1 | grep -v journal | tail -3; last=$cur
  fi
  pgrep -f "lanes.mjs --slice c2 --node 4622" >/dev/null || { node /private/tmp/ctxeval/node2/publish-docs-c2.mjs "$F" 2>&1 | grep -v journal | tail -2; echo "runner gone"; exit 0; }
  sleep 15
done
