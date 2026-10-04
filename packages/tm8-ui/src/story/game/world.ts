/** Deterministic graph-to-world layout. Structure and creation time determine land;
 * status, activity and encounter feeds only change its appearance. */
import { VIEW_OF_KIND, STORY_KIND, toneOf, type StoryGraphView, type StoryTone, type StoryView } from '../model';
import type { StatusCategory } from '@tm8/contract';
import type { StoryEdgeFamily } from '../model';
import { routeRoad, pathLength, ROAD_WIDTH, ROAD_SHOULDER, type Point } from './roads';

/* ------------------------------------------------------------------------- */
/* THE GENERIC SOURCE. The layout knows nothing of stories: it is handed a    */
/* HUB, ordered LANDMARKS for the first ring, the NODES behind them (with the */
/* anchor each was reached through, when known), PORTALS for the rim and the */
/* EDGES. `storySource(view)` is the first adapter; the whole graph is the    */
/* next one (task 01a107e7: "the bigger picture is the full map").           */
/* ------------------------------------------------------------------------- */
/** Optional encounters are source data: the renderer never fetches or guesses entities. */
export interface WorldEncounter {
  id: string;
  name: string;
  callSign: string;
  model: string | null;
  status: string | null;
  phase: 'active' | 'victory' | 'fainted' | 'resting';
  /** Actual completed attached tasks, not invented session health. */
  completed: number;
  total: number;
  activity: Array<{ id: string; at: string; text: string; author: string | null }>;
}

export interface WorldNode {
  id: string;
  kind: string;
  title: string;
  status: string | null;
  statusCategory: StatusCategory | null;
  blocked: boolean;
  live: boolean;
  /** When it came to be — TIME IS DISTANCE: newer stands nearer its anchor. Stable across live updates. */
  createdAt: string | null;
  /** Last activity — recent ones carry a beacon. Never moves a place. */
  activityAt: string | null;
  /** Done share for things that hold work (hub, landmarks, portals). */
  progress: number | null;
  /** The node this one hangs off, when the source knows. */
  anchorId: string | null;
  /** The landmarks' territory this node stands in. */
  rootIds: string[];
  encounters?: WorldEncounter[];
}

export interface WorldEdge {
  fromId: string;
  toId: string;
  type: string;
  family: StoryEdgeFamily;
  cross: boolean;
}

export interface WorldSource {
  id: string;
  hub: WorldNode;
  /** First ring, in display order. */
  landmarks: WorldNode[];
  nodes: WorldNode[];
  /** The rim: other worlds one can walk into. */
  portals: WorldNode[];
  edges: WorldEdge[];
}

/** What a place looks like. Keyed by graph view so kinds never leak into the scene. */
export type PlaceShape = 'hub' | 'building' | 'tent' | 'library' | 'signpost' | 'crystal' | 'camp' | 'portal' | 'stone';

export const SHAPE_OF_VIEW: Readonly<Record<StoryGraphView, PlaceShape>> = {
  all: 'stone',
  tasks: 'building',
  sessions: 'tent',
  made: 'library',
  code: 'signpost',
  memories: 'crystal',
  team: 'camp',
};

export interface Place {
  id: string;
  kind: string;
  title: string;
  shape: PlaceShape;
  /** Conservative occupied radius, including steps, lanterns and progress stones. */
  footprint: number;
  /** World position on the ground plane. */
  x: number;
  z: number;
  /** 0 = hub, 1 = roots, 2.. = trail depth + 1. Portals are 1. */
  ring: number;
  /** The place this one was laid out from (the hub has none). */
  anchorId: string | null;
  tone: StoryTone | null;
  status: string | null;
  live: boolean;
  /** Active within the last hour — draws a beacon. */
  recent: boolean;
  /** Done share for the hub, the roots and the portals — their glow. Null elsewhere. */
  progress: number | null;
  /** The root(s) whose territory this place stands in. */
  rootIds: string[];
  root: boolean;
  portal: boolean;
  encounters: WorldEncounter[];
}

export interface Road {
  points: Point[];
  length: number;
  id: string;
  fromId: string;
  toId: string;
  family: StoryEdgeFamily;
  type: string;
  cross: boolean;
}

