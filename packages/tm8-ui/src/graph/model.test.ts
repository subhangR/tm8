/**
 * Graph model — the pure pipeline: components, shelf, blocked path, heat,
 * per-filter partitioning, and the honest cap. DOM-free by design.
 */
import { describe, expect, it } from 'vitest';
import type { EdgeView, EntitySummary } from '@tm8/contract';
import {
  GRAPH_FIXTURE_NOW,
  graphFixtureEdges,
  graphFixtureNodes,
  spellDeploy,
  taskBlocked,
  taskUuidTitle,
} from '../fixtures';
import {
  NODE_H,
  NODE_W,
  RENDER_CAP,
  buildGraphModel,
  edgeLabel,
  focusSubgraph,
  heatOf,
  searchMatches,
} from './model';

/**
 * The whole-graph baseline. Pinned to the `all` lens on purpose: everything in
 * this file asserts properties of the FULL partition — components, the shelf,
 * blocked paths, ghosts, layout geometry — which are only well-defined when the
 * canvas is showing the whole space. Lens behavior (which subgraph a lens picks
 * and why) is relevance.test.ts's job.
 */
const model = () =>
  buildGraphModel({
    nodes: graphFixtureNodes,
    edges: graphFixtureEdges,
    kindFilter: null,
    edgeTypeFilter: null,
    now: GRAPH_FIXTURE_NOW,
    lens: 'all',
  });

