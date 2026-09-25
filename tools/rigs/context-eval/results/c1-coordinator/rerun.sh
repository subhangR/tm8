#!/bin/bash
cd /Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/01a0d958-19b5-7fc6-930f-7f1bb982152c/tools/rigs/context-eval
M=~/.claude/projects/-private-tmp-ctxeval-node1-fixture-repo/memory
OUT=results/2026-09-25-6d1f4c77-c1-rep2.jsonl
check() { n=$(ls -A "$M" 2>/dev/null | wc -l | tr -d ' '); echo "$(date +%T) memory dir entries=$n; $(uptime)"; [ "$n" = 0 ]; }
check || { echo "memory dir NOT empty, refusing"; exit 1; }
node lanes.mjs --slice c1 --node 4621 --only fee,category,rounding,stress30 --reps 1 --out $OUT
check || { echo "memory dir NOT empty after run 1 (guard moves it per spawn; run 2 still guarded)"; }
node lanes.mjs --slice c1 --node 4621 --only turn-date --models haiku45 --reps 1 --out $OUT
check; echo rerun-done
