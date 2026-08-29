/**
 * Graph relevance — the PURE scoring layer that decides which of a workspace's
 * entities are worth drawing, which fold into a neighbor, and in what order the
 * render budget is spent. DOM-free, react-free, kind-literal-free (§15.2).
 *
 * WHY THIS EXISTS. The canvas used to draw every entity the session had ever
 * ingested and every edge between them, then truncate at RENDER_CAP by ISLAND
 * ORDER — so what you saw was "the biggest islands", never "what matters".
 * Measured on a real space (2026-08-02): 435 live entities / 567 edges, of which
 * 53 had degree 0 and 244 had degree 1. 69% of the canvas carried no structure
 * at all, and the single most important node could be truncated away because it
 * happened to sit in a small island.
 *
 * THE MODEL. Furnas' degree-of-interest, adapted to graphs by van Ham & Perer
 * ("Search, Show Context, Expand on Demand", InfoVis 2009):
 *
 *     DOI(x | y, z) = α·APIdiff(x) + β·UIdiff(x, z) + γ·D(x, y)
 *
 * where API is a priori interest (how important x is on its own), UI is user
 * interest (what the search query z says about x), and D is graph distance from
 * the focus y. The `diff` suffix is the paper's interest DIFFUSION: interest
 * spreads to neighbors at a decay of δ per hop, so a dull node on the path to a
 * live one is still worth drawing. Without diffusion, thresholding a graph on
 * raw interest shatters it into disconnected fragments.
 *
 *     APIdiff(x) = max(API(x), δ · max over n ∈ N(x) of APIdiff(n))
 *
 * HONESTY LAWS THIS FILE MUST NOT BREAK.
 *  - Every signal read here is a REAL contract field (liveness snapshot, the
 *    server-derived `badges`, `activityAt`, observed degree). Nothing is
 *    inferred from appearance, and recency is never treated as liveness.
 *  - Folding HIDES NOTHING: a folded node is accounted on its hub's badge and
 *    counted in the model's totals. The caller renders the count.
 *  - A node the user is actively interested in — live, blocked, flagged for
 *    attention, worked on, searched for, focused, selected — is NEVER folded and
 *    NEVER outranked into truncation. Interest overrides topology, always.
 *  - No kind literals. Folding is decided on DEGREE (a topological fact) and
 *    interest, never on "messages are boring". That the rule happens to fold
 *    238 message/doc/memory leaves on the measured space is a CONSEQUENCE of
 *    their shape, not a hard-coded opinion about their kind.
 */
import type { EdgeView, EntitySummary } from '@tm8/contract';

// ---------------------------------------------------------------------------
// Lenses — the named starting points. A lens chooses SEEDS, not a hard filter:
// everything else is reached by diffusion from the seeds, so a lens can never
// sever the context that explains what it shows.
// ---------------------------------------------------------------------------

export type LensId = 'live' | 'working' | 'all';

export interface LensSpec {
  id: LensId;
  label: string;
  /** The honest one-line description of what this lens seeds from. */
  hint: string;
  /**
   * How far context is drawn around the seeds, in hops. THIS is what makes a
   * lens mean something: without it, a lens merely reorders and — because the
   * render budget is almost always larger than the interesting subgraph — every
   * lens ends up drawing the same ~150 nodes in a different order, which is
   * exactly the "shows too much" complaint wearing a new hat. `Infinity` means
   * the whole space, ranked.
   */
  radius: number;
}

export const LENSES: readonly LensSpec[] = [
  {
    id: 'live',
    label: 'Live',
    hint: 'Sessions running right now and what they are directly touching.',
    radius: 1,
  },
  {
    id: 'working',
    label: 'Active work',
    hint: 'Live sessions, work with someone on it, blocked paths and anything flagged for attention — plus one hop of context.',
    radius: 1,
  },
  {
    id: 'all',
    label: 'Everything',
    hint: 'The whole space, ranked by relevance. Large spaces are still capped.',
    radius: Infinity,
  },
];

export function lensSpec(id: LensId): LensSpec {
  return LENSES.find((l) => l.id === id) ?? LENSES[LENSES.length - 1];
}

export const DEFAULT_LENS: LensId = 'working';

// ---------------------------------------------------------------------------
// Weights. Tuned so the ORDER of the signals is what matters, not their exact
// values: a live node always outranks a merely-recent one, and a hub always
// outranks a leaf of the same freshness.
// ---------------------------------------------------------------------------

