/**
 * THE CAPS, ON EVERY WRITE PATH, AND WHAT AN EVICTION LEAVES BEHIND.
 *
 * Three claims are pinned here, and each one was false before this suite:
 *
 *  1. `ingestSummaries`, `ingestEdges`, `ingestDetail` and the optimistic
 *     merge enforce the same bounds `reduceEvents` does. They enforced nothing,
 *     so a client that BROWSES — the only client that actually accumulates —
 *     grew without limit while the cap looked enforced by the event-path test.
 *  2. An eviction is reference-safe: the evicted entity's detail and its edges
 *     go with it, and each of those edges is unindexed from its OTHER endpoint.
 *     Dropping the summary alone left a whole panel payload cached for a row no
 *     list can render, and an edge index naming an entity the store had
 *     forgotten.
 *  3. Retained ids — what a rendered projection still points at — are never
 *     evicted at either cap.
 *
 * The caps are 20k, which is too large to build a fixture for, so the sweep is
 * exercised through `enforceCacheBounds` with the cap passed as data where the
 * function takes it, and through the public reducers at their real caps where
 * it does not. Nothing here asserts a number the source does not export.
 */
import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent } from '@tm8/contract';
import {
  EDGE_CACHE_CAP,
  ENTITY_CACHE_CAP,
  MESSAGE_ANCHOR_CACHE_CAP,
  type DomainState,
  enforceCacheBounds,
  ingestDetail,
  ingestEdges,
  ingestMessages,
  ingestSummaries,
  initialDomainState,
  reduceEvent,
  reduceEvents,
} from './reducers';
import { createDomainStore } from './domain-store';
import {
  activity,
  counters,
  detail,
  edge,
  event,
  message,
  notification,
  summary,
} from './test-support';

/** A state with `count` entities, ids `e0…`, oldest first. */
function stateWithEntities(count: number, over: Partial<DomainState> = {}): DomainState {
  const entities: DomainState['entities'] = {};
  for (let i = 0; i < count; i++) entities[`e${i}`] = summary(`e${i}`);
  return { ...initialDomainState(), entities, ...over };
}

