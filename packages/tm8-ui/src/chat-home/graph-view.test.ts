// @vitest-environment jsdom
/**
 * GRAPH VIEW — the headless filter layer (plan 01a0094b step 1), asserted
 * over the MEASURED fixture: node filters drop incident lines, edge-type
 * filters only strip relations (isolating, never deleting, their endpoints),
 * search highlights without removing, and facets count the WHOLE fold so an
 * undrawn seed is never silently missing from a count.
 */
import { describe, expect, it } from 'vitest';
import type { GraphSeedFold } from './graph-seeds';
import { buildInducedGraph, type GraphSeed } from './induced-graph';
import {
  C1,
  M1,
  M2,
  S4,
  T1,
  T2,
  T3,
  measuredConnections,
  measuredSeeds,
} from './induced-graph.fixture';
import {
  anyGraphFilterActive,
  applyGraphFilters,
  emptyGraphFilters,
  graphFacets,
  type GraphFilterState,
} from './graph-view';

const measuredGraph = () => buildInducedGraph(measuredSeeds(), measuredConnections());
const filters = (partial: Partial<GraphFilterState>): GraphFilterState => ({
  ...emptyGraphFilters(),
  ...partial,
});

describe('applyGraphFilters', () => {
  it('the empty filter is the identity — nothing hidden, nothing matched', () => {
    const graph = measuredGraph();
    const out = applyGraphFilters(graph, emptyGraphFilters());
    expect(out.graph.nodes).toEqual(graph.nodes);
    expect(out.graph.edges).toEqual(graph.edges);
    expect(out.graph.relationCount).toBe(14);
    expect(out.hiddenNodes).toBe(0);
    expect(out.hiddenEdges).toBe(0);
    expect(out.matches.size).toBe(0);
    expect(anyGraphFilterActive(emptyGraphFilters())).toBe(false);
  });

  it('a KIND filter drops nodes AND their incident lines', () => {
    const out = applyGraphFilters(measuredGraph(), filters({ kinds: new Set(['task']) }));
    expect(out.graph.nodes.map((n) => n.id)).toEqual([T1, T2, T3]);
    // Every measured line pairs a task with a session or teammate — all gone.
    expect(out.graph.edges).toHaveLength(0);
    expect(out.hiddenNodes).toBe(7);
    expect(out.hiddenEdges).toBe(14);
    // Their reads succeeded and nothing links them IN THIS VIEW: isolated.
    expect(out.graph.isolatedCount).toBe(3);
  });

  it('two kinds keep the lines BETWEEN them', () => {
    const out = applyGraphFilters(
      measuredGraph(),
      filters({ kinds: new Set(['task', 'team_member']) }),
    );
    expect(out.graph.nodes).toHaveLength(5);
    // assigned_to ×3, participates_in(member→task) ×3, relates_to(T2↔M2) ×1.
    expect(out.graph.relationCount).toBe(7);
    expect(out.hiddenEdges).toBe(7);
  });

  it('an EDGE-TYPE filter strips relations only, and the stranded become isolated', () => {
    const out = applyGraphFilters(measuredGraph(), filters({ edgeTypes: new Set(['working_on']) }));
    // No node is removed by an edge filter.
    expect(out.graph.nodes).toHaveLength(10);
    expect(out.hiddenNodes).toBe(0);
    expect(out.graph.relationCount).toBe(3);
    expect(out.hiddenEdges).toBe(11);
    // M1, M2 and the always-isolated C1 lost every line; S4 stays UNREAD, not
    // isolated — the two states never conflate (R11).
    const isolated = out.graph.nodes.filter((n) => n.isolated).map((n) => n.id);
    expect(isolated.sort()).toEqual([C1, M1, M2].sort());
    expect(out.graph.nodes.find((n) => n.id === S4)!.isolated).toBe(false);
    expect(out.graph.unreadCount).toBe(1);
  });

  it('hideIsolated removes exactly the isolated-in-this-view set', () => {
    const out = applyGraphFilters(
      measuredGraph(),
      filters({ edgeTypes: new Set(['working_on']), hideIsolated: true }),
    );
    expect(out.graph.nodes).toHaveLength(7);
    expect(out.graph.nodes.map((n) => n.id)).not.toContain(C1);
    expect(out.graph.nodes.map((n) => n.id)).not.toContain(M1);
    expect(out.hiddenNodes).toBe(3);
  });

  it('hideUnread drops the failed-read seed and the line a peer read for it', () => {
    const out = applyGraphFilters(measuredGraph(), filters({ hideUnread: true }));
    expect(out.graph.nodes).toHaveLength(9);
    expect(out.graph.nodes.map((n) => n.id)).not.toContain(S4);
    // S4↔T1 relates_to arrived via T1's read; its endpoint is gone.
    expect(out.hiddenEdges).toBe(1);
    expect(out.graph.unreadCount).toBe(0);
  });

  it('mutatedOnly keeps exactly what the conversation edited', () => {
    const out = applyGraphFilters(measuredGraph(), filters({ mutatedOnly: true }));
    expect(out.graph.nodes.map((n) => n.id)).toEqual([T1]);
    expect(out.graph.edges).toHaveLength(0);
  });

  it('SEARCH never changes the node count — it only populates matches', () => {
    const graph = measuredGraph();
    const out = applyGraphFilters(graph, filters({ search: 'task' }));
    expect(out.graph.nodes).toHaveLength(graph.nodes.length);
    expect(out.hiddenNodes).toBe(0);
    // Title matches ("Task Types", "Task Types run") and kind matches (task).
    expect(out.matches.has(T1)).toBe(true);
    expect(out.matches.has(T2)).toBe(true);
    expect(out.matches.has(T3)).toBe(true);
    expect(out.matches.has(M1)).toBe(false);
    const none = applyGraphFilters(graph, filters({ search: 'zzz-no-such' }));
    expect(none.graph.nodes).toHaveLength(graph.nodes.length);
    expect(none.matches.size).toBe(0);
  });

  it('search composes with filters: matches are computed over the SURVIVORS', () => {
    const out = applyGraphFilters(
      measuredGraph(),
      filters({ kinds: new Set(['work_session']), search: 'task' }),
    );
    expect(out.graph.nodes).toHaveLength(4);
    // "Task Types run" survives and matches; the task NODES were filtered out.
    expect([...out.matches]).toHaveLength(1);
    expect(out.matches.has(T3)).toBe(false);
  });
});

