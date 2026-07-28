import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent } from '@tm8/contract';
import {
  ACTIVITY_CAP,
  MESSAGES_CAP,
  type DomainState,
  ingestDelivery,
  ingestDetail,
  ingestHandoffs,
  ingestMessages,
  ingestNotifications,
  ingestSummaries,
  initialDomainState,
  reduceEvent,
} from './reducers.js';
import {
  SPACE, activity, counters, deliveryRecord, detail, edge, event, handoff,
  menu, message, notification, summary,
} from './test-support.js';

function apply(state: DomainState, e: DurableWorkspaceEvent): DomainState {
  return { ...state, ...reduceEvent(state, e) };
}

describe('entity family', () => {
  it('entity.upsert inserts and replaces summaries', () => {
    let s = initialDomainState();
    s = apply(s, event('entity.upsert', { entity: summary('t1') }));
    expect(s.entities.t1.title).toBe('Task t1');

    s = apply(s, event('entity.upsert', { entity: summary('t1', { title: 'renamed', version: 2 }) }));
    expect(s.entities.t1.title).toBe('renamed');
    expect(s.entities.t1.version).toBe(2);
  });

  it('entity.upsert overlays a cached detail envelope but keeps heavy sections', () => {
    let s = initialDomainState();
    s = { ...s, ...ingestDetail(s, detail('t1')) };
    s = apply(s, event('entity.upsert', { entity: summary('t1', { title: 'fresher', version: 3 }) }));
    expect(s.details.t1.title).toBe('fresher');
    expect(s.details.t1.version).toBe(3);
    expect(s.details.t1.content).toEqual({ kind: 'task', description: 'Body of t1', acceptanceCriteria: [] });
  });

  it('entity.deleted keeps the (tombstoned) summary and drops the cached detail', () => {
    let s = initialDomainState();
    s = { ...s, ...ingestDetail(s, detail('t1')) };
    s = apply(s, event('entity.deleted', { entity: summary('t1', { deletedAt: '2026-07-28T01:00:00.000Z' }) }));
    expect(s.entities.t1.deletedAt).toBe('2026-07-28T01:00:00.000Z');
    expect(s.details.t1).toBeUndefined();
  });

  it('counter.changed folds into the cached summary and its detail overlay', () => {
    let s = initialDomainState();
    s = { ...s, ...ingestDetail(s, detail('t1')) };
    s = apply(s, event('counter.changed', { entityId: 't1', counters: counters({ likes: 4, messages: 2 }) }));
    expect(s.entities.t1.counters.likes).toBe(4);
    expect(s.details.t1.counters.messages).toBe(2);
  });

  it('counter.changed for an uncached entity is a no-op', () => {
    const s = initialDomainState();
    expect(reduceEvent(s, event('counter.changed', { entityId: 'ghost', counters: counters() }))).toEqual({});
  });
});

describe('edge family', () => {
  it('edge.upsert stores the edge and indexes both endpoints without duplicates', () => {
    let s = initialDomainState();
    const e1 = edge('e1', 'a', 'b');
    s = apply(s, event('edge.upsert', { edge: e1 }));
    s = apply(s, event('edge.upsert', { edge: e1 })); // re-upsert must not double-index
    expect(s.edges.e1).toEqual(e1);
    expect(s.edgeIdsByEntity.a).toEqual(['e1']);
    expect(s.edgeIdsByEntity.b).toEqual(['e1']);
  });

  it('edge.deleted removes the edge and unindexes both endpoints', () => {
    let s = initialDomainState();
    s = apply(s, event('edge.upsert', { edge: edge('e1', 'a', 'b') }));
    s = apply(s, event('edge.upsert', { edge: edge('e2', 'a', 'c') }));
    s = apply(s, event('edge.deleted', { edge: edge('e1', 'a', 'b') }));
    expect(s.edges.e1).toBeUndefined();
    expect(s.edgeIdsByEntity.a).toEqual(['e2']);
    expect(s.edgeIdsByEntity.b).toEqual([]);
  });
});

