/** Deterministic graph-to-world layout. Structure, creation time and — for
 * tasks — the status DISTRICT determine land; activity, progress and encounter
 * feeds only change its appearance.
 *
 * Swappable seams (task 01a1090f, story map W1):
 *  - `siteLayout` (world-groups.ts): how hierarchy children stand on their
 *    parent's site. The layout only reads its `slots` and `radius`.
 *  - `districtOf` / `DISTRICT_ORDER` (world-groups.ts): the status → district
 *    table and the sector order around the hub.
 *  - `storySource` aggregation: which graph views fold into one landmark
 *    (`LANDMARK_OF_VIEW`), and the placeholder shape each landmark takes. The
 *    asset lane replaces the look; the ids `${storyId}:library` and
 *    `${storyId}:code` are the contract.
 *
 * Fields sibling workers may rely on, on every `Place` (and `WorldNode`):
 *  `members`, `attachments`, `hasWorker`, `pendingAttention`, `parentId`,
 *  `district`, `siteRadius`; and `World.districts` (angular sectors). */
import { STORY_KIND, TASK_KIND, VIEW_OF_KIND, toneOf, type StoryGraphView, type StoryNode, type StoryTone, type StoryView } from '../model';
import type { StatusCategory } from '@tm8/contract';
import type { StoryEdgeFamily } from '../model';
import { routeRoad, pathClear, pathLength, segmentDistance, ROAD_WIDTH, ROAD_SHOULDER, type Obstacle, type Point } from './roads';
import { DISTRICT_ORDER, districtOf, districtSectors, siteLayout, type Sector, type SiteLayout, type WorldDistrict } from './world-groups';
export { DISTRICT_ORDER, districtOf, districtSectors, siteLayout, type WorldDistrict } from './world-groups';

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

/** A graph node folded into a landmark (a doc in the Library, a PR in the Code Factory). */
export interface WorldMember {
  id: string;
  kind: string;
  title: string;
  status: string | null;
  statusCategory: StatusCategory | null;
  activityAt: string | null;
  /** The places this member hangs off (every non-member neighbour by edge), sorted. */
  anchorIds: string[];
}