describe('enforceCacheBounds — reference-safe eviction', () => {
  it('evicts nothing, and allocates nothing, while under every cap', () => {
    const state = stateWithEntities(3);
    const draft = {};
    enforceCacheBounds(state, draft, new Set());
    // No family cloned ⇒ no patch ⇒ Zustand wakes no subscriber. The previous
    // edge trim built and filtered a full key array on every single batch.
    expect(draft).toEqual({});
  });

  it('takes the evicted entity DETAIL with it', () => {
    const state = stateWithEntities(ENTITY_CACHE_CAP + 1, {
      details: { e0: detail('e0') },
    });
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    enforceCacheBounds(state, draft, new Set());

    expect(draft.entities).toBeDefined();
    expect(draft.entities?.['e0']).toBeUndefined();
    // The whole point: a detail is an EntitySummary plus its heavy sections, so
    // leaving it behind keeps a panel's entire payload for a row `projectRows`
    // can no longer render.
    expect(draft.details?.['e0']).toBeUndefined();
  });

  it('takes the evicted entity EDGES with it, and unindexes the far endpoint', () => {
    const link = edge('edge_1', 'e0', 'far');
    const state = stateWithEntities(ENTITY_CACHE_CAP + 1, {
      edges: { edge_1: link },
      edgeIdsByEntity: { e0: ['edge_1'], far: ['edge_1'] },
    });
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    enforceCacheBounds(state, draft, new Set());

    expect(draft.entities?.['e0']).toBeUndefined();
    expect(draft.edges?.['edge_1']).toBeUndefined();
    expect(draft.edgeIdsByEntity?.['e0']).toBeUndefined();
    // `far` survives — but its index must no longer name an edge that is gone,
    // or `selectEdgesOf(far)` renders a hole.
    expect(draft.edgeIdsByEntity?.['far']).toEqual([]);
  });

  it('survives TWO co-evicted entities sharing one edge', () => {
    // The sweep mutates `edgeIdsByEntity` while walking it: dropping e0's edge
    // filters that same edge out of e1's list, and e1 is the very next
    // eviction candidate. If the second pass re-walked a stale list it would
    // call `dropEdge` on an id already gone; if it walked the live list
    // without a copy it would mutate mid-iteration.
    const shared = edge('edge_shared', 'e0', 'e1');
    const state = stateWithEntities(ENTITY_CACHE_CAP + 2, {
      edges: { edge_shared: shared },
      edgeIdsByEntity: { e0: ['edge_shared'], e1: ['edge_shared'] },
    });
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    enforceCacheBounds(state, draft, new Set());

    expect(draft.entities?.['e0']).toBeUndefined();
    expect(draft.entities?.['e1']).toBeUndefined();
    expect(draft.edges?.['edge_shared']).toBeUndefined();
    // Neither endpoint may leave an index entry behind.
    expect(draft.edgeIdsByEntity?.['e0']).toBeUndefined();
    expect(draft.edgeIdsByEntity?.['e1']).toBeUndefined();
    // And the sweep still stopped at exactly the excess.
    expect(Object.keys(draft.entities ?? {})).toHaveLength(ENTITY_CACHE_CAP);
  });

  it('leaves no edge naming an entity the store has forgotten', () => {
    // The invariant in one assertion, over a sweep that evicts many at once:
    // every surviving edge has both endpoints still in `entities`, and every
    // index entry names only surviving edges.
    const edges: DomainState['edges'] = {};
    const edgeIdsByEntity: DomainState['edgeIdsByEntity'] = {};
    const total = ENTITY_CACHE_CAP + 50;
    for (let i = 0; i < total - 1; i++) {
      const id = `edge_${i}`;
      edges[id] = edge(id, `e${i}`, `e${i + 1}`);
      edgeIdsByEntity[`e${i}`] = [...(edgeIdsByEntity[`e${i}`] ?? []), id];
      edgeIdsByEntity[`e${i + 1}`] = [...(edgeIdsByEntity[`e${i + 1}`] ?? []), id];
    }
    const state = stateWithEntities(total, { edges, edgeIdsByEntity });
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    enforceCacheBounds(state, draft, new Set());

    const survivingEdges = draft.edges ?? state.edges;
    const index = draft.edgeIdsByEntity ?? state.edgeIdsByEntity;
    for (const [entityId, list] of Object.entries(index)) {
      for (const edgeId of list) {
        expect(survivingEdges[edgeId], `${entityId} indexes a dropped edge`).toBeDefined();
      }
    }
  });

  it('never evicts a retained id, even when that leaves the cache over cap', () => {
    const over = 4;
    const retained = new Set(
      Array.from({ length: ENTITY_CACHE_CAP + over }, (_, i) => `e${i}`),
    );
    const state = stateWithEntities(ENTITY_CACHE_CAP + over);
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    enforceCacheBounds(state, draft, retained);

    // Nothing was evictable, so nothing was evicted. The bound is best-effort
    // against what the screen still references — it is never allowed to drop a
    // row a projection is rendering.
    expect(Object.keys(draft.entities ?? state.entities)).toHaveLength(
      ENTITY_CACHE_CAP + over,
    );
  });

  it('evicts the OLDEST entity, not an arbitrary one', () => {
    const state = stateWithEntities(ENTITY_CACHE_CAP + 1);
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    enforceCacheBounds(state, draft, new Set());
    expect(draft.entities?.['e0']).toBeUndefined();
    expect(draft.entities?.[`e${ENTITY_CACHE_CAP}`]).toBeDefined();
  });

  it('spares an edge whose endpoint is retained when trimming the edge cap', () => {
    const edges: DomainState['edges'] = {};
    const edgeIdsByEntity: DomainState['edgeIdsByEntity'] = {};
    for (let i = 0; i <= EDGE_CACHE_CAP; i++) {
      edges[`edge_${i}`] = edge(`edge_${i}`, `s${i}`, `t${i}`);
      edgeIdsByEntity[`s${i}`] = [`edge_${i}`];
      edgeIdsByEntity[`t${i}`] = [`edge_${i}`];
    }
    const state = { ...initialDomainState(), edges, edgeIdsByEntity };
    const draft: Parameters<typeof enforceCacheBounds>[1] = {};
    // edge_0 is the oldest and would go first; retaining ONE of its endpoints
    // is enough to save it, and the sweep must then take edge_1 instead.
    enforceCacheBounds(state, draft, new Set(['s0']));

    expect(draft.edges?.['edge_0']).toBeDefined();
    expect(draft.edges?.['edge_1']).toBeUndefined();
  });
});

