/**
 * Collection membership over the REAL production composition, end to end.
 *
 * The pg suite (test/db/collection-membership.pg.test.ts) proves the database
 * rules and the query executor. It cannot prove the half that a user actually
 * touches: that the two new operations are COMPOSED into `bootstrap()` rather
 * than merely registered in a seam, that the router extracts both path params
 * from `/v2/collections/:id/items/:entityId`, that the strict input schema is
 * bound, and — the one that had been silently wrong since 001 — that
 * `entities.get` returns a collection's members in `content.items` instead of
 * the empty array `contentOf` hard-codes.
 *
 * That last point is why this file exists rather than another handler unit
 * test. `content.items` was `[]` for every collection in the product, while
 * `state.itemCount` beside it reported the true number, so the UI's ITEMS
 * block rendered a heading over nothing. Nothing failed, because nothing ever
 * asserted on a populated collection through the real read path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

interface EntityRef { entity: { id: string } }
interface DetailBody {
  data: {
    state: { kind: string; itemCount: number };
    content: { kind: string; items: Array<{ id: string; title: string }> };
  };
}

describe.sequential('collection membership over the production Server', () => {
  let harness: W3PublicServer;
  let spaceId: string;
  let collectionId: string;
  let taskId: string;
  let docId: string;

  beforeAll(async () => {
    harness = await startW3PublicServer('collections');

    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'coll-space', name: 'Collections e2e',
      }),
    );
    spaceId = space.space.id;

    const collection = successData<EntityRef>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'coll-create', spaceId, kind: 'collection',
        title: 'Reading list', content: { description: 'mixed bag' },
      }),
    );
    collectionId = collection.entity.id;

    const task = successData<EntityRef>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'coll-task', spaceId, kind: 'task',
        title: 'A task', content: { priority: 'medium' },
      }),
    );
    taskId = task.entity.id;

    const doc = successData<EntityRef>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'coll-doc', spaceId, kind: 'doc',
        title: 'A doc', content: { body: 'text', format: 'markdown' },
      }),
    );
    docId = doc.entity.id;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  async function detail(): Promise<DetailBody['data']> {
    const response = await harness.request<DetailBody['data']>(
      'GET', `/v2/entities/${collectionId}`,
    );
    return successData<DetailBody['data']>(response);
  }

  it('starts empty, and says so consistently in items AND itemCount', async () => {
    const body = await detail();
    expect(body.content).toMatchObject({ kind: 'collection', items: [] });
    expect(body.state).toMatchObject({ kind: 'collection', itemCount: 0 });
  });

  it('adds entities of DIFFERENT kinds and returns them in content.items', async () => {
    const added = await harness.request('POST', `/v2/collections/${collectionId}/items`, {
      clientMutationId: 'coll-add-task', entityId: taskId,
    });
    expect(added.status).toBe(200);

    await harness.request('POST', `/v2/collections/${collectionId}/items`, {
      clientMutationId: 'coll-add-doc', entityId: docId,
    });

    const body = await detail();
    // The heterogeneity that is the whole point: a task and a doc in one list.
    expect(body.content.items.map((i) => i.id)).toEqual([taskId, docId]);
    expect(body.state.itemCount).toBe(2);
  });

  it('reorders by re-adding at a midpoint, without creating a duplicate', async () => {
    await harness.request('POST', `/v2/collections/${collectionId}/items`, {
      clientMutationId: 'coll-reorder', entityId: docId, position: 0.5,
    });

    const body = await detail();
    expect(body.content.items.map((i) => i.id)).toEqual([docId, taskId]);
    // Still two: the write upserted the existing edge rather than adding one.
    expect(body.state.itemCount).toBe(2);
  });

  it('refuses a position that is not a finite number', async () => {
    const response = await harness.request('POST', `/v2/collections/${collectionId}/items`, {
      clientMutationId: 'coll-bad-position', entityId: taskId, position: 'first',
    });
    expect(response.status).toBe(400);
  });

  it('refuses an unexpected field, because the DTO is strict', async () => {
    const response = await harness.request('POST', `/v2/collections/${collectionId}/items`, {
      clientMutationId: 'coll-strict', entityId: taskId, postion: 3,
    });
    expect(response.status).toBe(400);
  });

  it('removes by pair, and a repeat is a 200 reporting removed:false', async () => {
    const first = await harness.request<{ removed: boolean }>(
      'DELETE', `/v2/collections/${collectionId}/items/${taskId}`,
      { clientMutationId: 'coll-remove-1' },
    );
    expect(first.status).toBe(200);
    expect(successData<{ removed: boolean }>(first).removed).toBe(true);

    const again = await harness.request<{ removed: boolean }>(
      'DELETE', `/v2/collections/${collectionId}/items/${taskId}`,
      { clientMutationId: 'coll-remove-2' },
    );
    expect(again.status).toBe(200);
    expect(successData<{ removed: boolean }>(again).removed).toBe(false);

    const body = await detail();
    expect(body.content.items.map((i) => i.id)).toEqual([docId]);
    expect(body.state.itemCount).toBe(1);
  });

  it('leaves the removed entity itself alive and readable', async () => {
    const response = await harness.request<{ id: string }>('GET', `/v2/entities/${taskId}`);
    expect(response.status).toBe(200);
    expect(successData<{ id: string }>(response).id).toBe(taskId);
  });
});
