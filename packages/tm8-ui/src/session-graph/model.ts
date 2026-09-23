/**
 * THE SESSION GRAPH MODEL — the ego-network of one work session.
 *
 * WHAT THIS ANSWERS. "What did this session actually do?" A session's own
 * footprint is written into the edge table as it works: the task it took, the
 * teammate running it, the entities it created, the messages it wrote, the
 * sessions it talked to. That is provenance, and it is the only description of
 * a session that nobody had to remember to type.
 *
 * WHY NOT `graph.query`. Measured on the live node, `graph.query --focus
 * <session> --hops 3` reported ONE `authored_from` edge for a session that has
 * fifty-one, because the server takes a 200-row candidate slice of the space
 * BEFORE it traverses (`facade/context.ts` MAX_LIMIT), so most of a busy
 * session's own messages are never candidates. `entities.connections` on the
 * same session returned all 103 of its edges. The complete answer comes from
 * walking connections outward; that is what `load.ts` does and what this file
 * shapes.
 *
 * WHY HOPS ALONE ARE A LIE HERE, and what replaces them. Also measured: two
 * blind hops from a session reaches 36 entities, 30 of which are unrelated
 * sessions pulled in through the project (degree 27) and the teammate (degree
 * 29); three hops reaches 152 — the whole space. Depth is meaningless while a
 * supernode sits at depth 1. So this model keeps hops as the user's control and
 * makes them honest with two rules that are DERIVED FROM THE DATA, never from a
 * kind:
 *   · HUB STOP — a neighbour whose own degree exceeds `HUB_DEGREE` is drawn,
 *     labelled with its degree, and never expanded through. It is a landmark,
 *     not a corridor.
 *   · FOLD — a relation holding more than `FOLD_AT` peers collapses to one
 *     counted cell. Fifty-one messages are a fact about the session, not fifty-
 *     one things to look at, and a fold states the fact in one node.
 * Neither rule needs to know what a project or a message IS, so §15.2 holds
 * without an exemption and a kind added tomorrow behaves correctly today.
 *
 * FOLD IS ALSO THE EXPANSION BUDGET. The loader expands exactly the peers this
 * model would draw unfolded (`expandableFrom`), so "what you can see is what
 * gets deepened" — and pressing a fold open genuinely fetches further rather
 * than merely revealing what was already in hand.
 */
import type { EdgeView, EntitySummary } from '@tm8/contract';

/** A relation holding more peers than this collapses into one counted cell. */
export const FOLD_AT = 5;
/**
 * A node with more edges than this is a landmark, not a corridor: drawn, and
 * never expanded through. Measured basis — this space's two real supernodes
 * carry degree 27 and 29, its ordinary tasks and docs sit in the low single
 * digits, and a busy session itself reaches ~103. Twelve separates them with
 * room on both sides.
 */
export const HUB_DEGREE = 12;
/** Peers considered inside one relation before the rest become "+N more". */
export const FANOUT = 24;
/** Total drawn cells. Beyond this the canvas stops being readable. */
export const MAX_CELLS = 64;

export type Direction = 'out' | 'in';

/**
 * Human labels for the relations a session actually holds, keyed by
 * `type:direction` because the same edge means different things from each end:
 * `messaged:out` is "messaged", `messaged:in` is "messaged by".
 *
 * Edge TYPES are not entity kinds, so naming them here is not a §15.2 breach.
 * An unlisted type still renders — `humanize` turns it into words — so a new
 * edge type appears in this graph the day it is written, unlabelled but never
 * missing.
 */
