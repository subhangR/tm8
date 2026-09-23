#!/usr/bin/env node
/**
 * graphify-merge — `graphify merge-graphs`, minus the direction loss.
 *
 *   node scripts/graphify-merge.mjs <tag> <out.json> <graph.json>...
 *
 * WHY NOT `graphify merge-graphs`. In graphify 0.8.39 it composes every input
 * into an undirected `nx.Graph()` and re-serializes it, and serializing an
 * undirected graph writes each edge in adjacency order, not in the order it was
 * extracted. Measured on origin/main b02a8a7a: 4,785 of 7,310 `calls` edges
 * (65%) came out pointing callee -> caller. `affected`, `path` and `explain`
 * read link order as direction, so they answered backwards.
 *
 * WHAT THIS KEEPS FROM IT. The same id scheme (`<tag>::<id>`, plus `repo` and
 * `local_id` on each node, as `prefix_graph_for_global` does), so queries and
 * ids read exactly as before. Links are copied verbatim with their endpoints
 * prefixed; nothing is re-ordered.
 *
 * WHY `directed: false`. It is what graphify's own clustered `update` writes
 * (`export.to_json` serializes an undirected nx.Graph and restores each link's
 * true endpoints from `_src`/`_tgt`). The direction-aware commands force
 * `directed: True` on load; `graphify query` honours the flag, and with `true`
 * its BFS would follow successors only, so "what calls X" would return what X
 * calls. Undirected storage with source->target link order is the convention.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [tag, out, ...inputs] = process.argv.slice(2);
if (!tag || !out || inputs.length === 0) {
  console.error('usage: graphify-merge.mjs <tag> <out.json> <graph.json>...');
  process.exit(2);
}

const nodes = new Map();
const links = [];
for (const file of inputs) {
  const g = JSON.parse(readFileSync(file, 'utf8'));
  for (const n of g.nodes) {
    const id = `${tag}::${n.id}`;
    // Later inputs win on a shared id, as nx.compose does.
    nodes.set(id, { ...nodes.get(id), ...n, id, repo: tag, local_id: n.id });
  }
  for (const l of g.links ?? g.edges ?? []) {
    links.push({ ...l, source: `${tag}::${l.source}`, target: `${tag}::${l.target}` });
  }
}
const known = new Set(nodes.keys());
const kept = links.filter((l) => known.has(l.source) && known.has(l.target));

writeFileSync(out, JSON.stringify({ directed: false, multigraph: false, graph: {}, nodes: [...nodes.values()], links: kept }));
console.log(`graphify-merge: ${inputs.length} graphs -> ${nodes.size} nodes, ${kept.length} links (${links.length - kept.length} dangling dropped) -> ${out}`);
