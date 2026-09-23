#!/usr/bin/env bash
# graphify-refresh — rebuild the code graph, re-project the tm8 work graph, and
# merge the two. Deterministic and free: no LLM call anywhere in this path.
#
# WHY A SCHEDULE AT ALL. Both halves go stale the moment anyone commits, and a
# stale join is worse than no join because it answers confidently. This ran
# exactly zero times between being merged and 2026-09-15 for want of these
# fifteen lines.
#
#   scripts/graphify-refresh.sh [<repo-dir>] [<space-id>] [<ref>]
#
#   <repo-dir>  the LAUNCH PROJECT — `projects.working_dir`, the checkout tm8
#               cuts worker worktrees from. Default: the prod host's checkout,
#               /home/tm8/prod-workspace/tm8 (or $GRAPHIFY_REPO).
#   <space-id>  the space whose work graph is projected. Default: the prod
#               space (or $TM8_SPACE_ID).
#   <ref>       optional (or $GRAPHIFY_REF). Unset: graph <repo-dir>'s working
#               tree in place — the prod behaviour. Set (e.g. origin/main):
#               fetch, graph a clean `git archive` of that ref in a scratch
#               directory, and publish the three JSON files into
#               <repo-dir>/graphify-out. Use it wherever the launch project is
#               a person's checkout that lags main or carries uncommitted work;
#               it never touches that checkout's files outside graphify-out/.
#
# Local node, for example:
#
#   scripts/graphify-refresh.sh /Users/subhang/Desktop/projects/tm8 \
#     019fb748-0068-76dc-9869-1bb36133c554 origin/main
#
# WHERE IT WRITES, AND WHY NO COPY STEP. Output always lands in
# <repo-dir>/graphify-out/ — the launch project, which is gitignored. Worker
# worktrees do not get a copy: worktree provisioning symlinks
# <worktree>/graphify-out -> <launch-project>/graphify-out
# (`LANE_SHARED_PATHS` in packages/execution/src/worktree/WorktreeManager.ts),
# so every lane reads whatever this script last published. Files are replaced by
# rename, so a lane mid-query never reads a half-written graph.
#
# Run it against the launch project, never from inside a lane: a lane's
# graphify-out is that symlink, and graphing the lane would publish one
# branch's code as everyone's graph. The guard below refuses that.
set -euo pipefail
REPO="${1:-${GRAPHIFY_REPO:-/home/tm8/prod-workspace/tm8}}"
SPACE="${2:-${TM8_SPACE_ID:-019fbd5a-3c5b-71ea-9b91-1d3baa50da25}}"
REF="${3:-${GRAPHIFY_REF:-}}"
export PATH="$HOME/.local/bin:$PATH"
cd "$REPO"

if [ -L graphify-out ]; then
  echo "graphify-refresh: $REPO/graphify-out is a symlink (a worker lane?) -> $(readlink graphify-out)" >&2
  echo "graphify-refresh: refresh the launch project it points into instead" >&2
  exit 2
fi
mkdir -p graphify-out

if [ -z "$REF" ]; then
  SRC="$REPO"
else
  git fetch --quiet origin
  # Named after the repo: merge-graphs prefixes node ids with this directory's
  # name, so the scratch tree must carry the same one an in-place build would.
  SRC="${GRAPHIFY_BUILD_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/tm8-graphify}/$(basename "$REPO")"
  rm -rf "$SRC"
  mkdir -p "$SRC"
  git archive "$REF" | tar -x -C "$SRC"
fi

# 1 · the code half. --no-cluster keeps it deterministic; clustering is the only
#     stage that would reach for a model, and community labels are not used here.
#     Node paths are relative to $SRC, so a graph built in a scratch tree reads
#     the same as one built in place.
(cd "$SRC" && graphify update . --no-cluster)

# 2 · the work half, and the commit->file edges that cross between them. `git
#     show` runs against $REPO, which holds every object $REF has.
node "$SRC/scripts/tm8-to-graphify.mjs" --space "$SPACE" \
  --code "$SRC/graphify-out/graph.json" \
  --out  "$SRC/graphify-out/tm8-work.json" \
  --repo "$REPO"

#     Both halves must say what they are. graphify 0.8.39's `update` writes
#     graph.json with no `directed` or `multigraph` key, networkx then loads it
#     as a MultiGraph, and `merge-graphs` — which composes into a plain Graph —
#     dies with "All graphs must be graphs or multigraphs". The exporter at an
#     older $REF omits the key too.
node -e '
  const fs = require("node:fs");
  for (const f of process.argv.slice(1)) {
    const g = JSON.parse(fs.readFileSync(f, "utf8"));
    if (g.multigraph !== undefined && g.directed !== undefined) continue;
    g.directed ??= false; g.multigraph ??= false;
    fs.writeFileSync(f, JSON.stringify(g));
  }' "$SRC/graphify-out/graph.json" "$SRC/graphify-out/tm8-work.json"

# 3 · one graph a person can query.
graphify merge-graphs "$SRC/graphify-out/graph.json" "$SRC/graphify-out/tm8-work.json" \
  --out "$SRC/graphify-out/merged-graph.json"

# 4 · publish (ref mode only; in place it is already there). Copy beside, then
#     rename: a reader sees the old file or the new one, never a torn one.
if [ "$SRC" != "$REPO" ]; then
  for f in graph.json tm8-work.json merged-graph.json; do
    cp "$SRC/graphify-out/$f" "graphify-out/.$f.tmp"
    mv -f "graphify-out/.$f.tmp" "graphify-out/$f"
  done
fi

echo "graphify-refresh: $(date -u +%FT%TZ) ok ${REF:+($REF @ $(git rev-parse --short "$REF")) }-> $REPO/graphify-out"