const RELATION_LABELS: Readonly<Record<string, string>> = {
  'working_on:out': 'Working on',
  'working_on:in': 'Worked on by',
  'in_project:out': 'In project',
  'in_project:in': 'Contains',
  'participates_in:in': 'Run by',
  'participates_in:out': 'Participates in',
  'relates_to:out': 'Related to',
  'relates_to:in': 'Related from',
  'created_in:in': 'Created here',
  'created_in:out': 'Created in',
  'authored_from:in': 'Wrote',
  'authored_from:out': 'Written from',
  'anchored_to:in': 'Addressed to it',
  'anchored_to:out': 'Anchored to',
  'messaged:out': 'Messaged',
  'messaged:in': 'Messaged by',
  'dispatched_by:out': 'Dispatched by',
  'dispatched_by:in': 'Dispatched',
  'depends_on:out': 'Depends on',
  'depends_on:in': 'Blocks',
  'completed_by:in': 'Completed by',
  'completed_by:out': 'Completes',
  'tracks:out': 'Tracks',
  'tracks:in': 'Tracked by',
  'attached_to:in': 'Attachments',
  'attached_to:out': 'Attached to',
  'remembers:out': 'Remembers',
  'remembers:in': 'Remembered by',
};

/**
 * Expansion order when the budget cannot take every relation. Structural
 * relations first — the task and what it depends on say what the work IS;
 * conversation says who it happened with. Anything unlisted sorts after these
 * and before the two message relations, which are near-always folded anyway.
 */
const EXPAND_PRIORITY: readonly string[] = [
  'working_on:out',
  'depends_on:out',
  'depends_on:in',
  'created_in:in',
  'tracks:out',
  'completed_by:in',
  'relates_to:out',
  'relates_to:in',
  'messaged:out',
  'messaged:in',
];

export function humanize(type: string): string {
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function relationKey(type: string, direction: Direction): string {
  return `${type}:${direction}`;
}

export function relationLabel(type: string, direction: Direction): string {
  return RELATION_LABELS[relationKey(type, direction)] ?? humanize(type);
}

export interface Relation {
  key: string;
  type: string;
  direction: Direction;
  label: string;
  /** Peers on the far end, most recently active first. */
  peers: readonly EntitySummary[];
}

/**
 * The edges around `nodeId`, grouped into relations SEEN FROM THAT NODE.
 *
 * Self-edges are dropped: an edge whose two endpoints are the same entity has
 * no far end to place, and drawing it as a peer of itself puts a duplicate of
 * the focus on the first ring.
 */
export function relationsOf(nodeId: string, edges: readonly EdgeView[]): Relation[] {
  const groups = new Map<string, { type: string; direction: Direction; peers: EntitySummary[] }>();
  const seen = new Map<string, Set<string>>();
  for (const edge of edges) {
    const outgoing = edge.source.id === nodeId;
    const incoming = edge.target.id === nodeId;
    if (outgoing === incoming) continue;
    const direction: Direction = outgoing ? 'out' : 'in';
    const peer = outgoing ? edge.target : edge.source;
    const key = relationKey(edge.type, direction);
    let group = groups.get(key);
    if (!group) {
      group = { type: edge.type, direction, peers: [] };
      groups.set(key, group);
      seen.set(key, new Set());
    }
    // Two entities can hold the same relation twice; the peer is still one peer.
    const already = seen.get(key)!;
    if (already.has(peer.id)) continue;
    already.add(peer.id);
    group.peers.push(peer);
  }
  return [...groups]
    .map(([key, group]) => ({
      key,
      type: group.type,
      direction: group.direction,
      label: relationLabel(group.type, group.direction),
      peers: [...group.peers].sort(byRecencyThenTitle),
    }))
    .sort((a, b) => expandRank(a.key) - expandRank(b.key) || a.key.localeCompare(b.key));
}

function expandRank(key: string): number {
  const index = EXPAND_PRIORITY.indexOf(key);
  return index === -1 ? EXPAND_PRIORITY.length : index;
}

/**
 * Recency ranks but never selects (the graph lens learned this the hard way:
 * on a busy space almost everything is recent, so recency cannot discriminate —
 * it can only order). Title breaks the tie so the layout is stable across
 * reloads rather than reshuffling on equal timestamps.
 */
function byRecencyThenTitle(a: EntitySummary, b: EntitySummary): number {
  const at = Date.parse(a.activityAt);
  const bt = Date.parse(b.activityAt);
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
  return a.title.localeCompare(b.title);
}

/**
 * The peers of `nodeId` that are drawn INDIVIDUALLY — i.e. everything in a
 * relation small enough not to fold, plus any fold the viewer has opened.
 *
 * This is the loader's expansion set as well as the model's draw set, on
 * purpose: expanding what is folded away would spend reads on things the canvas
 * has already decided not to show.
 */
export function expandableFrom(
  nodeId: string,
  edges: readonly EdgeView[],
  openFolds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const relation of relationsOf(nodeId, edges)) {
    const folded = relation.peers.length > FOLD_AT && !openFolds.has(foldId(nodeId, relation.key));
    if (folded) continue;
    for (const peer of relation.peers.slice(0, FANOUT)) out.push(peer.id);
  }
  return out;
}

