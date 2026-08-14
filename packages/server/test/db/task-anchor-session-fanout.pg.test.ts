import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * TASK-ANCHOR FAN-OUT — `w2_record_session_message_routes` after 121.
 *
 * A message anchored on a TASK matched none of the three existing target
 * classes (anchor / reply / mention), so `tm8 message send --to <task-id>` was
 * durable and silent: the row landed, the counters moved, and no session
 * working that task ever learned it happened. 121 adds the fourth class.
 *
 * Everything here runs against a REAL database because every behaviour under
 * test lives in plpgsql — the class itself, its four narrowings, and the
 * conversation-anchor gate the class made conditional. A FakeDb would be
 * asserting this file's transcription of that SQL, not the SQL.
 *
 * The call is always made as `tm8_app` with a real identity claim, because the
 * function's batch guard compares the message author against
 * `internal.actor_id()`/`internal.current_member_id()`. Calling as the owner
 * would take a path no request takes and would skip the guard entirely.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  channelId: string;
  alice: string;
  taskId: string;
  /** `working_on` the task, running — the session that must be woken. */
  liveSessionId: string;
  /** `working_on` the task, running — a second worker on the same task. */
  secondSessionId: string;
  /** `working_on` the task, but `exited` — must never be woken. */
  deadSessionId: string;
  /** Live, but `working_on` NOTHING — must never be woken. */
  bystanderSessionId: string;
  /** A task nobody is working — the negative control. */
  quietTaskId: string;
}

interface Route {
  targetMessageId: string;
  targetWorkSessionId: string;
  sourceAnchorId: string;
  sourceMessageId: string;
  addressingKind: string;
  body: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function asViewer<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'task-fanout-pg', true)`,
      [fixture.identityId],
    );
    return fn(client);
  });
}

/**
 * One message, anchored where the caller says. `authoredFrom` writes the
 * provenance edge a Teammate-authored message carries — the discriminator the
 * self-exclusion narrowing reads.
 */
async function newMessage(opts: {
  anchorId: string;
  body: string;
  parentId?: string;
  batchId?: string;
  authoredFrom?: string;
}): Promise<string> {
  return asOwner(async (client) => {
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'message',$3,null,$4)`,
      [id, fixture.spaceId, opts.parentId ?? null, fixture.alice],
    );
    await client.query(
      `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,message_batch_id)
       values($1,$2,$3,$4,$5,$6)`,
      [id, opts.anchorId, opts.parentId ?? null, fixture.alice, opts.body, opts.batchId ?? null],
    );
    if (opts.authoredFrom) {
      // `authored_from` is recorder-owned: the guard refuses a plain insert
      // even as the graph owner. Same two-line dance w1-foundations.test.ts
      // uses to seed the one edge the whole delivery boundary reads.
      await client.query(`select internal.w1_set_writer('message_recorder')`);
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,created_by)
         values($1,$2,$3,'authored_from',$4)`,
        [fixture.spaceId, id, opts.authoredFrom, fixture.alice],
      );
      await client.query(`select internal.w1_set_writer(null)`);
    }
    return id;
  });
}

async function record(
  messageIds: readonly string[],
  conversationAnchorId: string | null = null,
  mentionSessionIds: readonly string[] | null = null,
): Promise<Route[]> {
  return asViewer(async (client) =>
    (await client.query<{ routes: Route[] }>(
      `select public.w2_record_session_message_routes($1::uuid[], $2::uuid, $3::uuid[]) as routes`,
      [messageIds, conversationAnchorId, mentionSessionIds],
    )).rows[0]!.routes);
}

/**
 * The durable side. `record()` returns envelopes; this is what was WRITTEN.
 *
 * Read WITHOUT `set local role`, unlike every other helper here.
 * `session_message_reply_routes` is owned by the default migration role, not by
 * `tm8_graph_owner` (099's header explains why, and pg_class agrees), so the
 * "owner" connection this file otherwise uses is denied it outright.
 */
async function storedRoutes(messageId: string): Promise<Array<{ target: string; kind: string }>> {
  return database.query<{ target: string; kind: string }>(
    `select target_work_session_id::text target, addressing_kind kind
       from public.session_message_reply_routes
      where target_message_id = $1
      order by target_work_session_id`,
    [messageId],
  );
}

async function seed(scratch: W1ScratchDatabase): Promise<Fixture> {
  return scratch.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<Omit<Fixture, never>>(
      `select 'taskfanout-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "channelId", internal.new_id()::text "alice",
              internal.new_id()::text "taskId", internal.new_id()::text "liveSessionId",
              internal.new_id()::text "secondSessionId", internal.new_id()::text "deadSessionId",
              internal.new_id()::text "bystanderSessionId", internal.new_id()::text "quietTaskId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Fanout owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Task Fanout Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$9,'member',null,0,$1),($2,$9,'channel',null,1,$1),
       ($3,$9,'task',null,2,$1),($4,$9,'work_session',null,3,$1),
       ($5,$9,'work_session',null,4,$1),($6,$9,'work_session',null,5,$1),
       ($7,$9,'work_session',null,6,$1),($8,$9,'task',null,7,$1)`,
      [base.alice, base.channelId, base.taskId, base.liveSessionId, base.secondSessionId,
        base.deadSessionId, base.bystanderSessionId, base.quietTaskId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Alice')`,
      [base.alice, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.channels(entity_id,space_id,name) values($1,$2,'the-channel')`,
      [base.channelId, base.spaceId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority) values
       ($1,'The worked task','open','medium'),($2,'A task nobody is on','open','medium')`,
      [base.taskId, base.quietTaskId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status) values
       ($1,'live worker','running'),($2,'second worker','idle'),
       ($3,'dead worker','exited'),($4,'bystander','running')`,
      [base.liveSessionId, base.secondSessionId, base.deadSessionId, base.bystanderSessionId],
    );
    // Three sessions claim the task; the bystander claims nothing.
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values
       ($1,$2,$5,'working_on',$6),($1,$3,$5,'working_on',$6),($1,$4,$5,'working_on',$6)`,
      [base.spaceId, base.liveSessionId, base.secondSessionId, base.deadSessionId,
        base.taskId, base.alice],
    );

    return base;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('task_fanout');
  database.apply(migrationFiles());
  fixture = await seed(database);
}, 240_000);

