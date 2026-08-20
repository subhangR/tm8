import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * TASK-ANCHOR PARTICIPANT FAN-OUT — `w2_record_session_message_routes` after 159.
 *
 * 121 gave a task anchor a target class and made it one relation wide:
 * `working_on`, which only 111's spawn RPC writes, and only for the session the
 * spawn put on the task. 121 then excludes the author. On the ordinary topology
 * — one coordinator opens a task, one worker is spawned on it, the worker
 * reports back — the membership set is {the worker} minus {the worker}, and the
 * post routes to nobody. 159 widens membership to the task's CONVERSATION:
 * sessions working it, the session that OPENED it, and any session that has
 * SPOKEN on it.
 *
 * Real database for the same reason 121's file gives: every behaviour under
 * test is plpgsql/SQL, so a fake would assert this file's transcription of it.
 * The call is always made as `tm8_app` with a real identity claim, because the
 * function's batch guard compares the author against `internal.actor_id()` /
 * `internal.current_member_id()`.
 *
 * The fixture deliberately keeps every new member class ISOLATED from the old
 * one: the opener, the speaker and the shell session have NO `working_on` edge,
 * so any route they receive can only have come from the relation under test.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  alice: string;
  /** Opened by `openerSessionId`, worked by `workerSessionId`. */
  taskId: string;
  /** `working_on` the task — 121's only class, and the message author below. */
  workerSessionId: string;
  /** `created_in` the task, working NOTHING, live. The coordinator. */
  openerSessionId: string;
  /** Has posted on the task, works nothing, opened nothing, live. */
  speakerSessionId: string;
  /** Has posted on the task, but `exited`. */
  deadSpeakerSessionId: string;
  /** Live, but `session_kind = 'shell'`. Opened `shellTaskId`. */
  shellSessionId: string;
  /** Live and unrelated to the task in every way. */
  bystanderSessionId: string;
  /** Opened by nobody, worked by nobody. */
  orphanTaskId: string;
  /**
   * Opened by the SHELL session, worked by `speakerSessionId`. Its own task
   * because `edges_created_in_source_idx` (066) is unique on the source: an
   * entity has exactly one birth session, so the OPENED class can never
   * contribute more than one target and two openers cannot be tested on one
   * task.
   */
  shellTaskId: string;
  /**
   * OPENED IN ISOLATION. Nobody works it, nobody has spoken on it, and its
   * opener is a session that is a member of nothing else — so a route to
   * `soleOpenerSessionId` can only have come from `created_in`.
   *
   * This exists because review found the first version of this file's OPENED
   * coverage to be load-bearing on the ORDER of two `it()` blocks: the SPOKEN
   * test posts as the opener, permanently enrolling it, so with `created_in`
   * deleted and those two tests swapped the whole file stayed green with the
   * OPENED class entirely absent — the class that carries a third of the fix.
   */
  openedOnlyTaskId: string;
  /** `created_in` -> `openedOnlyTaskId`, and a member of nothing else. */
  soleOpenerSessionId: string;
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