export function foldId(parentId: string, relationKey: string): string {
  return `fold:${parentId}:${relationKey}`;
}

export interface EntityCell {
  sort: 'focus' | 'entity';
  id: string;
  entity: EntitySummary;
  hop: number;
  parentId: string | null;
  relationKey: string | null;
  /** Degree of this node, when we fetched it. `null` ⇒ its edges were not read. */
  degree: number | null;
  /** Over `HUB_DEGREE`: drawn, never expanded through. */
  hub: boolean;
  /** Neighbours this node holds that are not on the canvas. */
  withheld: number;
}

export interface FoldCell {
  sort: 'fold';
  id: string;
  hop: number;
  parentId: string;
  relationKey: string;
  label: string;
  count: number;
  byKind: Readonly<Record<string, number>>;
  memberIds: readonly string[];
}

export type Cell = EntityCell | FoldCell;

export interface Link {
  id: string;
  fromId: string;
  toId: string;
  type: string;
  label: string;
  /** Toward the focus (`in`) or away from it (`out`), as seen from `fromId`. */
  direction: Direction;
}

export interface SessionGraph {
  focusId: string;
  cells: readonly Cell[];
  links: readonly Link[];
  /** Every relation the FOCUS holds, whether drawn, folded or hidden. */
  relations: readonly Relation[];
  /** Relation keys the viewer switched off. */
  hidden: ReadonlySet<string>;
  /** Cells dropped because `MAX_CELLS` was reached. */
  truncated: number;
  /** True while more edges are still being read for the requested depth. */
  reachedDepth: number;
}

export interface BuildInput {
  focusId: string;
  /** nodeId → its complete edge list. An absent key means "not read". */
  edgesByNode: ReadonlyMap<string, readonly EdgeView[]>;
  /** The focus entity, so the centre draws before any read resolves. */
  focus: EntitySummary;
  hops: number;
  openFolds?: ReadonlySet<string>;
  hiddenRelations?: ReadonlySet<string>;
}

/**
 * Breadth-first from the focus, admitting a node once at its shallowest hop.
 *
 * Hubs are admitted and then closed: their edges may well have been read (the
 * loader reads a node before it can know the degree), but their neighbours are
 * counted into `withheld` instead of drawn. That number is the honest form of
 * "there are 27 more things through here" and is what the canvas prints on the
 * node — an unexplained missing branch is the failure this replaces.
 */
