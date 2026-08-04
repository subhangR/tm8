import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent } from '@tm8/contract';
import {
  createDomainStore,
  selectConnectionsOf,
  selectConnectionsStale,
  selectDeliveryOf,
  selectDetail,
  selectEdgesOf,
  selectEntity,
  selectHandoffsOf,
  selectIsPending,
  selectMenu,
  selectMessages,
  selectSpaceSettings,
  selectUnreadNotificationCount,
} from './domain-store.js';
import {
  SPACE, deliveryRecord, detail, edge, event, handoff, menu, message,
  notification, summary,
} from './test-support.js';

/** Minimal fake of the seam's onEvent surface (LLD C-3: one event stream). */
function fakeSeam() {
  const subscribers = new Set<(e: DurableWorkspaceEvent) => void>();
  return {
    onEvent(cb: (e: DurableWorkspaceEvent) => void) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    emit(e: DurableWorkspaceEvent) {
      for (const cb of subscribers) cb(e);
    },
    subscriberCount: () => subscribers.size,
  };
}

describe('createDomainStore wiring', () => {
  it('folds seam events through the reducers into domain state', () => {
    const seam = fakeSeam();
    const { store, dispose } = createDomainStore(seam);

    seam.emit(event('entity.upsert', { entity: summary('t1') }));
    seam.emit(event('edge.upsert', { edge: edge('e1', 't1', 't2') }));
    seam.emit(event('message.created', { anchorId: 'ch1', message: message('m1', 'ch1', '2026-07-28T00:01:00.000Z') }));
    seam.emit(event('menu.updated', { menu: menu(5) }));
    seam.emit(event('space.default_channel.updated', { channelId: 'ch1', settingsRevision: 2 }));
    seam.emit(event('notification.created', { notification: notification('n1', '2026-07-28T00:01:00.000Z') }));

    const s = store.getState();
    expect(selectEntity('t1')(s)?.title).toBe('Task t1');
    expect(selectEdgesOf('t1')(s).map((e) => e.id)).toEqual(['e1']);
    expect(selectMessages('ch1')(s)?.map((m) => m.id)).toEqual(['m1']);
    expect(selectMenu(SPACE)(s)?.revision).toBe(5);
    expect(selectSpaceSettings(SPACE)(s)).toEqual({ defaultChannelId: 'ch1', settingsRevision: 2 });
    expect(selectUnreadNotificationCount(s)).toBe(1);
    dispose();
  });

  it('dispose unsubscribes from the seam; state stays but stops advancing', () => {
    const seam = fakeSeam();
    const { store, dispose } = createDomainStore(seam);
    seam.emit(event('entity.upsert', { entity: summary('t1') }));
    expect(seam.subscriberCount()).toBe(1);

    dispose();
    expect(seam.subscriberCount()).toBe(0);
    seam.emit(event('entity.upsert', { entity: summary('t2') }));
    expect(selectEntity('t1')(store.getState())).toBeDefined();
    expect(selectEntity('t2')(store.getState())).toBeUndefined();
  });

  it('works without a seam — applyEvent driven manually', () => {
    const { store } = createDomainStore();
    store.getState().applyEvent(event('entity.upsert', { entity: summary('t1') }));
    expect(selectEntity('t1')(store.getState())).toBeDefined();
  });

  it('hydrates graph edges into the same projection that live edge events update', () => {
    const { store } = createDomainStore();
    store.getState().ingestEdges([edge('e1', 't1', 't2')]);
    expect(selectEdgesOf('t1')(store.getState()).map((item) => item.id)).toEqual(['e1']);

    store.getState().applyEvent(event('edge.upsert', { edge: edge('e2', 't1', 't3') }));
    expect(selectEdgesOf('t1')(store.getState()).map((item) => item.id)).toEqual(['e1', 'e2']);
  });

  it('projects an edge created after detail hydration into live Connections', () => {
    const { store } = createDomainStore();
    store.getState().ingestDetail(detail('task'));
    expect(selectConnectionsOf('task')(store.getState())?.incoming).toEqual([]);

    store.getState().applyEvent(event('edge.upsert', {
      edge: edge('work', 'session', 'task', { type: 'working_on' }),
    }));

    const connections = selectConnectionsOf('task')(store.getState());
    expect(connections?.incoming).toHaveLength(1);
    expect(connections?.incoming[0]).toMatchObject({
      type: 'working_on',
      direction: 'incoming',
      label: 'Working on',
    });
    expect(connections?.incoming[0].edges.map((item) => item.id)).toEqual(['work']);

    store.getState().applyEvent(event('edge.deleted', {
      edge: edge('work', 'session', 'task', { type: 'working_on' }),
    }));
    expect(selectConnectionsOf('task')(store.getState())?.incoming).toEqual([]);
  });

  it('normalizes the connection snapshot carried by an entity detail', () => {
    const { store } = createDomainStore();
    const linked = edge('existing', 'task', 'peer', { type: 'relates_to' });
    store.getState().ingestDetail(detail('task', {
      connections: {
        outgoing: [{ type: 'relates_to', direction: 'outgoing', label: 'Relates to', edges: [linked] }],
        incoming: [],
        unresolvedHardDependencyCount: 0,
      },
    }));

    expect(selectConnectionsOf('task')(store.getState())?.outgoing[0].edges.map((item) => item.id))
      .toEqual(['existing']);
  });
});

