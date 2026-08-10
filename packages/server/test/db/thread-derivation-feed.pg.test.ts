/**
 * 098 — `thread_v1` / `task_discussion_v1` and the four derivation predicates
 * against a REAL PostgreSQL chain.
 *
 * THE CLAIM UNDER TEST. An agent spawned on a thread reports on its assignment
 * anchor — a task `derived_from` the thread's root (064) — and a thread's
 * reader still sees the report IN the thread, while the task's reader sees the
 * thread's conversation in the task's Discussion. ONE stored row, TWO surfaces,
 * joined by an edge at READ time. The write side cannot do this (019:416 `a
 * reply has exactly one anchor`, :423 `reply anchor must equal parent anchor`),
 * which is why every predicate here is a read that follows `derived_from`.
 *
 * Asserted against a real database because every fact in play — the reply
 * anchor rule, `derived_from`'s src/dst kinds, RLS on messages/activity/edges —
 * is plpgsql a FakeDb cannot see; a FakeDb run would assert the transcription.
 * The branch queries run the LITERAL exported production SQL via `feedPageSql`.
 *
 * Every seeded row carries an EXPLICIT `created_at`: a one-transaction seed
 * gives every row the identical transaction timestamp, and ordering assertions
 * then tie and pass vacuously.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FEED_SCOPE_PREDICATES,
  feedPageSql,
} from '../../src/facade/services/w2/feed-context.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identityMember: string;
  identityOutsider: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  channelId: string;
  /** The thread under test: a root on the channel with two replies. */
  rootMessageId: string;
  replyOneId: string;
  replyTwoId: string;
  /** A second thread on the same channel — the isolation control. */
  otherRootId: string;
  otherReplyId: string;
  /** Task derived from the root; the agent's assignment anchor. */
  taskId: string;
  /** Task derived from the OTHER root — must never leak across. */
  otherTaskId: string;
  taskReportId: string;
  taskReportReplyId: string;
  otherTaskMessageId: string;
  /** Session working the derived task. */
  sessionId: string;
  /** Spawn shape: `created` ABOUT the session, work_session_id NULL (043). */
  spawnActivityId: string;
  /** Recorder shape: about the task, work_session_id stamped. */
  causedActivityId: string;
  /** Both columns name the session — the fold-to-one-row case. */
  selfActivityId: string;
  rootSubjectActivityId: string;
  channelNoiseActivityId: string;
}