export interface World {
  storyId: string;
  hubId: string;
  places: Place[];
  byId: ReadonlyMap<string, Place>;
  roads: Road[];
  /** Place id → neighbouring place ids along the roads. */
  adjacency: ReadonlyMap<string, readonly string[]>;
  /** Radius of the island: the farthest place plus a margin. */
  extent: number;
}

/* ---- the lay of the land ---- */
/** Six world units of meadow between occupied landmark footprints. */
export const LANDMARK_GAP = 6;
export const MIN_DISTANCE = 9;
const ROOT_RING_BASE = 17;
const RECENT_MS = 3_600_000;
const ISLAND_MARGIN = 9;

export function footprintOf(shape: PlaceShape, root = false): number {
  return shape === 'hub' ? 2.05 : root ? 1.65 : 1.5;
}
/** Roads meet a shared apron on the entrance side, outside the occupied footprint. */
export const doorstep = (p: Place): Point => ({ x: p.x, z: p.z + p.footprint + 1.1 });
export const roadObstacles = (places: readonly Place[]) => places.map((p) => ({ x: p.x, z: p.z, radius: p.footprint + ROAD_WIDTH / 2 + ROAD_SHOULDER + .1 }));

const TAU = Math.PI * 2;

export function shapeOf(kind: string): PlaceShape {
  if (kind === STORY_KIND) return 'portal';
  const v = VIEW_OF_KIND[kind];
  return v ? SHAPE_OF_VIEW[v] : 'stone';
}

export function pctOf(p: { work: number; done: number }): number {
  return p.work ? p.done / p.work : 0;
}

