import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from './public-harness.js';

/**
 * `entities.context` -> `entities.children` continuation.
 *
 * `cursors.children` from `entities.context` is advertised as the token that
 * continues the children section, and the operation that consumes it is
 * `entities.children --cursor`. That endpoint keys its cursor as
 * `[fingerprint('entities.children', {parentId}), position, id]` and rejects
 * anything else. Context used to emit `[position, id]` — a well-formed token
 * the continuing operation answered with `invalid_cursor`, so every parent with
 * more than one section's worth of children was unreachable past row 50.
 *
 * Asserted as EXACTLY-ONCE and COMPLETE against the unpaged truth, not merely
 * "accepted": a token that is accepted but resumes at the wrong row is the
 * quieter failure. Positions are forced into ties so the `id` half of the
 * keyset carries the ordering across page boundaries too.
 */
describe.sequential('entities.context children cursor continues in entities.children', () => {
  let harness: W3PublicServer;
  let parentId = '';
  /** More than the context section's 50-row cap. */
  const CHILDREN = 57;

  beforeAll(async () => {
    harness = await startW3PublicServer('ctxchildren');
    const space = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'ctxchildren-space',
        name: 'context children cursor Space',
      }),
    );
    const parent = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'ctxchildren-parent',
        spaceId: space.space.id,
        kind: 'task',
        title: 'context children cursor parent',
        content: { priority: 'medium' },
      }),
    );
    parentId = parent.entity.id;

    for (let index = 0; index < CHILDREN; index += 1) {
      successData(await harness.request('POST', '/v2/entities', {
        clientMutationId: `ctxchildren-child-${index}`,
        spaceId: space.space.id,
        parentId,
        kind: 'task',
        title: `child ${index}`,
        content: { priority: 'low' },
      }));
    }
    // Five children per position: ties at every page boundary, ordered by id.
    await harness.rows(
      `update public.entities e
          set position = floor(r.n / 5)
         from (select id, row_number() over (order by id) - 1 n
                 from public.entities where parent_id = $1) r
        where e.id = r.id`,
      [parentId],
    );
  }, 300_000);

  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it('pages every child exactly once, starting from the context cursor', async () => {
    const truth = (await harness.rows<{ id: string }>(
      `select id from public.entities
        where parent_id = $1 and deleted_at is null
        order by position, id`,
      [parentId],
    )).map((row) => row.id);
    expect(truth).toHaveLength(CHILDREN);

    const context = successData<{
      children: Array<{ id: string }>;
      cursors: Record<string, string | null>;
    }>(await harness.request('GET', `/v2/entities/${parentId}/context?sections=hierarchy`));
    const seen = context.children.map((child) => child.id);
    expect(seen.length).toBeLessThan(CHILDREN);
    let cursor = context.cursors['children'] ?? null;
    expect(cursor, 'context emitted no children continuation for an overfull parent').toBeTruthy();

    for (let pages = 0; cursor && pages < CHILDREN; pages += 1) {
      const response = await harness.request<{ items: Array<{ id: string }>; nextCursor: string | null }>(
        'GET',
        `/v2/entities/${parentId}/children?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const page = successData<{ items: Array<{ id: string }>; nextCursor: string | null }>(response);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }

    expect(cursor, 'paging did not terminate').toBeNull();
    expect(seen).toEqual(truth);
  }, 120_000);
});