const W_LIVE = 1.0;
const W_BLOCKED = 0.85;
const W_ATTENTION = 0.8;
const W_WORKING_ACTOR = 0.75;
const W_HUB_MAX = 0.45;
const HUB_SATURATION = 8; // degree at which hub-ness is fully earned
const W_FRESH = 0.35;
const W_WARM = 0.2;

/** Interest decay per hop (the paper's δ). 0 ≤ δ < 1; higher spreads further. */
const DIFFUSION = 0.55;
/** The UI (search) term's weight — a hit outranks everything but a live node. */
const W_SEARCH = 0.9;
/** Distance penalty per hop from an explicit focus (the paper's γ, negated). */
const W_DISTANCE = 0.12;

/**
 * Most interesting neighbors any one node may pull into the lens per hop.
 *
 * THE SUPERNODE GUARD. Expanding a neighborhood without a fan-out cap is how a
 * bounded lens still produces a hairball: this workspace has a node of degree
 * 76, so "live sessions and one hop" quietly meant "and 76 more". van Ham &
 * Perer name this directly — the system can make no guarantee about the degree
 * of the node being expanded, so it must admit only the top N neighbors and
 * SAY how many it held back. The fold badge on the card is where it says so.
 */
const EXPANSION_FANOUT = 6;

/**
 * Degree past which a node is a HUB: still drawn, still linked, but never used
 * to JOIN two nodes into the same cluster. Read by the component partition in
 * `model.ts`, which is the only place the distinction can be expressed.
 *
 * WHY THE FAN-OUT CAP ABOVE IS NOT ENOUGH. It bounds how many neighbors one hop
 * admits; it does not stop a hub from WELDING unrelated work together, because
 * six neighbors of a project node are still six different threads.
 *
 * Measured on this space (2026-08-16, 3,917 entities / 7,434 edges): ONE
 * connected component covers 98% of the all-time edge set, 97% at 7 days and
 * 88% at 24 hours — and 93% even with messages excluded. There are no natural
 * disjoint sets to show. The welders are hubs: at 7 days the top degrees are a
 * `work_session` at 237, a `team_member` at 130 and a `project` at 112, and
 * dropping one edge type alone (`created_in`) takes the 7-day component count
 * from 51 to 189.
 *
 * Refusing to CLUSTER through them is what makes disjoint sets exist. Neither
 * axis works alone: a 24-hour window on its own gives 195 nodes whose giant
 * component is 171; 7 days with this rule gives 2,006 nodes in 100 components,
 * unusable. Together they give 183 nodes, largest component 19, and 22 clusters
 * of 7–19 that each turn out to be one real work thread — a task, its session,
 * its PR and commits, its messages. 12 of those 22 contain exactly one task and
 * 14 exactly one session, which is why a cluster can be NAMED after the task it
 * is about without inventing an entity to hold the name.
 *
 * A HUB IS CONTEXT, NOT NOISE. It is drawn, its edges are drawn, and it joins
 * the cluster of its most interesting neighbor — deleting the teammate and the
 * project would give the same clusters and a lying picture in which nobody owns
 * the work.
 *
 * THE DEGREE IS INDUCED, NOT ABSOLUTE. It counts a node's neighbors AMONG THE
 * NODES THIS CANVAS HOLDS, after the window and the lens have run — so the same
 * project reads as a welder on an all-time canvas and stops being one in the
 * last hour, when it is only holding six things together. That is a DIFFERENT
 * universe from `session-graph`'s HUB_DEGREE, which counts a node's full
 * incident connection count as the server reports it. The threshold is shared
 * because both were tuned on this space; the quantities they compare are not
 * the same quantity, and the two are free to diverge.
 *
 * A larger space may want it lifted; it is one named export.
 */
export const HUB_DEGREE = 12;

const FRESH_MS = 2 * 60_000;
const WARM_MS = 45 * 60_000;

// (Recency no longer seeds any lens — see `seedsFor`.)

// ---------------------------------------------------------------------------

export interface RelevanceInput {
  nodes: readonly EntitySummary[];
  edges: readonly EdgeView[];
  /** The liveness snapshot's verdict — the ONLY honest source of "running". */
  liveIds: ReadonlySet<string>;
  /** Search hits (Furnas' UI term). Empty when the query is blank. */
  matchIds: ReadonlySet<string>;
  /** Ids the user has explicitly pinned attention to — focus and selection. */
  pinnedIds: ReadonlySet<string>;
  /** Explicit focus node, if any: adds the distance term. */
  focusId?: string | null;
  now: string;
}

