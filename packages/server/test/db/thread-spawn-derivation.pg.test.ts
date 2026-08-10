import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * SPAWN ON A THREAD — `derive_task_for_entity` after 099.
 *
 * Everything here is asserted against a REAL database because every behaviour
 * under test lives in plpgsql — the title coalesce, the root normalization,
 * the reuse/force_new/refuse branching — and a FakeDb would be asserting this
 * file's own transcription of that logic, not the logic (the exact failure the
 * house verification memo warns about).
 *
 * The fixture follows thread-footer-metadata.pg.test.ts, including its
 * explicit per-row `created_at` offsets: the whole seed runs in ONE
 * transaction, so `now()` is identical for every row and any ordering
 * assertion (reuse picks "newest", the listing orders newest-first) would
 * otherwise tie and pass vacuously.
 */

interface Fixture {
  identityId: string;
  spaceId: string;
  channelId: string;
  alice: string;
  rootId: string;
  replyId: string;
  /** A second, unrelated root — derivations must not bleed across threads. */
  otherRootId: string;
  workSessionId: string;
  plainTaskId: string;
}

const ROOT_BODY = [
  'auth is failing on staging — 401 after exactly one hour.',
  'Suspect the refresh path; μs vs ms in the expiry compare?',
  'Repro: log in, wait 61 minutes, any API call.',
].join('\n');

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/**
 * Run under `tm8_app` with a real identity claim, the way production reaches
 * these functions: `resolve_actor` reads `tm8.identity_id`, so calling as the
 * graph owner would test a path no request ever takes.
 */
