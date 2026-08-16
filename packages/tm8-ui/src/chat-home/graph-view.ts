/**
 * GRAPH VIEW — the headless filter layer over the induced entity graph
 * (plan 01a0094b step 1). Pure functions; the fullscreen rail and the inline
 * summary both render what these return and nothing else.
 *
 * THE RULES, EACH WITH A TEST:
 *   - NODE filters (kind, edited-here, hide-unread, hide-isolated) drop nodes
 *     AND their incident lines.
 *   - EDGE-TYPE filters drop RELATIONS only. A line whose relations all
 *     vanish is not drawn, and a node stripped of every line becomes
 *     `isolated` in the filtered view — removed only by `hideIsolated`.
 *   - SEARCH NEVER REMOVES (design commitment 3): it populates `matches` for
 *     the canvas to highlight, so context is kept while attention narrows.
 *   - COUNTS STAY HONEST (commitment 4): facets are computed over the WHOLE
 *     fold — including seeds the draw cap kept off canvas — because a facet
 *     over a truncated set lies (`task 18` when the thread referenced 30).
 *     Relation-type facets are necessarily scoped to the edges actually READ,
 *     and the caller labels them as such — same honesty as "edges not read".
 */
import type { GraphSeedFold } from './graph-seeds';
import type { InducedEdge, InducedGraph, InducedNode } from './induced-graph';

export interface GraphFilterState {
  /** Kinds to keep; empty = all. */
  kinds: ReadonlySet<string>;
  /** Relation types to keep; empty = all. */
  edgeTypes: ReadonlySet<string>;
  /** Only nodes a write-shaped call referenced — "edited here". */
  mutatedOnly: boolean;
  hideIsolated: boolean;
  hideUnread: boolean;
  /** Highlight query — dims non-matches, never removes. */
  search: string;
}

export function emptyGraphFilters(): GraphFilterState {
  return {
    kinds: new Set(),
    edgeTypes: new Set(),
    mutatedOnly: false,
    hideIsolated: false,
    hideUnread: false,
    search: '',
  };
}

/** True when the state would change what is drawn or highlighted. */
export function anyGraphFilterActive(f: GraphFilterState): boolean {
  return (
    f.kinds.size > 0 ||
    f.edgeTypes.size > 0 ||
    f.mutatedOnly ||
    f.hideIsolated ||
    f.hideUnread ||
    f.search.trim() !== ''
  );
}

export interface GraphFacets {
  /** Per kind, split into drawn and not-drawn — counted over the WHOLE fold. */
  kinds: readonly { kind: string; drawn: number; undrawn: number }[];
  /** Relations per type across the lines actually read. */
  edgeTypes: readonly { type: string; count: number }[];
}

export function graphFacets(fold: GraphSeedFold, graph: InducedGraph): GraphFacets {
  /* A drawn node's kind may have been resolved by an edge payload the bare
     seed never carried, so the node's kind wins where one exists. */
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const kindCounts = new Map<string, { drawn: number; undrawn: number }>();
  for (const seed of fold.seeds) {
    const node = nodeById.get(seed.id);
    const kind = node?.kind ?? seed.kind ?? 'entity';
    const entry = kindCounts.get(kind) ?? { drawn: 0, undrawn: 0 };
    if (node) entry.drawn += 1;
    else entry.undrawn += 1;
    kindCounts.set(kind, entry);
  }

  const typeCounts = new Map<string, number>();
  for (const edge of graph.edges) {
    for (const relation of edge.relations) {
      typeCounts.set(relation.type, (typeCounts.get(relation.type) ?? 0) + 1);
    }
  }

  const byCountThenName = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || a[0].localeCompare(b[0]);
  return {
    kinds: [...kindCounts.entries()]
      .sort((a, b) => byCountThenName([a[0], a[1].drawn + a[1].undrawn], [b[0], b[1].drawn + b[1].undrawn]))
      .map(([kind, counts]) => ({ kind, ...counts })),
    edgeTypes: [...typeCounts.entries()]
      .sort(byCountThenName)
      .map(([type, count]) => ({ type, count })),
  };
}

export interface FilteredGraph {
  graph: InducedGraph;
  /** Nodes the filters removed from the drawn set. */
  hiddenNodes: number;
  /** RELATIONS the filters removed — the same unit `relationCount` counts. */
  hiddenEdges: number;
  /** Node ids the search highlights; empty when the query is blank. */
  matches: ReadonlySet<string>;
}

export function applyGraphFilters(graph: InducedGraph, f: GraphFilterState): FilteredGraph {
  /* 1 — node predicates. */
  const keepNode = (node: InducedNode): boolean => {
    if (f.kinds.size > 0 && !f.kinds.has(node.kind)) return false;
    if (f.mutatedOnly && !node.mutated) return false;
    if (f.hideUnread && !node.edgesRead) return false;
    return true;
  };
  let nodes = graph.nodes.filter(keepNode);
  let kept = new Set(nodes.map((node) => node.id));

  /* 2 — lines: drop those touching a dropped node, then filter relations by
     type; a line whose relations all vanish is not drawn. */
  const edges: InducedEdge[] = [];
  for (const edge of graph.edges) {
    if (!kept.has(edge.a) || !kept.has(edge.b)) continue;
    const relations =
      f.edgeTypes.size > 0
        ? edge.relations.filter((relation) => f.edgeTypes.has(relation.type))
        : edge.relations;
    if (relations.length > 0) edges.push(relations === edge.relations ? edge : { ...edge, relations });
  }

  /* 3 — isolation is a property of the FILTERED view: a read node with no
     surviving line is isolated here even if it has relations at rest. */
  const linked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.a);
    linked.add(edge.b);
  }
  nodes = nodes.map((node) => {
    const isolated = node.edgesRead && !linked.has(node.id);
    return isolated === node.isolated ? node : { ...node, isolated };
  });
  if (f.hideIsolated) {
    nodes = nodes.filter((node) => !node.isolated);
    kept = new Set(nodes.map((node) => node.id));
  }

  /* 4 — search highlights over what remains; it never removes (rule 3). */
  const query = f.search.trim().toLowerCase();
  const matches = new Set<string>();
  if (query !== '') {
    for (const node of nodes) {
      if (node.title.toLowerCase().includes(query) || node.kind.toLowerCase().includes(query)) {
        matches.add(node.id);
      }
    }
  }

  const relationCount = edges.reduce((sum, edge) => sum + edge.relations.length, 0);
  return {
    graph: {
      nodes,
      edges,
      relationCount,
      unreadCount: nodes.filter((node) => !node.edgesRead).length,
      isolatedCount: nodes.filter((node) => node.isolated).length,
    },
    hiddenNodes: graph.nodes.length - nodes.length,
    hiddenEdges: graph.relationCount - relationCount,
    matches,
  };
}
