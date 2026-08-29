/**
 * Graph relevance — the scoring, folding and selection laws. Pure, DOM-free.
 *
 * These tests encode the promises the canvas makes about what it shows and what
 * it declines to show. The load-bearing ones are the HONESTY laws: nothing is
 * ever dropped without being counted, and a node the user has reason to care
 * about is never folded away or budgeted out, however unremarkable its shape.
 */
import { describe, expect, it } from 'vitest';
import type { EdgeView, EntitySummary } from '@tm8/contract';
import {
  computeRelevance,
  foldLeaves,
  seedsFor,
  selectByInterest,
  type LensId,
} from './relevance';
import { buildGraphModel } from './model';

const NOW = '2026-08-02T12:00:00.000Z';
const EMPTY: ReadonlySet<string> = new Set();

let seq = 0;
function node(over: Partial<EntitySummary> = {}): EntitySummary {
  seq += 1;
  return {
    id: over.id ?? `n${seq}`,
    spaceId: 'space-1',
    kind: 'task',
    title: over.title ?? `node ${seq}`,
    parentId: null,
    position: seq,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'a1', displayName: 'A', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'task', status: 'open', priority: 'medium', axes: {}, assignees: [],
             acceptance: { total: 0, completed: 0 } },
    badges: {},
    ...over,
  } as EntitySummary;
}

function edge(source: EntitySummary, target: EntitySummary, type = 'relates_to'): EdgeView {
  seq += 1;
  return {
    id: `e${seq}`,
    type,
    source,
    target,
    props: {},
    createdBy: { id: 'a1', displayName: 'A', isAgent: false },
    createdAt: NOW,
    updatedAt: NOW,
  } as EdgeView;
}

const relevanceOf = (
  nodes: EntitySummary[],
  edges: EdgeView[],
  over: Partial<Parameters<typeof computeRelevance>[0]> = {},
) =>
  computeRelevance({
    nodes, edges, liveIds: EMPTY, matchIds: EMPTY, pinnedIds: EMPTY, now: NOW, ...over,
  });

// ---------------------------------------------------------------------------

/**
 * A three-node ring: every member has degree 2, so the CORE is structural and
 * nothing in it folds. Leaves hung off `hub` are then the only foldable things,
 * which is what each test below is actually about. (A plain hub-and-one-spoke
 * core does not work: the spoke is itself degree-1 and folds, correctly.)
 */
function ring(): { hub: EntitySummary; core: EntitySummary[]; edges: EdgeView[] } {
  const hub = node({ id: 'hub' });
  const b = node({ id: 'core-b' });
  const c = node({ id: 'core-c' });
  return { hub, core: [hub, b, c], edges: [edge(hub, b), edge(b, c), edge(c, hub)] };
}

describe('folding leaves onto their hub', () => {
  it('folds a degree-1 leaf and records it on the hub, with its kind', () => {
    const { hub, core, edges: coreEdges } = ring();
    const leaf = node({ id: 'leaf', kind: 'message' });
    const nodes = [...core, leaf];
    const edges = [...coreEdges, edge(hub, leaf)];

    const r = relevanceOf(nodes, edges);
    const folds = foldLeaves(nodes, r);

    expect([...folds.foldedIds]).toEqual(['leaf']);
    expect(folds.groups.get('hub')!.byKind).toEqual({ message: 1 });
    expect(folds.groups.get('hub')!.nodes.map((n) => n.id)).toEqual(['leaf']);
  });

  it('NEVER folds a live, blocked, flagged, worked, searched or pinned leaf', () => {
    const { hub, core, edges: coreEdges } = ring();
    const live = node({ id: 'live' });
    const blocked = node({
      id: 'blocked',
      badges: { blocked: { unresolvedHardDependencyCount: 1, waitingOn: [] } },
    });
    const flagged = node({
      id: 'flagged',
      badges: { attention: { count: 1, points: 10 } as never },
    });
    const worked = node({ id: 'worked', badges: { workingActors: [{}] as never } });
    const hit = node({ id: 'hit' });
    const pinned = node({ id: 'pinned' });
    const dull = node({ id: 'dull' });

    const leaves = [live, blocked, flagged, worked, hit, pinned, dull];
    const nodes = [...core, ...leaves];
    const edges = [...coreEdges, ...leaves.map((l) => edge(hub, l))];

    const r = relevanceOf(nodes, edges, {
      liveIds: new Set(['live']),
      matchIds: new Set(['hit']),
      pinnedIds: new Set(['pinned']),
    });
    const folds = foldLeaves(nodes, r);

    // Only the one with no reason to be interesting folded.
    expect([...folds.foldedIds]).toEqual(['dull']);
  });

  it('never folds a tombstone — a ghost hidden behind a badge is still hidden', () => {
    const { hub, core, edges: coreEdges } = ring();
    const ghost = node({ id: 'ghost', deletedAt: '2026-08-01T10:00:00.000Z' });
    const nodes = [...core, ghost];
    const edges = [...coreEdges, edge(hub, ghost)];

    const folds = foldLeaves(nodes, relevanceOf(nodes, edges));
    expect(folds.foldedIds.has('ghost')).toBe(false);
  });

  it('never folds a leaf onto another leaf — a 2-node island keeps both cards', () => {
    const a = node({ id: 'a' });
    const b = node({ id: 'b' });
    const nodes = [a, b];
    const edges = [edge(a, b)];

    const folds = foldLeaves(nodes, relevanceOf(nodes, edges));
    expect(folds.foldedIds.size).toBe(0);
  });
});

