/**
 * G0 store tests — the four Zustand stores replay a scripted WorkspaceEvent
 * stream correctly: normalization, event de-dup, optimistic journal with
 * reconcile/rollback, nav hash round-trips, collection cache patching,
 * presence snapshots.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectionKey, connectStores, dispatchWorkspaceEvent, selectEdgesOf,
  selectUnreadNotificationCount, useCollectionsStore, useGraphStore,
  useNavStore, usePresenceStore,
} from '../../stores';
import { VIEWS } from '../../stores/nav';
import type { EntitySummary, WorkspaceEvent } from '../../types/contract';
import { createRig } from './helpers';

beforeEach(() => {
  useGraphStore.getState().reset();
  useNavStore.getState().reset();
  useCollectionsStore.getState().reset();
  usePresenceStore.getState().reset();
});

describe('graph store — live command replay through the facade subscription', () => {
  it('mirrors world mutations driven purely by events', async () => {
    const { facade, ids } = createRig();
    const unsubscribe = connectStores(facade, ids.space);

    const seedTasks = await facade.queryCollection({ spaceId: ids.space, kinds: ['task'], subtreeOf: ids.t100 });
    useGraphStore.getState().ingestSummaries(seedTasks.page.items);

    // A content edit arrives as entity.upsert → version visible in the store
    await facade.patchTask(ids.t102, { expectedVersion: 1, description: 'sharper', actorId: ids.mira });
    expect(useGraphStore.getState().entities[ids.t102]?.version).toBe(2);

    // Reaction → counter.changed merges into the summary
    await facade.setReaction(ids.t102, { reaction: 'like', enabled: true, actorId: ids.subhang });
    expect(useGraphStore.getState().entities[ids.t102]?.counters.likes).toBe(1);

    // Edge events index by both endpoints (assignment also emits a notification)
    const edgeRes = await facade.createEdge({ srcId: ids.t108, dstId: ids.mira, type: 'assigned_to', actorId: ids.subhang });
    expect(selectEdgesOf(ids.t108)(useGraphStore.getState()).map((e) => e.id)).toContain(edgeRes.edge!.id);
    await facade.deleteEdge(edgeRes.edge!.id, { actorId: ids.mira });
    expect(selectEdgesOf(ids.t108)(useGraphStore.getState())).toHaveLength(0);

    // Messages land under their anchor; deletion keeps the tombstone view
    await facade.postMessage({ anchorId: ids.t107, body: 'live message', actorId: ids.mira });
    const msgs = useGraphStore.getState().messagesByAnchor[ids.t107];
    expect(msgs).toHaveLength(1);
    await facade.deleteMessage(msgs[0].id, { actorId: ids.mira });
    expect(useGraphStore.getState().messagesByAnchor[ids.t107][0].deletedAt).not.toBeNull();

    // Deletion tombstones the summary and drops the detail
    await facade.getEntity(ids.t108).then((d) => useGraphStore.getState().ingestDetail(d));
    await facade.deleteEntity(ids.t108, { actorId: ids.subhang });
    expect(useGraphStore.getState().entities[ids.t108]?.deletedAt).not.toBeNull();
    expect(useGraphStore.getState().details[ids.t108]).toBeUndefined();

    // Notifications & activity accumulate
    expect(selectUnreadNotificationCount(useGraphStore.getState())).toBeGreaterThan(0);
    expect(useGraphStore.getState().activityFeed.length).toBeGreaterThan(0);

    unsubscribe();
    await facade.postMessage({ anchorId: ids.t107, body: 'after unsubscribe', actorId: ids.mira });
    expect(useGraphStore.getState().messagesByAnchor[ids.t107]).toHaveLength(1); // no longer listening
  });

  it('de-duplicates events by eventId', () => {
    const summary = { id: 'e1', version: 3 } as unknown as EntitySummary;
    const ev: WorkspaceEvent = { type: 'activity.created', eventId: 'evt_x', activity: { id: 'a1', verb: 'created', summary: {}, createdAt: new Date().toISOString() } };
    dispatchWorkspaceEvent(ev);
    dispatchWorkspaceEvent(ev);
    expect(useGraphStore.getState().activityFeed).toHaveLength(1);
    void summary;
  });
});

describe('graph store — optimistic journal', () => {
  const base: EntitySummary = {
    id: 'ent_x', spaceId: 'spc', kind: 'task', title: 'Server title', parentId: null,
    position: 0, visibility: 'space', version: 1,
    activityAt: '2026-07-25T12:00:00.000Z', createdAt: '2026-07-25T12:00:00.000Z',
    updatedAt: '2026-07-25T12:00:00.000Z', deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'S', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0 },
    state: { kind: 'task', workStatus: 'open', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } },
    badges: {},
  };

  it('applies, reconciles on the matching event, and survives', () => {
    const g = useGraphStore.getState();
    g.ingestSummaries([base]);
    g.applyOptimistic('cmid-1', [{ ...base, title: 'Optimistic title' }]);
    expect(useGraphStore.getState().entities.ent_x.title).toBe('Optimistic title');
    dispatchWorkspaceEvent({
      type: 'entity.upsert', eventId: 'evt_r1', clientMutationId: 'cmid-1',
      entity: { ...base, title: 'Server confirmed', version: 2 },
    });
    const s = useGraphStore.getState();
    expect(s.entities.ent_x.title).toBe('Server confirmed');
    expect(s.optimistic['cmid-1']).toBeUndefined();
  });

  it('rolls back to the pre-patch state on typed failure', () => {
    const g = useGraphStore.getState();
    g.ingestSummaries([base]);
    g.applyOptimistic('cmid-2', [{ ...base, title: 'Doomed edit' }]);
    expect(useGraphStore.getState().entities.ent_x.title).toBe('Doomed edit');
    useGraphStore.getState().rollback('cmid-2');
    const s = useGraphStore.getState();
    expect(s.entities.ent_x.title).toBe('Server title');
    expect(s.optimistic['cmid-2']).toBeUndefined();
  });

  it('rollback removes entities that were optimistically created', () => {
    useGraphStore.getState().applyOptimistic('cmid-3', [{ ...base, id: 'ent_new' }]);
    expect(useGraphStore.getState().entities.ent_new).toBeDefined();
    useGraphStore.getState().rollback('cmid-3');
    expect(useGraphStore.getState().entities.ent_new).toBeUndefined();
  });
});

describe('nav store — panel stack + hash URL', () => {
  it('round-trips space/view/stack/pins/tabs through the hash', () => {
    const nav = useNavStore.getState();
    nav.setSpace('spc_maestro_core');
    nav.setView('tasks');
    nav.pushPanel({ entityId: 'ent_a' });
    nav.pushPanel({ entityId: 'ent_b', tab: 'connections' });
    nav.pinPanel('ent_a');
    const hash = useNavStore.getState().toHash();

    useNavStore.getState().reset();
    useNavStore.getState().hydrateFromHash(hash);
    const s = useNavStore.getState();
    expect(s.spaceId).toBe('spc_maestro_core');
    expect(s.view).toBe('tasks');
    expect(s.stack).toEqual([{ entityId: 'ent_b', tab: 'connections' }]);
    expect(s.pinned).toEqual([{ entityId: 'ent_a' }]);
  });

  it('round-trips an entity Z4 route', () => {
    const nav = useNavStore.getState();
    nav.setSpace('spc');
    nav.setView('entity', 'ent_doc');
    const hash = useNavStore.getState().toHash();
    useNavStore.getState().reset();
    useNavStore.getState().hydrateFromHash(hash);
    expect(useNavStore.getState().view).toBe('entity');
    expect(useNavStore.getState().entityId).toBe('ent_doc');
  });

  /**
   * The generalized version of the bug that shipped: `channel` serialized as
   * `/e/{id}` and read back as `entity`, so the URL silently changed the view.
   * Asserting one view at a time is what let it hide — this asserts EVERY view
   * round-trips, so a new entity-focused view cannot reintroduce the asymmetry.
   */
  it('every view round-trips through the hash unchanged', () => {
    for (const view of VIEWS) {
      // `entity` and the entity-focused views are meaningless without a target;
      // the rest are bare.
      const entityId = view === 'entity' || view === 'channel' || view === 'sessions'
        ? `ent_for_${view}`
        : null;

      useNavStore.getState().reset();
      const nav = useNavStore.getState();
      nav.setSpace('spc');
      nav.setView(view, entityId);
      const hash = useNavStore.getState().toHash();

      useNavStore.getState().reset();
      useNavStore.getState().hydrateFromHash(hash);
      const s = useNavStore.getState();
      expect(`${view}:${s.view}`).toBe(`${view}:${view}`);
      expect(`${view}:${s.entityId ?? ''}`).toBe(`${view}:${entityId ?? ''}`);
    }
  });

  it('ignores a stray trailing segment on a view that focuses nothing', () => {
    useNavStore.getState().reset();
    useNavStore.getState().hydrateFromHash('#/s/spc/tasks/ent_stray');
    expect(useNavStore.getState().view).toBe('tasks');
    expect(useNavStore.getState().entityId).toBeNull();
  });

  it('never emits a trailing empty id for an entity-focused view with no entity', () => {
    const nav = useNavStore.getState();
    nav.setSpace('spc');
    nav.setView('sessions', null);
    const hash = useNavStore.getState().toHash();
    expect(hash).toBe('#/s/spc/sessions');

    useNavStore.getState().reset();
    useNavStore.getState().hydrateFromHash(hash);
    expect(useNavStore.getState().view).toBe('sessions');
    expect(useNavStore.getState().entityId).toBeNull();
  });

  it('stacks, pops, re-stacks without duplicates, promotes, caps pins at 3', () => {
    const nav = useNavStore.getState();
    nav.setSpace('spc');
    nav.pushPanel({ entityId: 'a' });
    nav.pushPanel({ entityId: 'b' });
    nav.pushPanel({ entityId: 'a' }); // re-open moves to top, no dupe
    expect(useNavStore.getState().stack.map((r) => r.entityId)).toEqual(['b', 'a']);
    nav.popPanel();
    expect(useNavStore.getState().stack.map((r) => r.entityId)).toEqual(['b']);
    expect(useNavStore.getState().pinPanel('b')).toBe(true);
    expect(useNavStore.getState().stack).toHaveLength(0); // pin moves out of the stack
    expect(useNavStore.getState().pinPanel('c')).toBe(true);
    expect(useNavStore.getState().pinPanel('d')).toBe(true);
    expect(useNavStore.getState().pinPanel('e')).toBe(false); // 2–3 splits max
    useNavStore.getState().promotePanel('c');
    const s = useNavStore.getState();
    expect(s.view).toBe('entity');
    expect(s.entityId).toBe('c');
  });
});