describe('graphFacets', () => {
  const foldOf = (extraUndrawn: GraphSeed[]): GraphSeedFold => {
    const drawn = measuredSeeds();
    return {
      seeds: [...drawn, ...extraUndrawn],
      drawn,
      overflow: extraUndrawn.length,
      overflowByKind: extraUndrawn.reduce((map, seed) => {
        const kind = seed.kind ?? 'entity';
        return map.set(kind, (map.get(kind) ?? 0) + 1);
      }, new Map<string, number>()),
    };
  };

  it('kind facets count the WHOLE fold — undrawn seeds included, never dropped', () => {
    const undrawnA = '01900000-00aa-7000-8000-000000000098';
    const undrawnB = '01900000-00aa-7000-8000-000000000099';
    const fold = foldOf([
      { id: undrawnA, kind: 'task', mutated: false },
      { id: undrawnB, mutated: false }, // kind unknown ⇒ 'entity'
    ]);
    const facets = graphFacets(fold, buildInducedGraph(fold.drawn, measuredConnections()));
    const byKind = new Map(facets.kinds.map((f) => [f.kind, f]));
    expect(byKind.get('task')).toEqual({ kind: 'task', drawn: 3, undrawn: 1 });
    expect(byKind.get('work_session')).toEqual({ kind: 'work_session', drawn: 4, undrawn: 0 });
    expect(byKind.get('team_member')).toEqual({ kind: 'team_member', drawn: 2, undrawn: 0 });
    expect(byKind.get('channel')).toEqual({ kind: 'channel', drawn: 1, undrawn: 0 });
    expect(byKind.get('entity')).toEqual({ kind: 'entity', drawn: 0, undrawn: 1 });
  });

  it('a drawn node counts under its RESOLVED kind, not the bare seed', () => {
    // measuredSeeds carry no kind at all — every kind below arrived from the
    // edge payloads, including S4's, whose own read failed (a peer named it).
    const fold = foldOf([]);
    const facets = graphFacets(fold, buildInducedGraph(fold.drawn, measuredConnections()));
    expect(facets.kinds.find((f) => f.kind === 'entity')).toBeUndefined();
    expect(facets.kinds.reduce((sum, f) => sum + f.drawn, 0)).toBe(10);
  });

  it('edge-type facets count relations over the lines actually read', () => {
    const fold = foldOf([]);
    const facets = graphFacets(fold, buildInducedGraph(fold.drawn, measuredConnections()));
    expect(facets.edgeTypes).toEqual([
      { type: 'participates_in', count: 6 },
      { type: 'assigned_to', count: 3 },
      { type: 'working_on', count: 3 },
      { type: 'relates_to', count: 2 },
    ]);
  });
});