describe('interest diffusion', () => {
  it('lifts a dull node that sits on the path to a live one', () => {
    // Two identical chains — same shape, same degrees, so the same a priori
    // interest. The ONLY difference is that one end of the first chain is live.
    const live = node({ id: 'live' });
    const bridge = node({ id: 'bridge' });
    const far = node({ id: 'far' });
    const ctrlEnd = node({ id: 'ctrl-end' });
    const ctrl = node({ id: 'ctrl' });
    const ctrlFar = node({ id: 'ctrl-far' });
    const nodes = [live, bridge, far, ctrlEnd, ctrl, ctrlFar];
    const edges = [
      edge(live, bridge), edge(bridge, far),
      edge(ctrlEnd, ctrl), edge(ctrl, ctrlFar),
    ];

    const r = relevanceOf(nodes, edges, { liveIds: new Set(['live']) });

    // Raw interest cannot tell the two middles apart — identical topology.
    expect(r.api.get('bridge')).toBe(r.api.get('ctrl'));
    // After diffusion, the one next to the live node is worth drawing and its
    // twin is not: this is what stops a DOI threshold from shattering the graph.
    expect(r.doi.get('bridge')!).toBeGreaterThan(r.doi.get('ctrl')!);
    // And interest decays with distance, so `far` ranks below `bridge`.
    expect(r.doi.get('bridge')!).toBeGreaterThan(r.doi.get('far')!);
    expect(r.doi.get('far')!).toBeGreaterThan(r.doi.get('ctrl-far')!);
  });
});

describe('lens seeding', () => {
  const live = node({ id: 'live' });
  const blocked = node({
    id: 'blocked',
    badges: { blocked: { unresolvedHardDependencyCount: 1, waitingOn: [] } },
  });
  const recent = node({ id: 'recent', activityAt: '2026-08-02T11:45:00.000Z' });
  const old = node({ id: 'old', activityAt: '2026-07-01T00:00:00.000Z' });
  const nodes = [live, blocked, recent, old];
  const liveIds = new Set(['live']);

  const seeds = (lens: LensId) => [...seedsFor(lens, nodes, liveIds)].sort();

  it('the live lens seeds only on the liveness snapshot, never on recency', () => {
    expect(seeds('live')).toEqual(['live']);
  });

  it('the active-work lens adds blocked, flagged and worked-on — but NOT recency', () => {
    // Recency is a ranking signal, not a lens definition. On a busy space
    // nearly everything is recent, so seeding on it collapses this lens into
    // `Everything`; `recent` and `old` are therefore both absent here.
    expect(seeds('working')).toEqual(['blocked', 'live']);
  });

  it('the everything lens seeds nothing — it ranks the whole space instead', () => {
    expect(seeds('all')).toEqual([]);
  });
});