describe('optimistic journal integration', () => {
  it('applyOptimistic patches state and marks the mutation pending', () => {
    const { store } = createDomainStore();
    store.getState().applyOptimistic('cm1', [summary('t1', { title: 'optimistic' })]);
    const s = store.getState();
    expect(selectEntity('t1')(s)?.title).toBe('optimistic');
    expect(selectIsPending('cm1')(s)).toBe(true);
  });

  it('success path: CommandResult patches ingest + reconcile drops the pending entry', () => {
    const { store, journal } = createDomainStore();
    store.getState().applyOptimistic('cm1', [summary('t1', { title: 'optimistic', version: 1 })]);
    // authoritative CommandResult.patches
    store.getState().ingestSummaries([summary('t1', { title: 'authoritative', version: 2 })]);
    store.getState().reconcile('cm1');

    const s = store.getState();
    expect(selectEntity('t1')(s)?.title).toBe('authoritative');
    expect(selectIsPending('cm1')(s)).toBe(false);
    expect(journal.has('cm1')).toBe(false);
  });

  it('event echo carrying the clientMutationId reconciles first; later reconcile is a no-op', () => {
    const seam = fakeSeam();
    const { store, journal } = createDomainStore(seam);
    store.getState().applyOptimistic('cm1', [summary('t1', { title: 'optimistic' })]);

    seam.emit(event('entity.upsert', { entity: summary('t1', { title: 'echoed', version: 2 }), clientMutationId: 'cm1' }));
    let s = store.getState();
    expect(selectEntity('t1')(s)?.title).toBe('echoed');
    expect(selectIsPending('cm1')(s)).toBe(false);
    expect(journal.has('cm1')).toBe(false);

    // the CommandResult settling afterwards double-reconciles harmlessly
    store.getState().reconcile('cm1');
    s = store.getState();
    expect(selectEntity('t1')(s)?.title).toBe('echoed');
  });

  it('rollback restores prior summaries and removes was-absent optimistic creates', () => {
    const { store } = createDomainStore();
    store.getState().ingestSummaries([summary('t1', { title: 'original' })]);
    store.getState().ingestDetail(detail('t1', { title: 'original' }));

    store.getState().applyOptimistic('cm1', [
      summary('t1', { title: 'optimistic' }),
      summary('tNew', { title: 'optimistic create' }),
    ]);
    expect(selectEntity('tNew')(store.getState())).toBeDefined();
    expect(selectDetail('t1')(store.getState())?.title).toBe('optimistic');

    store.getState().rollback('cm1');
    const s = store.getState();
    expect(selectEntity('t1')(s)?.title).toBe('original');
    expect(selectDetail('t1')(s)?.title).toBe('original');
    expect(selectEntity('tNew')(s)).toBeUndefined();
    expect(selectIsPending('cm1')(s)).toBe(false);
  });

  it('rollback after an echo reconcile does not clobber authoritative state', () => {
    const seam = fakeSeam();
    const { store } = createDomainStore(seam);
    store.getState().ingestSummaries([summary('t1', { title: 'original' })]);
    store.getState().applyOptimistic('cm1', [summary('t1', { title: 'optimistic' })]);
    seam.emit(event('entity.upsert', { entity: summary('t1', { title: 'authoritative' }), clientMutationId: 'cm1' }));

    store.getState().rollback('cm1'); // journal entry already gone — no instructions
    expect(selectEntity('t1')(store.getState())?.title).toBe('authoritative');
  });
});

describe('reads feeding the domain slice', () => {
  it('ingestMenu caches per space and clears on null (C-4 shipped-default)', () => {
    const { store } = createDomainStore();
    store.getState().ingestMenu(SPACE, menu(3));
    expect(selectMenu(SPACE)(store.getState())?.revision).toBe(3);
    store.getState().ingestMenu(SPACE, null);
    expect(selectMenu(SPACE)(store.getState())).toBeUndefined();
  });

  it('ingestDelivery / ingestHandoffs feed the on-demand facets', () => {
    const { store } = createDomainStore();
    store.getState().ingestDelivery('m1', [deliveryRecord('d1', 'm1', { status: 'unknown' })]);
    store.getState().ingestHandoffs('ws1', [handoff('h1', 'ws1')]);
    const s = store.getState();
    expect(selectDeliveryOf('m1')(s)[0].status).toBe('unknown');
    expect(selectHandoffsOf('ws1')(s).map((h) => h.handoffId)).toEqual(['h1']);
    expect(selectDeliveryOf('unread-message')(s)).toEqual([]);
  });
});

describe('invalidation lifecycle', () => {
  it('association-corrected marks connections stale until the consumer clears it', () => {
    const seam = fakeSeam();
    const { store } = createDomainStore(seam);
    seam.emit(event('project.association.corrected', {
      result: { artifactId: 't1', projectId: 'p1', outcome: 'demoted', edge: null },
    }));
    expect(selectConnectionsStale('t1')(store.getState())).toBe(true);

    store.getState().clearConnectionsStale('t1');
    expect(selectConnectionsStale('t1')(store.getState())).toBe(false);
  });
});

describe('reset', () => {
  it('returns to the initial state and empties the journal', () => {
    const { store, journal } = createDomainStore();
    store.getState().ingestSummaries([summary('t1')]);
    store.getState().applyOptimistic('cm1', [summary('t2')]);
    store.getState().reset();

    const s = store.getState();
    expect(s.entities).toEqual({});
    expect(s.pendingMutations).toEqual({});
    expect(journal.pending()).toEqual([]);
    // actions survive the reset
    store.getState().applyEvent(event('entity.upsert', { entity: summary('t3') }));
    expect(selectEntity('t3')(store.getState())).toBeDefined();
  });
});
