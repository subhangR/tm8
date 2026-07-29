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

const model = () =>
  buildGraphModel({
    nodes: graphFixtureNodes,
    edges: graphFixtureEdges,
    kindFilter: null,
    edgeTypeFilter: null,
    now: GRAPH_FIXTURE_NOW,
  });

describe('components and the shelf', () => {
  it('places every connected node and shelves every singleton — nothing vanishes', () => {
    const m = model();
    expect(m.placed.length + m.shelf.length).toBe(graphFixtureNodes.length);
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

  it('keeps frozen nodes at EXACTLY their positions even when an edge is added', () => {
    const base = model();
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
      frozen,
    });
    for (const p of m.placed) {
      expect({ x: p.x, y: p.y }).toEqual(frozen[p.entity.id]);
    }
    // Everyone was frozen — no arrivals.
    expect(m.pendingRelayout).toBe(0);
  });

  it('slots an arrival next to its frozen neighbor without overlapping any frozen rect', () => {
    const base = model();
    const frozen = freezeAll(base);
    const arrival: EntitySummary = { ...graphFixtureNodes[0], id: 'arrival-1', title: 'the newcomer' };
    const arrivalEdge = { ...graphFixtureEdges[0], id: 'ge-arrival', source: arrival, target: taskUuidTitle };
    const m = buildGraphModel({
      nodes: [...graphFixtureNodes, arrival],
      edges: [...graphFixtureEdges, arrivalEdge],
      kindFilter: null,
      edgeTypeFilter: null,
      now: GRAPH_FIXTURE_NOW,
      frozen,
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
    });
    expect(m.placed.length).toBeLessThanOrEqual(RENDER_CAP);
    expect(m.truncated).toBe(big.length - m.placed.length - m.shelf.length);
    expect(m.truncated).toBeGreaterThan(0);
  });
});