describe('selection under a budget', () => {
  it('admits protected nodes first — a live session is never budgeted away', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => node({ id: `n-${i}` }));
    const edges = nodes.slice(1).map((n) => edge(nodes[0], n));
    // The live node is the LAST one — pure ranking by degree would drop it.
    const liveIds = new Set(['n-19']);
    const r = relevanceOf(nodes, edges, { liveIds });

    const sel = selectByInterest(nodes.map((n) => n.id), new Set(liveIds), r, 3);
    expect(sel.selected).toContain('n-19');
    expect(sel.selected.length).toBe(3);
    expect(sel.omitted.length).toBe(17);
  });

  it('a lens REORDERS; it hides only when the budget actually binds', () => {
    // Two disconnected islands, seeds touching only the first. With budget to
    // spare, the second island must still be drawn — a lens is a priority, not
    // a filter, and hiding a reachable island under an unspent budget would be
    // hiding without a reason.
    const a1 = node({ id: 'a1' });
    const a2 = node({ id: 'a2' });
    const b1 = node({ id: 'b1' });
    const b2 = node({ id: 'b2' });
    const nodes = [a1, a2, b1, b2];
    const edges = [edge(a1, a2), edge(b1, b2)];
    const r = relevanceOf(nodes, edges, { liveIds: new Set(['a1']) });

    const roomy = selectByInterest(nodes.map((n) => n.id), new Set(['a1']), r, 10);
    expect(roomy.selected.sort()).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(roomy.omitted).toEqual([]);

    // Squeeze the budget and the seeded island wins the space.
    const tight = selectByInterest(nodes.map((n) => n.id), new Set(['a1']), r, 2);
    expect(tight.selected).toContain('a1');
    expect(tight.omitted.length + tight.outOfLens.length).toBe(2);
  });

  it('reports budget cuts and lens exclusions SEPARATELY, never as one number', () => {
    // Six disjoint triangles; one live node in the first. A radius-1 lens reaches
    // only that triangle, and the budget is never approached — so every exclusion
    // here is a LENS exclusion and the truncation count must be zero. Conflating
    // them made the banner read "15 of 18 not drawn — the canvas holds 150" while
    // only 3 nodes were placed, blaming a cap that was never reached.
    const ns: EntitySummary[] = [];
    const es: EdgeView[] = [];
    for (let c = 0; c < 6; c += 1) {
      const a = node({ id: `c${c}-a` });
      const b = node({ id: `c${c}-b` });
      const d = node({ id: `c${c}-c` });
      ns.push(a, b, d);
      es.push(edge(a, b), edge(b, d), edge(d, a));
    }
    const m = buildGraphModel({
      nodes: ns, edges: es, kindFilter: null, edgeTypeFilter: null, now: NOW,
      lens: 'live', liveIds: new Set(['c0-a']),
    });

    expect(m.placed.length).toBe(3);          // the live triangle
    expect(m.outOfLens).toBe(15);             // the other five, out of lens
    expect(m.truncated).toBe(0);              // the 150 cap was never in play
    expect(m.placed.length + m.shelf.length + m.foldedCount + m.truncated + m.outOfLens)
      .toBe(m.visibleTotal);
  });

  it('a seeded lens with NO seeds shows nothing and says so — never the whole space', () => {
    // `Live` on a workspace with nothing running. This used to fall back to
    // scoping the entire space, so the canvas drew every node and labelled it
    // Live — the exact opposite of what the lens promises.
    const ns: EntitySummary[] = [];
    const es: EdgeView[] = [];
    for (let c = 0; c < 4; c += 1) {
      const a = node({ id: `q${c}-a` });
      const b = node({ id: `q${c}-b` });
      const d = node({ id: `q${c}-c` });
      ns.push(a, b, d);
      es.push(edge(a, b), edge(b, d), edge(d, a));
    }
    const live = buildGraphModel({
      nodes: ns, edges: es, kindFilter: null, edgeTypeFilter: null, now: NOW,
      lens: 'live', liveIds: new Set(),
    });
    const all = buildGraphModel({
      nodes: ns, edges: es, kindFilter: null, edgeTypeFilter: null, now: NOW,
      lens: 'all', liveIds: new Set(),
    });

    expect(live.lensEmpty).toBe(true);
    expect(live.placed.length).toBe(0);
    expect(live.outOfLens).toBe(ns.length);
    expect(live.truncated).toBe(0);
    // The whole point: Live must NOT look like Everything.
    expect(all.lensEmpty).toBe(false);
    expect(all.placed.length).toBe(ns.length);
    expect(live.placed.length).not.toBe(all.placed.length);
  });
});

describe('the model’s accounting law', () => {
  it('places, shelves, folds or truncates every node — and says so in the totals', () => {
    const { hub, core, edges: coreEdges } = ring();
    const leaves = Array.from({ length: 12 }, (_, i) => node({ id: `leaf-${i}`, kind: 'message' }));
    const loose = node({ id: 'loose' });
    const nodes = [...core, ...leaves, loose];
    const edges = [...coreEdges, ...leaves.map((l) => edge(hub, l))];

    const m = buildGraphModel({
      nodes, edges, kindFilter: null, edgeTypeFilter: null, now: NOW, lens: 'all',
    });

    expect(m.visibleTotal).toBe(nodes.length);
    expect(
      m.placed.length + m.shelf.length + m.foldedCount + m.truncated + m.outOfLens,
    ).toBe(nodes.length);
    // The twelve message leaves collapsed onto the hub, which now says so.
    expect(m.foldedCount).toBe(12);
    const placedHub = m.placed.find((p) => p.entity.id === 'hub')!;
    expect(placedHub.folded!.nodes.length).toBe(12);
    expect(placedHub.folded!.byKind).toEqual({ message: 12 });
    // The unconnected node still shelves rather than vanishing.
    expect(m.shelf.map((s) => s.id)).toEqual(['loose']);
  });
});
