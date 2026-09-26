/**
 * 220 — the SECURITY DEFINER RPCs that filtered many rows by
 * `internal.is_space_member(x.space_id)` now read 218's membership array once
 * per statement, and admit exactly the rows they admitted before.
 *
 * 218 fixed the POLICIES; these functions bypass RLS and test membership
 * themselves, so 218 could not reach them. Every visibility assertion is a
 * red/green pair: the member gets the row AND the outsider (a member of a
 * different space) and the stranger (no membership) do not.
 *
 * Also pinned: `internal.uuid_at` inlines (its body is IMMUTABLE now), and
 * `tm8_graph_owner` may execute `internal.repo_slug_from_url`, which the
 * SECURITY DEFINER PR observer reaches through `internal.pr_owning_session`.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MEMBER_IDENTITY = 'secdef220-member';
/** A second member of the same space: the author of the unread messages. */
const AUTHOR_IDENTITY = 'secdef220-author';
/** A member of a DIFFERENT space only. */
const OUTSIDER_IDENTITY = 'secdef220-outsider';
/** A real identity with no membership at all. */
const STRANGER_IDENTITY = 'secdef220-stranger';

/** The functions 220 rewrote that must no longer call the per-row helper at all. */
const REWRITTEN = [
  'claim_form_deliveries',
  'claim_pending_task_nudges',
  'claim_pending_nudges',
  'retire_stale_pending_nudges',
  'observer_watch_targets',
  'claim_tracking_refresh',
];

interface Fixture {
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  authorId: string;
  outsiderMemberId: string;
  channelId: string;
  taskId: string;
  sessionId: string;
  prId: string;
  pendingNudgeId: string;
  refreshId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** Runs as `tm8_app` under `identity`, and ROLLS BACK: the claim RPCs mutate. */
async function asIdentity<T>(
  identity: string,
  fn: (client: PoolClient) => Promise<T>,
  opts: { trackFunctions?: boolean } = {},
): Promise<T> {
  let result: T | undefined;
  const rollback = new Error('rollback');
  try {
    await database.transaction(async (client) => {
      // A superuser-only setting: set before dropping to tm8_app.
      if (opts.trackFunctions) await client.query(`set local track_functions = 'all'`);
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [identity]);
      await client.query(
        `select set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'secdef-membership-once-per-statement-pg', true)`,
      );
      result = await fn(client);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return result as T;
}

async function rpc<T>(identity: string, sql: string, params: unknown[] = []): Promise<T> {
  return asIdentity(identity, async (client) => (await client.query<{ r: T }>(sql, params)).rows[0]!.r);
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const id = async () => (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
    const fx: Fixture = {
      spaceId: await id(),
      otherSpaceId: await id(),
      memberId: await id(),
      authorId: await id(),
      outsiderMemberId: await id(),
      channelId: await id(),
      taskId: await id(),
      sessionId: await id(),
      prId: await id(),
      pendingNudgeId: await id(),
      refreshId: await id(),
    };

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, '220 member'), ($2, '220 author'), ($3, '220 outsider'), ($4, '220 stranger')`,
      [MEMBER_IDENTITY, AUTHOR_IDENTITY, OUTSIDER_IDENTITY, STRANGER_IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Secdef 220', $3), ($2, 'Secdef 220 elsewhere', $4)`,
      [fx.spaceId, fx.otherSpaceId, MEMBER_IDENTITY, OUTSIDER_IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $4, 'member', 0, $1), ($2, $4, 'member', 1, $2), ($3, $5, 'member', 0, $3)`,
      [fx.memberId, fx.authorId, fx.outsiderMemberId, fx.spaceId, fx.otherSpaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $4, $6, 'owner', '220 member'), ($2, $4, $7, 'member', '220 author'),
       ($3, $5, $8, 'owner', '220 outsider')`,
      [
        fx.memberId, fx.authorId, fx.outsiderMemberId, fx.spaceId, fx.otherSpaceId,
        MEMBER_IDENTITY, AUTHOR_IDENTITY, OUTSIDER_IDENTITY,
      ],
    );

    // A channel with three messages by the author, and an OLD read mark for the
    // member, so `unread_counts` evaluates `uuid_at(last_read_at)` per row.
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $2, 'channel', 2, $3)`,
      [fx.channelId, fx.spaceId, fx.memberId],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic) values ($1, $2, 'general', '220')`,
      [fx.channelId, fx.spaceId],
    );
    for (let i = 0; i < 3; i += 1) {
      const messageId = await id();
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $2, 'message', null, $3)`,
        [messageId, fx.spaceId, fx.authorId],
      );
      await client.query(
        `insert into public.messages(entity_id, anchor_id, author_id, body, client_msg_id)
         values ($1, $2, $3, $4, gen_random_uuid()::text)`,
        [messageId, fx.channelId, fx.authorId, `message ${i}`],
      );
    }
    await client.query(
      `insert into public.read_marks(anchor_id, member_id, last_read_at)
       values ($1, $2, now() - interval '1 day')`,
      [fx.channelId, fx.memberId],
    );

    // A task, a session on it, a pending task nudge, a tracked PR, and a
    // queued tracking refresh — one row for each claim RPC to find.
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by, visibility) values
       ($1, $4, 'task', 10, $5, 'space'), ($2, $4, 'work_session', 11, $5, 'space'),
       ($3, $4, 'pull_request', 12, $5, 'space')`,
      [fx.taskId, fx.sessionId, fx.prId, fx.spaceId, fx.memberId],
    );
    await client.query(`insert into public.tasks(entity_id, title, work_status) values ($1, '220', 'working')`, [
      fx.taskId,
    ]);
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, session_kind, workdir_mode)
       values ($1, 'worker', 'running', 'space', 'agent', 'scratch')`,
      [fx.sessionId],
    );
    await client.query(
      `insert into public.pull_requests(entity_id, space_id, url, repo, number, state)
       values ($1, $2, 'https://github.com/o/r/pull/1', 'o/r', 1, 'open')`,
      [fx.prId, fx.spaceId],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'tracks', $4)`,
      [fx.spaceId, fx.taskId, fx.prId, fx.memberId],
    );
    await client.query(
      `insert into public.pending_task_nudges(id, space_id, work_session_id, task_id, loop_kind, cause)
       values ($1, $2, $3, $4, 'closure', 'completed')`,
      [fx.pendingNudgeId, fx.spaceId, fx.sessionId, fx.taskId],
    );
    await client.query(
      `insert into public.tracking_refresh_requests(id, space_id, requested_by, entity_ids)
       values ($1, $2, $3, array[$4]::uuid[])`,
      [fx.refreshId, fx.spaceId, fx.memberId, fx.prId],
    );
    return fx;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('secdef_membership_220');
  database.apply(migrationFiles());
  fixture = await seed();
});

