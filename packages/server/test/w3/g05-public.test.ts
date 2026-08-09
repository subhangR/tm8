import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

describe.sequential('W3.G05 collections, graph, and undo through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let memberId = '';
  const taskIds: string[] = [];
  let dependencyEdgeId = '';
  let undoToken = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g05');
    const space = successData<{ space: { id: string }; memberId: string }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g05-space',
        name: 'W3 G05 public gate',
      }),
    );
    spaceId = space.space.id;
    memberId = space.memberId;
    for (const [index, title] of ['Alpha', 'Beta', 'Gamma'].entries()) {
      const task = successData<{ entity: { id: string } }>(
        await harness.request('POST', '/v2/entities', {
          clientMutationId: `w3-g05-task-${index}`,
          spaceId,
          kind: 'task',
          title,
          content: { priority: index === 0 ? 'high' : 'medium' },
        }),
      );
      taskIds.push(task.entity.id);
    }
  }, 120_000);

  // 30s -> 120s. `harness.close()` ends with `database.destroy()`, which DROPS a
  // scratch database, and a drop is exactly the operation that slows down under
  // the parallel load this suite runs in — w2-execution.pg.test.ts measured the
  // same thing and raised its own teardown budget for it. All twenty w3 suites
  // shared this 30s, so whichever one lost the race reported `Hook timed out in
  // 30000ms` and the identity of the loser rotated between runs. A larger budget
  // costs nothing when teardown is fast.
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

  it('returns stable keyset collection pages and binds cursors to the normalized query', async () => {
    const first = successData<{
      query: { spaceId: string; sort: string; limit: number };
      page: { items: Array<{ id: string }>; nextCursor: string | null };
    }>(await harness.request('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['task'],
      sort: 'createdAt_desc',
      limit: 1,
    }));
    expect(first.query).toMatchObject({ spaceId, sort: 'createdAt_desc', limit: 1 });
    expect(first.page.items).toHaveLength(1);
    expect(first.page.nextCursor).toBeTruthy();

    const second = successData<typeof first>(await harness.request('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['task'],
      sort: 'createdAt_desc',
      limit: 1,
      cursor: first.page.nextCursor,
    }));
    expect(second.page.items).toHaveLength(1);
    expect(second.page.items[0]?.id).not.toBe(first.page.items[0]?.id);

    const mismatched = await harness.request('POST', '/v2/collections/query', {
      spaceId,
      kinds: ['task'],
      sort: 'activityAt_desc',
      limit: 1,
      cursor: first.page.nextCursor,
    });
    expect(mismatched.status).toBe(400);
    expect(errorCode(mismatched)).toBe('invalid_cursor');
  });

  it('returns a bounded live graph lens over public edge state', async () => {
    const firstEdge = successData<{
      edge: { id: string };
      undo?: { token: string };
    }>(await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g05-edge-a-b',
      srcId: taskIds[0],
      dstId: taskIds[1],
      type: 'depends_on',
      props: { hard: true },
    }));
    dependencyEdgeId = firstEdge.edge.id;
    undoToken = firstEdge.undo?.token ?? '';
    expect(undoToken.length).toBeGreaterThanOrEqual(8);

    successData(await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g05-edge-b-c',
      srcId: taskIds[1],
      dstId: taskIds[2],
      type: 'depends_on',
      props: { hard: false },
    }));

    const graph = successData<{
      nodes: Array<{ id: string }>;
      edges: Array<{ id: string; type: string }>;
      clusters: unknown[];
    }>(await harness.request('POST', '/v2/graph/query', {
      spaceId,
      kinds: ['task'],
      focusId: taskIds[0],
      hops: 2,
      edgeTypes: ['depends_on'],
      mode: 'dependency',
      limit: 10,
    }));
    expect(graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(taskIds));
    expect(graph.edges.map((edge) => edge.id)).toContain(dependencyEdgeId);
    expect(graph.edges.every((edge) => edge.type === 'depends_on')).toBe(true);
    expect(graph.nodes.length).toBeLessThanOrEqual(10);
  });

  it('redeems one registered undo token idempotently and persists one inverse', async () => {
    const undone = successData<{ patches: unknown[] }>(
      await harness.request('POST', '/v2/undo', {
        token: undoToken,
        actorId: memberId,
        clientMutationId: 'w3-g05-undo-edge',
      }),
    );
    const replay = successData<typeof undone>(
      await harness.request('POST', '/v2/undo', {
        token: undoToken,
        actorId: memberId,
        clientMutationId: 'w3-g05-undo-edge',
      }),
    );
    expect(replay).toEqual(undone);

    const differentMutation = await harness.request('POST', '/v2/undo', {
      token: undoToken,
      actorId: memberId,
      clientMutationId: 'w3-g05-undo-edge-different',
    });
    expect(differentMutation.status).toBe(409);
    expect(errorCode(differentMutation)).toBe('invariant_violation');

    const rows = await harness.rows<{
      edges: number;
      ledger_rows: number;
      redemption_client_mutation_id: string;
    }>(
      `select
         (select count(*)::integer from public.edges where id = $1) edges,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g05-undo-edge') ledger_rows,
         redemption_client_mutation_id
       from public.undo_tokens where token = $2`,
      [dependencyEdgeId, undoToken],
    );
    expect(rows[0]).toEqual({
      edges: 0,
      ledger_rows: 1,
      redemption_client_mutation_id: 'w3-g05-undo-edge',
    });
  });

  it('rejects malformed graph and undo inputs before a database effect', async () => {
    const graph = await harness.request('POST', '/v2/graph/query', {
      spaceId,
      focusId: taskIds[0],
      hops: 4,
    });
    expect(graph.status).toBe(400);
    expect(errorCode(graph)).toBe('invalid_input');

    const undo = await harness.request('POST', '/v2/undo', {
      token: 'short',
      clientMutationId: 'w3-g05-invalid-undo',
    });
    expect(undo.status).toBe(400);
    expect(errorCode(undo)).toBe('invalid_input');

    const rows = await harness.rows<{ ledger_rows: number }>(
      `select count(*)::integer ledger_rows from public.command_ledger
        where client_mutation_id = 'w3-g05-invalid-undo'`,
    );
    expect(rows[0]?.ledger_rows).toBe(0);
  });
});