export function buildSessionGraph(input: BuildInput): SessionGraph {
  const { focusId, edgesByNode, focus, hops } = input;
  const openFolds = input.openFolds ?? new Set<string>();
  const hidden = input.hiddenRelations ?? new Set<string>();

  const degreeOf = (id: string): number | null => edgesByNode.get(id)?.length ?? null;
  const isHub = (id: string): boolean => {
    const degree = degreeOf(id);
    return degree !== null && degree > HUB_DEGREE;
  };

  const cells: Cell[] = [];
  const links: Link[] = [];
  const placed = new Set<string>([focusId]);
  let truncated = 0;
  let reachedDepth = 0;

  cells.push({
    sort: 'focus',
    id: focusId,
    entity: focus,
    hop: 0,
    parentId: null,
    relationKey: null,
    degree: degreeOf(focusId),
    hub: false,
    withheld: 0,
  });

  const focusRelations = relationsOf(focusId, edgesByNode.get(focusId) ?? []);

  let frontier: string[] = [focusId];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const parentEdges = edgesByNode.get(parentId);
      // Never read ⇒ this branch simply ends here; that is a boundary, not a
      // claim that the node is a leaf. The cell's `degree: null` says so.
      if (!parentEdges) continue;
      const parentCell = cells.find((c) => c.id === parentId);
      if (parentCell && parentCell.sort !== 'fold' && parentCell.hub && hop > 1) continue;

      for (const relation of relationsOf(parentId, parentEdges)) {
        // Hiding is a FOCUS control: switching "Wrote" off means "not from the
        // session", not "nowhere in the graph", so it only filters hop 1.
        if (hop === 1 && hidden.has(relation.key)) continue;

        const fresh = relation.peers.filter((peer) => !placed.has(peer.id));
        if (fresh.length === 0) continue;

        const id = foldId(parentId, relation.key);
        const shouldFold = fresh.length > FOLD_AT && !openFolds.has(id);

        if (shouldFold) {
          if (cells.length >= MAX_CELLS) {
            truncated += fresh.length;
            continue;
          }
          const byKind: Record<string, number> = {};
          for (const peer of fresh) byKind[peer.kind] = (byKind[peer.kind] ?? 0) + 1;
          cells.push({
            sort: 'fold',
            id,
            hop,
            parentId,
            relationKey: relation.key,
            label: relation.label,
            count: fresh.length,
            byKind,
            memberIds: fresh.map((peer) => peer.id),
          });
          links.push({
            id: `link:${parentId}:${id}`,
            fromId: parentId,
            toId: id,
            type: relation.type,
            label: relation.label,
            direction: relation.direction,
          });
          // Folded members are claimed so a deeper hop cannot draw them
          // individually and contradict the count printed on the fold.
          for (const peer of fresh) placed.add(peer.id);
          reachedDepth = Math.max(reachedDepth, hop);
          continue;
        }

        const admitted = fresh.slice(0, FANOUT);
        truncated += fresh.length - admitted.length;
        for (const peer of admitted) {
          if (cells.length >= MAX_CELLS) {
            truncated += 1;
            continue;
          }
          placed.add(peer.id);
          const hub = isHub(peer.id);
          cells.push({
            sort: 'entity',
            id: peer.id,
            entity: peer,
            hop,
            parentId,
            relationKey: relation.key,
            degree: degreeOf(peer.id),
            hub,
            withheld: 0,
          });
          links.push({
            id: `link:${parentId}:${peer.id}:${relation.key}`,
            fromId: parentId,
            toId: peer.id,
            type: relation.type,
            label: relation.label,
            direction: relation.direction,
          });
          reachedDepth = Math.max(reachedDepth, hop);
          if (!hub) next.push(peer.id);
        }
      }
    }
    frontier = next;
  }

  // Second pass for `withheld`: a node's undrawn neighbours can only be counted
  // once every cell that WILL be drawn is known.
  for (const cell of cells) {
    if (cell.sort === 'fold') continue;
    const edges = edgesByNode.get(cell.id);
    if (!edges) continue;
    const neighbours = new Set<string>();
    for (const edge of edges) {
      const peer = edge.source.id === cell.id ? edge.target : edge.source;
      if (peer.id !== cell.id) neighbours.add(peer.id);
    }
    let withheld = 0;
    for (const id of neighbours) if (!placed.has(id)) withheld += 1;
    cell.withheld = withheld;
  }

  return {
    focusId,
    cells,
    links,
    relations: focusRelations,
    hidden,
    truncated,
    reachedDepth,
  };
}

export interface SessionGraphSummary {
  /** Relations of the focus, with counts — the "what it does" line. */
  headline: readonly { key: string; label: string; count: number }[];
  entityCount: number;
  relationCount: number;
  /** Nodes drawn whose own edges were never read; their branches end early. */
  unreadBoundary: number;
}

export function summarize(graph: SessionGraph): SessionGraphSummary {
  const entityCells = graph.cells.filter((c): c is EntityCell => c.sort !== 'fold');
  return {
    headline: graph.relations.map((r) => ({ key: r.key, label: r.label, count: r.peers.length })),
    entityCount: entityCells.length - 1,
    relationCount: graph.relations.reduce((sum, r) => sum + r.peers.length, 0),
    unreadBoundary: entityCells.filter((c) => c.degree === null).length,
  };
}
