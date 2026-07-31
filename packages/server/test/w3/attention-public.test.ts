import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

interface AttentionResult {
  request: null | { id: string; entityId: string; reason: string; points: number; status: string; version: number };
  entity: { id: string; badges: { attention?: { pendingCount: number; totalPoints: number; maxPoints: number; latestReason: string } } };
  affectedCount: number;
}

describe.sequential('generic attention requests through the production HTTP surface', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let entityId = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('attention');
    const space = successData<{ space: { id: string } }>(await harness.request('POST', '/v2/spaces', {
      clientMutationId: 'attention-space', name: 'Attention test', visibility: 'private',
    }));
    spaceId = space.space.id;
    const created = successData<{ entity: { id: string } }>(await harness.request('POST', '/v2/entities', {
      clientMutationId: 'attention-entity', spaceId, kind: 'task', title: 'Decision needed',
    }));
    entityId = created.entity.id;
  }, 60_000);

  afterAll(async () => harness.close(), 30_000);

  it('creates scored reasons, lists them, updates state, and resolves all pending rows on one entity', async () => {
    const firstBody = { clientMutationId: 'attention-first', reason: 'Choose an API shape', points: 90 };
    const first = successData<AttentionResult>(await harness.request(
      'POST', `/v2/entities/${entityId}/attention-requests`, firstBody,
    ));
    expect(first.request).toMatchObject({ entityId, reason: firstBody.reason, points: 90, status: 'open', version: 1 });
    expect(first.entity.badges.attention).toMatchObject({ pendingCount: 1, totalPoints: 90, maxPoints: 90 });

    const events = successData<{ items: Array<{ type: string; entity?: AttentionResult['entity'] }> }>(
      await harness.request('GET', `/v2/spaces/${spaceId}/events?since=0&limit=100`),
    );
    const attentionEvent = events.items.find((event) =>
      event.type === 'entity.upsert'
      && event.entity?.id === entityId
      && event.entity.badges.attention?.pendingCount === 1);
    expect(attentionEvent?.entity?.badges.attention?.latestReason).toBe(firstBody.reason);

    const listed = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      await harness.request('GET', `/v2/attention-requests?spaceId=${spaceId}&entityId=${entityId}&status=open`),
    );
    expect(listed.items.map(({ id }) => id)).toEqual([first.request!.id]);

    const acknowledged = successData<AttentionResult>(await harness.request(
      'PATCH', `/v2/attention-requests/${first.request!.id}`,
      { clientMutationId: 'attention-ack', expectedVersion: 1, status: 'acknowledged' },
    ));
    expect(acknowledged.request).toMatchObject({ status: 'acknowledged', version: 2 });

    const second = successData<AttentionResult>(await harness.request(
      'POST', `/v2/entities/${entityId}/attention-requests`,
      { clientMutationId: 'attention-second', reason: 'Confirm the rollout', points: 40 },
    ));
    expect(second.entity.badges.attention).toMatchObject({ pendingCount: 2, totalPoints: 130, maxPoints: 90 });

    const resolvedBody = { clientMutationId: 'attention-resolve-all' };
    const resolved = successData<AttentionResult>(await harness.request(
      'POST', `/v2/entities/${entityId}/attention-requests/resolve`, resolvedBody,
    ));
    expect(resolved.affectedCount).toBe(2);
    expect(resolved.entity.badges.attention).toBeUndefined();

    const rows = await harness.rows<{ status: string; total: number }>(
      `select status, count(*)::int total from public.attention_requests
        where entity_id = $1 group by status`, [entityId],
    );
    expect(rows).toEqual([{ status: 'resolved', total: 2 }]);
  });
});