export interface Relevance {
  /** Raw a priori interest, before diffusion. */
  api: ReadonlyMap<string, number>;
  /** Interest after diffusion — what selection and folding actually read. */
  doi: ReadonlyMap<string, number>;
  /** Undirected adjacency over the given edge set. */
  adjacency: ReadonlyMap<string, readonly string[]>;
  degree: ReadonlyMap<string, number>;
  /**
   * Ids that must never FOLD into a neighbor. Broad by design: anything with a
   * reason to be looked at keeps its own card, however leafy its shape.
   */
  protectedIds: ReadonlySet<string>;
  /**
   * Ids that must never be TRUNCATED — admitted to the canvas whatever the lens
   * and whatever the budget.
   *
   * DELIBERATELY NARROWER than `protectedIds`, and the distinction is what makes
   * a lens able to be small. Conflating the two put all 63 blocked/worked/
   * flagged nodes on the Live canvas, each dragging its own context, and "Live"
   * came out at 114 nodes on a space with 19 running sessions. Blocked and
   * flagged entities are still strong ranking signals and still SEED the active
   * -work lens; they simply do not force their way onto every other one.
   */
  mustDrawIds: ReadonlySet<string>;
}

function recencyWeight(activityAt: string, now: string): number {
  const delta = Date.parse(now) - Date.parse(activityAt);
  if (!Number.isFinite(delta)) return 0;
  if (delta <= FRESH_MS) return W_FRESH;
  if (delta <= WARM_MS) return W_WARM;
  return 0;
}

/** True when the server's derived badges say this node is on a blocked path. */
export function isBlockedNode(entity: EntitySummary): boolean {
  return (entity.badges.blocked?.unresolvedHardDependencyCount ?? 0) > 0;
}

/** True when an unresolved attention request is riding on this node. */
export function needsAttention(entity: EntitySummary): boolean {
  return entity.badges.attention !== undefined;
}

/** True when the server reports an actor actively working this node. */
export function hasWorkingActor(entity: EntitySummary): boolean {
  return (entity.badges.workingActors?.length ?? 0) > 0;
}

export function buildAdjacency(
  nodes: readonly EntitySummary[],
  edges: readonly EdgeView[],
): Map<string, string[]> {
  const known = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    const s = e.source.id;
    const t = e.target.id;
    if (s === t || !known.has(s) || !known.has(t)) continue;
    adj.get(s)!.push(t);
    adj.get(t)!.push(s);
  }
  return adj;
}

/**
 * Max-propagation of interest across the graph — the exact computation of
 * `APIdiff(x) = max(API(x), δ · max over neighbors)`, done as a Dijkstra-shaped
 * best-first relaxation rather than the paper's iterate-until-stable. Exact in
 * one pass because δ < 1 makes every propagated value strictly smaller than its
 * source, so the first time a node is popped its value is final.
 */
function diffuse(
  api: ReadonlyMap<string, number>,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const out = new Map(api);
  // Descending by value: a simple sorted frontier is fine at workspace scale
  // (hundreds of nodes), and it keeps the pass allocation-light and readable.
  const frontier = [...api.entries()].sort((a, b) => b[1] - a[1]);
  const settled = new Set<string>();
  while (frontier.length > 0) {
    const [id, value] = frontier.shift()!;
    if (settled.has(id)) continue;
    if ((out.get(id) ?? 0) > value) continue; // a better value arrived first
    settled.add(id);
    const spread = value * DIFFUSION;
    if (spread <= 0.01) continue; // below the noise floor — stop early
    for (const n of adjacency.get(id) ?? []) {
      if (settled.has(n)) continue;
      if ((out.get(n) ?? 0) >= spread) continue;
      out.set(n, spread);
      // Insert in descending order so the next shift() is still the maximum.
      const at = frontier.findIndex(([, v]) => v < spread);
      if (at === -1) frontier.push([n, spread]);
      else frontier.splice(at, 0, [n, spread]);
    }
  }
  return out;
}

/** Hop distance from `focusId` over the undirected adjacency. */
function hopsFrom(
  focusId: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  const dist = new Map<string, number>([[focusId, 0]]);
  let frontier = [focusId];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacency.get(id) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, depth);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