interface PageRow {
  item_kind: string;
  item_id: string;
  created_at: Date;
  via: string[];
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'threadderive-member'::text   as "identityMember",
              'threadderive-outsider'::text as "identityOutsider",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "teammateId",
              internal.new_id()::text as "channelId",
              internal.new_id()::text as "rootMessageId",
              internal.new_id()::text as "replyOneId",
              internal.new_id()::text as "replyTwoId",
              internal.new_id()::text as "otherRootId",
              internal.new_id()::text as "otherReplyId",
              internal.new_id()::text as "taskId",
              internal.new_id()::text as "otherTaskId",
              internal.new_id()::text as "taskReportId",
              internal.new_id()::text as "taskReportReplyId",
              internal.new_id()::text as "otherTaskMessageId",
              internal.new_id()::text as "sessionId",
              internal.new_id()::text as "spawnActivityId",
              internal.new_id()::text as "causedActivityId",
              internal.new_id()::text as "selfActivityId",
              internal.new_id()::text as "rootSubjectActivityId",
              internal.new_id()::text as "channelNoiseActivityId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values ($1,'Derivation member'),($2,'Derivation outsider')`,
      [ids.identityMember, ids.identityOutsider],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values ($1,'Derivation',$2)`,
      [ids.spaceId, ids.identityMember],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility)
       values ($1,$6,'member',$1,'space'),
              ($2,$6,'team_member',$1,'space'),
              ($3,$6,'channel',$1,'space'),
              ($4,$6,'task',$1,'space'),
              ($5,$6,'task',$1,'space')`,
      [ids.memberId, ids.teammateId, ids.channelId, ids.taskId, ids.otherTaskId, ids.spaceId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility)
       values ($1,$2,'work_session',$3,'space')`,
      [ids.sessionId, ids.spaceId, ids.memberId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values ($1,$2,$3,'owner','Derivation member')`,
      [ids.memberId, ids.spaceId, ids.identityMember],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values ($1,$2,'Derivation Agent','worker','derivation-agent')`,
      [ids.teammateId, ids.memberId],
    );
    await client.query(
      `insert into public.channels(entity_id,space_id,name,topic)
       values ($1,$2,'derivation','thread under test')`,
      [ids.channelId, ids.spaceId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title)
       values ($1,'Derived from the root'),($2,'Derived from the other root')`,
      [ids.taskId, ids.otherTaskId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status,share_mode,started_at)
       values ($1,'Derivation session','running','space',now())`,
      [ids.sessionId],
    );

    // Message envelopes. A reply's ENVELOPE parent is its parent message.
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,created_by,visibility)
       values ($1,$8,'message',null,$9,'space'),
              ($2,$8,'message',$1,  $9,'space'),
              ($3,$8,'message',$1,  $9,'space'),
              ($4,$8,'message',null,$9,'space'),
              ($5,$8,'message',$4,  $9,'space'),
              ($6,$8,'message',null,$9,'space'),
              ($7,$8,'message',$6,  $9,'space')`,
      [
        ids.rootMessageId, ids.replyOneId, ids.replyTwoId,
        ids.otherRootId, ids.otherReplyId,
        ids.taskReportId, ids.taskReportReplyId,
        ids.spaceId, ids.teammateId,
      ],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,created_by,visibility)
       values ($1,$2,'message',null,$3,'space')`,
      [ids.otherTaskMessageId, ids.spaceId, ids.teammateId],
    );

    // Replies anchor on the CHANNEL, never on their root — the 019:423 rule
    // this whole design routes around. Distinct timestamps throughout.
    await client.query(
      `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,created_at)
       values ($1,$9, null,$8,'root: fix the login bug',   timestamptz '2026-08-10T09:00:00Z'),
              ($2,$9, $1,  $8,'first reply',               timestamptz '2026-08-10T09:05:00Z'),
              ($3,$9, $1,  $8,'second reply',              timestamptz '2026-08-10T09:10:00Z'),
              ($4,$9, null,$8,'other root',                timestamptz '2026-08-10T09:15:00Z'),
              ($5,$9, $4,  $8,'other reply',               timestamptz '2026-08-10T09:20:00Z'),
              ($6,$10,null,$8,'agent report on the task',  timestamptz '2026-08-10T09:25:00Z'),
              ($7,$10,$6,  $8,'follow-up on the report',   timestamptz '2026-08-10T09:30:00Z'),
              ($11,$12,null,$8,'report on the OTHER task', timestamptz '2026-08-10T09:35:00Z')`,
      [
        ids.rootMessageId, ids.replyOneId, ids.replyTwoId,
        ids.otherRootId, ids.otherReplyId,
        ids.taskReportId, ids.taskReportReplyId,
        ids.teammateId, ids.channelId, ids.taskId,
        ids.otherTaskMessageId, ids.otherTaskId,
      ],
    );

    // The derivation edges 064's `derive_task_for_entity` writes: task -> root.
    // And the `working_on` edge `execution.spawn` writes: session -> task.
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by)
       values ($1,$2,$4,'derived_from',$6),
              ($1,$3,$5,'derived_from',$6),
              ($1,$7,$2,'working_on',$6)`,
      [
        ids.spaceId, ids.taskId, ids.otherTaskId,
        ids.rootMessageId, ids.otherRootId, ids.memberId, ids.sessionId,
      ],
    );

    // The three activity shapes `derived_session` must and must not fold:
    //  - spawn writes `created` ABOUT the session with work_session_id NULL
    //    (043/048 call record_activity with the session as p_entity);
    //  - the recorder stamps work_session_id on rows ABOUT something else;
    //  - a row naming the session in BOTH columns must fold to ONE feed item.
    // `execution.transition` writes no activity at all, so there is no fourth
    // shape to seed — a status flip is visible only through rows like these.
    await client.query(
      `insert into public.activity(id,space_id,entity_id,actor_id,verb,created_at,work_session_id)
       values ($1,$6,$7, $8,'created',     timestamptz '2026-08-10T09:22:00Z',null),
              ($2,$6,$9, $8,'updated',     timestamptz '2026-08-10T09:40:00Z',$7),
              ($3,$6,$7, $8,'restored',    timestamptz '2026-08-10T09:45:00Z',$7),
              ($4,$6,$10,$8,'work.changed',timestamptz '2026-08-10T09:02:00Z',null),
              ($5,$6,$11,$8,'updated',     timestamptz '2026-08-10T09:03:00Z',null)`,
      [
        ids.spawnActivityId, ids.causedActivityId, ids.selfActivityId,
        ids.rootSubjectActivityId, ids.channelNoiseActivityId,
        ids.spaceId, ids.sessionId, ids.memberId,
        ids.taskId, ids.rootMessageId, ids.channelId,
      ],
    );
    return ids;
  });
}

/** One read as `tm8_app` with a bound identity — the claim-bound RLS path. */
async function asApp<T>(
  identityId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    return fn(client);
  });
}