describe('message family', () => {
  it('upserts by anchor sorted by createdAt', () => {
    let s = initialDomainState();
    s = apply(s, event('message.created', { anchorId: 'ch1', message: message('m2', 'ch1', '2026-07-28T00:02:00.000Z') }));
    s = apply(s, event('message.created', { anchorId: 'ch1', message: message('m1', 'ch1', '2026-07-28T00:01:00.000Z') }));
    expect(s.messagesByAnchor.ch1.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('message.deleted keeps the tombstone view in the list', () => {
    let s = initialDomainState();
    s = apply(s, event('message.created', { anchorId: 'ch1', message: message('m1', 'ch1', '2026-07-28T00:01:00.000Z') }));
    const tombstone = message('m1', 'ch1', '2026-07-28T00:01:00.000Z', { deletedAt: '2026-07-28T00:05:00.000Z' });
    s = apply(s, event('message.deleted', { anchorId: 'ch1', message: tombstone }));
    expect(s.messagesByAnchor.ch1).toHaveLength(1);
    expect(s.messagesByAnchor.ch1[0].deletedAt).toBe('2026-07-28T00:05:00.000Z');
  });

  it('caps the per-anchor list at MESSAGES_CAP keeping the newest', () => {
    let s = initialDomainState();
    const base = Date.parse('2026-07-28T00:00:00.000Z');
    const msgs = Array.from({ length: MESSAGES_CAP + 1 }, (_, i) =>
      message(`m${i}`, 'ch1', new Date(base + i * 1000).toISOString()));
    s = { ...s, ...ingestMessages(s, 'ch1', msgs.slice(0, MESSAGES_CAP)) };
    s = apply(s, event('message.created', { anchorId: 'ch1', message: msgs[MESSAGES_CAP] }));
    expect(s.messagesByAnchor.ch1).toHaveLength(MESSAGES_CAP);
    expect(s.messagesByAnchor.ch1[0].id).toBe('m1'); // oldest (m0) evicted
    expect(s.messagesByAnchor.ch1[s.messagesByAnchor.ch1.length - 1].id).toBe(`m${MESSAGES_CAP}`);
  });
});

describe('activity family', () => {
  it('prepends newest-first and caps at ACTIVITY_CAP', () => {
    let s = initialDomainState();
    for (let i = 0; i < ACTIVITY_CAP + 5; i += 1) {
      s = apply(s, event('activity.created', { activity: activity(`a${i}`) }));
    }
    expect(s.activityFeed).toHaveLength(ACTIVITY_CAP);
    expect(s.activityFeed[0].id).toBe(`a${ACTIVITY_CAP + 4}`);
  });

  it('dedupes by id: a re-sent item is replaced in place, not reordered', () => {
    let s = initialDomainState();
    s = apply(s, event('activity.created', { activity: activity('a1') }));
    s = apply(s, event('activity.created', { activity: activity('a2') }));
    s = apply(s, event('activity.created', { activity: activity('a1', { verb: 'entity.renamed' }) }));
    expect(s.activityFeed.map((a) => a.id)).toEqual(['a2', 'a1']);
    expect(s.activityFeed[1].verb).toBe('entity.renamed');
  });
});

describe('notification family', () => {
  it('upserts by id sorted createdAt-descending', () => {
    let s = initialDomainState();
    s = apply(s, event('notification.created', { notification: notification('n1', '2026-07-28T00:01:00.000Z') }));
    s = apply(s, event('notification.created', { notification: notification('n2', '2026-07-28T00:02:00.000Z') }));
    expect(s.notifications.map((n) => n.id)).toEqual(['n2', 'n1']);

    s = apply(s, event('notification.read', { notification: notification('n2', '2026-07-28T00:02:00.000Z', { readAt: '2026-07-28T00:03:00.000Z' }) }));
    expect(s.notifications).toHaveLength(2);
    expect(s.notifications[0].readAt).toBe('2026-07-28T00:03:00.000Z');
  });
});

describe('passthrough — flowing rows (Delta 1 v1)', () => {
  it('menu.updated applies the full MenuConfig per space', () => {
    let s = initialDomainState();
    s = apply(s, event('menu.updated', { menu: menu(1) }));
    s = apply(s, event('menu.updated', { menu: menu(2) }));
    expect(s.menuBySpace[SPACE].revision).toBe(2);

    s = apply(s, event('menu.updated', { menu: menu(7) }, { spaceId: 'space_other' }));
    expect(s.menuBySpace[SPACE].revision).toBe(2);
    expect(s.menuBySpace.space_other.revision).toBe(7);
  });

  it('space.default_channel.updated applies to the space-settings slice', () => {
    let s = initialDomainState();
    s = apply(s, event('space.default_channel.updated', { channelId: 'ch9', settingsRevision: 3 }));
    expect(s.settingsBySpace[SPACE]).toEqual({ defaultChannelId: 'ch9', settingsRevision: 3 });

    s = apply(s, event('space.default_channel.updated', { channelId: null, settingsRevision: 4 }));
    expect(s.settingsBySpace[SPACE]).toEqual({ defaultChannelId: null, settingsRevision: 4 });
  });
});

describe('passthrough — dormant rows (apply-shaped, correctness-independent)', () => {
  it('message.delivery_reserved/settled upsert the record by deliveryId', () => {
    let s = initialDomainState();
    s = apply(s, event('message.delivery_reserved', { delivery: deliveryRecord('d1', 'm1') }));
    s = apply(s, event('message.delivery_settled', { delivery: deliveryRecord('d1', 'm1', { status: 'delivered' }) }));
    s = apply(s, event('message.delivery_reserved', { delivery: deliveryRecord('d2', 'm1') }));
    expect(s.deliveryByMessageId.m1).toHaveLength(2);
    expect(s.deliveryByMessageId.m1[0].status).toBe('delivered');
  });

  it('message.attachments.updated applies the full MessageView at its anchor', () => {
    let s = initialDomainState();
    s = apply(s, event('message.created', { anchorId: 'ch1', message: message('m1', 'ch1', '2026-07-28T00:01:00.000Z') }));
    const updated = message('m1', 'ch1', '2026-07-28T00:01:00.000Z', {
      content: {
        kind: 'message', body: 'msg m1', mentions: [],
        attachments: [{ fileEntityId: 'f1', name: 'a.txt', mime: 'text/plain' }],
      },
    });
    s = apply(s, event('message.attachments.updated', { message: updated }));
    expect(s.messagesByAnchor.ch1).toHaveLength(1);
    expect(s.messagesByAnchor.ch1[0].content.attachments).toHaveLength(1);
  });

  it('handoff.* upsert the full HandoffView under the target work session', () => {
    let s = initialDomainState();
    s = apply(s, event('handoff.prepared', { handoff: handoff('h1', 'ws1') }));
    s = apply(s, event('handoff.recorded', { handoff: handoff('h1', 'ws1', { recordStatus: 'recorded' }) }));
    s = apply(s, event('handoff.prepared', { handoff: handoff('h2', 'ws1') }));
    expect(s.handoffsByWorkSession.ws1).toHaveLength(2);
    expect(s.handoffsByWorkSession.ws1[0].recordStatus).toBe('recorded');
  });
});

describe('invalidation rows', () => {
  it('project.association.corrected marks connections(artifactId) stale', () => {
    let s = initialDomainState();
    s = apply(s, event('project.association.corrected', {
      result: { artifactId: 't1', projectId: 'p1', outcome: 'removed', edge: null },
    }));
    expect(s.staleConnections.t1).toBe(true);
  });

  it('interaction_profile.* only ticks the invalidation counter — even for drifted names', () => {
    let s = initialDomainState();
    s = apply(s, event('interaction_profile.retired', {
      profile: {
        profileId: 'ip1', spaceId: SPACE, status: 'retired', currentDraftVersion: 1,
        validatedVersion: null, validatedHash: null, activeVersion: null, activeHash: null,
        generatedByTeamMemberId: null, retiredAt: '2026-07-28T00:00:00.000Z', version: 1,
        draft: {} as never,
      },
    }));
    expect(s.profileInvalidations).toBe(1);

    // Migration 027 drift: names the contract does not declare must still be
    // caught by the family prefix, not crash, not mutate families.
    const drifted = { ...event('activity.created', { activity: activity('x') }) } as Record<string, unknown>;
    drifted.type = 'interaction_profile.teammate_default_updated';
    s = apply(s, drifted as unknown as DurableWorkspaceEvent);
    expect(s.profileInvalidations).toBe(2);
    expect(s.activityFeed).toHaveLength(0);
  });
});

describe('unknown event types', () => {
  it('are silently skipped, never thrown on', () => {
    const s = initialDomainState();
    const bogus = { ...event('activity.created', { activity: activity('x') }) } as Record<string, unknown>;
    bogus.type = 'totally.unknown.event';
    expect(reduceEvent(s, bogus as unknown as DurableWorkspaceEvent)).toEqual({});
  });
});

describe('hydration ingestion', () => {
  it('ingestSummaries merges a batch, overlaying cached details', () => {
    let s = initialDomainState();
    s = { ...s, ...ingestDetail(s, detail('t1')) };
    s = { ...s, ...ingestSummaries(s, [summary('t1', { title: 'new' }), summary('t2')]) };
    expect(s.entities.t2).toBeDefined();
    expect(s.details.t1.title).toBe('new');
  });

  it('ingestNotifications merges with existing rows', () => {
    let s = initialDomainState();
    s = { ...s, ...ingestNotifications(s, [notification('n1', '2026-07-28T00:01:00.000Z')]) };
    s = { ...s, ...ingestNotifications(s, [notification('n2', '2026-07-28T00:02:00.000Z')]) };
    expect(s.notifications.map((n) => n.id)).toEqual(['n2', 'n1']);
  });

  it('ingestDelivery / ingestHandoffs replace the per-key list (read is authoritative)', () => {
    let s = initialDomainState();
    s = { ...s, ...ingestDelivery(s, 'm1', [deliveryRecord('d1', 'm1')]) };
    s = { ...s, ...ingestDelivery(s, 'm1', [deliveryRecord('d2', 'm1')]) };
    expect(s.deliveryByMessageId.m1.map((r) => r.deliveryId)).toEqual(['d2']);

    s = { ...s, ...ingestHandoffs(s, 'ws1', [handoff('h1', 'ws1')]) };
    s = { ...s, ...ingestHandoffs(s, 'ws1', [handoff('h2', 'ws1')]) };
    expect(s.handoffsByWorkSession.ws1.map((h) => h.handoffId)).toEqual(['h2']);
  });
});