/** Stable order: `position` (nulls last), then title, then id. */
function byPosition<T extends { position?: number | null; title: string; id: string }>(a: T, b: T): number {
  const pa = a.position ?? Number.POSITIVE_INFINITY;
  const pb = b.position ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const t = a.title.localeCompare(b.title);
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

function byTitle<T extends { title: string; id: string }>(a: T, b: T): number {
  const t = a.title.localeCompare(b.title);
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

function placeOf(n: WorldNode, x: number, z: number, ring: number, anchorId: string | null, root: boolean, portal: boolean, now: number): Place {
  const shape = ring === 0 ? 'hub' : portal ? 'portal' : root ? 'building' : shapeOf(n.kind);
  return {
    footprint: footprintOf(shape, root),
    id: n.id,
    kind: n.kind,
    title: n.title,
    shape,
    x,
    z,
    ring,
    anchorId,
    tone: toneOf(n),
    status: n.status,
    live: n.live,
    recent: !!n.activityAt && now - Date.parse(n.activityAt) < RECENT_MS,
    progress: n.progress,
    rootIds: n.rootIds,
    root,
    portal,
    encounters: n.encounters ?? [],
  };
}

const ageOf = (n: WorldNode): number => (n.createdAt ? Date.parse(n.createdAt) : 0);
/** Newest first (TIME IS DISTANCE), then title, then id. */
function byAge(a: WorldNode, b: WorldNode): number {
  const d = ageOf(b) - ageOf(a);
  return d !== 0 ? d : byTitle(a, b);
}

/** The story as a world. */
export function buildWorld(view: StoryView, now: number = Date.now()): World {
  return layoutWorld(storySource(view), now);
}

export function storySource(view: StoryView): WorldSource {
  const { page } = view;
  const nodes = new Map(page.nodes.map((n) => [n.id, n]));
  const roots = [...page.roots].sort(byPosition);
  const rootIds = new Set(roots.map((r) => r.id));

  /* ANCHORS: the node each trail node was reached through. The root's own
     children hang off the root; a trail item hangs off its `viaId`. First
     claim wins, so a node two roots share stands in the first root's land. */
  const anchorOf = new Map<string, string>();
  for (const r of roots) {
    for (const c of r.childIds) if (!anchorOf.has(c) && !rootIds.has(c)) anchorOf.set(c, r.id);
    for (const t of [...r.trail].sort((a, b) => a.depth - b.depth)) {
      if (rootIds.has(t.id) || anchorOf.has(t.id)) continue;
      anchorOf.set(t.id, t.viaId);
    }
  }

  const wn = (n: { id: string; kind: string; title: string; status: string | null; statusCategory: StatusCategory | null; blocked: boolean; live?: boolean; createdAt?: string | null; activityAt?: string | null; rootIds?: string[] }, progress: number | null, anchorId: string | null): WorldNode => ({
    id: n.id, kind: n.kind, title: n.title, status: n.status, statusCategory: n.statusCategory, blocked: n.blocked,
    live: !!n.live, createdAt: n.createdAt ?? null, activityAt: n.activityAt ?? null, progress, anchorId, rootIds: n.rootIds ?? [],
  });

  const encounters = page.sessions.map((session): WorldEncounter => {
    const attached = session.taskIds.map((id) => nodes.get(id)).filter((n) => n !== undefined);
    const completed = attached.filter((n) => n.statusCategory === 'done').length;
    const failed = session.runtimeStatus === 'failed';
    const victory = !session.live && !failed && ((attached.length > 0 && completed === session.taskIds.length) || nodes.get(session.id)?.statusCategory === 'done');
    const relevant = new Set([session.id, ...session.taskIds]);
    const messages = view.feed.filter((m) => relevant.has(m.anchorId)).map((m) => ({
      id: m.id, at: m.at, text: m.excerpt, author: m.author?.displayName ?? (m.authorId ? view.people[m.authorId]?.name ?? null : null),
    }));
    const activity = page.activity.filter((a) => relevant.has(a.entityId)).map((a) => ({
      id: a.id, at: a.at, text: `${a.entityTitle} · ${a.verb}`, author: a.actor?.displayName ?? null,
    }));
    return {
      id: session.id,
      name: (session.teamMemberId ? view.people[session.teamMemberId]?.name ?? page.team.find((t) => t.id === session.teamMemberId)?.name : null) ?? session.title,
      callSign: session.callSign, model: session.model ?? null, status: session.runtimeStatus,
      phase: session.live ? 'active' : failed ? 'fainted' : victory ? 'victory' : 'resting',
      completed, total: session.taskIds.length,
      activity: [...messages, ...activity].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, 8).reverse(),
    };
  });
  const attachEncounters = (node: WorldNode): void => {
    node.encounters = encounters.filter((e) => e.id === node.id || page.sessions.find((s) => s.id === e.id)?.taskIds.includes(node.id))
      .sort((a, b) => Number(b.phase === 'active') - Number(a.phase === 'active') || a.id.localeCompare(b.id));
  };

  const hubNode = nodes.get(view.id);
  const hub = wn(
    { id: view.id, kind: STORY_KIND, title: view.title, status: view.status, statusCategory: view.statusCategory, blocked: false,
      live: view.state.liveSessionCount > 0, createdAt: hubNode?.createdAt ?? null, activityAt: view.state.lastActivityAt },
    pctOf(view.state.taskProgress), null,
  );
  const landmarks = roots.map((r) => {
    const n = nodes.get(r.id);
    return wn(n ?? { ...r, live: false, createdAt: null, activityAt: null, rootIds: [r.id] }, pctOf(r.taskProgress), view.id);
  });
  const rest = page.nodes.filter((n) => n.id !== view.id && !rootIds.has(n.id)).map((n) => wn(n, null, anchorOf.get(n.id) ?? null));
  const portals = [...page.childStories].sort(byTitle).map((c) =>
    wn({ id: c.id, kind: STORY_KIND, title: c.title, status: c.status, statusCategory: c.statusCategory, blocked: false,
         live: c.liveSessionCount > 0, activityAt: c.lastActivityAt }, pctOf(c.taskProgress), view.id),
  );
  for (const node of [hub, ...landmarks, ...rest, ...portals]) attachEncounters(node);
  const edges: WorldEdge[] = page.edges.map((e) => ({ fromId: e.fromId, toId: e.toId, type: e.type, family: e.family, cross: e.cross }));
  // Root membership and child-story containment are actual source relationships.
  // Layout anchor hints alone never manufacture an edge in the generic world.
  for (const n of [...landmarks, ...portals]) if (!edges.some((e) => e.fromId === view.id && e.toId === n.id))
    edges.push({ fromId: view.id, toId: n.id, type: 'contains', family: 'story', cross: false });
  return { id: view.id, hub, landmarks, nodes: rest, portals, edges };
}

/** Any graph as a world: the generic layout. */
export function layoutWorld(src: WorldSource, now: number = Date.now()): World {
  const places: Place[] = [];
  const placed = new Map<string, Place>();
  const put = (p: Place): Place => {
    places.push(p);
    placed.set(p.id, p);
    return p;
  };
  const known = new Map<string, WorldNode>();
  for (const n of [src.hub, ...src.landmarks, ...src.nodes, ...src.portals]) if (!known.has(n.id)) known.set(n.id, n);

  /* THE HUB at the origin. */
  put(placeOf(src.hub, 0, 0, 0, null, false, false, now));

  /* THE LANDMARKS: a ring, in the source's order, the first at the top. */
  const landmarks = src.landmarks.filter((l) => !placed.has(l.id));
  const rootRadius = Math.max(ROOT_RING_BASE, landmarks.length * (MIN_DISTANCE + 2) / TAU);
  const rootAngle = new Map<string, number>();
  landmarks.forEach((l, i) => {
    const a = -Math.PI / 2 + (TAU * i) / Math.max(1, landmarks.length);
    rootAngle.set(l.id, a);
    put(placeOf(l, Math.cos(a) * rootRadius, Math.sin(a) * rootRadius, 1, src.id, true, false, now));
  });

  /* ANCHORS: the source's hint; else a placed/anchored neighbour by edge; else the hub (the commons). */
  const anchorOf = new Map<string, string>();
  const pending = src.nodes.filter((n) => !placed.has(n.id));
  for (const n of pending) if (n.anchorId && n.anchorId !== n.id && known.has(n.anchorId)) anchorOf.set(n.id, n.anchorId);
  const edgesOf = new Map<string, string[]>();
  for (const e of src.edges) {
    if (!known.has(e.fromId) || !known.has(e.toId)) continue;
    edgesOf.set(e.fromId, [...(edgesOf.get(e.fromId) ?? []), e.toId]);
    edgesOf.set(e.toId, [...(edgesOf.get(e.toId) ?? []), e.fromId]);
  }
  for (const n of [...pending].sort(byTitle)) {
    if (anchorOf.has(n.id)) continue;
    const near = (edgesOf.get(n.id) ?? []).filter((o) => o !== n.id && (placed.has(o) || anchorOf.has(o))).sort();
    anchorOf.set(n.id, near[0] ?? src.id);
  }
  // A dangling anchor (named but never placed) falls back to the hub; so does a cycle.
  for (const [id] of anchorOf) {
    const seen = new Set<string>([id]);
    let at = anchorOf.get(id)!;
    while (!placed.has(at)) {
      if (seen.has(at) || !anchorOf.has(at)) { anchorOf.set(id, src.id); break; }
      seen.add(at);
      at = anchorOf.get(at)!;
    }
  }

  /* CHILDREN BY ANCHOR, newest first. */
  const childrenOf = new Map<string, WorldNode[]>();
  for (const [id, a] of anchorOf) {
    const n = known.get(id);
    if (n) childrenOf.set(a, [...(childrenOf.get(a) ?? []), n]);
  }
  for (const list of childrenOf.values()) list.sort(byAge);

  /* Allocate unoccupied land outward from each anchor. Newer siblings claim
     nearer land first. Sampling expands until footprint clearance is satisfied,
     rather than squeezing more entities into a fixed fan or relaxing neighbours. */
  const allocate = (node: WorldNode, anchor: Place, ring: number, preferred: number, minimum: number, spread: number, portal = false): Place => {
    const p = placeOf(node, 0, 0, ring, anchor.id, false, portal, now);
    for (let radius = minimum; ; radius += 1.25) {
      const samples = Math.max(12, Math.ceil(radius * spread / 2));
      for (let slot = 0; slot < samples; slot++) {
        const offset = slot === 0 ? 0 : Math.ceil(slot / 2) * (slot % 2 ? 1 : -1) * spread / samples;
        const angle = preferred + offset;
        p.x = anchor.x + Math.cos(angle) * radius; p.z = anchor.z + Math.sin(angle) * radius;
        if (places.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= p.footprint + q.footprint + LANDMARK_GAP)) return put(p);
      }
    }
  };
  const queue: string[] = [src.hub.id, ...landmarks.map((l) => l.id)];
  while (queue.length) {
    const anchor = placed.get(queue.shift()!)!;
    const kids = (childrenOf.get(anchor.id) ?? []).filter((k) => !placed.has(k.id));
    const parent = anchor.anchorId ? placed.get(anchor.anchorId) : null;
    const outward = parent ? Math.atan2(anchor.z - parent.z, anchor.x - parent.x) : -Math.PI / 2;
    let previousRadius = 0;
    kids.forEach((k, i) => {
      const spread = anchor.ring === 0 ? TAU : Math.PI * 1.4;
      const angle = outward + ((i * .61803398875) % 1 - .5) * spread;
      const minimum = Math.max(10 + Math.sqrt(i) * 2, previousRadius + .1);
      const p = allocate(k, anchor, Math.max(2, anchor.ring + 1), angle, minimum, spread);
      previousRadius = Math.hypot(p.x - anchor.x, p.z - anchor.z);
      queue.push(p.id);
    });
  }

  // Portals live beyond the occupied land, with the same clearance guarantee.
  const portals = src.portals.filter((c) => !placed.has(c.id));
  const portalRadius = Math.max(rootRadius, ...places.map((p) => Math.hypot(p.x, p.z))) + 10;
  portals.forEach((c, i) => allocate(c, places[0]!, 1, -Math.PI / 2 + TAU * (i + .5) / portals.length, portalRadius, TAU, true));

  const roads: Road[] = [];
  const pair = new Set<string>(), obstacles = roadObstacles(places);
  const routes = new Map<string, Point[]>();
  // Preserve distinct relationship types, including a dependency parallel to containment.
  for (const e of src.edges) {
    const a = placed.get(e.fromId), b = placed.get(e.toId);
    if (!a || !b || a === b) continue;
    const id = `${e.fromId}|${e.toId}|${e.type}`;
    if (pair.has(id)) continue;
    pair.add(id);
    const routeKey = `${e.fromId}|${e.toId}`;
    const points = routes.get(routeKey) ?? routeRoad(doorstep(a), doorstep(b), obstacles);
    routes.set(routeKey, points);
    roads.push({ ...e, id, points, length: pathLength(points) });
  }

  const adjacency = new Map<string, string[]>();
  for (const r of roads) {
    adjacency.set(r.fromId, [...(adjacency.get(r.fromId) ?? []), r.toId]);
    adjacency.set(r.toId, [...(adjacency.get(r.toId) ?? []), r.fromId]);
  }

  let far = 0;
  for (const p of places) far = Math.max(far, Math.hypot(p.x, p.z));
  return { storyId: src.id, hubId: src.id, places, byId: placed, roads, adjacency, extent: Math.max(far + ISLAND_MARGIN, Math.sqrt(places.length) * 5.6 + ISLAND_MARGIN) / .959 };
}

/** Shortest road walk between two places (BFS; roads are unweighted). Null when unconnected. */
export function roadPath(world: World, fromId: string, toId: string): string[] | null {
  if (fromId === toId) return [fromId];
  const prev = new Map<string, string | null>([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of world.adjacency.get(cur) ?? []) {
      if (prev.has(next)) continue;
      prev.set(next, cur);
      if (next === toId) {
        const path: string[] = [];
        for (let at: string | null = toId; at !== null; at = prev.get(at) ?? null) path.unshift(at);
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** The place nearest a point, within `within` units (default: anywhere). */
export function nearestPlace(world: World, x: number, z: number, within: number = Number.POSITIVE_INFINITY): Place | null {
  let best: Place | null = null;
  let bestD = within;
  for (const p of world.places) {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d <= bestD) { best = p; bestD = d; }
  }
  return best;
}