async function page(
  identityId: string,
  anchorId: string,
  scope: keyof typeof FEED_SCOPE_PREDICATES,
): Promise<PageRow[]> {
  const sql = feedPageSql(FEED_SCOPE_PREDICATES[scope], {
    comparator: '<',
    direction: 'desc',
    limit: 50,
    keyed: false,
  });
  return asApp(identityId, async (client) => (
    await client.query<PageRow>(sql, [anchorId])
  ).rows);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('thread_deriv');
  database.apply(migrationFiles());
  fixture = await seed();
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('098 thread_v1 — the thread pulls the work it spawned', () => {
  it('shows the branch, the report on the derived task, and the working session', async () => {
    const rows = await page(fixture.identityMember, fixture.rootMessageId, 'thread_v1');
    expect(rows.map((row) => [row.item_id, row.via])).toEqual([
      // Both columns name the session — ONE row, not two: the group-by folds
      // the two derived_session routes before the client ever sees them.
      [fixture.selfActivityId, ['derived_session']],
      // Recorder shape: work_session_id stamped, entity_id elsewhere.
      [fixture.causedActivityId, ['derived_session']],
      // The agent's report thread, anchored on the task, read back through
      // `derived_from` — the agent never named this thread.
      [fixture.taskReportReplyId, ['derived_task']],
      [fixture.taskReportId, ['derived_task']],
      // Spawn shape: `created` about the session, work_session_id NULL.
      [fixture.spawnActivityId, ['derived_session']],
      [fixture.replyTwoId, ['thread']],
      [fixture.replyOneId, ['thread']],
      [fixture.rootSubjectActivityId, ['subject']],
    ]);
  });

  it('never leaks the sibling thread or its derived task', async () => {
    const rows = await page(fixture.identityMember, fixture.rootMessageId, 'thread_v1');
    const ids = rows.map((row) => row.item_id);
    expect(ids).not.toContain(fixture.otherRootId);
    expect(ids).not.toContain(fixture.otherReplyId);
    expect(ids).not.toContain(fixture.otherTaskMessageId);
    expect(ids).not.toContain(fixture.channelNoiseActivityId);
    // The root is the ANCHOR of this feed, not an item in it — the surface
    // renders it as the pane header, and `anchored` is deliberately absent.
    expect(ids).not.toContain(fixture.rootMessageId);
  });

  it('documents the trap it replaces: direct_v1 on a message anchor is message-empty', async () => {
    // `anchored` means `m.anchor_id = $1`, and a reply anchors on the CHANNEL
    // (019:423) — so the obvious `entities.feed(rootMessageId, direct_v1)`
    // returns no messages at all. This assertion is the WHY of `thread_v1`.
    const rows = await page(fixture.identityMember, fixture.rootMessageId, 'direct_v1');
    expect(rows.filter((row) => row.item_kind === 'message')).toEqual([]);
    expect(rows.map((row) => row.item_id)).toEqual([fixture.rootSubjectActivityId]);
  });

  it('is invisible to a non-member: every branch reads RLS-guarded tables', async () => {
    const rows = await page(fixture.identityOutsider, fixture.rootMessageId, 'thread_v1');
    expect(rows).toEqual([]);
  });
});

describe.sequential('098 task_discussion_v1 — the task carries its origin thread', () => {
  it('is direct_v1 plus the thread the task was derived from', async () => {
    const rows = await page(fixture.identityMember, fixture.taskId, 'task_discussion_v1');
    expect(rows.map((row) => [row.item_id, row.via])).toEqual([
      // About the task AND stamped with the session: `subject` here, and
      // `derived_session` on the thread side — one row, two readings.
      [fixture.causedActivityId, ['subject']],
      [fixture.taskReportReplyId, ['replies']],
      [fixture.taskReportId, ['anchored']],
      // The origin thread, root included — the HUMAN chatter, visible in the
      // Discussion on purpose: the task is that conversation's work record.
      [fixture.replyTwoId, ['derived_thread']],
      [fixture.replyOneId, ['derived_thread']],
      [fixture.rootMessageId, ['derived_thread']],
    ]);
  });

  it('direct_v1 on the same task still reads exactly the pre-derivation Discussion', async () => {
    const rows = await page(fixture.identityMember, fixture.taskId, 'direct_v1');
    expect(rows.map((row) => [row.item_id, row.via])).toEqual([
      [fixture.causedActivityId, ['subject']],
      [fixture.taskReportReplyId, ['replies']],
      [fixture.taskReportId, ['anchored']],
    ]);
  });

  it('one stored row appears on both surfaces — nothing was written twice', async () => {
    const thread = await page(fixture.identityMember, fixture.rootMessageId, 'thread_v1');
    const task = await page(fixture.identityMember, fixture.taskId, 'task_discussion_v1');
    const threadIds = new Set(thread.map((row) => row.item_id));
    const taskIds = new Set(task.map((row) => row.item_id));
    // The agent's report, visible in the thread; the humans' replies, visible
    // on the task — the SAME item ids, joined by `derived_from` at read time.
    for (const shared of [
      fixture.taskReportId, fixture.taskReportReplyId,
      fixture.replyOneId, fixture.replyTwoId,
    ]) {
      expect(threadIds, shared).toContain(shared);
      expect(taskIds, shared).toContain(shared);
    }
  });
});