/** What a task carries: its shelf in the Library and its mailbox. Counts come from the page, never invented. */
export interface WorldAttachments {
  library: { count: number; memberIds: string[] };
  /** `approx` is true when the count came from the page's bounded message window (not a server tally). */
  mailbox: { count: number; approx: boolean };
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
  /** A source-chosen look (aggregates); otherwise the kind's view decides. */
  shape?: PlaceShape;
  /** Nodes folded into this one. Empty or absent for an ordinary place. */
  members?: WorldMember[];
  attachments?: WorldAttachments | null;
  /** Live itself, or a live session is working on it. */
  hasWorker?: boolean;
  /** Unresolved attention requests, when the page carries a tally. */
  pendingAttention?: number | null;
  /** Hierarchy parent (`parent` edge). The node stands on that parent's SITE when both are in the world. */
  parentId?: string | null;
  /** Tasks: the sector of the map they stand in. */
  district?: WorldDistrict | null;
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
export type PlaceShape = 'hub' | 'building' | 'tent' | 'library' | 'signpost' | 'crystal' | 'camp' | 'portal' | 'stone' | 'factory';

export const SHAPE_OF_VIEW: Readonly<Record<StoryGraphView, PlaceShape>> = {
  all: 'stone',
  tasks: 'building',
  sessions: 'tent',
  made: 'library',
  code: 'signpost',
  memories: 'crystal',
  team: 'camp',
};

/** The kind a landmark reports for its view: the first kind the view table lists for it (doc for made, pull_request for code). */
function kindOfView(view: StoryGraphView): string {
  const kind = Object.entries(VIEW_OF_KIND).find(([, v]) => v === view)?.[0];
  if (!kind) throw new Error(`No kind is shown in the ${view} view`);
  return kind;
}
/** The graph views that fold into ONE landmark each, with the landmark's suffix, kind, title and look. */
export const LANDMARK_OF_VIEW: Readonly<Partial<Record<StoryGraphView, { suffix: string; kind: string; title: string; shape: PlaceShape }>>> = {
  made: { suffix: 'library', kind: kindOfView('made'), title: 'Library', shape: 'library' },
  code: { suffix: 'code', kind: kindOfView('code'), title: 'Code factory', shape: 'factory' },
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
  /** Folded-in nodes (the Library's docs, the Code Factory's PRs). Empty for an ordinary place. */
  members: WorldMember[];
  /** Tasks only; null elsewhere. */
  attachments: WorldAttachments | null;
  hasWorker: boolean;
  pendingAttention: number | null;
  /** The hierarchy parent whose site this place stands on; null for a top-level place. */
  parentId: string | null;
  district: WorldDistrict | null;
  /** Radius of this place's whole site (its own footprint when it has no hierarchy children). */
  siteRadius: number;
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

export interface WorldSector {
  id: WorldDistrict;
  /** Radians on the ground plane (`atan2(z, x)`), `from < to`, within [-π/2, 3π/2). */
  from: number;
  to: number;
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
  /** The status districts as angular sectors from the hub, in DISTRICT_ORDER; empty when nothing has a district. */
  districts: WorldSector[];
}

/* ---- the lay of the land ---- */
/** Six world units of meadow between occupied landmark footprints. */
export const LANDMARK_GAP = 6;
export const MIN_DISTANCE = 9;
const ROOT_RING_BASE = 17;
const RECENT_MS = 3_600_000;
const ISLAND_MARGIN = 9;
/** The page's `recentMessages` window: at that size a mailbox count is a floor, not a tally. */
const MAILBOX_WINDOW = 50;

export function footprintOf(shape: PlaceShape, root = false): number {
  return shape === 'hub' ? 2.05 : root ? 1.65 : 1.5;
}
/** Roads meet a shared apron on the entrance side, outside the occupied footprint. */
export const doorstep = (p: Place): Point => ({ x: p.x, z: p.z + p.footprint + 1.1 });
export const roadObstacles = (places: readonly Place[]) => places.map((p) => ({ x: p.x, z: p.z, radius: p.footprint + ROAD_WIDTH / 2 + ROAD_SHOULDER + .1 }));
/** Half-width of the corridor a road is routed in before the whole field is consulted. */
const ROUTE_CORRIDOR = MIN_DISTANCE * 2;
/** Routes against the obstacles near the pair first (sites make most roads short); the result only stands when it is
 * verified clear against every obstacle, otherwise the whole field routes it. Correctness never depends on the corridor. */
export function routeNear(a: Point, b: Point, obstacles: readonly Obstacle[]): Point[] {
  const near = obstacles.filter((o) => segmentDistance(o, a, b) <= ROUTE_CORRIDOR + o.radius);
  if (near.length < obstacles.length) {
    try {
      const points = routeRoad(a, b, near);
      if (points.slice(1).every((p, i) => pathClear(points[i]!, p, obstacles))) return points;
    } catch { /* corridor too tight for a detour: fall through to the whole field */ }
  }
  return routeRoad(a, b, obstacles);
}

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

/** A stable 0..1 from an id (FNV-1a), so a site's turn never depends on runtime. */
function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function shapeFor(n: WorldNode, ring: number, root: boolean, portal: boolean): PlaceShape {
  return ring === 0 ? 'hub' : portal ? 'portal' : root ? 'building' : n.shape ?? shapeOf(n.kind);
}

function placeOf(n: WorldNode, x: number, z: number, ring: number, anchorId: string | null, root: boolean, portal: boolean, now: number): Place {
  const shape = shapeFor(n, ring, root, portal);
  const footprint = footprintOf(shape, root);
  return {
    footprint,
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
    members: n.members ?? [],
    attachments: n.attachments ?? null,
    hasWorker: n.hasWorker ?? false,
    pendingAttention: n.pendingAttention ?? null,
    parentId: null,
    district: n.district ?? null,
    siteRadius: footprint,
  };
}

const ageOf = (n: WorldNode): number => (n.createdAt ? Date.parse(n.createdAt) : 0);
/** Newest first (TIME IS DISTANCE), then title, then id. */
function byAge(a: WorldNode, b: WorldNode): number {
  const d = ageOf(b) - ageOf(a);
  return d !== 0 ? d : byTitle(a, b);
}
const newest = (list: ReadonlyArray<string | null | undefined>): string | null => list.reduce<string | null>((best, at) => (at && (!best || at > best) ? at : best), null);

/** The story as a world. */
export function buildWorld(view: StoryView, now: number = Date.now()): World {
  return layoutWorld(storySource(view), now);
}

/** Optional server tallies a node may carry (a sibling adds them to the contract); read defensively. */
function countsOf(n: StoryNode): { messages?: number; pendingAttention?: number } {
  // Older servers and fixtures send no counts: undefined is "not known", never 0, so the page-window fallback stays.
  const { messages, pendingAttention } = n.counts ?? {};
  return { ...(typeof messages === 'number' ? { messages } : {}), ...(typeof pendingAttention === 'number' ? { pendingAttention } : {}) };
}

export function storySource(view: StoryView): WorldSource {
  const { page } = view;
  const nodes = new Map(page.nodes.map((n) => [n.id, n]));
  const roots = [...page.roots].sort(byPosition);
  const rootIds = new Set(roots.map((r) => r.id));
  const viewOf = (id: string): StoryGraphView | undefined => VIEW_OF_KIND[nodes.get(id)?.kind ?? ''];

  /* AGGREGATION: made and code nodes fold into one landmark each. Roots stay
     landmarks whatever their kind (they were put in by hand). */
  const landmarkIdOf = (v: StoryGraphView | undefined): string | null => (v && LANDMARK_OF_VIEW[v] ? `${view.id}:${LANDMARK_OF_VIEW[v]!.suffix}` : null);
  const memberOf = new Map<string, string>();
  for (const n of page.nodes) {
    if (n.id === view.id || rootIds.has(n.id)) continue;
    const l = landmarkIdOf(VIEW_OF_KIND[n.kind]);
    if (l) memberOf.set(n.id, l);
  }
  const at = (id: string): string => memberOf.get(id) ?? id;
  const neighbours = new Map<string, Set<string>>();
  for (const e of page.edges) {
    if (e.fromId === e.toId) continue;
    neighbours.set(e.fromId, (neighbours.get(e.fromId) ?? new Set()).add(e.toId));
    neighbours.set(e.toId, (neighbours.get(e.toId) ?? new Set()).add(e.fromId));
  }
  const membersOf = new Map<string, WorldMember[]>();
  for (const [id, l] of memberOf) {
    const n = nodes.get(id)!;
    const anchorIds = [...(neighbours.get(id) ?? [])].filter((o) => !memberOf.has(o)).sort();
    membersOf.set(l, [...(membersOf.get(l) ?? []), { id, kind: n.kind, title: n.title, status: n.status, statusCategory: n.statusCategory, activityAt: n.activityAt, anchorIds }]);
  }

  /* ANCHORS: the node each trail node was reached through. The root's own
     children hang off the root; a trail item hangs off its `viaId` (or the
     landmark that swallowed it). First claim wins, so a node two roots share
     stands in the first root's land. */
  const anchorOf = new Map<string, string>();
  for (const r of roots) {
    for (const c of r.childIds) if (!anchorOf.has(c) && !rootIds.has(c)) anchorOf.set(c, r.id);
    for (const t of [...r.trail].sort((a, b) => a.depth - b.depth)) {
      if (rootIds.has(t.id) || anchorOf.has(t.id)) continue;
      anchorOf.set(t.id, at(t.viaId));
    }
  }

  /* HIERARCHY: `parent` edges between two places. First parent wins. */
  const parentOf = new Map<string, string>();
  for (const e of page.edges) {
    if (e.type !== 'parent' || e.fromId === e.toId || memberOf.has(e.fromId) || memberOf.has(e.toId)) continue;
    if (!nodes.has(e.fromId) || !nodes.has(e.toId) || parentOf.has(e.toId)) continue;
    parentOf.set(e.toId, e.fromId);
  }

  /* ATTACHMENTS: a task's shelf (made-family edges to made-kind nodes) and mailbox (messages anchored on it). */
  const shelfOf = new Map<string, Set<string>>();
  for (const e of page.edges) {
    if (e.family !== 'made') continue;
    if (viewOf(e.toId) === 'made') shelfOf.set(e.fromId, (shelfOf.get(e.fromId) ?? new Set()).add(e.toId));
    if (viewOf(e.fromId) === 'made') shelfOf.set(e.toId, (shelfOf.get(e.toId) ?? new Set()).add(e.fromId));
  }
  const mailOf = new Map<string, number>();
  for (const m of page.recentMessages) mailOf.set(m.anchorId, (mailOf.get(m.anchorId) ?? 0) + 1);
  const windowed = page.recentMessages.length >= MAILBOX_WINDOW;
  const workedOn = new Set(page.sessions.filter((s) => s.live).flatMap((s) => s.taskIds));
  const carried = (n: StoryNode): Pick<WorldNode, 'attachments' | 'hasWorker' | 'pendingAttention' | 'parentId' | 'district'> => {
    const counts = countsOf(n);
    const task = n.kind === TASK_KIND;
    return {
      hasWorker: !!n.live || workedOn.has(n.id),
      pendingAttention: counts.pendingAttention ?? null,
      parentId: parentOf.get(n.id) ?? null,
      district: task ? districtOf(n) : null,
      attachments: task
        ? {
            library: { count: shelfOf.get(n.id)?.size ?? 0, memberIds: [...(shelfOf.get(n.id) ?? [])].sort() },
            mailbox: counts.messages !== undefined ? { count: counts.messages, approx: false } : { count: mailOf.get(n.id) ?? 0, approx: windowed },
          }
        : null,
    };
  };

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
    return { ...wn(n ?? { ...r, live: false, createdAt: null, activityAt: null, rootIds: [r.id] }, pctOf(r.taskProgress), view.id), ...(n ? carried(n) : {}) };
  });
  const rest = page.nodes.filter((n) => n.id !== view.id && !rootIds.has(n.id) && !memberOf.has(n.id)).map((n) => ({ ...wn(n, null, anchorOf.get(n.id) ?? null), ...carried(n) }));
  /* The landmarks, only when they hold at least one member. Newest member decides where they stand (TIME IS DISTANCE). */
  const aggregates: WorldNode[] = [];
  for (const v of Object.keys(LANDMARK_OF_VIEW) as StoryGraphView[]) {
    const spec = LANDMARK_OF_VIEW[v]!, id = `${view.id}:${spec.suffix}`;
    const members = membersOf.get(id);
    if (!members?.length) continue;
    members.sort((a, b) => (b.activityAt ?? '').localeCompare(a.activityAt ?? '') || byTitle(a, b));
    const rows = members.map((m) => nodes.get(m.id)!);
    aggregates.push({
      id, kind: spec.kind, title: spec.title, status: null, statusCategory: null, blocked: false,
      live: rows.some((n) => !!n.live), createdAt: newest(rows.map((n) => n.createdAt)), activityAt: newest(rows.map((n) => n.activityAt)),
      progress: null, anchorId: view.id, rootIds: [...new Set(rows.flatMap((n) => n.rootIds))].sort(), shape: spec.shape, members,
      hasWorker: false, attachments: null, pendingAttention: null, parentId: null, district: null,
    });
  }
  const portals = [...page.childStories].sort(byTitle).map((c) =>
    wn({ id: c.id, kind: STORY_KIND, title: c.title, status: c.status, statusCategory: c.statusCategory, blocked: false,
         live: c.liveSessionCount > 0, activityAt: c.lastActivityAt }, pctOf(c.taskProgress), view.id),
  );
  for (const node of [hub, ...landmarks, ...rest, ...aggregates, ...portals]) attachEncounters(node);
  /* Edges follow their nodes into the landmarks; a pair of members leaves no road. */
  const edges: WorldEdge[] = [];
  const seen = new Set<string>();
  for (const e of page.edges) {
    const fromId = at(e.fromId), toId = at(e.toId), key = `${fromId}|${toId}|${e.type}`;
    if (fromId === toId || seen.has(key)) continue;
    seen.add(key);
    edges.push({ fromId, toId, type: e.type, family: e.family, cross: e.cross });
  }
  // Root membership and child-story containment are actual source relationships.
  // Layout anchor hints alone never manufacture an edge in the generic world.
  for (const n of [...landmarks, ...portals]) if (!edges.some((e) => e.fromId === view.id && e.toId === n.id))
    edges.push({ fromId: view.id, toId: n.id, type: 'contains', family: 'story', cross: false });
  return { id: view.id, hub, landmarks, nodes: [...rest, ...aggregates], portals, edges };
}