async function newMessage(opts: {
  anchorId: string;
  body: string;
  batchId?: string;
  authoredFrom?: string;
}): Promise<string> {
  return asOwner(async (client) => {
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'message',null,null,$3)`,
      [id, fixture.spaceId, fixture.alice],
    );
    await client.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body,message_batch_id,attachments)
       values($1,$2,$3,$4,$5,'[]'::jsonb)`,
      [id, opts.anchorId, fixture.alice, opts.body, opts.batchId ?? null],
    );
    if (opts.authoredFrom) {
      // `authored_from` is recorder-owned: the guard refuses a plain insert
      // even as the graph owner.
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

async function record(messageIds: readonly string[]): Promise<Route[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'task-participant-pg', true)`,
      [fixture.identityId],
    );
    return (await client.query<{ routes: Route[] }>(
      `select public.w2_record_session_message_routes($1::uuid[], null, null) as routes`,
      [messageIds],
    )).rows[0]!.routes;
  });
}

async function targetsOf(messageIds: readonly string[]): Promise<string[]> {
  return (await record(messageIds)).map((route) => route.targetWorkSessionId).sort();
}

async function seed(scratch: W1ScratchDatabase): Promise<Fixture> {
  return scratch.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<Fixture>(
      `select 'taskparticipant-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "alice", internal.new_id()::text "taskId",
              internal.new_id()::text "workerSessionId", internal.new_id()::text "openerSessionId",
              internal.new_id()::text "speakerSessionId",
              internal.new_id()::text "deadSpeakerSessionId",
              internal.new_id()::text "shellSessionId",
              internal.new_id()::text "bystanderSessionId",
              internal.new_id()::text "orphanTaskId",
              internal.new_id()::text "shellTaskId",
              internal.new_id()::text "openedOnlyTaskId",
              internal.new_id()::text "soleOpenerSessionId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Participant owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Participant Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$13,'member',null,0,$1),($2,$13,'task',null,1,$1),
       ($3,$13,'work_session',null,2,$1),($4,$13,'work_session',null,3,$1),
       ($5,$13,'work_session',null,4,$1),($6,$13,'work_session',null,5,$1),
       ($7,$13,'work_session',null,6,$1),($8,$13,'work_session',null,7,$1),
       ($9,$13,'task',null,8,$1),($10,$13,'task',null,9,$1),
       ($11,$13,'task',null,10,$1),($12,$13,'work_session',null,11,$1)`,
      [base.alice, base.taskId, base.workerSessionId, base.openerSessionId,
        base.speakerSessionId, base.deadSpeakerSessionId, base.shellSessionId,
        base.bystanderSessionId, base.orphanTaskId, base.shellTaskId,
        base.openedOnlyTaskId, base.soleOpenerSessionId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Alice')`,
      [base.alice, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority) values
       ($1,'The worked task','open','medium'),($2,'Nobody opened this one','open','medium'),
       ($3,'Opened from a shell','open','medium'),
       ($4,'Opened and then left alone','open','medium')`,
      [base.taskId, base.orphanTaskId, base.shellTaskId, base.openedOnlyTaskId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status,session_kind) values
       ($1,'the worker','running','agent'),($2,'the coordinator','idle','agent'),
       ($3,'a speaker','running','agent'),($4,'a dead speaker','exited','agent'),
       ($5,'a shell','running','shell'),($6,'bystander','running','agent'),
       ($7,'the sole opener','running','agent')`,
      [base.workerSessionId, base.openerSessionId, base.speakerSessionId,
        base.deadSpeakerSessionId, base.shellSessionId, base.bystanderSessionId,
        base.soleOpenerSessionId],
    );
    // ONE `working_on` edge on the main task — the topology the report
    // describes, and the one 121 leaves routing to nobody once its author
    // exclusion applies. The shell task gets a live agent worker so that the
    // shell narrowing is tested against a fan-out that DOES fire.
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values
       ($1,$2,$3,'working_on',$5),($1,$4,$6,'working_on',$5)`,
      [base.spaceId, base.workerSessionId, base.taskId, base.speakerSessionId,
        base.alice, base.shellTaskId],
    );
    // `created_in` runs the other way: task -> the session that opened it.
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values
       ($1,$2,$3,'created_in',$5),($1,$4,$6,'created_in',$5),
       ($1,$7,$8,'created_in',$5)`,
      [base.spaceId, base.taskId, base.openerSessionId, base.shellTaskId,
        base.alice, base.shellSessionId, base.openedOnlyTaskId, base.soleOpenerSessionId],
    );

    return base;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('task_participant');
  database.apply(migrationFiles());
  fixture = await seed(database);
  // The two SPOKEN members earn their membership the only way it can be
  // earned: by having posted on the task before anything under test is sent.
  await newMessage({
    anchorId: fixture.taskId, body: 'I looked at this earlier',
    authoredFrom: fixture.speakerSessionId,
  });
  await newMessage({
    anchorId: fixture.taskId, body: 'so did I, before I died',
    authoredFrom: fixture.deadSpeakerSessionId,
  });
}, 240_000);

afterAll(async () => {
  await database?.destroy();
}, 60_000);