export function computeRelevance(input: RelevanceInput): Relevance {
  const { nodes, edges, liveIds, matchIds, pinnedIds, now } = input;
  const adjacency = buildAdjacency(nodes, edges);
  const degree = new Map<string, number>();
  for (const n of nodes) degree.set(n.id, (adjacency.get(n.id) ?? []).length);

  // A PRIORI INTEREST — the MAX of the honest signals, not their sum. Summing
  // would let a node accumulate importance out of three weak signals and
  // outrank a genuinely live one; the max keeps the ranking readable and keeps
  // "why is this on screen?" answerable with a single word.
  const api = new Map<string, number>();
  const protectedIds = new Set<string>();
  const mustDrawIds = new Set<string>();
  for (const n of nodes) {
    const signals: number[] = [];
    if (liveIds.has(n.id)) {
      signals.push(W_LIVE);
      protectedIds.add(n.id);
      mustDrawIds.add(n.id); // the node says it is running: always on canvas
    }
    if (isBlockedNode(n)) {
      signals.push(W_BLOCKED);
      protectedIds.add(n.id);
    }
    if (needsAttention(n)) {
      signals.push(W_ATTENTION);
      protectedIds.add(n.id);
    }
    if (hasWorkingActor(n)) {
      signals.push(W_WORKING_ACTOR);
      protectedIds.add(n.id);
    }
    if (matchIds.has(n.id)) {
      signals.push(W_SEARCH);
      protectedIds.add(n.id);
      mustDrawIds.add(n.id); // the user asked for it by name
    }
    if (pinnedIds.has(n.id)) {
      signals.push(W_LIVE);
      protectedIds.add(n.id);
      mustDrawIds.add(n.id); // the user is pointing at it right now
    }
    // A TOMBSTONE IS NEVER FOLDED. The canvas law is that a deleted entity
    // renders as a ghost and is never hidden — and folding a ghost onto a hub
    // badge IS hiding it, just with a number over the top. "This still points
    // at something deleted" is precisely what a reader needs to see, so a
    // tombstone is protected however leafy it has become. It gets no interest
    // BOOST from this, only immunity: the push below is deliberately absent.
    if (n.deletedAt !== null) protectedIds.add(n.id);
    const deg = degree.get(n.id) ?? 0;
    signals.push(Math.min(deg / HUB_SATURATION, 1) * W_HUB_MAX);
    signals.push(recencyWeight(n.activityAt, now));
    api.set(n.id, Math.max(...signals, 0));
  }

  const doi = diffuse(api, adjacency);

  // The distance term. Applied AFTER diffusion so it shapes the ranking around
  // the focus without erasing the intrinsic interest that put a node in play.
  if (input.focusId && adjacency.has(input.focusId)) {
    const dist = hopsFrom(input.focusId, adjacency);
    for (const [id, value] of doi) {
      const d = dist.get(id);
      // Unreachable from the focus: not part of this story at all.
      doi.set(id, d === undefined ? value - W_DISTANCE * 6 : value - W_DISTANCE * d);
    }
    doi.set(input.focusId, (doi.get(input.focusId) ?? 0) + 1);
    protectedIds.add(input.focusId);
    mustDrawIds.add(input.focusId);
  }

  return { api, doi, adjacency, degree, protectedIds, mustDrawIds };
}

// ---------------------------------------------------------------------------
// Folding — the single biggest reduction, and the one that costs no meaning.
// ---------------------------------------------------------------------------

export interface FoldedInto {
  /** The hub these nodes collapsed onto. */
  hubId: string;
  /** The folded entities themselves — the caller can list them on demand. */
  nodes: EntitySummary[];
  /** kind → count, so the hub badge can say WHAT it swallowed, not just how many. */
  byKind: Record<string, number>;
}

export interface FoldResult {
  /** hubId → what folded onto it. */
  groups: ReadonlyMap<string, FoldedInto>;
  /** Every id that folded — removed from the canvas, never from the totals. */
  foldedIds: ReadonlySet<string>;
}

/**
 * Fold every UNPROTECTED degree-1 node onto its single neighbor.
 *
 * A degree-1 node is, by construction, a leaf: it adds one card and one line to
 * the canvas and tells you nothing the hub does not already imply. On the
 * measured space that is 244 of 435 nodes. The hub keeps the count, so the
 * information is relocated, not lost.
 *
 * A protected node — live, blocked, flagged, worked, searched, focused,
 * selected — never folds however leafy it is. Interest beats topology.
 */
