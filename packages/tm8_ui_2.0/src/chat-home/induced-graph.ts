/**
 * INDUCED ENTITY GRAPH — the pure model behind Chat Home's entity graph.
 *
 * THE CONVERSATION IS THE SELECTOR, NOT A NODE (owner ruling, 2026-08-16).
 * The chat decides which entities are on screen — the seeds — and never
 * appears on screen itself. There is no hub, no centre, no anchor cell.
 *
 * EDGES COME ONLY FROM THE REAL GRAPH. An edge is drawn iff
 * `entities.connections` returned it AND both endpoints are seeds. Never
 * `graph.query` (it slices 200 candidates before traversing and under-reports
 * a busy session's edges ~50:1 — measured, see `session-graph/model.ts`).
 * No co-occurrence edges, no inferred edges, no connector hops: measured on
 * the live node, 72 external entities were reachable from ≥2 of 10 seeds, so
 * one intermediate hop floods the picture.
 *
 * PARALLEL RELATIONS MERGE (R4): the measurement shows `assigned_to` AND
 * `relates_to` between one task/teammate pair — that is one line carrying a
 * relation set, with direction preserved per relation.
 *
 * ISOLATED IS A RESULT, NOT A FAILURE (R5/R11): a seed whose read succeeded
 * and matched nothing is drawn unlinked — "we read this; it relates to
 * nothing else we read" is true and useful. A seed whose read FAILED (or has
 * not settled) is a different state — its edges are simply not known — and
 * the two must never be conflated, so the model splits them.
 *
 * TITLES COME FROM THE EDGE PAYLOAD FIRST (F2/R7): every `EdgeView` embeds
 * the full source AND target entity summaries, so the read that gives us
 * edges also resolves bare-id seeds. Order: edge summary → extraction
 * kind/title → (render-time resolver) → truncated id.
 */
import type { EdgeView } from '@tm8/contract';
import { humanize } from '../session-graph/model';
import { truncateEntityId } from './entity-refs';

/** One entity the conversation referenced — produced by the seed fold. */
export interface GraphSeed {
  id: string;
  /** From extraction, when a tool payload carried them. */
  kind?: string | undefined;
  title?: string | undefined;
  /** A write-shaped tool call referenced it (R6 interim source). */
  mutated: boolean;
}

/** The state of one seed's `entities.connections` read. */
export type SeedConnections =
  | { state: 'loaded'; edges: readonly EdgeView[]; pageCapped: boolean }
  | { state: 'failed' }
  | { state: 'pending' };

export interface InducedNode {
  id: string;
  kind: string;
  title: string;
  /** False ⇒ `title` is a truncated id and the render layer should try the
   *  shared entity resolver (R7c) before settling for it. */
  resolvedTitle: boolean;
  mutated: boolean;
  /** Edges its own read returned; null ⇒ its edges were never read. */
  degree: number | null;
  /** True when one page did not hold them all — `degree` is a floor. */
  pageCapped: boolean;
  /** Its own connections read settled successfully. */
  edgesRead: boolean;
  /** Read succeeded and no induced edge touches it (R5). Never true for an
   *  unread seed — "isolated" and "not read" mean opposite things (R11). */
  isolated: boolean;
}

/** One relation inside a merged line; `from → to` is the edge's real
 *  direction, preserved per relation (R4). */
export interface InducedRelation {
  type: string;
  from: string;
  to: string;
  /** Humanised by the existing session-graph mechanism — never a tool name. */
  label: string;
}

/** One drawn line: every relation between an unordered pair of seeds. */
export interface InducedEdge {
  /** Canonical pair key, endpoints sorted. */
  key: string;
  a: string;
  b: string;
  relations: readonly InducedRelation[];
}

export interface InducedGraph {
  /** Seed order in, node order out — placement stability rests on this. */
  nodes: readonly InducedNode[];
  edges: readonly InducedEdge[];
  /** Total relations across all merged lines — the caption's number. */
  relationCount: number;
  /** Seeds whose own connections read failed or has not settled. */
  unreadCount: number;
  isolatedCount: number;
}

export function buildInducedGraph(
  seeds: readonly GraphSeed[],
  connections: ReadonlyMap<string, SeedConnections>,
): InducedGraph {
  const seedIds = new Set(seeds.map((seed) => seed.id));

  /* Harvest summaries for ANY seed named by ANY returned edge — including a
     seed whose own read failed but which a peer's read reached (its summary
     rides on that edge), and a seed whose only edges are external (every row
     of its own read still carries its own summary). */
  const summaries = new Map<string, { kind: string; title: string }>();
  const note = (endpoint: EdgeView['source']): void => {
    if (seedIds.has(endpoint.id) && !summaries.has(endpoint.id)) {
      summaries.set(endpoint.id, { kind: endpoint.kind, title: endpoint.title });
    }
  };

  /* Collect induced relations. The same edge arrives once per endpoint read,
     so relations dedupe on (type, from, to); self-edges have no line to draw. */
  const relationSeen = new Set<string>();
  const byPair = new Map<string, InducedRelation[]>();
  for (const seed of seeds) {
    const read = connections.get(seed.id);
    if (read?.state !== 'loaded') continue;
    for (const edge of read.edges) {
      note(edge.source);
      note(edge.target);
      const from = edge.source.id;
      const to = edge.target.id;
      if (from === to || !seedIds.has(from) || !seedIds.has(to)) continue;
      const relationKey = `${edge.type}:${from}:${to}`;
      if (relationSeen.has(relationKey)) continue;
      relationSeen.add(relationKey);
      const pairKey = from < to ? `${from}|${to}` : `${to}|${from}`;
      const list = byPair.get(pairKey);
      const relation: InducedRelation = { type: edge.type, from, to, label: humanize(edge.type) };
      if (list) list.push(relation);
      else byPair.set(pairKey, [relation]);
    }
  }

  /* Deterministic merged lines: pairs in first-endpoint seed order via the
     sorted key, relations ordered by type then direction. */
  const edges: InducedEdge[] = [...byPair.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, relations]) => {
      const [a, b] = key.split('|') as [string, string];
      return {
        key,
        a,
        b,
        relations: [...relations].sort(
          (x, y) => x.type.localeCompare(y.type) || x.from.localeCompare(y.from),
        ),
      };
    });

  const linked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.a);
    linked.add(edge.b);
  }

  const nodes: InducedNode[] = seeds.map((seed) => {
    const read = connections.get(seed.id);
    const summary = summaries.get(seed.id);
    const edgesRead = read?.state === 'loaded';
    const title = summary?.title ?? seed.title;
    return {
      id: seed.id,
      kind: summary?.kind ?? seed.kind ?? 'entity',
      title: title ?? truncateEntityId(seed.id),
      resolvedTitle: title !== undefined,
      mutated: seed.mutated,
      degree: read?.state === 'loaded' ? read.edges.length : null,
      pageCapped: read?.state === 'loaded' ? read.pageCapped : false,
      edgesRead,
      isolated: edgesRead && !linked.has(seed.id),
    };
  });

  return {
    nodes,
    edges,
    relationCount: edges.reduce((sum, edge) => sum + edge.relations.length, 0),
    unreadCount: nodes.filter((node) => !node.edgesRead).length,
    isolatedCount: nodes.filter((node) => node.isolated).length,
  };
}