/** Any graph as a world: the generic layout. */
export function layoutWorld(src: WorldSource, now: number = Date.now()): World {
  const places: Place[] = [];
  const placed = new Map<string, Place>();
  const sites = new Map<string, SiteLayout>();
  const put = (p: Place): Place => {
    p.siteRadius = sites.get(p.id)?.radius ?? p.footprint;
    places.push(p);
    placed.set(p.id, p);
    return p;
  };
  const known = new Map<string, WorldNode>();
  for (const n of [src.hub, ...src.landmarks, ...src.nodes, ...src.portals]) if (!known.has(n.id)) known.set(n.id, n);
  const landmarkIds = new Set(src.landmarks.map((l) => l.id));
  const portalIds = new Set(src.portals.map((p) => p.id));

  /* THE HUB at the origin. */
  const hub = put(placeOf(src.hub, 0, 0, 0, null, false, false, now));

  /* SITES: a node with a known hierarchy parent stands on that parent's site.
     The hub, the portals and the landmarks are never site children; a chain
     that loops is cut where it was first seen. */
  const parentOf = new Map<string, string>();
  for (const n of src.nodes) {
    const p = n.parentId;
    if (!p || p === n.id || !known.has(p) || p === src.id || portalIds.has(p) || landmarkIds.has(n.id) || portalIds.has(n.id)) continue;
    parentOf.set(n.id, p);
  }
  for (const [id] of parentOf) {
    const seen = new Set<string>([id]);
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) {
      if (seen.has(at)) { parentOf.delete(id); break; }
      seen.add(at);
    }
  }
  const siteKids = new Map<string, WorldNode[]>();
  for (const [id, p] of parentOf) siteKids.set(p, [...(siteKids.get(p) ?? []), known.get(id)!]);
  for (const list of siteKids.values()) list.sort(byAge);
  /** The clear radius a node needs: its footprint, or its whole site (computed bottom-up, once). */
  const unitRadius = (id: string): number => {
    const cached = sites.get(id);
    if (cached) return cached.radius;
    const n = known.get(id)!;
    const own = footprintOf(shapeFor(n, id === src.id ? 0 : 1, landmarkIds.has(id), portalIds.has(id)), landmarkIds.has(id));
    const kids = siteKids.get(id);
    if (!kids?.length) return own;
    const layout = siteLayout({ id, radius: own }, kids.map((k) => ({ id: k.id, radius: unitRadius(k.id) })), seedOf(id), LANDMARK_GAP);
    sites.set(id, layout);
    return layout.radius;
  };
  for (const id of siteKids.keys()) unitRadius(id);

  /* ANCHORS: the source's hint; else a placed/anchored neighbour by edge; else the hub (the commons). */
  const anchorOf = new Map<string, string>();
  const pending = src.nodes.filter((n) => !placed.has(n.id) && !landmarkIds.has(n.id) && !parentOf.has(n.id));
  for (const n of pending) if (n.anchorId && n.anchorId !== n.id && known.has(n.anchorId)) anchorOf.set(n.id, n.anchorId);
  const edgesOf = new Map<string, string[]>();
  for (const e of src.edges) {
    if (!known.has(e.fromId) || !known.has(e.toId)) continue;
    edgesOf.set(e.fromId, [...(edgesOf.get(e.fromId) ?? []), e.toId]);
    edgesOf.set(e.toId, [...(edgesOf.get(e.toId) ?? []), e.fromId]);
  }
  const topLevel = (id: string): boolean => id === src.id || landmarkIds.has(id);
  for (const n of [...pending].sort(byTitle)) {
    if (anchorOf.has(n.id)) continue;
    const near = (edgesOf.get(n.id) ?? []).filter((o) => o !== n.id && (topLevel(o) || anchorOf.has(o))).sort();
    anchorOf.set(n.id, near[0] ?? src.id);
  }
  // A dangling anchor (named but never placed) or a cycle falls back to the hub.
  // A site child is reached through its parent, so anchoring to one is fine.
  for (const [id] of anchorOf) {
    const seen = new Set<string>([id]);
    let at = anchorOf.get(id)!;
    while (!topLevel(at)) {
      const next = parentOf.get(at) ?? anchorOf.get(at);
      if (seen.has(at) || next === undefined) { anchorOf.set(id, src.id); break; }
      seen.add(at);
      at = next;
    }
  }

  /* DISTRICTS: each one a sector from the hub, weighted by the land its
     top-level units need. Landmarks without a district share a nameless
     sector after the named ones (not exported). */
  const landmarks = src.landmarks.filter((l) => !placed.has(l.id));
  const landOf = (id: string): number => unitRadius(id) * 2 + LANDMARK_GAP;
  const weightOf = new Map<WorldDistrict | null, number>();
  for (const n of [...landmarks, ...pending]) if (n.district) weightOf.set(n.district, (weightOf.get(n.district) ?? 0) + landOf(n.id));
  const loose = landmarks.filter((l) => !l.district);
  const weights: Array<{ id: WorldDistrict | null; weight: number }> = DISTRICT_ORDER.filter((d) => weightOf.has(d)).map((d) => ({ id: d, weight: weightOf.get(d)! }));
  if (weights.length && loose.length) weights.push({ id: null, weight: loose.reduce((s, l) => s + landOf(l.id), 0) });
  const sectors = districtSectors(weights);
  const sectorOfDistrict = new Map(sectors.map((s) => [s.id, s]));
  const districts: WorldSector[] = sectors.filter((s): s is Sector<WorldDistrict> => s.id !== null).map((s) => ({ id: s.id, from: s.from, to: s.to }));
  /** The sector a place's children spread into: its own district's, else its anchor's. */
  const sectorOf = new Map<string, Sector<WorldDistrict | null>>();

  /* THE LANDMARKS: a ring, each in its district's sector (in the source's order
     within it), or evenly spaced from the top when nothing has a district. The
     radius keeps every neighbouring pair of SITES apart and leaves the commons
     inside for the hub's own children. */
  const rootAngle = new Map<string, number>();
  if (sectors.length) {
    for (const s of sectors) {
      const own = landmarks.filter((l) => (l.district ?? null) === s.id);
      own.forEach((l, i) => rootAngle.set(l.id, s.from + ((i + .5) * (s.to - s.from)) / own.length));
    }
  } else landmarks.forEach((l, i) => rootAngle.set(l.id, -Math.PI / 2 + (TAU * i) / Math.max(1, landmarks.length)));
  const hubKids = pending.filter((n) => anchorOf.get(n.id) === src.id).length;
  const commons = hubKids ? 10 + Math.sqrt(hubKids - 1) * 2 + 1.5 + LANDMARK_GAP + 1 : hub.footprint + LANDMARK_GAP;
  let rootRadius = ROOT_RING_BASE;
  const ordered = [...landmarks].sort((a, b) => rootAngle.get(a.id)! - rootAngle.get(b.id)!);
  for (const [i, a] of ordered.entries()) {
    rootRadius = Math.max(rootRadius, unitRadius(a.id) + commons);
    const b = ordered[(i + 1) % ordered.length]!;
    if (a === b) continue;
    const gap = ((rootAngle.get(b.id)! - rootAngle.get(a.id)! + TAU * 2) % TAU) || TAU;
    rootRadius = Math.max(rootRadius, (unitRadius(a.id) + unitRadius(b.id) + LANDMARK_GAP) / (2 * Math.sin(Math.min(Math.PI, gap) / 2)));
  }
  const queue: string[] = [src.hub.id];
  /** Hierarchy children take their slots on the parent's site, the open side facing the parent's anchor. */
  const placeSite = (parent: Place, facing: number): void => {
    const layout = sites.get(parent.id);
    if (!layout) return;
    const cos = Math.cos(facing), sin = Math.sin(facing);
    for (const slot of layout.slots) {
      const p = put(placeOf(known.get(slot.id)!, parent.x + slot.dx * cos - slot.dz * sin, parent.z + slot.dx * sin + slot.dz * cos, parent.ring + 1, parent.id, false, false, now));
      p.parentId = parent.id;
      const own = p.district ? sectorOfDistrict.get(p.district) : undefined;
      const s = own ?? sectorOf.get(parent.id);
      if (s) sectorOf.set(p.id, s);
      const outward = rootAngle.get(parent.id);
      if (outward !== undefined) rootAngle.set(p.id, outward);
      placeSite(p, Math.atan2(parent.z - p.z, parent.x - p.x));
      queue.push(p.id);
    }
  };
  for (const l of landmarks) {
    const a = rootAngle.get(l.id)!;
    const p = put(placeOf(l, Math.cos(a) * rootRadius, Math.sin(a) * rootRadius, 1, src.id, true, false, now));
    const s = sectorOfDistrict.get(l.district ?? null);
    if (s) sectorOf.set(p.id, s);
    placeSite(p, a + Math.PI);
    queue.push(p.id);
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
     rather than squeezing more entities into a fixed fan or relaxing neighbours.
     A node with a site claims its whole site radius. */
  const allocate = (node: WorldNode, anchor: Place, ring: number, preferred: number, minimum: number, spread: number, portal = false, sector = preferred): Place => {
    const p = placeOf(node, 0, 0, ring, anchor.id, false, portal, now);
    const clear = unitRadius(node.id);
    for (let radius = minimum; ; radius += 1.25) {
      const samples = Math.max(12, Math.ceil(radius * spread / 2));
      for (let slot = 0; slot < samples; slot++) {
        const offset = slot === 0 ? 0 : Math.ceil(slot / 2) * (slot % 2 ? 1 : -1) * spread / samples;
        const angle = preferred + offset;
        if (spread < TAU && Math.abs(angle - sector) > spread / 2) continue;
        p.x = anchor.x + Math.cos(angle) * radius; p.z = anchor.z + Math.sin(angle) * radius;
        if (places.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= clear + q.footprint + LANDMARK_GAP)) return put(p);
      }
    }
  };
  while (queue.length) {
    const anchor = placed.get(queue.shift()!)!;
    const kids = (childrenOf.get(anchor.id) ?? []).filter((k) => !placed.has(k.id));
    const parent = anchor.anchorId ? placed.get(anchor.anchorId) : null;
    const outward = rootAngle.get(anchor.id) ?? (parent ? Math.atan2(anchor.z - parent.z, anchor.x - parent.x) : -Math.PI / 2);
    let previousRadius = 0;
    kids.forEach((k, i) => {
      // Off the hub, a districted node heads for its sector; everything else fans around its anchor.
      const own = anchor.ring === 0 && k.district ? sectorOfDistrict.get(k.district) : undefined;
      const spread = own ? own.to - own.from : anchor.ring === 0 ? TAU : TAU / Math.max(3, landmarks.length) * .9;
      const centre = own ? (own.from + own.to) / 2 : outward;
      const angle = centre + ((i * .61803398875) % 1 - .5) * spread;
      const minimum = Math.max(10 + Math.sqrt(i) * 2, previousRadius + .1) + unitRadius(k.id) - footprintOf(shapeFor(k, 2, false, false));
      const p = allocate(k, anchor, Math.max(2, anchor.ring + 1), angle, minimum, spread, false, centre);
      if (anchor.ring > 0) rootAngle.set(p.id, outward);
      else if (own) rootAngle.set(p.id, Math.atan2(p.z, p.x));
      const s = (k.district ? sectorOfDistrict.get(k.district) : undefined) ?? sectorOf.get(anchor.id);
      if (s) sectorOf.set(p.id, s);
      previousRadius = Math.hypot(p.x - anchor.x, p.z - anchor.z);
      placeSite(p, Math.atan2(anchor.z - p.z, anchor.x - p.x));
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
    const points = routes.get(routeKey) ?? routeNear(doorstep(a), doorstep(b), obstacles);
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
  return { storyId: src.id, hubId: src.id, places, byId: placed, roads, adjacency, extent: Math.max(far + ISLAND_MARGIN, Math.sqrt(places.length) * 5.6 + ISLAND_MARGIN) / .959, districts };
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
