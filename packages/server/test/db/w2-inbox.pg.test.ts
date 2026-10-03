import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identityA: string;
  identityB: string;
  spaceA: string;
  spaceB: string;
  memberA: string;
  memberAInB: string;
  memberB: string;
  teammateA: string;
  teammateAInB: string;
  teammateB: string;
  liveAnchor: string;
  otherAnchor: string;
  restrictedAnchor: string;
  deletedAnchor: string;
  memberNotification: string;
  teammateNotification: string;
  otherTeammateNotification: string;
  fallbackMemberNotification: string;
  fallbackTeammateNotification: string;
  crossSpaceMemberNotification: string;
}

interface NotificationRecord {
  id: string;
  recipient_member_id: string;
  recipient_team_member_id: string | null;
  target_entity_id: string | null;
  kind: string;
  read_at: string | null;
  created_at: string;
}

const BASELINE_MIGRATIONS = Array.from({ length: 15 }, (_, index) =>
  `${String(index + 1).padStart(3, '0')}_`,
);

function explicitG08Migrations(): string[] {
  const files = migrationFiles();
  const baseline = BASELINE_MIGRATIONS.map((prefix) => {
    const file = files.find((candidate) => candidate.startsWith(prefix));
    if (!file) throw new Error(`missing baseline migration ${prefix}`);
    return file;
  });
  return [...baseline, '023_w2_inbox.sql', '123_teammate_read_cursor.sql'];
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'g08-identity-a'::text as "identityA",
              'g08-identity-b'::text as "identityB",
              internal.new_id()::text as "spaceA",
              internal.new_id()::text as "spaceB",
              internal.new_id()::text as "memberA",
              internal.new_id()::text as "memberAInB",
              internal.new_id()::text as "memberB",
              internal.new_id()::text as "teammateA",
              internal.new_id()::text as "teammateAInB",
              internal.new_id()::text as "teammateB",
              internal.new_id()::text as "liveAnchor",
              internal.new_id()::text as "otherAnchor",
              internal.new_id()::text as "restrictedAnchor",
              internal.new_id()::text as "deletedAnchor",
              internal.new_id()::text as "memberNotification",
              internal.new_id()::text as "teammateNotification",
              internal.new_id()::text as "otherTeammateNotification",
              internal.new_id()::text as "fallbackMemberNotification",
              internal.new_id()::text as "fallbackTeammateNotification",
              internal.new_id()::text as "crossSpaceMemberNotification"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G08 Owner'), ($2, 'G08 Other Admin')`,
      [fixture.identityA, fixture.identityB],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G08 A', $3), ($2, 'G08 B', $3)`,
      [fixture.spaceA, fixture.spaceB, fixture.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility, deleted_at)
       values
         ($1, $10, 'member', $1, 'space', null),
         ($2, $11, 'member', $2, 'space', null),
         ($3, $10, 'member', $3, 'space', null),
         ($4, $10, 'team_member', $1, 'space', null),
         ($5, $11, 'team_member', $2, 'space', null),
         ($6, $10, 'team_member', $3, 'space', null),
         ($7, $10, 'channel', $1, 'space', null),
         ($8, $10, 'channel', $1, 'space', null),
         ($9, $10, 'channel', $1, 'restricted', null),
         ($12, $10, 'channel', $1, 'space', now())`,
      [
        fixture.memberA,
        fixture.memberAInB,
        fixture.memberB,
        fixture.teammateA,
        fixture.teammateAInB,
        fixture.teammateB,
        fixture.liveAnchor,
        fixture.otherAnchor,
        fixture.restrictedAnchor,
        fixture.spaceA,
        fixture.spaceB,
        fixture.deletedAnchor,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'G08 Owner A'),
              ($2, $5, $6, 'owner', 'G08 Owner B'),
              ($3, $4, $7, 'admin', 'G08 Other Admin')`,
      [
        fixture.memberA,
        fixture.memberAInB,
        fixture.memberB,
        fixture.spaceA,
        fixture.spaceB,
        fixture.identityA,
        fixture.identityB,
      ],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name)
       values ($1, $4, 'Scout A'), ($2, $5, 'Scout B'), ($3, $6, 'Other Scout')`,
      [
        fixture.teammateA,
        fixture.teammateAInB,
        fixture.teammateB,
        fixture.memberA,
        fixture.memberAInB,
        fixture.memberB,
      ],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1, $5, 'live', ''), ($2, $5, 'other', ''),
              ($3, $5, 'restricted', ''), ($4, $5, 'deleted', '')`,
      [
        fixture.liveAnchor,
        fixture.otherAnchor,
        fixture.restrictedAnchor,
        fixture.deletedAnchor,
        fixture.spaceA,
      ],
    );
    await client.query(
      `insert into public.notifications(
         id, space_id, recipient_member_id, recipient_team_member_id,
         target_entity_id, kind, payload, created_at)
       values
         ($1, $10, $6, null, $4, 'mention', '{"message":"personal"}', '2026-07-26T12:00:00Z'),
         ($2, $10, $6, $7, $4, 'assignment', '{}', '2026-07-26T11:00:00Z'),
         ($3, $10, $8, $9, $5, 'assignment', '{}', '2026-07-26T10:00:00Z'),
         ($11, $10, $6, null, $4, 'message_reply', '{"messageId":"stored-message"}', '2026-07-26T09:00:00Z'),
         ($12, $10, $6, $7, $4, 'session_delivery_failed', '{"deliveryStatus":"unknown"}', '2026-07-26T08:00:00Z'),
         ($13, $14, $15, null, null, 'mention', '{}', '2026-07-26T07:00:00Z')`,
      [
        fixture.memberNotification,
        fixture.teammateNotification,
        fixture.otherTeammateNotification,
        fixture.liveAnchor,
        fixture.otherAnchor,
        fixture.memberA,
        fixture.teammateA,
        fixture.memberB,
        fixture.teammateB,
        fixture.spaceA,
        fixture.fallbackMemberNotification,
        fixture.fallbackTeammateNotification,
        fixture.crossSpaceMemberNotification,
        fixture.spaceB,
        fixture.memberAInB,
      ],
    );
    return fixture;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identityId: string,
  actorId: string | null,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', $2, true)`,
      [identityId, actorId ?? ''],
    );
    return fn(client);
  });
}