afterAll(async () => {
  await database?.destroy();
});

describe('unread_counts (was is_space_member per message row)', () => {
  const sql = `select coalesce(json_agg(json_build_object('anchor', anchor_id, 'unread', unread)), '[]') r
                 from public.unread_counts($1)`;

  it('counts the member\'s unread messages, and nothing for the outsider or the stranger', async () => {
    expect(await rpc(MEMBER_IDENTITY, sql, [fixture.spaceId])).toEqual([
      { anchor: fixture.channelId, unread: 3 },
    ]);
    expect(await rpc(OUTSIDER_IDENTITY, sql, [fixture.spaceId])).toEqual([]);
    expect(await rpc(STRANGER_IDENTITY, sql, [fixture.spaceId])).toEqual([]);
  });

  it('calls is_space_member once per call (the one-time filter), and uuid_at never', async () => {
    const calls = await asIdentity(MEMBER_IDENTITY, async (client) => {
      await client.query('select * from public.unread_counts($1)', [fixture.spaceId]);
      const rows = await client.query<{ funcname: string; calls: string }>(
        `select funcname, calls from pg_stat_xact_user_functions
          where funcname in ('is_space_member', 'uuid_at', 'member_space_ids')`,
      );
      return Object.fromEntries(rows.rows.map((r) => [r.funcname, Number(r.calls)]));
    }, { trackFunctions: true });
    // Three messages: before 220 this was 1 + 3 is_space_member and 3 uuid_at.
    expect(calls['is_space_member']).toBe(1);
    expect(calls['member_space_ids']).toBe(1);
    expect(calls['uuid_at']).toBeUndefined();
  });
});