describe.sequential('task-anchor participant fan-out (163)', () => {
  it('OPENED alone reaches a session, on a task nobody works and nobody has spoken on', async () => {
    // THE ISOLATING TEST FOR `created_in`, and it is first on purpose.
    //
    // Review showed that the class carrying a THIRD of this fix had no test of
    // its own: every assertion naming the opener ran on `fixture.taskId`, where
    // another test posts as that opener and enrols it via SPOKEN, so deleting
    // the `created_in` edge and swapping two `it()` blocks left the whole file
    // green with OPENED entirely absent. Here the only relation in existence is
    // `created_in`, so this expectation cannot be satisfied for a second reason
    // no matter what order anything runs in.
    const messageId = await newMessage({
      anchorId: fixture.openedOnlyTaskId, body: 'a human asks, on a task with one opener',
    });
    const routes = await record([messageId]);
    expect(routes.map((r) => r.targetWorkSessionId)).toEqual([fixture.soleOpenerSessionId]);
    expect(routes[0]!.sourceAnchorId).toBe(fixture.openedOnlyTaskId);
    expect(routes[0]!.addressingKind).toBe('anchored_message');
  });

  it('the worker reporting on its own task reaches the coordinator that OPENED it', async () => {
    // THE REPORTED DEFECT, end to end. Under 121 this batch produced zero
    // routes: the only `working_on` session is the author, and the author is
    // excluded. The coordinator was live the whole time and heard nothing.
    const messageId = await newMessage({
      anchorId: fixture.taskId,
      body: 'milestone: the thing is done',
      authoredFrom: fixture.workerSessionId,
    });

    const routes = await record([messageId]);
    expect(routes.map((route) => route.targetWorkSessionId).sort()).toEqual(
      [fixture.openerSessionId, fixture.speakerSessionId].sort(),
    );

    const forOpener = routes.find((r) => r.targetWorkSessionId === fixture.openerSessionId)!;
    // src is (the task, the message on it), so the coordinator's reply resolves
    // back onto the task rather than into a private thread.
    expect(forOpener.sourceAnchorId).toBe(fixture.taskId);
    expect(forOpener.sourceMessageId).toBe(messageId);
    expect(forOpener.addressingKind).toBe('anchored_message');
    expect(forOpener.body).toBe('milestone: the thing is done');
  });

  it('a session that has SPOKEN on the task is in the conversation', async () => {
    // The sub-session case: nothing ever put this session on the task and it
    // did not open it. Its own earlier post is the entire membership claim.
    const messageId = await newMessage({
      anchorId: fixture.taskId, body: 'anyone still here?', authoredFrom: fixture.openerSessionId,
    });
    expect(await targetsOf([messageId])).toEqual(
      [fixture.workerSessionId, fixture.speakerSessionId].sort(),
    );
  });

  it('a speaker that has EXITED is never woken, however much it said', async () => {
    const messageId = await newMessage({ anchorId: fixture.taskId, body: 'from a human' });
    const targets = await targetsOf([messageId]);
    expect(targets).not.toContain(fixture.deadSpeakerSessionId);
    // A human post has no authoring session, so every live member is owed one.
    expect(targets).toEqual(
      [fixture.workerSessionId, fixture.openerSessionId, fixture.speakerSessionId].sort(),
    );
  });

  it('never wakes a SHELL session, even though it opened the task', async () => {
    // Narrowing 5, and the hazard 159 itself creates: a shell session has no
    // interaction pin, so `sessionInputAllowed` defaults true and the envelope
    // would be TYPED INTO THE USER'S BASH PROMPT. Asserted on a task whose
    // fan-out does fire — the live agent working it is routed on the same
    // call — so the shell's absence is the narrowing and not an empty result.
    const messageId = await newMessage({
      anchorId: fixture.shellTaskId, body: 'shell must not hear this',
    });
    const targets = await targetsOf([messageId]);
    expect(targets).toEqual([fixture.speakerSessionId]);
    expect(targets).not.toContain(fixture.shellSessionId);
  });

  it('leaves a session that never touched the task alone — membership is not a blanket', async () => {
    const messageId = await newMessage({ anchorId: fixture.taskId, body: 'still not for you' });
    // Assert the FULL set, not just the bystander's absence: a bare
    // `not.toContain` is satisfied by an empty result, so it would stay green
    // through a change that broke the fan-out outright. Review caught this one.
    expect(await targetsOf([messageId])).toEqual(
      [fixture.workerSessionId, fixture.openerSessionId, fixture.speakerSessionId].sort(),
    );
  });

  it('a task nobody opened, works or has spoken on still routes to nobody', async () => {
    const messageId = await newMessage({ anchorId: fixture.orphanTaskId, body: 'anyone?' });
    expect(await record([messageId])).toEqual([]);
  });

  it('membership means "has spoken BEFORE" — a batch does not enrol its own authors', async () => {
    // Run on the ORPHAN task, where the membership set is empty, so the only
    // thing that could produce a route is the batch enrolling itself. Without
    // the `p_batch_message_ids` exclusion in `w2_task_conversation_sessions`,
    // each message's `authored_from` edge enrols the OTHER message's author —
    // and narrowing 2 cannot take them back out, because it only excludes a
    // session from ITS OWN message. Two routes instead of none.
    const batchId = `participant-batch-${Date.now()}`;
    const mine = await newMessage({
      anchorId: fixture.orphanTaskId, body: 'two of us at once', batchId,
      authoredFrom: fixture.workerSessionId,
    });
    const yours = await newMessage({
      anchorId: fixture.orphanTaskId, body: 'two of us at once', batchId,
      authoredFrom: fixture.openerSessionId,
    });

    expect(await record([mine, yours])).toEqual([]);
  });

  /**
   * THE PLANNER ASSERTION. Nothing above would notice this regressing, and no
   * amount of reading the SQL finds it: `w2_task_conversation_sessions` is
   * `language sql stable` with a one-query body, so Postgres INLINES it, which
   * turns `join ... on true` from a per-row lateral into a subquery it may
   * reorder — and it chooses to test `entities.kind = 'task'` LAST. Measured on
   * the live graph, a CHANNEL post with 209 siblings went from 5 buffers to 712,
   * walking that channel's whole history through the SPOKEN arm before throwing
   * every row away. Every non-task post on the node paid it.
   *
   * The fix is two deterministic fences — a plpgsql IF in the guard and
   * `as materialized` in the CTE — and determinism is exactly what a timing
   * assertion cannot check. So this reads the PLAN instead: on a non-task
   * anchor, the membership walk must not run AT ALL.
   */
  it('a non-task anchor never walks the membership arms — the fences hold', async () => {
    const channelId = await asOwner(async (client) => {
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`))
        .rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'channel',null,90,$3)`,
        [id, fixture.spaceId, fixture.alice],
      );
      await client.query(
        `insert into public.channels(entity_id,space_id,name) values($1,$2,'noisy')`,
        [id, fixture.spaceId],
      );
      return id;
    });
    // Give the channel a history, so that a walk of it would be visible in the
    // plan as executed rows rather than as an empty scan that proves nothing.
    for (let i = 0; i < 12; i += 1) {
      await newMessage({
        anchorId: channelId, body: `chatter ${i}`, authoredFrom: fixture.speakerSessionId,
      });
    }
    const subject = await newMessage({ anchorId: channelId, body: 'one more' });

    // (a) THE FENCE WORKS. `as materialized` is what makes the anchor-kind test
    //     provably run first; without it the planner reorders and the walk
    //     happens anyway. Run the CTE's own shape and read the plan.
    // `explain` names its single column "QUERY PLAN", with a space — read it
    // positionally rather than inventing an alias that silently yields
    // `undefined` and an empty plan string.
    const fenced = (await database.query<Record<string, string>>(
      `explain (analyze, buffers, costs off, timing off, format text)
       with task_anchored as materialized (
         select m.entity_id as message_id, m.anchor_id as task_id
           from public.messages m
           join public.entities anchor
             on anchor.id = m.anchor_id and anchor.kind = 'task' and anchor.deleted_at is null
          where m.entity_id = any($1::uuid[])
       )
       select 1
         from task_anchored ta
         join internal.w2_task_conversation_sessions(ta.task_id, $1::uuid[]) member on true
         join public.work_sessions ws on ws.entity_id = member.work_session_id
        where ws.status in ('spawning', 'running', 'idle') and ws.session_kind = 'agent'`,
      [[subject]],
    )).map((row) => Object.values(row)[0]!).join('\n');

    // The SPOKEN arm is the expensive one — the only node that reads `messages`
    // as `prior`. On a non-task anchor there is nothing for it to do, and
    // Postgres says so in as many words. Matched on the alias rather than on an
    // index name, because a scratch database small enough to seq-scan would
    // otherwise make this assertion vacuous in exactly the way it is guarding.
    const spokenArm = fenced.split('\n').find((l) => / on messages prior\b/.test(l));
    expect(spokenArm, `no SPOKEN arm in plan:\n${fenced}`).toBeDefined();
    expect(spokenArm, `SPOKEN arm ran on a non-task anchor:\n${fenced}`)
      .toContain('never executed');

    // (b) THE SHIPPED FUNCTION ACTUALLY USES BOTH FENCES. (a) alone would pass
    //     against this test file's own transcription of a shape the migration
    //     had stopped using, which is the classic way a performance assertion
    //     rots into decoration. The guard's half is plpgsql control flow and so
    //     cannot be read out of a plan at all — a branch is not a planner
    //     choice, which is the entire reason it is a branch.
    const [body] = await database.query<{ src: string }>(
      `select p.prosrc src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'w2_record_session_message_routes'`,
    );
    expect(body!.src).toContain('task_anchored as materialized');
    expect(body!.src).toMatch(/owes_task_copy := false;/);
  });
});