async function asViewer<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'thread-spawn-pg', true)`,
      [fixture.identityId],
    );
    return fn(client);
  });
}

interface DeriveResult {
  taskId: string;
  sourceEntityId: string;
  sourceKind: string;
  created: boolean;
}

async function derive(
  client: PoolClient,
  entityId: string,
  forceNew = false,
): Promise<DeriveResult> {
  const result = await client.query<{ r: DeriveResult }>(
    `select public.derive_task_for_entity($1, $2, null, $3) as r`,
    [fixture.spaceId, entityId, forceNew],
  );
  return result.rows[0]!.r;
}

async function taskRow(taskId: string): Promise<{ title: string; description: string }> {
  return asOwner(async (client) =>
    (await client.query<{ title: string; description: string }>(
      `select title, description from public.tasks where entity_id = $1`,
      [taskId],
    )).rows[0]!);
}

async function seed(scratch: W1ScratchDatabase): Promise<Fixture> {
  return scratch.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{
      identityId: string; spaceId: string; channelId: string; alice: string;
      workSessionId: string; plainTaskId: string;
    }>(
      `select 'threadspawn-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "channelId", internal.new_id()::text "alice",
              internal.new_id()::text "workSessionId", internal.new_id()::text "plainTaskId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Thread owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Thread Spawn Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$5,'member',null,0,$1),($2,$5,'channel',null,1,$1),
       ($3,$5,'work_session',null,2,$1),($4,$5,'task',null,3,$1)`,
      [base.alice, base.channelId, base.workSessionId, base.plainTaskId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Alice')`,
      [base.alice, base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.channels(entity_id,space_id,name) values($1,$2,'staging-auth')`,
      [base.channelId, base.spaceId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id,title,status) values($1,'a session','running')`,
      [base.workSessionId],
    );
    await client.query(
      `insert into public.tasks(entity_id,title,work_status,priority)
       values($1,'A plain task','open','medium')`,
      [base.plainTaskId],
    );

    const newMessage = async (
      rootId: string | null,
      body: string,
      offsetSeconds: number,
    ): Promise<string> => {
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by,created_at)
         values($1,$2,'message',$3,null,$4, now() + ($5 || ' seconds')::interval)`,
        [id, base.spaceId, rootId, base.alice, String(offsetSeconds)],
      );
      await client.query(
        `insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,created_at)
         values($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval)`,
        [id, base.channelId, rootId, base.alice, body, String(offsetSeconds)],
      );
      return id;
    };

    const rootId = await newMessage(null, ROOT_BODY, 0);
    const replyId = await newMessage(rootId, 'this reply must NOT become the derivation target', 10);
    const otherRootId = await newMessage(null, 'a different, unrelated thread', 20);

    return { ...base, rootId, replyId, otherRootId };
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('thread_spawn');
  database.apply(migrationFiles());
  fixture = await seed(database);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('derive_task_for_entity after 099', () => {
  it('titles a message-derived task from the body — excerpted, collapsed, never Untitled', async () => {
    const derived = await asViewer((client) => derive(client, fixture.rootId));
    expect(derived.created).toBe(true);
    expect(derived.sourceKind).toBe('message');

    const task = await taskRow(derived.taskId);
    expect(task.title).not.toContain('Untitled');
    expect(task.title.startsWith('Work on: auth is failing on staging')).toBe(true);
    // The multi-line body reads as ONE line: newlines collapsed to spaces.
    expect(task.title).not.toContain('\n');
    // 'Work on: ' (9) + a 120-CHARACTER excerpt. char_length, not bytes — the
    // fixture body carries multibyte μ to make a byte-counting left() overrun.
    expect(task.title.length).toBeLessThanOrEqual(129);
  });

  it('bodies the task with the root VERBATIM plus the LIVE read, never a thread snapshot', async () => {
    const derived = await asViewer((client) => derive(client, fixture.rootId));
    const task = await taskRow(derived.taskId);

    // The explicit named read the agent can run — channel id and root id.
    expect(task.description).toContain(
      `tm8 message list ${fixture.channelId} --root ${fixture.rootId}`,
    );
    // The root itself, verbatim (multibyte content intact).
    expect(task.description).toContain('μs vs ms in the expiry compare?');
    // NOT a snapshot of the branch: the reply's text must be absent, because a
    // thread is still moving and only the live read stays true.
    expect(task.description).not.toContain('must NOT become the derivation target');
  });

  it('normalizes a REPLY to its thread root: same task, edge targets the root', async () => {
    const fromRoot = await asViewer((client) => derive(client, fixture.rootId));
    const fromReply = await asViewer((client) => derive(client, fixture.replyId));

    expect(fromReply.taskId).toBe(fromRoot.taskId);
    expect(fromReply.created).toBe(false);
    // The result reports the NORMALIZED subject, and the provenance edge
    // targets the root — never the reply that happened to be dispatched.
    expect(fromReply.sourceEntityId).toBe(fixture.rootId);

    const edges = await asOwner(async (client) =>
      (await client.query<{ dst_id: string }>(
        `select dst_id from public.edges where src_id = $1 and type = 'derived_from'`,
        [fromRoot.taskId],
      )).rows);
    expect(edges.map((edge) => edge.dst_id)).toEqual([fixture.rootId]);
  });

  it('reuses the one open derivation; force_new mints a second', async () => {
    const first = await asViewer((client) => derive(client, fixture.rootId));
    expect(first.created).toBe(false); // reused from the tests above

    const forced = await asViewer((client) => derive(client, fixture.rootId, true));
    expect(forced.created).toBe(true);
    expect(forced.taskId).not.toBe(first.taskId);
  });

  it('REFUSES to pick among several open derivations, and names them all', async () => {
    let refusal: { code?: string; detail?: string } | null = null;
    try {
      await asViewer((client) => derive(client, fixture.rootId));
    } catch (error) {
      refusal = error as { code?: string; detail?: string };
    }
    expect(refusal, 'two open derived tasks must refuse, not guess').not.toBeNull();
    expect(refusal!.code).toBe('22023');

    const detail = JSON.parse(refusal!.detail ?? '{}') as { openDerivedTaskIds?: string[] };
    expect(detail.openDerivedTaskIds).toHaveLength(2);
  });

  it('lists the open derivations for ANY message in the thread, newest first', async () => {
    const listFor = async (entityId: string): Promise<Array<{ taskId: string; createdAt: string }>> =>
      asViewer(async (client) =>
        (await client.query<{ r: Array<{ taskId: string; createdAt: string }> }>(
          `select public.open_derived_tasks_for_entity($1, $2) as r`,
          [fixture.spaceId, entityId],
        )).rows[0]!.r);

    const fromRoot = await listFor(fixture.rootId);
    expect(fromRoot).toHaveLength(2);
    // Newest first — the forced task was created after the original.
    expect(new Date(fromRoot[0]!.createdAt).getTime())
      .toBeGreaterThanOrEqual(new Date(fromRoot[1]!.createdAt).getTime());

    // A reply asks about ITS thread, by the same normalization as derivation.
    expect(await listFor(fixture.replyId)).toEqual(fromRoot);
    // Another thread sees nothing — derivations do not bleed across roots.
    expect(await listFor(fixture.otherRootId)).toEqual([]);
  });

  it('closing one derivation makes reuse unambiguous again', async () => {
    const open = await asViewer(async (client) =>
      (await client.query<{ r: Array<{ taskId: string }> }>(
        `select public.open_derived_tasks_for_entity($1, $2) as r`,
        [fixture.spaceId, fixture.rootId],
      )).rows[0]!.r);
    await asOwner((client) =>
      client.query(`update public.tasks set work_status = 'done' where entity_id = $1`,
        [open[0]!.taskId]));

    const derived = await asViewer((client) => derive(client, fixture.rootId));
    expect(derived.created).toBe(false);
    expect(derived.taskId).toBe(open[1]!.taskId);
  });

  it('still refuses a work_session, and still fast-paths a task, after the signature change', async () => {
    await expect(
      asViewer((client) => derive(client, fixture.workSessionId)),
    ).rejects.toThrow(/cannot derive a task from a work_session/);

    // force_new must not offer a loophole around the refusal either.
    await expect(
      asViewer((client) => derive(client, fixture.workSessionId, true)),
    ).rejects.toThrow(/cannot derive a task from a work_session/);

    const passthrough = await asViewer((client) => derive(client, fixture.plainTaskId, true));
    expect(passthrough).toEqual({
      taskId: fixture.plainTaskId, sourceEntityId: fixture.plainTaskId,
      sourceKind: 'task', created: false,
    });
  });
});

/**
 * THE @TAG POKE — mention targets in `w2_record_session_message_routes` (099).
 *
 * A threaded reply has exactly one anchor (019), so @tag-on-a-reply cannot
 * ride the second-anchor trick; it rides the 072/076 delivery-route table as a
 * third target class. Asserted here: the route row is durable, the envelope
 * names the THREAD ROOT (what the poked session needs to read the live
 * thread), a bad target refuses rather than silently dropping the wake, and a
 * two-argument call — every pre-099 caller — is byte-for-byte unchanged.
 */
describe.sequential('mention targets in route recording', () => {
  interface RouteEnvelope {
    targetWorkSessionId: string;
    sourceAnchorId: string;
    sourceMessageId: string;
    threadRootMessageId: string;
    addressingKind: string;
  }

  const postReply = async (client: PoolClient, body: string, cmid: string): Promise<string> => {
    const batch = await client.query<{ r: { messageIds: string[] } }>(
      `select public.w2_post_message_batch($1, $2, $3, '{}', '{}', null, null, $4) as r`,
      [[fixture.channelId], body, fixture.rootId, cmid],
    );
    return batch.rows[0]!.r.messageIds[0]!;
  };

  it('pokes a session from a threaded reply: one route, thread root on the envelope', async () => {
    const { replyMessageId, routes } = await asViewer(async (client) => {
      const replyMessageId = await postReply(client, 'poking a session from inside a thread', 'poke-cmid-1');
      const result = await client.query<{ r: RouteEnvelope[] }>(
        `select public.w2_record_session_message_routes($1, null, $2) as r`,
        [[replyMessageId], [fixture.workSessionId]],
      );
      return { replyMessageId, routes: result.rows[0]!.r };
    });

    expect(routes).toHaveLength(1);
    const route = routes[0]!;
    expect(route.targetWorkSessionId).toBe(fixture.workSessionId);
    // The conversation stays the thread's home: the poked session replies to
    // (channel, tagging message) and lands IN the thread, never in a DM.
    expect(route.sourceAnchorId).toBe(fixture.channelId);
    expect(route.sourceMessageId).toBe(replyMessageId);
    expect(route.threadRootMessageId).toBe(fixture.rootId);
    expect(route.addressingKind).toBe('channel_mention');

    // Durable, not merely returned: the row is what a woken session's reply
    // resolves against after the request that created it is long gone. Read as
    // the MIGRATION role (no set role): the table is 072's, owned by the
    // default role and revoked from public — tm8_graph_owner cannot see it.
    const rows = await database.transaction(async (client) =>
      (await client.query(
        `select 1 from public.session_message_reply_routes
          where target_message_id = $1 and target_work_session_id = $2`,
        [replyMessageId, fixture.workSessionId],
      )).rows);
    expect(rows).toHaveLength(1);
  });

  it('REFUSES a poke target that is not a live work session in this space', async () => {
    let refusal: { code?: string } | null = null;
    try {
      await asViewer(async (client) => {
        const replyMessageId = await postReply(client, 'poking a task, which is not pokeable', 'poke-cmid-2');
        await client.query(
          `select public.w2_record_session_message_routes($1, null, $2)`,
          [[replyMessageId], [fixture.plainTaskId]],
        );
      });
    } catch (error) {
      refusal = error as { code?: string };
    }
    expect(refusal, 'a bad poke target must refuse, never silently drop the wake').not.toBeNull();
    expect(refusal!.code).toBe('22023');
  });

  it('keeps the two-argument call — every pre-099 caller — unchanged', async () => {
    const routes = await asViewer(async (client) => {
      const replyMessageId = await postReply(client, 'an unpoked reply owes the parent author only', 'poke-cmid-3');
      const result = await client.query<{ r: unknown[] }>(
        `select public.w2_record_session_message_routes($1, null) as r`,
        [[replyMessageId]],
      );
      return result.rows[0]!.r;
    });
    // The fixture root was seeded directly (no authored_from edge), nothing is
    // anchored on a session, and nothing was poked: an empty target set, which
    // is exactly what 076 answered here.
    expect(routes).toEqual([]);
  });
});