export function foldLeaves(
  nodes: readonly EntitySummary[],
  relevance: Pick<Relevance, 'adjacency' | 'degree' | 'protectedIds'>,
): FoldResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = new Map<string, FoldedInto>();
  const foldedIds = new Set<string>();

  for (const n of nodes) {
    if ((relevance.degree.get(n.id) ?? 0) !== 1) continue;
    if (relevance.protectedIds.has(n.id)) continue;
    const hubId = (relevance.adjacency.get(n.id) ?? [])[0];
    if (hubId === undefined || !byId.has(hubId)) continue;
    // Never fold a leaf onto another leaf: a two-node island would collapse to
    // a single card whose badge claims a hub that is not one. Both stay.
    if ((relevance.degree.get(hubId) ?? 0) <= 1) continue;
    let group = groups.get(hubId);
    if (!group) {
      group = { hubId, nodes: [], byKind: {} };
      groups.set(hubId, group);
    }
    group.nodes.push(n);
    group.byKind[n.kind] = (group.byKind[n.kind] ?? 0) + 1;
    foldedIds.add(n.id);
  }

  // Stable order inside each group so the expanded list never reshuffles.
  for (const group of groups.values()) {
    group.nodes.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  }
  return { groups, foldedIds };
}

// ---------------------------------------------------------------------------
// Seeding and selection.
// ---------------------------------------------------------------------------

/**
 * The ids a lens starts from. Seeds are a STARTING POINT, never a filter: the
 * greedy expansion below reaches outward from them, so the context that
 * explains a seed is drawn even though the lens never named it.
 */
export function seedsFor(
  lens: LensId,
  nodes: readonly EntitySummary[],
  liveIds: ReadonlySet<string>,
): Set<string> {
  const seeds = new Set<string>();
  if (lens === 'all') return seeds; // no seeds — rank the whole space instead
  for (const n of nodes) {
    // LIVE MEANS THE SNAPSHOT, AND ONLY THE SNAPSHOT. Not "someone is working
    // on it", not "it was touched a minute ago" — those are different facts and
    // conflating them is the forbidden inference (R-UI-5). Keeping this term
    // narrow is also what keeps the Live canvas small: on the measured space,
    // folding `workingActors` in here added 44 seeds and took Live from 45
    // nodes to 114, at which point it no longer meant "live".
    if (liveIds.has(n.id)) {
      seeds.add(n.id);
      continue;
    }
    if (lens !== 'working') continue;
    // Work with a person, an agent, a blocker or a flag on it. NOT recency:
    // on a busy space nearly everything is recent — 348 of 435 entities inside
    // a day on the measured workspace — so seeding on it collapses this lens
    // into `Everything` and it stops meaning anything. Recency still RANKS
    // (see `recencyWeight`); it just does not get to say what the lens is about.
    if (hasWorkingActor(n) || isBlockedNode(n) || needsAttention(n)) seeds.add(n.id);
  }
  return seeds;
}

export interface SelectionResult {
  /** Ids that earned a place on the canvas, in the order they were admitted. */
  selected: string[];
  /**
   * Ids inside the lens that lost to the RENDER BUDGET. Only these are honestly
   * described as "the canvas is full".
   */
  omitted: string[];
  /**
   * Ids the LENS never reached — outside its radius from any seed. A different
   * fact from `omitted` with a different remedy (widen the lens, not raise the
   * cap), and conflating the two made the banner blame the budget for exclusions
   * the budget never made: "15 of 18 not drawn — the canvas holds 150" while
   * only 3 nodes were placed.
   */
  outOfLens: string[];
  /**
   * True when a seeded lens found NO seeds at all — e.g. `Live` on a workspace
   * with nothing running. The caller must render an honest empty state; falling
   * back to scoping the whole space (what this used to do) renders every node in
   * the workspace and calls it Live, which is the opposite of the promise.
   */
  lensEmpty: boolean;
}

/**
 * Greedy maximal-interest connected expansion — van Ham & Perer §3.2. Starting
 * from the seed set, repeatedly admit the highest-DOI candidate and offer its
 * neighbors as new candidates, until the budget is spent.
 *
 * This is the fix for truncation-by-island-order: the budget is now spent on
 * the most interesting reachable nodes, so the thing you needed to see cannot
 * be cut merely for living in a small island.
 *
 * Protected ids are admitted FIRST and unconditionally — a live session is
 * never budgeted away.
 */