describe('components and the shelf', () => {
  it('accounts for every node — placed, shelved, folded or truncated, nothing vanishes', () => {
    const m = model();
    // THE ACCOUNTING LAW. Folding relocates leaves onto their hub's badge, so
    // the old `placed + shelf === total` no longer holds — but nothing may go
    // missing, and every node must still be findable in exactly one bucket.
    expect(
      m.placed.length + m.shelf.length + m.foldedCount + m.truncated + m.outOfLens,
    ).toBe(graphFixtureNodes.length);
    expect(m.visibleTotal).toBe(graphFixtureNodes.length);
    expect(m.truncated).toBe(0);
    // The deliberate singletons land on the shelf.
    expect(m.shelf.map((s) => s.id)).toContain(spellDeploy.id);
    // A connected node never shelves.
    expect(m.shelf.map((s) => s.id)).not.toContain(taskBlocked.id);
  });

  it('assigns one componentId per island and never overlaps node positions', () => {
    const m = model();
    const seen = new Set<string>();
    for (const p of m.placed) {
      const key = `${p.x},${p.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(m.componentCount).toBeGreaterThanOrEqual(1);
  });

  it('partitions PER FILTER: hiding an edge type can split or shelve nodes', () => {
    const only = new Set(['depends_on']);
    const m = buildGraphModel({
      nodes: graphFixtureNodes,
      edges: graphFixtureEdges,
      kindFilter: null,
      edgeTypeFilter: only,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
    });
    // Only dependency endpoints stay on canvas; everything else shelves.
    for (const p of m.placed) {
      expect(
        graphFixtureEdges.some(
          (e) => e.type === 'depends_on' && (e.source.id === p.entity.id || e.target.id === p.entity.id),
        ),
      ).toBe(true);
    }
    expect(m.shelf.length).toBeGreaterThan(model().shelf.length);
  });
});

describe('the blocked path and edge labels', () => {
  it('marks the unresolved-hard dependency edge AND both endpoints, with the word', () => {
    const m = model();
    const blockedEdge = m.edges.find((e) => e.blocked);
    expect(blockedEdge).toBeDefined();
    expect(blockedEdge!.label).toContain('blocked');
    const byId = new Map(m.placed.map((p) => [p.entity.id, p]));
    expect(byId.get(taskBlocked.id)!.onBlockedPath).toBe(true);
    expect(byId.get(taskUuidTitle.id)!.onBlockedPath).toBe(true);
  });

  it('labels a soft dependency · soft, never blocked', () => {
    const soft = graphFixtureEdges.find((e) => e.id === 'ge-dep-soft')!;
    expect(edgeLabel(soft)).toBe('depends on · soft');
    const m = model();
    expect(m.edges.find((e) => e.id === 'ge-dep-soft')!.blocked).toBe(false);
  });
});

describe('heat and ghosts', () => {
  it('buckets recency honestly against the given clock', () => {
    expect(heatOf('2026-07-28T11:59:00.000Z', GRAPH_FIXTURE_NOW)).toBe('fresh');
    expect(heatOf('2026-07-28T11:20:00.000Z', GRAPH_FIXTURE_NOW)).toBe('warm');
    expect(heatOf('2026-07-20T09:00:00.000Z', GRAPH_FIXTURE_NOW)).toBe('rest');
  });

  it('renders a tombstone as a ghost, never hides it', () => {
    const m = model();
    const ghost = m.placed.find((p) => p.entity.deletedAt !== null);
    expect(ghost).toBeDefined();
    expect(ghost!.ghost).toBe(true);
  });
});

describe('layout stability (frozen positions)', () => {
  const rectsOverlap = (
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): boolean =>
    a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H;

  const freezeAll = (m: ReturnType<typeof model>): Record<string, { x: number; y: number }> =>
    Object.fromEntries(m.placed.map((p) => [p.entity.id, { x: p.x, y: p.y }]));

  /**
   * The stability spine is about GEOMETRY: frozen rects hold, arrivals slot in
   * beside them. Folding changes WHICH nodes get placed at all, so a folded
   * baseline frozen against an unfolded model would report every unfolded leaf
   * as an "arrival" and measure nothing. Both halves of each test below share
   * this unfolded baseline so the only new node is the one the test adds.
   */
  const unfolded = () =>
    buildGraphModel({
      nodes: graphFixtureNodes,
      edges: graphFixtureEdges,
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
      fold: false,
    });

  it('keeps frozen nodes at EXACTLY their positions even when an edge is added', () => {
    const base = unfolded();
    const frozen = freezeAll(base);
    // A brand-new edge between two already-placed nodes — the partition may
    // shift, but nothing frozen is allowed to move.
    const extraEdge = { ...graphFixtureEdges[0], id: 'ge-extra', source: taskBlocked, target: taskUuidTitle };
    const m = buildGraphModel({
      nodes: graphFixtureNodes,
      edges: [...graphFixtureEdges, extraEdge],
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
      frozen,
      fold: false, // matches the unfolded baseline — see `unfolded` above
    });
    for (const p of m.placed) {
      expect({ x: p.x, y: p.y }).toEqual(frozen[p.entity.id]);
    }
    // Everyone was frozen — no arrivals.
    expect(m.pendingRelayout).toBe(0);
  });

  it('slots an arrival next to its frozen neighbor without overlapping any frozen rect', () => {
    const base = unfolded();
    const frozen = freezeAll(base);
    const arrival: EntitySummary = { ...graphFixtureNodes[0], id: 'arrival-1', title: 'the newcomer' };
    const arrivalEdge = { ...graphFixtureEdges[0], id: 'ge-arrival', source: arrival, target: taskUuidTitle };
    const m = buildGraphModel({
      nodes: [...graphFixtureNodes, arrival],
      edges: [...graphFixtureEdges, arrivalEdge],
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
      frozen,
      // What is under test here is the STABILITY SPINE — frozen rects hold and
      // an arrival slots in beside its neighbor. The arrival has exactly one
      // edge, so with folding on it would legitimately collapse onto its hub
      // and never be placed at all; that is folding policy, covered by its own
      // tests below. Held off here so this asserts only the geometry it names.
      fold: false,
    });
    // Exactly one node was positioned heuristically.
    expect(m.pendingRelayout).toBe(1);
    const placedArrival = m.placed.find((p) => p.entity.id === 'arrival-1');
    expect(placedArrival).toBeDefined();
    // Frozen nodes never moved.
    for (const p of m.placed) {
      if (frozen[p.entity.id]) expect({ x: p.x, y: p.y }).toEqual(frozen[p.entity.id]);
    }
    // The arrival's rect clears every frozen rect.
    for (const p of m.placed) {
      if (p.entity.id === 'arrival-1') continue;
      expect(rectsOverlap(placedArrival!, p)).toBe(false);
    }
  });

  it('resets pendingRelayout to 0 on a full re-layout (no frozen)', () => {
    expect(model().pendingRelayout).toBe(0);
  });
});

describe('focus and search helpers', () => {
  const chainNodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const chainEdges = [
    { sourceId: 'a', targetId: 'b' },
    { sourceId: 'b', targetId: 'c' },
    { sourceId: 'c', targetId: 'd' },
  ];

  it('walks undirected n hops from the focus (PlacedEdge shape)', () => {
    expect([...focusSubgraph(chainNodes, chainEdges, 'b', 1)].sort()).toEqual(['a', 'b', 'c']);
    expect([...focusSubgraph(chainNodes, chainEdges, 'b', 2)].sort()).toEqual(['a', 'b', 'c', 'd']);
    // 0 hops is just the focus itself.
    expect([...focusSubgraph(chainNodes, chainEdges, 'b', 0)]).toEqual(['b']);
  });

  it('accepts EdgeView-shaped edges and never throws on an unknown focusId', () => {
    const one = focusSubgraph(graphFixtureNodes, graphFixtureEdges, taskUuidTitle.id, 1);
    // taskBlocked → taskUuidTitle is a hard depends_on edge.
    expect(one.has(taskBlocked.id)).toBe(true);
    const lonely = focusSubgraph(graphFixtureNodes, graphFixtureEdges, 'nope-not-here', 3);
    expect([...lonely]).toEqual(['nope-not-here']);
  });

  it('matches titles and kinds, case-insensitively; empty query matches nothing', () => {
    expect(searchMatches(graphFixtureNodes, '').size).toBe(0);
    expect(searchMatches(graphFixtureNodes, '   ').size).toBe(0);
    // Title substring, wrong case.
    expect(searchMatches(graphFixtureNodes, 'WIRE PALETTE').has(taskBlocked.id)).toBe(true);
    // Kind match pulls in every task.
    const tasks = searchMatches(graphFixtureNodes, 'TASK');
    expect(tasks.has(taskBlocked.id)).toBe(true);
    expect(tasks.has(taskUuidTitle.id)).toBe(true);
  });
});

describe('the time window', () => {
  const windowed = (windowMs: number | null, extra: Partial<Parameters<typeof buildGraphModel>[0]> = {}) =>
    buildGraphModel({
      nodes: graphFixtureNodes,
      edges: graphFixtureEdges,
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
      windowMs,
      ...extra,
    });

  it('defaults to no window, so omitting it changes nothing', () => {
    expect(windowed(null).outOfWindow).toBe(0);
    expect(windowed(null).placed.length).toBe(model().placed.length);
  });

  it('excludes entities older than the window and says how many', () => {
    // The fixture clock is 12:00; `old` is 17.5h back and `morning` 2h45m back.
    const hour = windowed(60 * 60_000);
    expect(hour.outOfWindow).toBeGreaterThan(0);
    const day = windowed(24 * 60 * 60_000);
    // A wider window can never exclude more than a narrower one.
    expect(day.outOfWindow).toBeLessThan(hour.outOfWindow);
    expect(day.outOfWindow).toBe(0);
    for (const p of hour.placed) {
      expect(Date.parse(GRAPH_FIXTURE_NOW) - Date.parse(p.entity.activityAt)).toBeLessThanOrEqual(
        60 * 60_000,
      );
    }
  });

  it('keeps the accounting law with a window in play', () => {
    const m = windowed(60 * 60_000);
    expect(
      m.placed.length + m.shelf.length + m.foldedCount + m.truncated + m.outOfLens + m.outOfWindow,
    ).toBe(graphFixtureNodes.length);
    expect(m.visibleTotal).toBe(graphFixtureNodes.length);
  });

  it('never lets the window hide what the user is pointing at', () => {
    // `spellDeploy` is old enough to fall out of a one-hour window...
    const stale = graphFixtureNodes.find(
      (n) => Date.parse(GRAPH_FIXTURE_NOW) - Date.parse(n.activityAt) > 60 * 60_000,
    )!;
    const base = windowed(60 * 60_000);
    const drawn = (m: ReturnType<typeof windowed>): boolean =>
      m.placed.some((p) => p.entity.id === stale.id) || m.shelf.some((s) => s.id === stale.id);
    expect(drawn(base)).toBe(false);
    // ...but a search hit, a pin or the liveness snapshot outranks the window.
    for (const key of ['matchIds', 'pinnedIds', 'liveIds'] as const) {
      const m = windowed(60 * 60_000, { [key]: new Set([stale.id]) });
      expect(drawn(m)).toBe(true);
      expect(m.outOfWindow).toBe(base.outOfWindow - 1);
    }
  });
});

describe('hubs bridge clusters instead of welding them', () => {
  /** Two independent 3-chains, both hanging off one node of degree 17. */
  const starred = (
    hubStop: boolean,
    extra: Partial<Parameters<typeof buildGraphModel>[0]> = {},
  ) => {
    const proto = graphFixtureNodes[0];
    const node = (id: string): EntitySummary => ({ ...proto, id, title: id });
    const hub = node('hub');
    const nodes = [hub];
    const edges: EdgeView[] = [];
    const link = (a: EntitySummary, b: EntitySummary): void => {
      edges.push({ ...graphFixtureEdges[0], id: `e-${a.id}-${b.id}`, source: a, target: b });
    };
    for (const chain of ['a', 'b']) {
      const c = [node(`${chain}1`), node(`${chain}2`), node(`${chain}3`)];
      nodes.push(...c);
      link(c[0], c[1]);
      link(c[1], c[2]);
      link(hub, c[1]);
    }
    // Filler so the hub's degree clears HUB_DEGREE (2 chains + 15 = 17).
    for (let i = 0; i < 15; i += 1) {
      const f = node(`f${i}`);
      nodes.push(f);
      link(hub, f);
    }
    return buildGraphModel({
      nodes,
      edges,
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      lens: 'all',
      fold: false,
      hubStop,
      ...extra,
    });
  };

  it('splits the chains apart when hub-stopping is on, and fuses them when off', () => {
    const clustered = starred(true);
    const fused = starred(false);
    // Same nodes drawn either way — this rule changes the PARTITION, not the
    // membership. Nothing is hidden by it.
    expect(clustered.placed.length).toBe(fused.placed.length);
    expect(fused.componentCount).toBe(1);
    expect(clustered.componentCount).toBeGreaterThan(1);
    const componentOf = (id: string): number =>
      clustered.placed.find((p) => p.entity.id === id)!.componentId;
    expect(componentOf('a1')).toBe(componentOf('a3'));
    expect(componentOf('a1')).not.toBe(componentOf('b1'));
  });

  it('draws the hub, names its degree, and never shelves it', () => {
    const m = starred(true);
    const hub = m.placed.find((p) => p.entity.id === 'hub')!;
    expect(hub.hub).toBe(true);
    expect(hub.degree).toBe(17);
    expect(m.hubCount).toBe(1);
    expect(m.shelf.map((s) => s.id)).not.toContain('hub');
    // The hub's edges are still drawn — the clusters are visibly linked, they
    // are simply not claimed to be the same thread.
    expect(m.edges.filter((e) => e.sourceId === 'hub' || e.targetId === 'hub').length).toBe(17);
    // And it sits WITH a cluster rather than alone.
    expect(m.placed.filter((p) => p.componentId === hub.componentId).length).toBeGreaterThan(1);
  });

  it('leaves ordinary nodes unflagged', () => {
    for (const p of starred(true).placed) {
      if (p.entity.id !== 'hub') expect(p.hub).toBe(false);
    }
  });

  /**
   * Degree cannot tell a SHARED CONNECTOR from a BUSY THING THE VIEWER ASKED
   * FOR. Both have high degree; demoting the second one re-parents it into an
   * arbitrary neighbor's island and the canvas loses the entity the question
   * was about. The naming sets are the discriminator the rule needs.
   */
  it('never demotes the entity the viewer named, however high its degree', () => {
    for (const named of [
      { focusId: 'hub' },
      { matchIds: new Set(['hub']) },
      { pinnedIds: new Set(['hub']) },
    ]) {
      const m = starred(true, named);
      const hub = m.placed.find((p) => p.entity.id === 'hub')!;
      expect(hub.hub).toBe(false);
      expect(hub.degree).toBe(17);
      expect(m.hubCount).toBe(0);
      // It anchors rather than being attached to someone else's thread: with
      // the welder re-enabled, everything it touches is one island again.
      expect(m.componentCount).toBe(1);
    }
  });

  /** ...and an unnamed connector of the same degree still stops clustering. */
  it('still hub-stops an intermediary the viewer did not name', () => {
    const m = starred(true, { focusId: 'a1' });
    expect(m.placed.find((p) => p.entity.id === 'hub')!.hub).toBe(true);
    expect(m.componentCount).toBeGreaterThan(1);
  });
});

describe('the honest cap', () => {
  it('truncates whole islands past RENDER_CAP and REPORTS the count', () => {
    const big: EntitySummary[] = [];
    const edges: EdgeView[] = [];
    const proto = graphFixtureNodes[0];
    for (let i = 0; i < RENDER_CAP + 40; i += 1) {
      big.push({ ...proto, id: `n-${i}`, title: `node ${i}` });
    }
    // Chain pairs so every node is connected (75+20 two-node islands).
    for (let i = 0; i + 1 < big.length; i += 2) {
      edges.push({
        ...graphFixtureEdges[0],
        id: `e-${i}`,
        source: big[i],
        target: big[i + 1],
      });
    }
    const m = buildGraphModel({
      nodes: big,
      edges,
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      // `all` so the RENDER BUDGET is what binds — this test is about the cap.
      // Under a seeded lens these islands would be excluded by RADIUS instead,
      // which is a different count with a different meaning (see `outOfLens`).
      lens: 'all',
    });
    expect(m.placed.length).toBeLessThanOrEqual(RENDER_CAP);
    expect(m.truncated).toBe(big.length - m.placed.length - m.shelf.length - m.outOfLens);
    expect(m.truncated).toBeGreaterThan(0);
    // The cap did the cutting, not the lens: nothing here is out-of-lens.
    expect(m.outOfLens).toBe(0);
  });
});