async function notification(
  database: W1ScratchDatabase,
  id: string,
): Promise<NotificationRecord> {
  return (await database.query<NotificationRecord>(
    `select id::text, recipient_member_id::text, recipient_team_member_id::text,
            target_entity_id::text, kind, read_at::text, created_at::text
       from public.notifications where id = $1`,
    [id],
  ))[0]!;
}

describe.sequential('W2.G08 inbox and read-mark PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g08');
    database.apply(explicitG08Migrations());
    fixture = await seed(database);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('adds the ledgered read RPC overloads while closing the legacy unledgered write', async () => {
    const rows = await database.query<{
      signature: string;
      app_exec: boolean;
      public_exec: boolean;
    }>(
      `select p.oid::regprocedure::text signature,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('mark_read', 'mark_notification_read', 'inspect_owned_teammate_inbox')
        order by signature`,
    );
    const bySignature = new Map(rows.map((row) => [row.signature, row]));
    expect(bySignature.get('mark_read(uuid,text)')).toMatchObject({ app_exec: true, public_exec: false });
    expect(bySignature.get('mark_notification_read(uuid,text,uuid,text)')).toMatchObject({
      app_exec: true,
      public_exec: false,
    });
    expect(bySignature.get('mark_notification_read(uuid)')).toMatchObject({
      app_exec: false,
      public_exec: false,
    });
    expect(bySignature.has('inspect_owned_teammate_inbox(uuid,uuid,boolean,timestamp with time zone,uuid,integer)')).toBe(true);
  });

  it('keeps one semantic recipient arm, enforces owner routing, and uses all four partial indexes', async () => {
    const arms = await database.query<{ invalid: number }>(
      `select count(*) filter (
                where recipient_member_id is null
                   or (case when recipient_team_member_id is null
                            then recipient_member_id
                            else recipient_team_member_id end) is null
              )::integer invalid
         from public.notifications`,
    );
    expect(arms[0]!.invalid).toBe(0);

    await expect(database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.notifications(
           space_id, recipient_member_id, recipient_team_member_id, target_entity_id, kind)
         values ($1, $2, $3, $4, 'session_delivery_failed')`,
        [fixture.spaceA, fixture.memberB, fixture.teammateA, fixture.liveAnchor],
      );
    })).rejects.toMatchObject({ code: '23514' });

    const plans = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('set local enable_seqscan = off');
      const queries = [
        [`select id from public.notifications where recipient_member_id = $1
            and recipient_team_member_id is null order by created_at desc, id desc limit 20`, fixture.memberA],
        [`select id from public.notifications where recipient_member_id = $1
            and recipient_team_member_id is null and read_at is null
            order by created_at desc, id desc limit 20`, fixture.memberA],
        [`select id from public.notifications where recipient_team_member_id = $1
            order by created_at desc, id desc limit 20`, fixture.teammateA],
        [`select id from public.notifications where recipient_team_member_id = $1 and read_at is null
            order by created_at desc, id desc limit 20`, fixture.teammateA],
      ] as const;
      const output: string[] = [];
      for (const [sql, id] of queries) {
        const explained = await client.query(`explain (format json, costs off) ${sql}`, [id]);
        output.push(JSON.stringify(explained.rows[0]));
      }
      return output;
    });
    expect(plans[0]).toContain('notifications_member_personal_cursor_idx');
    expect(plans[1]).toContain('notifications_member_personal_unread_idx');
    expect(plans[2]).toContain('notifications_teammate_cursor_idx');
    expect(plans[3]).toContain('notifications_teammate_unread_idx');
  });

  it('separates Member and actor-claim Teammate pages and keeps owner inspection read-only', async () => {
    const personal = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ id: string }>(
        `select id::text from public.notifications order by created_at desc, id desc`,
      )
    ).rows.map((row) => row.id));
    expect(personal).toContain(fixture.memberNotification);
    expect(personal).toContain(fixture.fallbackMemberNotification);
    expect(personal).toContain(fixture.crossSpaceMemberNotification);
    expect(personal).not.toContain(fixture.teammateNotification);
    expect(personal).not.toContain(fixture.fallbackTeammateNotification);

    const teammate = await asApp(database, fixture.identityA, fixture.teammateA, async (client) => (
      await client.query<{ id: string }>(
        `select id::text from public.notifications order by created_at desc, id desc`,
      )
    ).rows.map((row) => row.id));
    expect(teammate).toContain(fixture.teammateNotification);
    expect(teammate).toContain(fixture.fallbackTeammateNotification);
    expect(teammate).not.toContain(fixture.memberNotification);

    const inspected = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ id: string; read_at: string | null }>(
        `select id::text, read_at::text
           from public.inspect_owned_teammate_inbox($1, null, false, null, null, 100)`,
        [fixture.teammateA],
      )
    ).rows);
    expect(inspected.map((row) => row.id)).toContain(fixture.teammateNotification);
    expect(inspected.every((row) => row.read_at === null)).toBe(true);
    expect((await notification(database, fixture.teammateNotification)).read_at).toBeNull();

    const unreadInSpace = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ id: string }>(
        `select id::text
           from public.inspect_owned_teammate_inbox($1, $2, true, null, null, 100)`,
        [fixture.teammateA, fixture.spaceA],
      )
    ).rows.map((row) => row.id));
    expect(unreadInSpace).toContain(fixture.teammateNotification);
    const wrongSpace = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ id: string }>(
        `select id::text
           from public.inspect_owned_teammate_inbox($1, $2, true, null, null, 100)`,
        [fixture.teammateA, fixture.spaceB],
      )
    ).rows);
    expect(wrongSpace).toEqual([]);
    const afterCursor = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ id: string }>(
        `select id::text
           from public.inspect_owned_teammate_inbox(
             $1, null, false, '2026-07-26T11:00:00Z', $2, 100)`,
        [fixture.teammateA, fixture.teammateNotification],
      )
    ).rows.map((row) => row.id));
    expect(afterCursor).not.toContain(fixture.teammateNotification);
    expect(afterCursor).toContain(fixture.fallbackTeammateNotification);

    const unrelated = await asApp(database, fixture.identityB, null, async (client) => (
      await client.query<{ id: string }>(
        `select id::text
           from public.inspect_owned_teammate_inbox($1, null, false, null, null, 100)`,
        [fixture.teammateA],
      )
    ).rows);
    expect(unrelated).toEqual([]);
    const fabricated = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ id: string }>(
        `select id::text
           from public.inspect_owned_teammate_inbox($1, null, false, null, null, 100)`,
        [randomUUID()],
      )
    ).rows);
    expect(fabricated).toEqual([]);
  });

  it('authorizes the selected recipient before notification lookup and marks only that recipient copy', async () => {
    const memberMutation = `g08-member-mark-${randomUUID()}`;
    const first = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ result: NotificationRecord }>(
        `select public.mark_notification_read($1, 'member', $2, $3) result`,
        [fixture.memberNotification, fixture.memberA, memberMutation],
      )
    ).rows[0]!.result);
    const replay = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ result: NotificationRecord }>(
        `select public.mark_notification_read($1, 'member', $2, $3) result`,
        [fixture.memberNotification, fixture.memberA, memberMutation],
      )
    ).rows[0]!.result);
    expect(replay).toEqual(first);
    expect(first.read_at).not.toBeNull();
    expect((await notification(database, fixture.teammateNotification)).read_at).toBeNull();

    for (const notificationId of [fixture.memberNotification, randomUUID()]) {
      await expect(asApp(database, fixture.identityB, null, (client) => client.query(
        `select public.mark_notification_read($1, 'member', $2, $3)`,
        [notificationId, fixture.memberA, `g08-unrelated-${randomUUID()}`],
      ))).rejects.toMatchObject({ code: 'P0002' });
    }
    expect((await notification(database, fixture.teammateNotification)).read_at).toBeNull();

    await expect(asApp(database, fixture.identityA, null, (client) => client.query(
      `select public.mark_notification_read($1, 'team_member', $2, $3)`,
      [fixture.teammateNotification, fixture.teammateA, `g08-owner-cannot-mark-${randomUUID()}`],
    ))).rejects.toMatchObject({ code: 'P0002' });

    const teamMutation = `g08-team-mark-${randomUUID()}`;
    const [teamFirst, teamReplay] = await Promise.all([0, 1].map(() =>
      asApp(database, fixture.identityA, fixture.teammateA, async (client) => (
        await client.query<{ result: NotificationRecord }>(
          `select public.mark_notification_read($1, 'team_member', $2, $3) result`,
          [fixture.teammateNotification, fixture.teammateA, teamMutation],
        )
      ).rows[0]!.result),
    ));
    expect(teamReplay).toEqual(teamFirst);
    expect(teamFirst.read_at).not.toBeNull();
    expect((await notification(database, fixture.otherTeammateNotification)).read_at).toBeNull();
  });

  it('keeps Member and acting-Teammate cursors disjoint and monotonic', async () => {
    const firstMutation = `g08-read-mark-${randomUUID()}`;
    const first = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ result: { anchorId: string; lastReadAt: string; patches: unknown[] } }>(
        `select public.mark_read($1, $2) result`,
        [fixture.liveAnchor, firstMutation],
      )
    ).rows[0]!.result);
    const replay = await asApp(database, fixture.identityA, null, async (client) => (
      await client.query<{ result: typeof first }>(
        `select public.mark_read($1, $2) result`,
        [fixture.liveAnchor, firstMutation],
      )
    ).rows[0]!.result);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ anchorId: fixture.liveAnchor, patches: [] });
    expect((await notification(database, fixture.memberNotification)).read_at).not.toBeNull();
    expect((await notification(database, fixture.fallbackMemberNotification)).read_at).not.toBeNull();
    expect((await notification(database, fixture.fallbackTeammateNotification)).read_at).toBeNull();

    const raced = await Promise.all([0, 1, 2].map(() =>
      asApp(database, fixture.identityA, null, async (client) => (
        await client.query<{ result: { lastReadAt: string } }>(
          `select public.mark_read($1, $2) result`,
          [fixture.liveAnchor, `g08-read-race-${randomUUID()}`],
        )
      ).rows[0]!.result),
    ));
    const stored = (await database.query<{ last_read_at: string }>(
      `select last_read_at::text from public.read_marks
        where member_id = $1 and anchor_id = $2`,
      [fixture.memberA, fixture.liveAnchor],
    ))[0]!;
    const maxResult = Math.max(...raced.map((result) => Date.parse(result.lastReadAt)));
    expect(Date.parse(stored.last_read_at)).toBeGreaterThanOrEqual(maxResult);

    const teammateMutation = `g08-teammate-read-${randomUUID()}`;
    const teammateResult = await asApp(database, fixture.identityA, fixture.teammateA, async (client) => (
      await client.query<{ result: { anchorId: string; lastReadAt: string; patches: unknown[] } }>(
        `select public.mark_read($1, $2) result`,
        [fixture.otherAnchor, teammateMutation],
      )
    ).rows[0]!.result);
    expect(teammateResult).toMatchObject({ anchorId: fixture.otherAnchor, patches: [] });
    const teammateReplay = await asApp(database, fixture.identityA, fixture.teammateA, async (client) => (
      await client.query<{ result: typeof teammateResult }>(
        `select public.mark_read($1, $2) result`,
        [fixture.otherAnchor, teammateMutation],
      )
    ).rows[0]!.result);
    expect(teammateReplay).toEqual(teammateResult);

    const teammateMarks = await database.query<{
      member_marks: number;
      teammate_id: string;
      teammate_marks: number;
    }>(
      `select
         (select count(*)::integer from public.read_marks where anchor_id = $1) member_marks,
         (select min(team_member_id::text) from public.teammate_read_marks
           where anchor_id = $1) teammate_id,
         (select count(*)::integer from public.teammate_read_marks
           where anchor_id = $1) teammate_marks`,
      [fixture.otherAnchor],
    );
    expect(teammateMarks[0]).toEqual({
      member_marks: 0,
      teammate_id: fixture.teammateA,
      teammate_marks: 1,
    });
    await expect(asApp(database, fixture.identityA, null, (client) => client.query(
      `select public.mark_read($1, $2)`,
      [fixture.otherAnchor, teammateMutation],
    ))).rejects.toMatchObject({ code: '23514' });
  });

  it('uses the same non-leaking absence for restricted, deleted, and fabricated anchors', async () => {
    for (const anchorId of [fixture.restrictedAnchor, fixture.deletedAnchor, randomUUID()]) {
      await expect(asApp(database, fixture.identityA, null, (client) => client.query(
        `select public.mark_read($1, $2)`,
        [anchorId, `g08-hidden-anchor-${randomUUID()}`],
      ))).rejects.toMatchObject({ code: 'P0002' });
    }
  });

  it('denies direct tm8_app DML and records one command row per accepted mutation identity', async () => {
    await expect(asApp(database, fixture.identityA, null, (client) => client.query(
      `update public.notifications set read_at = now() where id = $1`,
      [fixture.fallbackTeammateNotification],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityA, null, (client) => client.query(
      `insert into public.read_marks(member_id, anchor_id) values ($1, $2)`,
      [fixture.memberA, fixture.otherAnchor],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityA, fixture.teammateA, (client) => client.query(
      `insert into public.teammate_read_marks(team_member_id, anchor_id) values ($1, $2)`,
      [fixture.teammateA, fixture.otherAnchor],
    ))).rejects.toMatchObject({ code: '42501' });

    const ledger = await database.query<{ operation: string; count: number }>(
      `select operation, count(*)::integer count
         from public.command_ledger
        where operation in ('inbox.markRead', 'readMarks.upsert')
        group by operation order by operation`,
    );
    expect(ledger.find((row) => row.operation === 'inbox.markRead')?.count).toBeGreaterThanOrEqual(2);
    expect(ledger.find((row) => row.operation === 'readMarks.upsert')?.count).toBeGreaterThanOrEqual(4);
  });
});