export function selectByInterest(
  candidateIds: readonly string[],
  seeds: ReadonlySet<string>,
  relevance: Pick<Relevance, 'doi' | 'adjacency' | 'mustDrawIds'>,
  budget: number,
  radius: number = Infinity,
): SelectionResult {
  const inPlay = new Set(candidateIds);
  const score = (id: string): number => relevance.doi.get(id) ?? 0;
  const selected: string[] = [];
  const admitted = new Set<string>();

  const admit = (id: string): void => {
    if (admitted.has(id)) return;
    admitted.add(id);
    selected.push(id);
  };

  // 1. Must-draw nodes are not negotiable — a live session, a search hit or the
  //    thing the user is pointing at is drawn whatever the lens and budget say.
  for (const id of candidateIds) {
    if (relevance.mustDrawIds.has(id)) admit(id);
  }

  // 2. THE LENS EXTENT. Everything within `radius` hops of a seed is in scope;
  //    beyond it is out of scope for this lens and reported as not-drawn. With
  //    no seeds (the 'all' lens) the whole candidate set is in scope, which
  //    degenerates to a pure ranking under the budget.
  //
  //    Radius is what gives a lens meaning. Ranking alone cannot: the budget is
  //    usually larger than the interesting subgraph, so a rank-and-fill lens
  //    draws the same ~150 nodes in a different order and "Live" stops meaning
  //    live. Bounding the extent is what makes the Live canvas actually small.
  // The top-N most interesting neighbors of `id` that are still in play — the
  // supernode guard. Everything past N is held back and reported, never
  // silently admitted and never silently dropped.
  const bestNeighbors = (id: string): string[] =>
    (relevance.adjacency.get(id) ?? [])
      .filter((n) => inPlay.has(n))
      .sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1))
      .slice(0, EXPANSION_FANOUT);

  // A SEEDED LENS THAT FOUND NOTHING SHOWS NOTHING. `Live` on a workspace with
  // no running session must say so, not quietly widen to the whole space and
  // label it Live. `all` has no seeds BY DESIGN, so it is not "empty" — it is
  // unseeded, and it scopes everything on purpose.
  const unseeded = radius === Infinity;
  const lensEmpty = !unseeded && seeds.size === 0;
  if (lensEmpty) {
    const mustDraw = [...admitted];
    return {
      selected: mustDraw,
      omitted: [],
      // Everything else is out of a lens that reached nothing — not truncated.
      outOfLens: candidateIds.filter((id) => !admitted.has(id)),
      lensEmpty: true,
    };
  }

  const scope = new Set<string>();
  if (unseeded) {
    for (const id of candidateIds) scope.add(id);
  } else {
    let frontier: string[] = [];
    for (const id of seeds) {
      if (!inPlay.has(id) || scope.has(id)) continue;
      scope.add(id);
      frontier.push(id);
    }
    for (let hop = 0; hop < radius && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const n of bestNeighbors(id)) {
          if (scope.has(n)) continue;
          scope.add(n);
          next.push(n);
        }
      }
      frontier = next;
    }
    // A protected node drags its immediate context in with it: showing a live
    // session as a lone card, severed from what it is working on, would be
    // technically in-lens and practically useless. Capped the same way.
    for (const id of admitted) {
      scope.add(id);
      for (const n of bestNeighbors(id)) scope.add(n);
    }
  }

  // 3. Spend the budget inside the scope, highest interest first.
  const ranked = [...scope]
    .filter((id) => !admitted.has(id))
    // Deterministic tiebreak so the same graph always lays out the same way.
    .sort((a, b) => score(b) - score(a) || (a < b ? -1 : 1));
  for (const id of ranked) {
    if (selected.length >= budget) break;
    admit(id);
  }

  // Split the two exclusion reasons. In-scope-but-unaffordable is a BUDGET
  // truncation; never-in-scope is a LENS exclusion. They read the same on a
  // count and mean opposite things to the reader, so they are reported apart.
  const omitted: string[] = [];
  const outOfLens: string[] = [];
  for (const id of candidateIds) {
    if (admitted.has(id)) continue;
    if (scope.has(id)) omitted.push(id);
    else outOfLens.push(id);
  }
  return { selected, omitted, outOfLens, lensEmpty: false };
}
