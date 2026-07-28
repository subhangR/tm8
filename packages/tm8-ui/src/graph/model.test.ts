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
import { RENDER_CAP, buildGraphModel, edgeLabel, heatOf } from './model';

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
