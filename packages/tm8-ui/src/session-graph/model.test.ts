/**
 * The four rules that make a session's ego-network readable, each measured
 * against the failure it exists to prevent (all four were observed live before
 * the model existed — see the header of `model.ts` for the numbers).
 */
import { describe, expect, it } from 'vitest';
import type { EdgeView, EntitySummary } from '@tm8/contract';
import {
  FOLD_AT,
  HUB_DEGREE,
  buildSessionGraph,
  expandableFrom,
  foldId,
  relationsOf,
  summarize,
  type EntityCell,
  type FoldCell,
} from './model';

const FOCUS = 'session-1';

function entity(id: string, kind = 'doc', title = id): EntitySummary {
  return {
    id,
    spaceId: 'space-1',
    kind,
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    deletedAt: null,
    createdBy: { kind: 'member', id: 'm1', displayName: 'M' },
    counters: {},
    state: {},
    badges: {},
  } as unknown as EntitySummary;
}

function edge(from: EntitySummary, type: string, to: EntitySummary): EdgeView {
  return {
    id: `${from.id}-${type}-${to.id}`,
    type,
    source: from,
    target: to,
    props: {},
    createdBy: { kind: 'member', id: 'm1', displayName: 'M' },
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  } as unknown as EdgeView;
}

const focusEntity = entity(FOCUS, 'work_session', 'Session');

describe('relationsOf', () => {
  it('groups by type AND direction, because one edge means two things', () => {
    const other = entity('s2', 'work_session');
    const relations = relationsOf(FOCUS, [
      edge(focusEntity, 'messaged', other),
      edge(other, 'messaged', focusEntity),
    ]);
    expect(relations.map((r) => r.key)).toEqual(['messaged:out', 'messaged:in']);
    expect(relations.map((r) => r.label)).toEqual(['Messaged', 'Messaged by']);
  });

  it('drops self-edges, which have no far end to place', () => {
    expect(relationsOf(FOCUS, [edge(focusEntity, 'relates_to', focusEntity)])).toEqual([]);
  });

  it('counts a peer once even when it holds the same relation twice', () => {
    const peer = entity('p1');
    const relations = relationsOf(FOCUS, [
      edge(focusEntity, 'relates_to', peer),
      edge(focusEntity, 'relates_to', peer),
    ]);
    expect(relations[0]!.peers).toHaveLength(1);
  });

  it('labels an unknown edge type rather than dropping it', () => {
    const relations = relationsOf(FOCUS, [edge(focusEntity, 'brand_new_type', entity('p1'))]);
    expect(relations[0]!.label).toBe('Brand new type');
  });
});

describe('folding', () => {
  const many = Array.from({ length: FOLD_AT + 3 }, (_, i) => entity(`msg-${i}`, 'message'));
  const edges = many.map((peer) => edge(peer, 'authored_from', focusEntity));

  it('collapses a relation past FOLD_AT into one cell that prints the exact count', () => {
    const graph = buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: new Map([[FOCUS, edges]]),
      hops: 2,
    });
    const folds = graph.cells.filter((c): c is FoldCell => c.sort === 'fold');
    expect(folds).toHaveLength(1);
    expect(folds[0]!.count).toBe(many.length);
    expect(folds[0]!.byKind).toEqual({ message: many.length });
    // The members are NOT also drawn individually — a fold that lies about its
    // own count is worse than no fold.
    expect(graph.cells.filter((c) => c.sort === 'entity')).toHaveLength(0);
  });

  it('draws the members individually once the viewer opens the fold', () => {
    const graph = buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: new Map([[FOCUS, edges]]),
      hops: 2,
      openFolds: new Set([foldId(FOCUS, 'authored_from:in')]),
    });
    expect(graph.cells.filter((c) => c.sort === 'fold')).toHaveLength(0);
    expect(graph.cells.filter((c) => c.sort === 'entity')).toHaveLength(many.length);
  });

  it('is also the loader budget: a folded relation is not expanded', () => {
    expect(expandableFrom(FOCUS, edges, new Set())).toEqual([]);
    expect(expandableFrom(FOCUS, edges, new Set([foldId(FOCUS, 'authored_from:in')]))).toHaveLength(
      many.length,
    );
  });
});

