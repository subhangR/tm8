/**
 * THE STORY AS A WORLD — the pure, deterministic layout the game walks on.
 *
 * `buildWorld(view)` turns the server's StoryPage into PLACES (one per node
 * on the page: the story as the HUB at the origin, the roots on a ring around
 * it, every trail node clustered behind the root it hangs off, the child
 * stories as PORTAL islands on the outer ring) and ROADS (every page edge
 * between two placed nodes, plus the hub's road to each root). The layout is
 * a function of the story's STRUCTURE only — not of timestamps, not of random
 * numbers — so a live update that changes a status or adds a trail node moves
 * nothing that was already standing: places light up in place and new ones
 * rise beside their anchor, which is what "the world renders as we explore"
 * needs.
 *
 * Kinds are DATA here (model.ts §15.2): a place's SHAPE comes from the
 * graph view its kind belongs to, never from a `case 'task':`.
 */
import { VIEW_OF_KIND, STORY_KIND, toneOf, type StoryGraphView, type StoryTone, type StoryView } from '../model';
import type { StatusCategory } from '@tm8/contract';
import type { StoryEdgeFamily } from '../model';

/* ------------------------------------------------------------------------- */
/* THE GENERIC SOURCE. The layout knows nothing of stories: it is handed a    */
/* HUB, ordered LANDMARKS for the first ring, the NODES behind them (with the */
/* anchor each was reached through, when known), PORTALS for the rim and the */
/* EDGES. `storySource(view)` is the first adapter; the whole graph is the    */
/* next one (task 01a107e7: "the bigger picture is the full map").           */
/* ------------------------------------------------------------------------- */
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
}

export interface Road {
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
const ROOT_RING_BASE = 9;
const ROOT_RING_PER_ROOT = 0.9;
const PORTAL_RING_GAP = 8;
const COMMONS_RADIUS = 4.6;
/** Distance from a place to the children laid out around it, by the child's ring. */
const FAN_RADIUS: Readonly<Record<number, number>> = { 2: 3.6, 3: 2.7, 4: 2.2 };
const FAN_SPREAD = Math.PI * 1.15;
export const MIN_DISTANCE = 2.1;
/** Siblings fan out between these multiples of the ring's radius: newest nearest, oldest farthest. */
const AGE_NEAR = 0.85;
const AGE_FAR = 1.35;
const RECENT_MS = 3_600_000;
const RELAX_ITERATIONS = 80;
const ISLAND_MARGIN = 5;

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
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    shape: ring === 0 ? 'hub' : portal ? 'portal' : root ? 'building' : shapeOf(n.kind),
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
  const edges: WorldEdge[] = page.edges.map((e) => ({ fromId: e.fromId, toId: e.toId, type: e.type, family: e.family, cross: e.cross }));
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
  const rootRadius = ROOT_RING_BASE + ROOT_RING_PER_ROOT * Math.max(0, landmarks.length - 3);
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

  /* FAN OUT, breadth-first from the hub and the landmarks. A child sits on an
     arc around its anchor, facing AWAY from the anchor's own anchor, so each
     land grows outward and never back over the hub. TIME IS DISTANCE: the
     newest sibling stands nearest, the oldest farthest out along the arc. */
  const queue: string[] = [src.id, ...landmarks.map((l) => l.id)];
  const seen = new Set(queue);
  while (queue.length) {
    const aid = queue.shift()!;
    const anchor = placed.get(aid);
    if (!anchor) continue;
    const kids = (childrenOf.get(aid) ?? []).filter((k) => !placed.has(k.id));
    if (!kids.length) continue;
    const ring = anchor.ring + 1;
    const ageStep = (i: number): number => (kids.length === 1 ? 1 : AGE_NEAR + ((AGE_FAR - AGE_NEAR) * i) / (kids.length - 1));
    if (aid === src.id) {
      // The commons: a ring of the hub's own direct neighbours, offset half a step from the landmarks.
      kids.forEach((k, i) => {
        const a = -Math.PI / 2 + Math.PI / Math.max(1, kids.length) + (TAU * i) / Math.max(1, kids.length);
        const rr = COMMONS_RADIUS * ageStep(i);
        const p = put(placeOf(k, Math.cos(a) * rr, Math.sin(a) * rr, 2, aid, false, false, now));
        if (!seen.has(p.id)) { seen.add(p.id); queue.push(p.id); }
      });
      continue;
    }
    const parent = anchor.anchorId ? placed.get(anchor.anchorId) : null;
    const outward = parent ? Math.atan2(anchor.z - parent.z, anchor.x - parent.x) : rootAngle.get(aid) ?? 0;
    const radius = FAN_RADIUS[Math.min(ring, 4)] ?? 2;
    const spread = kids.length === 1 ? 0 : FAN_SPREAD;
    kids.forEach((k, i) => {
      // Alternate sides so the newest sits in the middle of the arc, the oldest at its ends.
      const slot = i % 2 === 0 ? Math.floor(kids.length / 2) + Math.floor(i / 2) : Math.floor(kids.length / 2) - Math.ceil(i / 2);
      const t = kids.length === 1 ? 0.5 : slot / (kids.length - 1);
      const a = outward + (t - 0.5) * spread;
      const rr = radius * ageStep(i);
      const p = put(placeOf(k, anchor.x + Math.cos(a) * rr, anchor.z + Math.sin(a) * rr, ring, aid, false, false, now));
      if (!seen.has(p.id)) { seen.add(p.id); queue.push(p.id); }
    });
  }