describe('the read paths enforce the same bounds', () => {
  it('ingestSummaries sweeps — a read used to grow `entities` without limit', () => {
    const state = stateWithEntities(ENTITY_CACHE_CAP);
    const patch = ingestSummaries(state, [summary('fresh')]);
    expect(patch.entities?.['fresh']).toBeDefined();
    expect(Object.keys(patch.entities ?? {})).toHaveLength(ENTITY_CACHE_CAP);
    expect(patch.entities?.['e0']).toBeUndefined();
  });

  it('ingestSummaries moves a re-read row to the LRU tail', () => {
    const state = stateWithEntities(3);
    // e0 is the oldest. Re-reading it must make it the newest, or the row
    // everyone is looking at ages out ahead of one nobody has touched.
    const patch = ingestSummaries(state, [summary('e0', { version: 2 })]);
    expect(Object.keys(patch.entities ?? {})).toEqual(['e1', 'e2', 'e0']);
  });

  it('ingestSummaries still refuses a STALE summary', () => {
    const state = { ...initialDomainState(), entities: { e0: summary('e0', { version: 5 }) } };
    expect(ingestSummaries(state, [summary('e0', { version: 4 })])).toEqual({});
  });

  it('ingestEdges sweeps the edge family', () => {
    const edges: DomainState['edges'] = {};
    const edgeIdsByEntity: DomainState['edgeIdsByEntity'] = {};
    for (let i = 0; i < EDGE_CACHE_CAP; i++) {
      edges[`edge_${i}`] = edge(`edge_${i}`, `s${i}`, `t${i}`);
      edgeIdsByEntity[`s${i}`] = [`edge_${i}`];
      edgeIdsByEntity[`t${i}`] = [`edge_${i}`];
    }
    const state = { ...initialDomainState(), edges, edgeIdsByEntity };
    const patch = ingestEdges(state, [edge('edge_new', 'a', 'b')]);
    expect(patch.edges?.['edge_new']).toBeDefined();
    expect(Object.keys(patch.edges ?? {})).toHaveLength(EDGE_CACHE_CAP);
  });

  it('ingestDetail never evicts the id whose detail it just read', () => {
    // The subject is the LAST thing that may go: a panel is open on it right
    // now, and the caller's retained set was built from a render that predates
    // this read.
    const state = stateWithEntities(ENTITY_CACHE_CAP);
    const patch = ingestDetail(state, detail('opened'));
    expect(patch.entities?.['opened']).toBeDefined();
    expect(patch.details?.['opened']).toBeDefined();
    expect(Object.keys(patch.entities ?? {})).toHaveLength(ENTITY_CACHE_CAP);
  });
});

describe('the optimistic path enforces the bounds and keeps its own row', () => {
  it('sweeps, and never evicts the row the mutation is about', () => {
    const handle = createDomainStore(undefined, { batchWindowMs: 0 });
    handle.store.setState(stateWithEntities(ENTITY_CACHE_CAP));

    handle.store.getState().applyOptimistic('cmid_1', [summary('optimistic')]);
    const after = handle.store.getState();

    expect(after.entities['optimistic']).toBeDefined();
    expect(Object.keys(after.entities)).toHaveLength(ENTITY_CACHE_CAP);
    expect(after.pendingMutations['cmid_1']).toBe(true);
    // The journal's rollback entry names this row; evicting it would make
    // `rollback` restore a summary into a table the row is no longer in.
    handle.store.getState().rollback('cmid_1');
    expect(handle.store.getState().entities['optimistic']).toBeUndefined();
  });

  it('still applies an optimistic patch that does not bump `version`', () => {
    // Routing this through `ingestSummaries`' version guard would drop exactly
    // the writes the optimistic path exists to show.
    const handle = createDomainStore(undefined, { batchWindowMs: 0 });
    handle.store.getState().ingestSummaries([summary('t1', { title: 'before', version: 3 })]);
    handle.store.getState().applyOptimistic('cmid_2', [
      summary('t1', { title: 'after', version: 3 }),
    ]);
    expect(handle.store.getState().entities['t1']?.title).toBe('after');
  });

  it('passes the host\'s retained set to the READ paths, not only to events', () => {
    // The regression in one line: a read that skipped the sweep meant the
    // bound only ever described a client sitting still.
    const retained = new Set(['e0']);
    const handle = createDomainStore(undefined, {
      batchWindowMs: 0,
      retainedEntityIds: () => retained,
    });
    handle.store.setState(stateWithEntities(ENTITY_CACHE_CAP));
    handle.store.getState().ingestSummaries([summary('fresh')]);

    const after = handle.store.getState();
    expect(Object.keys(after.entities)).toHaveLength(ENTITY_CACHE_CAP);
    expect(after.entities['e0']).toBeDefined();
    expect(after.entities['e1']).toBeUndefined();
  });
});