describe('hub stop', () => {
  const project = entity('project-1', 'project');
  const behindHub = Array.from({ length: HUB_DEGREE + 4 }, (_, i) => entity(`sib-${i}`));
  const hubEdges = [
    edge(focusEntity, 'in_project', project),
    ...behindHub.map((peer) => edge(peer, 'in_project', project)),
  ];

  const graph = buildSessionGraph({
    focusId: FOCUS,
    focus: focusEntity,
    edgesByNode: new Map([
      [FOCUS, [hubEdges[0]!]],
      [project.id, hubEdges],
    ]),
    hops: 3,
  });

  it('draws the hub and never expands through it', () => {
    const cells = graph.cells.filter((c): c is EntityCell => c.sort === 'entity');
    expect(cells.map((c) => c.id)).toEqual([project.id]);
    expect(cells[0]!.hub).toBe(true);
    expect(cells[0]!.degree).toBe(hubEdges.length);
  });

  it('counts the branches it did not draw, so the stop is visible', () => {
    const hub = graph.cells.find((c) => c.id === project.id) as EntityCell;
    expect(hub.withheld).toBe(behindHub.length);
  });
});

describe('read boundary', () => {
  it('marks a drawn node whose own edges were never read, rather than calling it a leaf', () => {
    const task = entity('task-1', 'task');
    const graph = buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      // `task-1` is absent from the map: its edges were not read.
      edgesByNode: new Map([[FOCUS, [edge(focusEntity, 'working_on', task)]]]),
      hops: 2,
    });
    const cell = graph.cells.find((c) => c.id === task.id) as EntityCell;
    expect(cell.degree).toBeNull();
    expect(summarize(graph).unreadBoundary).toBe(1);
  });
});

describe('hidden relations', () => {
  it('filters the focus ring only — hiding is a focus control, not a graph-wide erasure', () => {
    const task = entity('task-1', 'task');
    const doc = entity('doc-1');
    const graph = buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: new Map([
        [FOCUS, [edge(focusEntity, 'working_on', task), edge(focusEntity, 'relates_to', doc)]],
        [task.id, [edge(focusEntity, 'working_on', task), edge(task, 'relates_to', doc)]],
      ]),
      hops: 2,
      hiddenRelations: new Set(['relates_to:out']),
    });
    // The doc is not on the focus ring, but it is still reachable through the
    // task — the same relation one hop out is not the viewer's filter.
    const doc1 = graph.cells.find((c) => c.id === doc.id) as EntityCell;
    expect(doc1.hop).toBe(2);
    expect(doc1.parentId).toBe(task.id);
    // The relation stays in the headline so the viewer can see what they hid.
    expect(graph.relations.map((r) => r.key)).toContain('relates_to:out');
  });
});

describe('summarize', () => {
  it('counts the entities around the session, never the session itself', () => {
    const graph = buildSessionGraph({
      focusId: FOCUS,
      focus: focusEntity,
      edgesByNode: new Map([
        [
          FOCUS,
          [
            edge(focusEntity, 'working_on', entity('task-1', 'task')),
            edge(entity('m1', 'message'), 'authored_from', focusEntity),
            edge(entity('m2', 'message'), 'authored_from', focusEntity),
          ],
        ],
      ]),
      hops: 1,
    });
    // "What does this session do" is answered by the relation chips, which read
    // `graph.relations` directly — the summary no longer restates it.
    expect(graph.relations.map((r) => [r.key, r.label, r.peers.length])).toEqual([
      ['working_on:out', 'Working on', 1],
      ['authored_from:in', 'Wrote', 2],
    ]);
    // The focus itself is not one of "the entities around this session".
    expect(summarize(graph).entityCount).toBe(3);
  });
});
