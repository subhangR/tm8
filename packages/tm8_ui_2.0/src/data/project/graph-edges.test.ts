import { describe, expect, it } from 'vitest';
import type { GraphEdgeView } from '@tm8/contract';
import { resolveGraphEdges } from './graph-edges.js';
import { ingestEdges, initialDomainState } from './reducers.js';
import { summary } from './test-support.js';

const ACTOR = summary('a1').createdBy;

function wireEdge(id: string, sourceId: string, targetId: string, over: Partial<GraphEdgeView> = {}): GraphEdgeView {
  return {
    id,
    type: 'relates_to',
    sourceId,
    targetId,
    props: {},
    createdBy: ACTOR,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

describe('resolveGraphEdges', () => {
  it('re-attaches endpoint summaries from the nodes of the same response', () => {
    const nodes = [summary('t1'), summary('t2', { title: 'second' })];
    const { edges, unresolved } = resolveGraphEdges(nodes, [wireEdge('e1', 't1', 't2')]);

    expect(unresolved).toEqual([]);
    expect(edges).toHaveLength(1);
    // Identity, not a copy: the store's entity family and its edge family must
    // agree about what `t2` is, and they cannot disagree if it is one object.
    expect(edges[0]!.source).toBe(nodes[0]);
    expect(edges[0]!.target).toBe(nodes[1]);
    expect(edges[0]!.target.title).toBe('second');
  });

  it('carries every non-endpoint field through, and leaves no id fields behind', () => {
    const nodes = [summary('t1'), summary('t2')];
    const [resolved] = resolveGraphEdges(nodes, [
      wireEdge('e1', 't1', 't2', {
        type: 'depends_on',
        props: { hard: true },
        resolved: false,
        hard: true,
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
    ]).edges;

    expect(resolved).toMatchObject({
      id: 'e1',
      type: 'depends_on',
      props: { hard: true },
      resolved: false,
      hard: true,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    // The wire keys must not survive into the store's shape: an EdgeView
    // carrying a stray `sourceId` would let a consumer read a stale endpoint
    // after `edge.upsert` replaced the object.
    expect(resolved).not.toHaveProperty('sourceId');
    expect(resolved).not.toHaveProperty('targetId');
  });

  it('reports an unresolvable endpoint instead of ingesting a half-built edge', () => {
    // The server's own filter makes this impossible; if it ever stops being
    // impossible, the edge must be NAMED, not quietly missing from the canvas.
    const nodes = [summary('t1')];
    const { edges, unresolved } = resolveGraphEdges(nodes, [
      wireEdge('e1', 't1', 'not-in-page'),
      wireEdge('e2', 'not-in-page', 't1'),
      wireEdge('e3', 't1', 't1'),
    ]);

    expect(edges.map((e) => e.id)).toEqual(['e3']);
    expect(unresolved).toEqual(['e1', 'e2']);
  });

  it('preserves input order and short-circuits an empty edge list', () => {
    const nodes = [summary('t1'), summary('t2'), summary('t3')];
    const { edges } = resolveGraphEdges(nodes, [
      wireEdge('e3', 't3', 't1'),
      wireEdge('e1', 't1', 't2'),
      wireEdge('e2', 't2', 't3'),
    ]);
    expect(edges.map((e) => e.id)).toEqual(['e3', 'e1', 'e2']);
    expect(resolveGraphEdges(nodes, [])).toEqual({ edges: [], unresolved: [] });
  });

  it('produces edges the normalized store indexes under both endpoints', () => {
    // The whole point of resolving here rather than teaching the store two
    // shapes: what comes out of this function must be ingestable unchanged.
    const nodes = [summary('t1'), summary('t2')];
    const { edges } = resolveGraphEdges(nodes, [wireEdge('e1', 't1', 't2')]);
    const state = { ...initialDomainState(), ...ingestEdges(initialDomainState(), edges) };

    expect(state.edges.e1!.source.id).toBe('t1');
    expect(state.edgeIdsByEntity.t1).toEqual(['e1']);
    expect(state.edgeIdsByEntity.t2).toEqual(['e1']);
  });
});
