import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

interface CommandResult {
  edge?: {
    id: string;
    type: string;
    source: { id: string };
    target: { id: string };
    props: Record<string, unknown>;
    hard?: boolean;
  };
  patches?: Array<{ id: string }>;
  entity?: { id: string };
  undo?: { token: string; label: string; expiresAt: string };
}

describe.sequential('W3.G03 edges and placements through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let taskA = '';
  let taskB = '';
  let taskC = '';
  let firstEdgeId = '';
  let secondEdgeId = '';
  let memberId = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g03');
    const space = successData<{ space: { id: string }; memberId: string }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g03-space',
        name: 'W3 G03 public gate',
      }),
    );
    spaceId = space.space.id;
    memberId = space.memberId;

    const createTask = async (suffix: string): Promise<string> => {
      const result = successData<{ entity: { id: string } }>(
        await harness.request('POST', '/v2/entities', {
          clientMutationId: `w3-g03-task-${suffix}`,
          spaceId,
          kind: 'task',
          title: `G03 task ${suffix}`,
          content: { priority: 'medium' },
        }),
      );
      return result.entity.id;
    };
    taskA = await createTask('a');
    taskB = await createTask('b');
    taskC = await createTask('c');
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

  it('publishes enforced edge-type schemas and refuses client-owned origin before mutation', async () => {
    const types = successData<Array<{
      type: string;
      direction: string;
      propsSchema: Record<string, unknown>;
      acyclic: boolean;
    }>>(await harness.request('GET', '/v2/edge-types'));
    expect(types.length).toBeGreaterThan(0);
    expect(types.find((entry) => entry.type === 'depends_on')).toMatchObject({
      direction: 'directed',
      acyclic: true,
      propsSchema: { type: 'object' },
    });

    const rejected = await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g03-origin-create',
      srcId: taskA,
      dstId: taskB,
      type: 'relates_to',
      props: { origin: 'client' },
    });
    expect(rejected.status).toBe(403);
    expect(errorCode(rejected)).toBe('forbidden');
    const rows = await harness.rows<{ edges: number; ledger: number }>(
      `select
         (select count(*)::integer from public.edges where src_id = $1 and dst_id = $2) edges,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g03-origin-create') ledger`,
      [taskA, taskB],
    );
    expect(rows[0]).toEqual({ edges: 0, ledger: 0 });
  });

  it('creates and replays ordinary edges, then paginates without repeats using a filter-bound cursor', async () => {
    const create = async (dstId: string, cmid: string): Promise<CommandResult> => successData<CommandResult>(
      await harness.request('POST', '/v2/edges', {
        clientMutationId: cmid,
        srcId: taskA,
        dstId,
        type: 'relates_to',
        props: { note: cmid },
      }),
    );
    const first = await create(taskB, 'w3-g03-edge-first');
    const replay = await create(taskB, 'w3-g03-edge-first');
    const second = await create(taskC, 'w3-g03-edge-second');
    expect(first.edge?.id).toBeTruthy();
    expect(replay).toEqual(first);
    expect(second.edge?.id).toBeTruthy();
    firstEdgeId = first.edge!.id;
    secondEdgeId = second.edge!.id;

    const query = `source=${taskA}&direction=outgoing&type=relates_to&limit=1`;
    const firstPage = successData<{
      items: Array<{ id: string; source: { id: string }; target: { id: string } }>;
      nextCursor: string | null;
    }>(await harness.request('GET', `/v2/edges?${query}`));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = successData<typeof firstPage>(
      await harness.request('GET', `/v2/edges?${query}&cursor=${encodeURIComponent(firstPage.nextCursor!)}`),
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((edge) => edge.id))).toEqual(
      new Set([firstEdgeId, secondEdgeId]),
    );
    expect([...firstPage.items, ...secondPage.items].every((edge) => edge.source.id === taskA)).toBe(true);

    const mismatched = await harness.request(
      'GET',
      `/v2/edges?source=${taskA}&direction=outgoing&type=depends_on&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect(mismatched.status).toBe(400);
    expect(errorCode(mismatched)).toBe('invalid_cursor');

    const rows = await harness.rows<{ edges: number; ledger: number }>(
      `select
         (select count(*)::integer from public.edges where id = any($1::uuid[])) edges,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in ('w3-g03-edge-first', 'w3-g03-edge-second')) ledger`,
      [[firstEdgeId, secondEdgeId]],
    );
    expect(rows[0]).toEqual({ edges: 2, ledger: 2 });
  });

  it('patches and deletes through the public commands with DB-observable replay semantics', async () => {
    const patched = successData<CommandResult>(
      await harness.request('PATCH', `/v2/edges/${firstEdgeId}`, {
        clientMutationId: 'w3-g03-edge-patch',
        props: { note: 'patched' },
      }),
    );
    const patchReplay = successData<CommandResult>(
      await harness.request('PATCH', `/v2/edges/${firstEdgeId}`, {
        clientMutationId: 'w3-g03-edge-patch',
        props: { note: 'patched' },
      }),
    );
    expect(patched.edge).toMatchObject({ id: firstEdgeId, props: { note: 'patched' } });
    expect(patchReplay).toEqual(patched);

    const originPatch = await harness.request('PATCH', `/v2/edges/${firstEdgeId}`, {
      clientMutationId: 'w3-g03-origin-patch',
      props: { origin: 'client' },
    });
    expect(originPatch.status).toBe(403);
    expect(errorCode(originPatch)).toBe('forbidden');

    const deleted = successData<CommandResult>(
      await harness.request('DELETE', `/v2/edges/${secondEdgeId}`, {
        clientMutationId: 'w3-g03-edge-delete',
      }),
    );
    const deleteReplay = successData<CommandResult>(
      await harness.request('DELETE', `/v2/edges/${secondEdgeId}`, {
        clientMutationId: 'w3-g03-edge-delete',
      }),
    );
    expect(deleteReplay).toEqual(deleted);

    const rows = await harness.rows<{ first_props: Record<string, unknown>; second_edges: number; ledger: number }>(
      `select
         (select props from public.edges where id = $1) first_props,
         (select count(*)::integer from public.edges where id = $2) second_edges,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in ('w3-g03-edge-patch', 'w3-g03-edge-delete')) ledger`,
      [firstEdgeId, secondEdgeId],
    );
    expect(rows[0]).toEqual({ first_props: { note: 'patched' }, second_edges: 0, ledger: 2 });
  });

  it('applies one normalized hard dependency placement atomically and replays it', async () => {
    const body = {
      clientMutationId: 'w3-g03-placement-depend',
      sourceId: taskB,
      targetId: taskC,
      intent: 'depend',
    };
    const placed = successData<CommandResult>(await harness.request('POST', '/v2/placements', body));
    const replay = successData<CommandResult>(await harness.request('POST', '/v2/placements', body));
    expect(replay).toEqual(placed);
    expect(placed.edge).toMatchObject({
      type: 'depends_on',
      source: { id: taskC },
      target: { id: taskB },
      props: { hard: true },
      hard: true,
    });
    expect(placed.undo?.token).toBeTruthy();

    const rows = await harness.rows<{ edges: number; ledger: number; tokens: number }>(
      `select
         (select count(*)::integer from public.edges
           where src_id = $1 and dst_id = $2 and type = 'depends_on' and props = '{"hard":true}'::jsonb) edges,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g03-placement-depend') ledger,
         (select count(*)::integer from public.undo_tokens where token = $3) tokens`,
      [taskC, taskB, placed.undo!.token],
    );
    expect(rows[0]).toEqual({ edges: 1, ledger: 1, tokens: 1 });
  });

  /**
   * The `embed` branch of `place_entity` (migration 018) posts a message and, in the
   * SAME transaction, issues an undo token whose operation is `messages.delete`.
   * Migration 020 constrains `undo_tokens.operation` to
   * ('edges.delete','entities.move','entities.restore') at INSERT time.
   *
   * G03's own PG fixture applies only 001-015 + 018 and never applies 020, so the
   * constraint is absent there. This harness applies EVERY migration present, so this
   * is the first gate to exercise `embed` against the real chain. The prior G03 PASS
   * covered only the `depend` branch.
   */
  it('applies an embed placement on the full migration chain without rolling back the message', async () => {
    const before = await harness.rows<{ messages: number }>(
      `select (select count(*)::integer from public.entities
                where space_id = $1 and kind = 'message' and deleted_at is null) messages`,
      [spaceId],
    );

    const body = {
      clientMutationId: 'w3-g03-placement-embed',
      sourceId: taskA,
      targetId: taskB,
      intent: 'embed',
    };
    const response = await harness.request<CommandResult>('POST', '/v2/placements', body);

    // Read authoritative state regardless of outcome, so a failure reports whether the
    // posted message survived or was rolled back together with the undo-token insert.
    const after = await harness.rows<{ messages: number; ledger: number; tokens: number }>(
      `select
         (select count(*)::integer from public.entities
           where space_id = $1 and kind = 'message' and deleted_at is null) messages,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g03-placement-embed') ledger,
         (select count(*)::integer from public.undo_tokens
           where operation = 'messages.delete') tokens`,
      [spaceId],
    );

    expect({
      status: response.status,
      errorCode: response.body.error?.code ?? null,
      errorMessage: response.body.error?.message ?? null,
      messagesBefore: before[0]?.messages,
      messagesAfter: after[0]?.messages,
      ledger: after[0]?.ledger,
      messageDeleteTokens: after[0]?.tokens,
    }).toMatchObject({ status: 200, errorCode: null });

    const placed = successData<CommandResult>(response);
    expect(placed.undo?.token).toBeTruthy();
    expect(after[0]).toMatchObject({
      messages: (before[0]?.messages ?? 0) + 1,
      ledger: 1,
      tokens: 1,
    });

    // Redeem the truthful `messages.delete` inverse and prove the tombstone is a
    // STATE TRANSITION, not a destructive delete: thread history must survive.
    const messageId = placed.entity?.id ?? '';
    expect(messageId).toBeTruthy();
    successData<CommandResult>(
      await harness.request('POST', '/v2/undo', {
        token: placed.undo!.token,
        actorId: memberId,
        clientMutationId: 'w3-g03-embed-undo',
      }),
    );

    const tombstone = await harness.rows<{
      entity_alive: number;
      message_row: number;
      body: string | null;
      mentions: string | null;
      attachments: string | null;
      redacted: number;
    }>(
      `select
         (select count(*)::integer from public.entities
           where id = $1 and deleted_at is null) entity_alive,
         (select count(*)::integer from public.messages where entity_id = $1) message_row,
         (select body from public.messages where entity_id = $1) body,
         (select mentions::text from public.messages where entity_id = $1) mentions,
         (select attachments::text from public.messages where entity_id = $1) attachments,
         (select count(*)::integer from public.messages
           where entity_id = $1 and redacted_at is not null) redacted`,
      [messageId],
    );
    expect(tombstone[0]).toMatchObject({
      entity_alive: 1,
      message_row: 1,
      body: '[redacted]',
      mentions: '[]',
      attachments: '[]',
      redacted: 1,
    });
  });

  it('rejects malformed and invalid-schema edge writes without durable effects', async () => {
    const invalidProps = await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g03-invalid-props',
      srcId: taskA,
      dstId: taskB,
      type: 'depends_on',
      props: { hard: 'yes' },
    });
    expect(invalidProps.status).toBe(400);
    expect(errorCode(invalidProps)).toBe('invalid_input');

    const unknown = await harness.request('POST', '/v2/placements', {
      clientMutationId: 'w3-g03-invalid-placement',
      sourceId: taskA,
      targetId: taskB,
      intent: 'depend',
      unknownField: true,
    });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe('invalid_input');

    const rows = await harness.rows<{ ledger: number }>(
      `select count(*)::integer ledger from public.command_ledger
        where client_mutation_id in ('w3-g03-invalid-props', 'w3-g03-invalid-placement')`,
    );
    expect(rows[0]?.ledger).toBe(0);
  });
});