  /* THE PORTALS on the rim, between the landmarks' lands. */
  const portals = src.portals.filter((c) => !placed.has(c.id));
  const portalRadius = rootRadius + PORTAL_RING_GAP;
  portals.forEach((c, i) => {
    const a = -Math.PI / 2 + Math.PI / Math.max(1, portals.length) + (TAU * i) / Math.max(1, portals.length);
    put(placeOf(c, Math.cos(a) * portalRadius, Math.sin(a) * portalRadius, 1, src.id, false, true, now));
  });

  relax(places);

  /* ROADS: the hub to each root and each portal, then every page edge whose
     two ends stand in the world, deduplicated by unordered pair. */
  const roads: Road[] = [];
  const pair = new Set<string>();
  const addRoad = (fromId: string, toId: string, family: StoryEdgeFamily, type: string, cross: boolean): void => {
    if (fromId === toId || !placed.has(fromId) || !placed.has(toId)) return;
    const key = fromId < toId ? `${fromId}|${toId}` : `${toId}|${fromId}`;
    if (pair.has(key)) return;
    pair.add(key);
    roads.push({ id: key, fromId, toId, family, type, cross });
  };
  for (const l of landmarks) addRoad(src.id, l.id, 'story', 'contains', false);
  for (const c of portals) addRoad(src.id, c.id, 'story', 'contains', false);
  for (const e of src.edges) addRoad(e.fromId, e.toId, e.family, e.type, e.cross);
  // A place the edges never reached still gets the road it was laid out along.
  for (const p of places) if (p.anchorId) addRoad(p.anchorId, p.id, p.portal ? 'story' : 'parent', 'contains', false);

  const adjacency = new Map<string, string[]>();
  for (const r of roads) {
    adjacency.set(r.fromId, [...(adjacency.get(r.fromId) ?? []), r.toId]);
    adjacency.set(r.toId, [...(adjacency.get(r.toId) ?? []), r.fromId]);
  }

  let far = 0;
  for (const p of places) far = Math.max(far, Math.hypot(p.x, p.z));
  return { storyId: src.id, hubId: src.id, places, byId: placed, roads, adjacency, extent: far + ISLAND_MARGIN };
}

/**
 * Push apart any two places closer than MIN_DISTANCE. Deterministic (fixed
 * order, fixed iteration count) and local: the hub never moves, roots move
 * only along their ring, everything else by small steps.
 */
function relax(places: Place[]): void {
  for (let it = 0; it < RELAX_ITERATIONS; it++) {
    let moved = false;
    for (let i = 0; i < places.length; i++) {
      for (let j = i + 1; j < places.length; j++) {
        const a = places[i]!;
        const b = places[j]!;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= MIN_DISTANCE) continue;
        if (d < 1e-6) { dx = 1; dz = 0; d = 1; }
        const push = (MIN_DISTANCE - d) / 2;
        const ux = dx / d;
        const uz = dz / d;
        const wa = a.ring === 0 ? 0 : a.root || a.portal ? 0.35 : 1;
        const wb = b.ring === 0 ? 0 : b.root || b.portal ? 0.35 : 1;
        a.x -= ux * push * wa; a.z -= uz * push * wa;
        b.x += ux * push * wb; b.z += uz * push * wb;
        moved = true;
      }
    }
    if (!moved) break;
  }
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
