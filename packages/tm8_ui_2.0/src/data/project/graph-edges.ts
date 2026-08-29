/**
 * `graph.query` → the normalized edge family.
 *
 * THE WIRE SHAPE AND THE STORE SHAPE ARE DELIBERATELY DIFFERENT. `graph.query`
 * returns `GraphEdgeView` — endpoints as `sourceId`/`targetId` — because every
 * endpoint of every edge it returns is ALREADY in the same response's `nodes`
 * array. Embedding the summaries a second time was ~75% of the response body
 * (measured: 1 022 KB of a 1 356 KB payload for 150 nodes / 281 edges), and the
 * client threw the duplicates away on arrival: `ingestSummaries(nodes)` runs
 * first and puts exactly those summaries in the store.
 *
 * The store, meanwhile, keeps `EdgeView` — the shape the event feed
 * (`edge.upsert`) and `entities.connections` deliver, where the peer is NOT
 * already in hand. Rather than teach every edge consumer two shapes, this
 * module re-attaches the endpoints at the one boundary that has the nodes:
 * the graph read itself.
 */
import type { EdgeView, EntitySummary, GraphEdgeView } from '@tm8/contract';

export interface ResolvedGraphEdges {
  /** Edges whose endpoints both resolved — safe to ingest. */
  edges: EdgeView[];
  /**
   * Ids of edges an endpoint could NOT be found for. Structurally empty: the
   * server admits an edge only when both endpoints survived node selection.
   * It is reported rather than swallowed so a server that ever breaks that
   * invariant shows up as a named edge instead of a graph that quietly draws
   * fewer relations than it was sent.
   */
  unresolved: string[];
}

/**
 * Re-attach endpoint summaries from `nodes`. Pure; preserves input order;
 * never throws and never fabricates a half-built endpoint.
 */
export function resolveGraphEdges(
  nodes: readonly EntitySummary[],
  edges: readonly GraphEdgeView[],
): ResolvedGraphEdges {
  if (edges.length === 0) return { edges: [], unresolved: [] };
  const byId = new Map<string, EntitySummary>();
  for (const node of nodes) byId.set(node.id, node);

  const resolved: EdgeView[] = [];
  const unresolved: string[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.sourceId);
    const target = byId.get(edge.targetId);
    if (source === undefined || target === undefined) {
      unresolved.push(edge.id);
      continue;
    }
    const { sourceId: _sourceId, targetId: _targetId, ...rest } = edge;
    resolved.push({ ...rest, source, target });
  }
  return { edges: resolved, unresolved };
}
