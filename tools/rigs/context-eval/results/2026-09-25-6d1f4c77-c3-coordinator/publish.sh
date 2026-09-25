#!/bin/bash
# c3: draft notes + publish/refresh lane docs + arm table. Usage: publish.sh "<status>"
set -e
RIG=/Users/subhang/.local/share/tm8/data/worktrees/019fb10e-8498-7189-8911-dd26c4307915/01a0d95a-888f-7999-bd42-febcdeb96778/tools/rigs/context-eval
N=/private/tmp/ctxeval/node3
cd "$RIG"
FILES=(results/2026-09-25-6d1f4c77-c3-pilot.jsonl results/2026-09-25-6d1f4c77-c3.jsonl)
SPECS=("results/2026-09-25-6d1f4c77-c3-pilot.jsonl: (pilot)" results/2026-09-25-6d1f4c77-c3.jsonl)
if [ -s results/2026-09-25-6d1f4c77-c3-rep2.jsonl ]; then FILES+=(results/2026-09-25-6d1f4c77-c3-rep2.jsonl); SPECS+=("results/2026-09-25-6d1f4c77-c3-rep2.jsonl: (rep2)"); fi
node $N/auto-notes.mjs $N/notes.json "${FILES[@]}"
node $N/publish-docs.mjs --refresh --arm-doc 01a0d960-38b6-7787-a55d-7557d6c6a882 --task 01a0d943-4a58-7f11-a6db-e95e376c7fc5 --notes $N/notes.json --status "$1" "${SPECS[@]}" 2>&1 | grep -v journal || true
