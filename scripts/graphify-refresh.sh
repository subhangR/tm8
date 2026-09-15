#!/usr/bin/env bash
# graphify-refresh — rebuild the code graph, re-project the tm8 work graph, and
# merge the two. Deterministic and free: no LLM call anywhere in this path.
#
# WHY A SCHEDULE AT ALL. Both halves go stale the moment anyone commits, and a
# stale join is worse than no join because it answers confidently. This ran
# exactly zero times between being merged and 2026-09-15 for want of these
# fifteen lines.
#
#   scripts/graphify-refresh.sh [<repo-dir>] [<space-id>]
set -euo pipefail
REPO="${1:-/home/tm8/prod-workspace/tm8}"
SPACE="${2:-${TM8_SPACE_ID:-019fbd5a-3c5b-71ea-9b91-1d3baa50da25}}"
export PATH="$HOME/.local/bin:$PATH"
cd "$REPO"

# 1 · the code half. --no-cluster keeps it deterministic; clustering is the only
#     stage that would reach for a model, and community labels are not used here.
graphify update . --no-cluster

# 2 · the work half, and the commit->file edges that cross between them.
node scripts/tm8-to-graphify.mjs --space "$SPACE" \
  --code graphify-out/graph.json \
  --out  graphify-out/tm8-work.json \
  --repo "$REPO"

# 3 · one graph a person can query.
graphify merge-graphs graphify-out/graph.json graphify-out/tm8-work.json \
  --out graphify-out/merged-graph.json

echo "graphify-refresh: $(date -u +%FT%TZ) ok"
