import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

describe.sequential('W3.G08 inbox and read marks through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let memberId = '';
  let teammateId = '';
  let anchorId = '';
  const memberNotificationIds = [randomUUID(), randomUUID()];
  const teammateNotificationIds = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    harness = await startW3PublicServer('g08');
    const space = successData<{ space: { id: string }; memberId: string }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g08-space',
        name: 'W3 G08 public gate',
      }),
    );
    spaceId = space.space.id;
    memberId = space.memberId;
    const anchor = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g08-anchor',
        spaceId,
        kind: 'task',
        title: 'Inbox anchor',
        content: { priority: 'medium' },
      }),
    );
    anchorId = anchor.entity.id;
    const teammate = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g08-teammate',
        spaceId,
        kind: 'team_member',
        title: 'Inbox teammate',
        content: {
          identity: 'G08 public recipient.',
          model: 'claude-sonnet-5',
          agentTool: 'claude-code',
        },
      }),
    );
    teammateId = teammate.entity.id;

    // Infrastructure fixture only: the public operations under test are inbox
    // projection/read-state commands, while notification production belongs to
    // later message/delivery groups. Assertions accept only the public reads and
    // writes below as G08 evidence.
    await harness.database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.notifications(
           id, space_id, recipient_member_id, recipient_team_member_id,
           target_entity_id, actor_id, kind, payload, created_at)
         values
           ($1, $5, $6, null, $7, $6, 'mention', '{"message":"member-new"}', '2026-07-26T12:00:00Z'),
           ($2, $5, $6, null, $7, $6, 'message_reply', '{"message":"member-old"}', '2026-07-26T11:00:00Z'),
           ($3, $5, $6, $8, $7, $6, 'assignment', '{"message":"teammate-new"}', '2026-07-26T10:00:00Z'),
           ($4, $5, $6, $8, $7, $6, 'session_delivery_failed', '{"message":"teammate-old"}', '2026-07-26T09:00:00Z')`,
        [
          memberNotificationIds[0],
          memberNotificationIds[1],
          teammateNotificationIds[0],
          teammateNotificationIds[1],
          spaceId,
          memberId,
          anchorId,
          teammateId,
        ],
      );
    });
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

  it('keeps personal and Teammate recipient pages separate with fingerprinted cursors', async () => {
    const personalFirst = successData<{
      items: Array<{ id: string; recipient: { id: string }; readAt: string | null }>;
      nextCursor: string | null;
    }>(await harness.request('GET', `/v2/inbox?spaceId=${spaceId}&limit=1`));
    expect(personalFirst.items).toHaveLength(1);
    expect(personalFirst.items[0]).toMatchObject({
      id: memberNotificationIds[0],
      recipient: { id: memberId },
      readAt: null,
    });
    expect(personalFirst.nextCursor).toBeTruthy();

    const personalSecond = successData<typeof personalFirst>(
      await harness.request(
        'GET',
        `/v2/inbox?spaceId=${spaceId}&limit=1&cursor=${encodeURIComponent(personalFirst.nextCursor!)}`,
      ),
    );
    expect(personalSecond.items[0]?.id).toBe(memberNotificationIds[1]);

    const recipient = encodeURIComponent(JSON.stringify({
      type: 'team_member',
      teamMemberId: teammateId,
    }));
    const teammatePage = successData<{
      items: Array<{ id: string; recipient: { id: string }; readAt: string | null }>;
      nextCursor: string | null;
    }>(await harness.request('GET', `/v2/inbox?recipient=${recipient}&spaceId=${spaceId}`));
    expect(teammatePage.items.map((item) => item.id)).toEqual(teammateNotificationIds);
    expect(teammatePage.items.every((item) => item.recipient.id === teammateId)).toBe(true);
    expect(teammatePage.items.every((item) => item.readAt === null)).toBe(true);

    const mismatched = await harness.request(
      'GET',
      `/v2/inbox?recipient=${recipient}&spaceId=${spaceId}&limit=1&cursor=${encodeURIComponent(personalFirst.nextCursor!)}`,
    );
    expect(mismatched.status).toBe(400);
    expect(errorCode(mismatched)).toBe('invalid_cursor');
  });

  it('marks one personal notification read idempotently without changing Teammate state', async () => {
    const first = successData<{ id: string; recipient: { id: string }; readAt: string | null }>(
      await harness.request('PUT', `/v2/inbox/${memberNotificationIds[0]}/read`, {
        clientMutationId: 'w3-g08-member-read',
      }),
    );
    expect(first.id).toBe(memberNotificationIds[0]);
    expect(first.recipient.id).toBe(memberId);
    expect(first.readAt).toBeTruthy();

    const replay = successData<typeof first>(
      await harness.request('PUT', `/v2/inbox/${memberNotificationIds[0]}/read`, {
        clientMutationId: 'w3-g08-member-read',
      }),
    );
    expect(replay).toEqual(first);

    const unread = successData<{ items: Array<{ id: string }> }>(
      await harness.request('GET', `/v2/inbox?spaceId=${spaceId}&unread=true`),
    );
    expect(unread.items.map((item) => item.id)).not.toContain(memberNotificationIds[0]);
    expect(unread.items.map((item) => item.id)).toContain(memberNotificationIds[1]);

    const rows = await harness.rows<{
      member_read: boolean;
      teammate_read: boolean;
      ledger_rows: number;
    }>(
      `select
         (select read_at is not null from public.notifications where id = $1) member_read,
         (select bool_or(read_at is not null) from public.notifications
           where id = any($2::uuid[])) teammate_read,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g08-member-read') ledger_rows`,
      [memberNotificationIds[0], teammateNotificationIds],
    );
    expect(rows[0]).toEqual({ member_read: true, teammate_read: false, ledger_rows: 1 });
  });

  it('refuses owner inspection from mutating a Teammate read state', async () => {
    const response = await harness.request('PUT', `/v2/inbox/${teammateNotificationIds[0]}/read`, {
      clientMutationId: 'w3-g08-owner-cannot-read-teammate',
      recipient: { type: 'team_member', teamMemberId: teammateId },
    });
    expect(response.status).toBe(404);
    expect(errorCode(response)).toBe('not_found');

    const rows = await harness.rows<{ read: boolean; ledger_rows: number }>(
      `select
         (select read_at is not null from public.notifications where id = $1) read,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g08-owner-cannot-read-teammate') ledger_rows`,
      [teammateNotificationIds[0]],
    );
    expect(rows[0]).toEqual({ read: false, ledger_rows: 0 });
  });

  it('advances a Member read mark through the public command and replays one timestamp', async () => {
    const first = successData<{ anchorId: string; lastReadAt: string }>(
      await harness.request('PUT', `/v2/read-marks/${anchorId}`, {
        clientMutationId: 'w3-g08-read-mark',
      }),
    );
    const replay = successData<typeof first>(
      await harness.request('PUT', `/v2/read-marks/${anchorId}`, {
        clientMutationId: 'w3-g08-read-mark',
      }),
    );
    expect(first.anchorId).toBe(anchorId);
    expect(Date.parse(first.lastReadAt)).not.toBeNaN();
    expect(replay).toEqual(first);

    const rows = await harness.rows<{ read_marks: number; ledger_rows: number }>(
      `select
         (select count(*)::integer from public.read_marks
           where member_id = $1 and anchor_id = $2) read_marks,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g08-read-mark') ledger_rows`,
      [memberId, anchorId],
    );
    expect(rows[0]).toEqual({ read_marks: 1, ledger_rows: 1 });
  });

  it('rejects unknown query fields and malformed command bodies before mutation', async () => {
    const query = await harness.request('GET', `/v2/inbox?spaceId=${spaceId}&unknown=true`);
    expect(query.status).toBe(400);
    expect(errorCode(query)).toBe('invalid_input');

    const body = await harness.request('PUT', `/v2/read-marks/${anchorId}`, {
      clientMutationId: 'w3-g08-invalid',
      unknownField: true,
    });
    expect(body.status).toBe(400);
    expect(errorCode(body)).toBe('invalid_input');

    const rows = await harness.rows<{ ledger_rows: number }>(
      `select count(*)::integer ledger_rows from public.command_ledger
        where client_mutation_id = 'w3-g08-invalid'`,
    );
    expect(rows[0]?.ledger_rows).toBe(0);
  });
});