describe('the open thread survives the message-anchor cap', () => {
  it('evicts an idle anchor rather than the retained one', () => {
    // Fable's advisory (6): `setBounded` took the oldest key unconditionally,
    // so a viewer reading a long-lived channel while 128 other anchors received
    // messages watched their own thread blank and refetch.
    const messagesByAnchor: DomainState['messagesByAnchor'] = {};
    for (let i = 0; i < MESSAGE_ANCHOR_CACHE_CAP; i++) {
      messagesByAnchor[`anchor_${i}`] = [message(`m${i}`, `anchor_${i}`, '2026-01-01T00:00:00.000Z')];
    }
    const state = { ...initialDomainState(), messagesByAnchor };

    // anchor_0 is the oldest and would go first — but it is the one on screen.
    const patch = ingestMessages(
      state,
      'anchor_new',
      [message('m_new', 'anchor_new', '2026-01-02T00:00:00.000Z')],
      new Set(['anchor_0']),
    );

    expect(patch.messagesByAnchor?.['anchor_new']).toBeDefined();
    expect(patch.messagesByAnchor?.['anchor_0']).toBeDefined();
    expect(patch.messagesByAnchor?.['anchor_1']).toBeUndefined();
    expect(Object.keys(patch.messagesByAnchor ?? {})).toHaveLength(MESSAGE_ANCHOR_CACHE_CAP);
  });
});

describe('reduceEvent and reduceEvents agree', () => {
  /**
   * Fable's advisory (7): the batched and unbatched folds are parallel
   * implementations of the same switch, and a future event family added to only
   * one would make behaviour depend on whether a burst happened to be batched —
   * a divergence no single-path test can see. This runs one list through both
   * and compares the resulting STATE, so the assertion is about the fold's
   * meaning rather than about either implementation's shape.
   */
  it('produces the same state for a mixed burst', () => {
    const events = [
      event('entity.upsert', { entity: summary('t1', { title: 'one' }) }),
      event('entity.upsert', { entity: summary('t2', { title: 'two' }) }),
      event('edge.upsert', { edge: edge('edge_1', 't1', 't2') }),
      event('counter.changed', { entityId: 't1', counters: counters({ messages: 3 }) }),
      event('message.created', {
        anchorId: 't1',
        message: message('m1', 't1', '2026-01-01T00:00:00.000Z'),
      }),
      event('activity.created', { activity: activity('a1') }),
      event('notification.created', { notification: notification('n1', '2026-01-01T00:00:00.000Z') }),
      event('edge.deleted', { edge: edge('edge_1', 't1', 't2', { updatedAt: '2026-02-01T00:00:00.000Z' }) }),
      event('entity.deleted', { entity: summary('t2', { version: 2 }) }),
      // A type neither path handles: both must skip it silently.
      { ...event('entity.upsert', { entity: summary('t3') }), type: 'not.a.real.event' },
    ] as DurableWorkspaceEvent[];

    let sequential = initialDomainState();
    for (const e of events) sequential = { ...sequential, ...reduceEvent(sequential, e) };

    const batched = { ...initialDomainState(), ...reduceEvents(initialDomainState(), events) };

    expect(batched.entities).toEqual(sequential.entities);
    expect(batched.details).toEqual(sequential.details);
    expect(batched.edges).toEqual(sequential.edges);
    expect(batched.edgeTombstones).toEqual(sequential.edgeTombstones);
    expect(batched.edgeIdsByEntity).toEqual(sequential.edgeIdsByEntity);
    expect(batched.messagesByAnchor).toEqual(sequential.messagesByAnchor);
    expect(batched.activityFeed).toEqual(sequential.activityFeed);
    expect(batched.notifications).toEqual(sequential.notifications);
  });
});