// The default 10s is not enough here, and the failure it produces is a
// FILE-LEVEL error with no test name attached — unmatchable by anyone reading
// the report. `destroy()` costs ~5s on its own and several pg suites run
// together; w1-foundations.test.ts measured the same thing and reached the
// same conclusion.
afterAll(async () => {
  await database?.destroy();
}, 60_000);

describe.sequential('task-anchor session fan-out (121)', () => {
  it('a message on a task reaches every LIVE session working it, and no one else', async () => {
    const messageId = await newMessage({ anchorId: fixture.taskId, body: 'status please' });
    const routes = await record([messageId]);

    // Two live workers. NOT the exited one, NOT the bystander.
    expect(routes.map((route) => route.targetWorkSessionId).sort()).toEqual(
      [fixture.liveSessionId, fixture.secondSessionId].sort(),
    );
    expect(routes.map((route) => route.targetWorkSessionId)).not.toContain(fixture.deadSessionId);
    expect(routes.map((route) => route.targetWorkSessionId)).not.toContain(
      fixture.bystanderSessionId,
    );

    for (const route of routes) {
      // src is (the task, the message on it) — a woken session's reply resolves
      // back to the task, which is the whole point of routing by the shared id.
      expect(route.sourceAnchorId).toBe(fixture.taskId);
      expect(route.sourceMessageId).toBe(messageId);
      expect(route.targetMessageId).toBe(messageId);
      expect(route.addressingKind).toBe('anchored_message');
      expect(route.body).toBe('status please');
    }

    // And the envelopes are not the only artifact: the durable rows exist too.
    expect(await storedRoutes(messageId)).toEqual([
      fixture.liveSessionId, fixture.secondSessionId,
    ].sort().map((target) => ({ target, kind: 'anchored_message' })));
  });

  it('a task nobody is working still routes to nobody — the class is not a blanket', async () => {
    const messageId = await newMessage({ anchorId: fixture.quietTaskId, body: 'anyone?' });
    expect(await record([messageId])).toEqual([]);
    expect(await storedRoutes(messageId)).toEqual([]);
  });

  it('a message on a CHANNEL is unchanged — 121 did not widen anything else', async () => {
    const messageId = await newMessage({ anchorId: fixture.channelId, body: 'just chatting' });
    expect(await record([messageId])).toEqual([]);
    expect(await storedRoutes(messageId)).toEqual([]);
  });

  it('never hands a session back its OWN message', async () => {
    // The common case, not a corner: an agent reporting on the task it is
    // working IS `working_on` that task. Without the exclusion this writes a
    // route row that occupies the primary key and delivers nothing.
    const messageId = await newMessage({
      anchorId: fixture.taskId,
      body: 'reporting in on my own task',
      authoredFrom: fixture.liveSessionId,
    });
    const routes = await record([messageId]);

    expect(routes.map((route) => route.targetWorkSessionId)).toEqual([fixture.secondSessionId]);
    expect(await storedRoutes(messageId)).toEqual([
      { target: fixture.secondSessionId, kind: 'anchored_message' },
    ]);
  });

  it('yields to the REPLY class rather than waking the same session twice', async () => {
    // The parent was authored by a session that also works the task. Reply
    // targets and task targets both name it; exactly one row may exist for
    // (message, session), and a second class disagreeing about the source
    // would be a 23514, not a duplicate.
    const parentId = await newMessage({
      anchorId: fixture.taskId,
      body: 'the parent',
      authoredFrom: fixture.liveSessionId,
    });
    const replyId = await newMessage({
      anchorId: fixture.taskId,
      body: 'answering you',
      parentId,
    });

    const routes = await record([replyId]);
    const forLive = routes.filter((route) => route.targetWorkSessionId === fixture.liveSessionId);
    expect(forLive).toHaveLength(1);
    expect(forLive[0]!.sourceMessageId).toBe(replyId);

    // The second worker is not in the thread at all, so it arrives by the task
    // class — both classes fire on one batch and neither collides.
    expect(routes.map((route) => route.targetWorkSessionId).sort()).toEqual(
      [fixture.liveSessionId, fixture.secondSessionId].sort(),
    );
    expect(await storedRoutes(replyId)).toHaveLength(2);
  });

  it('a MENTION of a task worker stays a mention — the task class defers', async () => {
    const messageId = await newMessage({ anchorId: fixture.taskId, body: 'tagging you' });
    const routes = await record([messageId], null, [fixture.liveSessionId]);

    const forLive = routes.filter((route) => route.targetWorkSessionId === fixture.liveSessionId);
    expect(forLive).toHaveLength(1);
    expect(await storedRoutes(messageId)).toHaveLength(2);
  });

  it('a task-only MULTI-ANCHOR batch does not demand a conversationAnchorId', async () => {
    // THE REGRESSION THIS GUARDS. Before 121 a multi-anchor batch that owed
    // nothing returned `[]` before the conversation-anchor check was reached.
    // Task routes never read that anchor, so making the class unconditional
    // without gating the check would turn a previously-silent post into a hard
    // 22023 ('multi-anchor session delivery requires conversationAnchorId').
    const batchId = `task-fanout-batch-${Date.now()}`;
    const onTask = await newMessage({
      anchorId: fixture.taskId, body: 'two anchors, no conversation anchor', batchId,
    });
    const onChannel = await newMessage({
      anchorId: fixture.channelId, body: 'two anchors, no conversation anchor', batchId,
    });

    const routes = await record([onTask, onChannel], null);
    expect(routes.map((route) => route.targetWorkSessionId).sort()).toEqual(
      [fixture.liveSessionId, fixture.secondSessionId].sort(),
    );
    // The copy delivered is the TASK's copy, never the channel's.
    expect(routes.every((route) => route.targetMessageId === onTask)).toBe(true);
    expect(await storedRoutes(onChannel)).toEqual([]);
  });

  it('still refuses a multi-anchor batch when an ADDRESSED class needs the anchor', async () => {
    // The gate is conditional, not deleted: a batch that owes a mention copy
    // reads the conversation anchor and must still be told when it is missing.
    const batchId = `task-fanout-addressed-${Date.now()}`;
    const first = await newMessage({ anchorId: fixture.taskId, body: 'a', batchId });
    const second = await newMessage({ anchorId: fixture.channelId, body: 'a', batchId });

    await expect(record([first, second], null, [fixture.bystanderSessionId])).rejects.toThrow(
      /multi-anchor session delivery requires conversationAnchorId/,
    );
  });

  /**
   * The task class also filters targets to the message's space. That narrowing
   * is BELT AND BRACES and this test says so out loud rather than pretending to
   * exercise it: the fan-out cannot reach across a space boundary because the
   * edge it walks cannot cross one. Asserting the real reason beats a test that
   * appears to cover a filter it never reaches — and if the trigger below is
   * ever relaxed, this fails and points at the filter that then starts to
   * matter.
   */
  it('cannot reach across a Space, because a cross-space working_on edge is refused', async () => {
    const foreignSessionId = await asOwner(async (client) => {
      const ids = (await client.query<{ spaceId: string; sessionId: string; identityId: string }>(
        `select internal.new_id()::text "spaceId", internal.new_id()::text "sessionId",
                'taskfanout-foreign'::text "identityId"`,
      )).rows[0]!;
      await client.query(
        `insert into public.user_profiles(identity_id,display_name) values($1,'Foreign')`,
        [ids.identityId],
      );
      await client.query(
        `insert into public.spaces(id,name,created_by_identity) values($1,'Other Space',$2)`,
        [ids.spaceId, ids.identityId],
      );
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'work_session',null,0,$3)`,
        [ids.sessionId, ids.spaceId, fixture.alice],
      );
      await client.query(
        `insert into public.work_sessions(entity_id,title,status) values($1,'foreign','running')`,
        [ids.sessionId],
      );
      return ids.sessionId;
    });

    await expect(
      asOwner((client) =>
        client.query(
          `insert into public.edges(space_id,src_id,dst_id,type,created_by)
           values($1,$2,$3,'working_on',$4)`,
          [fixture.spaceId, foreignSessionId, fixture.taskId, fixture.alice],
        )),
    ).rejects.toThrow(/edge endpoints must live in the edge space/);

    // And with no edge to walk, the fan-out is unchanged: the same two workers.
    const messageId = await newMessage({ anchorId: fixture.taskId, body: 'space-local only' });
    const routes = await record([messageId]);
    expect(routes.map((route) => route.targetWorkSessionId)).not.toContain(foreignSessionId);
    expect(routes).toHaveLength(2);
  });
});