describe('claim RPCs (was is_space_member per candidate row)', () => {
  it('claim_pending_task_nudges returns the space\'s pending nudge to its member only', async () => {
    type Out = { pending: { pendingId: string }[] };
    const sql = 'select public.claim_pending_task_nudges(100, 24) r';
    expect((await rpc<Out>(MEMBER_IDENTITY, sql)).pending.map((p) => p.pendingId)).toEqual([
      fixture.pendingNudgeId,
    ]);
    expect((await rpc<Out>(OUTSIDER_IDENTITY, sql)).pending).toEqual([]);
    expect((await rpc<Out>(STRANGER_IDENTITY, sql)).pending).toEqual([]);
  });

  it('observer_watch_targets lists the tracked PR to its member only, and does not fail on permissions', async () => {
    type Out = { targets: { prEntityId: string }[] };
    const sql = 'select public.observer_watch_targets(25, 0) r';
    expect((await rpc<Out>(MEMBER_IDENTITY, sql)).targets.map((t) => t.prEntityId)).toEqual([fixture.prId]);
    expect((await rpc<Out>(OUTSIDER_IDENTITY, sql)).targets).toEqual([]);
    expect((await rpc<Out>(STRANGER_IDENTITY, sql)).targets).toEqual([]);
  });

  it('claim_tracking_refresh claims the space\'s queued request for its member only', async () => {
    type Out = { claimed: { requestId: string }[] };
    const sql = 'select public.claim_tracking_refresh() r';
    expect((await rpc<Out>(MEMBER_IDENTITY, sql)).claimed.map((c) => c.requestId)).toEqual([fixture.refreshId]);
    expect((await rpc<Out>(OUTSIDER_IDENTITY, sql)).claimed).toEqual([]);
    expect((await rpc<Out>(STRANGER_IDENTITY, sql)).claimed).toEqual([]);
  });

  it('no rewritten function calls the per-row helper any more', async () => {
    const rows = await database.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[])
          and p.prosrc ~ 'is_space_member\\('`,
      [REWRITTEN],
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
    const [unread] = await database.query<{ src: string }>(
      `select prosrc src from pg_proc where oid = 'public.unread_counts(uuid)'::regprocedure`,
    );
    // Only the parameter test survives: the planner runs it once.
    expect(unread!.src.match(/is_space_member\(([^)]*)\)/g)).toEqual(['is_space_member(p_space_id)']);
    expect(unread!.src).toContain('member_space_ids()');
  });
});

describe('internal.uuid_at', () => {
  it('inlines, and yields the same uuid as the STABLE body in any session time zone', async () => {
    const plan = await asIdentity(MEMBER_IDENTITY, async (client) => {
      const rows = await client.query<{ 'QUERY PLAN': string }>(
        `explain (costs off, verbose) select internal.uuid_at(now() - g * interval '1 hour')
           from generate_series(1, 3) g`,
      );
      return rows.rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).not.toContain('uuid_at(');

    for (const zone of ['UTC', 'Asia/Kolkata', 'America/St_Johns']) {
      const [row] = await database.transaction(async (client) => {
        await client.query(`set local timezone = '${zone}'`);
        return (await client.query<{ mismatches: string }>(
          `select count(*) filter (where internal.uuid_at(t) <>
                    (lpad(to_hex(floor(extract(epoch from t) * 1000)::bigint), 12, '0')
                     || '7000' || '8000' || '000000000000')::uuid) mismatches
             from generate_series(timestamptz '2020-03-08 00:00:00.123456+00',
                                  timestamptz '2020-03-09 00:00:00+00', interval '7 minutes 13.017 seconds') t`,
        )).rows;
      });
      expect(Number(row!.mismatches)).toBe(0);
    }
  });
});

describe('repo_slug_from_url grant', () => {
  it('is executable by tm8_graph_owner, the definer of the PR observer RPCs', async () => {
    const [row] = await database.query<{ ok: boolean }>(
      `select has_function_privilege('tm8_graph_owner', 'internal.repo_slug_from_url(text)', 'execute') ok`,
    );
    expect(row!.ok).toBe(true);
    const slug = await asOwner(async (client) =>
      (await client.query<{ s: string }>(`select internal.repo_slug_from_url('https://github.com/o/r.git') s`))
        .rows[0]!.s,
    );
    expect(slug).toBe('o/r');
  });
});