describe('collections store', () => {
  it('caches by stable key, appends cursor pages, patches entities in place', async () => {
    const { facade, ids } = createRig();
    const q1 = { spaceId: ids.space, kinds: ['task' as const], limit: 5 };
    const q2 = { kinds: ['task' as const], spaceId: ids.space, limit: 5 };
    expect(collectionKey(q1)).toBe(collectionKey(q2)); // key order does not matter

    const page1 = await facade.queryCollection(q1);
    useCollectionsStore.getState().setResult(q1, page1);
    const page2 = await facade.queryCollection({ ...q1, cursor: page1.page.nextCursor as string });
    useCollectionsStore.getState().appendPage(q2, page2.page);
    const cached = useCollectionsStore.getState().cache[collectionKey(q1)];
    expect(cached.result.page.items.length).toBe(page1.page.items.length + page2.page.items.length);

    const target = cached.result.page.items[0];
    useCollectionsStore.getState().applyEntityPatch({ ...target, title: 'PATCHED' });
    expect(useCollectionsStore.getState().cache[collectionKey(q1)].result.page.items[0].title).toBe('PATCHED');

    useCollectionsStore.getState().removeEntity(target.id);
    expect(useCollectionsStore.getState().cache[collectionKey(q1)].result.page.items.map((i) => i.id))
      .not.toContain(target.id);
  });

  it('entity events flow into cached collections via the dispatcher', async () => {
    const { facade, ids } = createRig();
    const unsubscribe = connectStores(facade, ids.space);
    const query = { spaceId: ids.space, kinds: ['task' as const], subtreeOf: ids.t100 };
    useCollectionsStore.getState().setResult(query, await facade.queryCollection(query));
    await facade.patchTask(ids.t102, { expectedVersion: 1, title: 'T-102 · RLS policies (v2)', actorId: ids.mira });
    const cached = useCollectionsStore.getState().cache[collectionKey(query)];
    expect(cached.result.page.items.find((i) => i.id === ids.t102)?.title).toContain('(v2)');
    unsubscribe();
  });
});

describe('presence store', () => {
  it('applies presence + typing events', async () => {
    const { facade, ids } = createRig();
    const unsubscribe = connectStores(facade, ids.space);
    facade.withWorld((w) => w.setPresence(ids.chGeneral, [ids.mira], [ids.mira]));
    const s = usePresenceStore.getState();
    expect(s.byEntity[ids.chGeneral].viewers.map((v) => v.id)).toEqual([ids.mira]);
    expect(s.typingByAnchor[ids.chGeneral]).toEqual([ids.mira]);
    facade.withWorld((w) => w.setPresence(ids.chGeneral, [], []));
    expect(usePresenceStore.getState().typingByAnchor[ids.chGeneral]).toEqual([]);
    unsubscribe();
  });
});
