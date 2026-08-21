/**
 * W2 delivery authority, proved through the production server path against a
 * real Postgres.
 *
 * Migration 135 removes the wake-pair row and the copied version that used to
 * travel reserve -> claim -> settle. The copied value was not optimistic
 * concurrency: claim and settle never re-read the pair row and the copy never
 * changed. Their concurrency boundary is the delivery row `FOR UPDATE`, while
 * the unique (message,target,attempt) key protects logical reservation identity.
 *
 * This file now proves those surviving boundaries directly: distinct messages
 * on one pair reserve concurrently, duplicate logical attempts cannot fork, and
 * concurrent claim/settle calls serialize on one durable row. It also proves
 * the removed table, columns, reset RPC and cleanup key are actually absent.
 *
 * MEASUREMENT VALIDITY — read this before trusting the result.
 * Every existing pg test reaches the three delivery RPCs by running as the
 * SUPERUSER `tm8`, which may assume any role. That proves nothing about the
 * production principal, because `tm8_delivery_worker` is `login noinherit` and
 * pg_catalog shows no membership granting it to `tm8_app`. So the delivery pool
 * here AUTHENTICATES AS `tm8_delivery_worker` — the production shape — and the
 * refusal half runs over a pool that AUTHENTICATES AS `tm8_app`. The superuser
 * pool is used only to build fixtures and to read rows back.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PgW2DeliveryRpcPort,
  W2ExecutionDeliveryService,
  type InternalPromptPty,
} from '../../src/facade/services/w2/execution.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

// LOAD-SENSITIVE TIMEOUTS. vitest ships TWO INDEPENDENT defaults — testTimeout
// 5s (a NAMED test failure) and hookTimeout 10s (an UNNAMED file-level abort) —
// and a generous argument on `beforeAll` covers NEITHER. MEASURED on this
// machine: one scratch-database `destroy()` costs ~5.0s at load 20, and the wave
// drives load to ~48, where the same assertions on the same tree take >5x longer.
// Per-hook arguments below still win where present; this raises the floor for
// every `it` in the file. Precedent: test/integration/inbox.test.ts:39.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  channelId: string;
}

/**
 * The graph a delivery needs, and nothing more.
 *
 * `authored_from` edges are immutable source-session provenance. Reserve
 * refuses a team_member-authored message without one, and uses it to enforce
 * same-Space endpoints and self-contact refusal.
 */
async function seedSpace(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'g11-owner'::text as "identityId",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "teammateId",
              internal.new_id()::text as "channelId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'G11 Owner')`,
      [ids.identityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'G11', $2)`,
      [ids.spaceId, ids.identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'member', $1)`,
      [ids.memberId, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'G11 Owner')`,
      [ids.memberId, ids.spaceId, ids.identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $2, 'team_member', $3), ($4, $2, 'channel', $3)`,
      [ids.teammateId, ids.spaceId, ids.memberId, ids.channelId],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name)
       values ($1, $2, 'G11 Teammate')`,
      [ids.teammateId, ids.memberId],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name) values ($1, $2, 'general')`,
      [ids.channelId, ids.spaceId],
    );
    return ids;
  });
}

/**
 * One work session. `status` is set at INSERT rather than transitioned:
 * `work_sessions.status` has a single writer (R29, guarded on UPDATE), and a
 * fixture forging `tm8.work_session_transition` to move it would be a fixture
 * defeating a production guard to make a test convenient.
 */
async function newSession(
  database: W1ScratchDatabase,
  fx: Fixture,
  title: string,
  status: 'running' | 'exited' = 'running',
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'work_session', $3)`,
      [id, fx.spaceId, fx.teammateId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status) values ($1, $2, $3)`,
      [id, title, status],
    );
    return id;
  });
}

/** A Teammate-authored message, bound to the session it was authored from. */
async function newTeammateMessage(
  database: W1ScratchDatabase,
  fx: Fixture,
  sourceSessionId: string,
  body: string,
  parentMessageId: string | null = null,
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, created_by)
       values ($1, $2, 'message', $3, $4)`,
      [id, fx.spaceId, parentMessageId, fx.teammateId],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body)
       values ($1, $2, $3, $4, $5)`,
      [id, fx.channelId, parentMessageId, fx.teammateId, body],
    );
    await client.query(`select internal.w1_set_writer('message_recorder')`);
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'authored_from', $4)`,
      [fx.spaceId, id, sourceSessionId, fx.teammateId],
    );
    await client.query(`select internal.w1_set_writer(null)`);
    return id;
  });
}

// ---------------------------------------------------------------------------
// the "process"
// ---------------------------------------------------------------------------

/** Counts what actually reached a terminal. Zero is half of B1 and half of B2. */
class RecordingPty implements InternalPromptPty {
  readonly deliveries: Array<{ sessionId: string; content: string }> = [];
  bytes = 0;
  private readonly live: Set<string>;

  constructor(live: readonly string[]) {
    this.live = new Set(live);
  }

  hasSession(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  async deliverPrompt(sessionId: string, content: string): Promise<boolean> {
    this.deliveries.push({ sessionId, content });
    this.bytes += Buffer.byteLength(content, 'utf8');
    return true;
  }
}

/**
 * Fake `InternalPromptDeliverySettlement` — this fixture's `RecordingPty` above
 * admits every delivery synchronously and never calls a real `onPromptSettled`,
 * so resolving 'delivered' immediately reproduces the admission-is-the-outcome
 * shape this file's assertions were written against.
 */
function fakePromptSettlement(): { awaitOutcome: () => Promise<{ outcome: 'delivered' }>; cancel: () => void } {
  return {
    awaitOutcome: async () => ({ outcome: 'delivered' }),
    cancel: () => {},
  };
}

interface ServerProcess {
  readonly pty: RecordingPty;
  readonly service: W2ExecutionDeliveryService;
  shutdown(): Promise<void>;
}

/**
 * Everything a node holds in memory for delivery, and nothing that outlives it.
 *
 * `boot`/`shutdown` is the whole restart apparatus: a new `ServerProcess` shares
 * NO object with the previous one — new pool, new sockets, new adapter, new
 * dedup map, new PTY. Durable delivery rows are the only shared state.
 */
function boot(deliveryUrl: string, liveSessions: readonly string[]): ServerProcess {
  const rpc = PgW2DeliveryRpcPort.fromConnectionString(deliveryUrl, 8);
  const pty = new RecordingPty(liveSessions);
  const service = new W2ExecutionDeliveryService({ rpc, pty, promptSettlement: fakePromptSettlement() });
  return {
    pty,
    service,
    shutdown: () => rpc.close(),
  };
}

interface DeliveryAttemptResult {
  reserved: boolean;
  outcome: string | null;
}

/**
 * The full server path for one delivery: reserve → mint → claim → one write →
 * settle. This is the sequence `W2MessagesHandoffsService` runs for each
 * `deliveryIntent`, driven directly so the assertions can see each step.
 */
async function deliver(
  proc: ServerProcess,
  messageId: string,
  targetWorkSessionId: string,
  content: string,
  attemptNo = 1,
): Promise<DeliveryAttemptResult> {
  const reservation = await proc.service.reserve({
    messageId,
    targetWorkSessionId,
    content,
    mode: 'send',
    requestId: `g11-${randomUUID()}`,
    attemptNo,
  });
  if (!reservation) return { reserved: false, outcome: null };
  const result = await proc.service.dispatch({
    ...reservation,
    requestId: `g11-${randomUUID()}`,
    principal: proc.service.principalFor(reservation),
  });
  return { reserved: true, outcome: result.outcome };
}

// ---------------------------------------------------------------------------

describe('W2 delivery principal without wake-pair machinery, over the real delivery RPCs', () => {
  let database: W1ScratchDatabase;
  let fx: Fixture;
  let deliveryUrl: string;
  let appUrl: string;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('g11_execution');
    try {
      // The chain is DERIVED, never hand-listed: every file db/migrations holds,
      // in official order. A slice would make this an isolation fixture rather
      // than a coverage one, and would silently stop applying whatever lands next.
      database.apply(migrationFiles());
      fx = await seedSpace(database);
      const url = new URL(database.url);
      url.username = 'tm8_delivery_worker';
      url.password = '';
      deliveryUrl = url.toString();
      const app = new URL(database.url);
      app.username = 'tm8_app';
      app.password = '';
      appUrl = app.toString();
    } catch (error) {
      // NO teardown here. The original comment was right that a leaked scratch
      // database is ~12 MiB nothing comes back for — but `afterAll` ALSO runs
      // when `beforeAll` throws, so destroying here made `destroy()` run TWICE
      // and `pool.end()` throw `Called end on pool more than once` (w1-pg.ts:111),
      // a confusing secondary error stacked on the real one. Measured in the
      // 039 landing attempt against the sibling file that had this same shape.
      // `afterAll` below is the sole teardown and still covers the failure path.
      throw error;
    }
  }, 240_000);

  // EXPLICIT hook timeout. vitest's default is 10s and `afterAll` is configured
  // INDEPENDENTLY of `beforeAll` — the 240s above does not reach this hook.
  // MEASURED on this machine at load ~20: one scratch-database `destroy()` costs
  // ~5.0s, HALF the default budget, and the wave drives load to ~48. An overrun
  // here would replace this file's NAMED failure with an UNNAMED file-level
  // abort, which is the one substitution a subset-of-named-tests gate cannot see.
  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  // -- the principal boundary, measured in production shape -------------------

  it('applies the whole official migration chain, derived from migrationFiles()', () => {
    const files = migrationFiles();
    expect(files).toEqual(migrationFiles());
    expect(files[0]).toBe('001_core_graph.sql');
    expect(files).toContain('015_w1_foundations.sql');
    expect(files).toContain('019_w2_messages_handoffs.sql');
    expect(files).toContain('146_remove_wake_budget_machinery.sql');
    // No 025/026/028 exist, and G11 does not add one.
    expect(files).not.toContain('026_w2_execution.sql');
  });

  it('the application role cannot execute or assume the delivery boundary', async () => {
    // The catalog fact, from pg_catalog rather than from reading a grant file.
    const privileges = (await database.query<{
      member: boolean;
      reserve: boolean;
      claim: boolean;
      settle: boolean;
    }>(
      `select pg_has_role('tm8_app', 'tm8_delivery_worker', 'USAGE') as member,
              has_function_privilege('tm8_app',
                'public.reserve_session_message_delivery(uuid,uuid,uuid,integer)', 'EXECUTE') as reserve,
              has_function_privilege('tm8_app',
                'public.claim_session_message_delivery(uuid,uuid,uuid)', 'EXECUTE') as claim,
              has_function_privilege('tm8_app',
                'public.settle_session_message_delivery(uuid,uuid,uuid,text,text)', 'EXECUTE') as settle`,
    ))[0]!;
    expect(privileges).toEqual({ member: false, reserve: false, claim: false, settle: false });

    // And executably, over a connection that really authenticates as tm8_app —
    // not a superuser pretending, which is how every existing test reaches these
    // RPCs and is why none of them measures this.
    const appPool = new Pool({ connectionString: appUrl, max: 1 });
    try {
      await expect(appPool.query('set role tm8_delivery_worker')).rejects.toThrow(
        /permission denied|must be a member/i,
      );
      await expect(
        appPool.query(`select public.reserve_session_message_delivery($1,$2,$3,1)`, [
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ]),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await appPool.end();
    }
  });

  it('the delivery worker connection is the one that works', async () => {
    const pool = new Pool({ connectionString: deliveryUrl, max: 1 });
    try {
      const who = (await pool.query<{ session_user: string }>(`select session_user`)).rows[0]!;
      expect(who.session_user).toBe('tm8_delivery_worker');
    } finally {
      await pool.end();
    }
  });

  it('removes the table, pair columns, reset/cleanup functions, and old RPC overloads', async () => {
    const removed = (await database.query<{
      wake_table: string | null;
      reset_rpc: string | null;
      cleanup_function: string | null;
      old_claim: string | null;
      old_settle: string | null;
      new_claim: string | null;
      new_settle: string | null;
    }>(
      `select to_regclass('public.session_wake_budgets')::text as wake_table,
              to_regprocedure('public.reset_session_wake_budget_for_member_reply(uuid,text)')::text as reset_rpc,
              to_regprocedure('internal.w1_refresh_wake_budget_cleanup_eligibility()')::text as cleanup_function,
              to_regprocedure('public.claim_session_message_delivery(uuid,uuid,uuid,integer)')::text as old_claim,
              to_regprocedure('public.settle_session_message_delivery(uuid,uuid,uuid,integer,text,text)')::text as old_settle,
              to_regprocedure('public.claim_session_message_delivery(uuid,uuid,uuid)')::text as new_claim,
              to_regprocedure('public.settle_session_message_delivery(uuid,uuid,uuid,text,text)')::text as new_settle`,
    ))[0]!;
    expect(removed).toMatchObject({
      wake_table: null,
      reset_rpc: null,
      cleanup_function: null,
      old_claim: null,
      old_settle: null,
    });
    expect(removed.new_claim).not.toBeNull();
    expect(removed.new_settle).not.toBeNull();

    const columns = await database.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='session_message_deliveries'
          and column_name like 'pair_%' order by column_name`,
    );
    expect(columns).toEqual([]);
  });

  it('distinct messages on one session pair reserve and settle concurrently', async () => {
    const source = await newSession(database, fx, 'G11 concurrent source');
    const target = await newSession(database, fx, 'G11 concurrent target');
    const messages = await Promise.all(
      Array.from({ length: 8 }, (_, i) => newTeammateMessage(database, fx, source, `parallel ${i}`)),
    );
    const proc = boot(deliveryUrl, [target]);
    try {
      const results = await Promise.all(
        messages.map((message, i) => deliver(proc, message, target, `parallel ${i}`)),
      );
      expect(results.map((result) => result.outcome)).toEqual(Array(8).fill('delivered'));
      expect(proc.pty.deliveries).toHaveLength(8);
      const rows = await database.query<{ n: string }>(
        `select count(*)::text n from public.session_message_deliveries
          where message_id = any($1::uuid[]) and status='delivered'`,
        [messages],
      );
      expect(rows[0]!.n).toBe('8');
    } finally {
      await proc.shutdown();
    }
  }, 120_000);

  it('the unique logical-attempt key still prevents concurrent reservation forks', async () => {
    const source = await newSession(database, fx, 'G11 duplicate source');
    const target = await newSession(database, fx, 'G11 duplicate target');
    const message = await newTeammateMessage(database, fx, source, 'one logical attempt');
    const first = boot(deliveryUrl, [target]);
    const second = boot(deliveryUrl, [target]);
    try {
      const results = await Promise.allSettled([
        first.service.reserve({ messageId: message, targetWorkSessionId: target, content: 'a', mode: 'send' }),
        second.service.reserve({ messageId: message, targetWorkSessionId: target, content: 'b', mode: 'send' }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      const rows = await database.query<{ n: string }>(
        `select count(*)::text n from public.session_message_deliveries
          where message_id=$1 and target_work_session_id=$2 and attempt_no=1`,
        [message, target],
      );
      expect(rows[0]!.n).toBe('1');
    } finally {
      await Promise.all([first.shutdown(), second.shutdown()]);
    }
  }, 120_000);

  it('claim and settle serialize on the delivery row and keep idempotent replay', async () => {
    const source = await newSession(database, fx, 'G11 transition source');
    const target = await newSession(database, fx, 'G11 transition target');
    const message = await newTeammateMessage(database, fx, source, 'one durable row');
    const rpc = PgW2DeliveryRpcPort.fromConnectionString(deliveryUrl, 8);
    const lease = {
      deliveryId: randomUUID(),
      messageId: message,
      targetWorkSessionId: target,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    try {
      expect((await rpc.reserve(lease, 1)).status).toBe('pending');
      const claimed = await Promise.all([rpc.claim(lease), rpc.claim(lease)]);
      expect(claimed.map((row) => row.status)).toEqual(['dispatching', 'dispatching']);
      const settled = await Promise.all([
        rpc.settle(lease, 'delivered', null),
        rpc.settle(lease, 'delivered', null),
      ]);
      expect(settled.map((row) => row.status)).toEqual(['delivered', 'delivered']);
      await expect(rpc.settle(lease, 'failed_permanent', 'late_conflict')).rejects.toThrow(
        /delivery cannot settle from status delivered/,
      );
    } finally {
      await rpc.close();
    }
  }, 120_000);

  it('durable delivery rows survive a complete server-process rebuild', async () => {
    const source = await newSession(database, fx, 'G11 restart source');
    const target = await newSession(database, fx, 'G11 restart target');
    const firstMessage = await newTeammateMessage(database, fx, source, 'before restart');
    const secondMessage = await newTeammateMessage(database, fx, source, 'after restart');
    const first = boot(deliveryUrl, [target]);
    expect((await deliver(first, firstMessage, target, 'before')).outcome).toBe('delivered');
    await first.shutdown();
    const second = boot(deliveryUrl, [target]);
    try {
      expect((await deliver(second, secondMessage, target, 'after')).outcome).toBe('delivered');
      const rows = await database.query<{ n: string }>(
        `select count(*)::text n from public.session_message_deliveries
          where message_id in ($1,$2) and status='delivered'`,
        [firstMessage, secondMessage],
      );
      expect(rows[0]!.n).toBe('2');
    } finally {
      await second.shutdown();
    }
  }, 120_000);

  it('a retry remains a distinct durable attempt', async () => {
    const source = await newSession(database, fx, 'G11 retry source');
    const target = await newSession(database, fx, 'G11 retry target');
    // The target has NO live terminal, so the first attempt settles refused —
    // which is exactly the situation that produces a retry.
    const proc = boot(deliveryUrl, []);
    try {
      const message = await newTeammateMessage(database, fx, source, 'retry me');
      expect((await deliver(proc, message, target, 'attempt one')).outcome).toBe('refused');
      expect(proc.pty.bytes).toBe(0);

      const stored = (await database.query<{ status: string; failure_reason: string }>(
        `select status, failure_reason from public.session_message_deliveries
          where message_id = $1 and attempt_no = 1`,
        [message],
      ))[0]!;
      expect(stored).toEqual({ status: 'failed_retryable', failure_reason: 'no_live_terminal' });

      // Attempt 2 is a NEW delivery id against the SAME message and target.
      expect((await deliver(proc, message, target, 'attempt two', 2)).outcome).toBe('refused');
      const attempts = await database.query<{ attempt_no: number; status: string }>(
        `select attempt_no,status from public.session_message_deliveries
          where message_id=$1 order by attempt_no`,
        [message],
      );
      expect(attempts).toEqual([
        { attempt_no: 1, status: 'failed_retryable' },
        { attempt_no: 2, status: 'failed_retryable' },
      ]);
    } finally {
      await proc.shutdown();
    }
  }, 60_000);

  // -- retention, through the path that already owns it -----------------------

  /**
   * SECOND PREMISE EXPIRED — migration 135 removes the pair columns themselves.
   * The long record below is retained as history for the 019/040 defect, but the
   * live regression assertion now pins the exited-target outcome and immutable
   * source provenance without reintroducing the retired pair shape.
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ⚠ PREMISE EXPIRED — 2026-07-27, by migration `040`.
   *
   * Everything below this banner described a LIVE defect. **It is repaired.**
   * `040_w2_b2_exited_target_teammate_pair_shape.sql` landed on chain
   * **37 / fff3995e1c2a5dcd** (was 34 / a799b7ef1b20a9b0) and populates the
   * three `pair_*` columns on the exited/failed branch.
   *
   * The original test here was a CAUSATION PIN — red / repair / green / revert /
   * red — and its premise was *"the shipped definition is broken."* `040` expires
   * that premise, so there is no red left to pin. **It is RECORDED AS EXPIRED
   * rather than re-pinned to pass**: weakening an assertion until it goes green
   * produces a green that describes nothing. What replaces it is a NEW assertion
   * with content that can fail — see the regression guard below.
   *
   * THE ARCHIVED RED IS `test/db/w2-execution-pre-019-pair-shape-red.txt`,
   * beside this file. Its filename names the constraint
   * (`pair_shape`) and it holds the verbatim pre-repair failure. That archive is
   * now the only place the original red can be read, which is why it was kept.
   *
   * ⚠ AND THE FINDING THAT OUTLIVES THE DEFECT, which belongs here and not only
   * in a report: **the repair text this test applied transiently — its
   * `declareBudget` and `withPairColumns` fragments — is BYTE-FOR-BYTE IDENTICAL
   * to what `040` shipped.** `040`'s author derived it independently from
   * `pg_catalog` and the `pair_shape` constraint, having never opened this file.
   * **The correct SQL sat in this directory, executable and green, applying and
   * reverting itself on every single run, for an entire wave — and nobody landed
   * it.** That is the close document's §2 non-transfer class in its strongest
   * form: not knowledge that was written down and ignored, but knowledge that was
   * RUNNING AND PASSING. If you are reading this while deciding whether to file a
   * finding or fix it: file it.
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ⚠ HISTORICAL — A PRODUCTION DEFECT IN MIGRATION 019, FOUND BY THIS SUITE.
   * Retained as the record of what was wrong. Not mine, and deliberately NOT
   * worked around into invisibility.
   *
   * The LIVE `reserve_session_message_delivery` is 019's redefinition, not
   * 015's — 015 has no such branch, which is why reading 015 gives the wrong
   * answer here and `pg_get_functiondef` gives the right one. 019 added an
   * early branch for a target that is no longer live:
   *
   *   if target_status in ('exited','failed') then
   *     insert into public.session_message_deliveries(
   *       delivery_id, message_id, source_work_session_id, target_work_session_id,
   *       status, attempt_no, failure_reason, settled_at)          -- ← no pair_* columns
   *     values (..., source_session, ..., 'failed_permanent', ..., 'session_not_live', now())
   *
   * It writes `source_work_session_id` NON-NULL and leaves `pair_low_session_id`,
   * `pair_high_session_id` and `pair_budget_version` to default NULL. That is
   * precisely the combination `session_message_deliveries_pair_shape` forbids:
   * either all four are null, or all four are set. So the branch raises 23514
   * and can NEVER complete for a Teammate-authored message — and a Teammate
   * message is the only kind that reaches it with a source session at all,
   * because 019 raises earlier if a team_member message has no `authored_from`.
   *
   * Effect: every wake aimed at a session that has already exited or failed
   * returns an invariant violation instead of the `failed_permanent` /
   * `session_not_live` record the branch was written to produce — and the
   * `w2_delivery_fallback` call below it never runs, so the fallback that is
   * supposed to catch an undeliverable message is dead code today.
   *
   * THIS TEST HAS BOTH HALVES, which is why it is not simply an `it.fails`.
   * A red alone would only show that SOMETHING throws on this path; it would
   * not show that the missing pair columns are the cause, and a "detector"
   * with no green control has an unmeasured false-positive rate. So the test
   * runs the full causal sequence IN THE SCRATCH DATABASE ONLY:
   *
   *   1. RED     — the shipped function raises 23514 on an exited target.
   *   2. REPAIR  — `create or replace` the captured definition with the three
   *                pair columns populated, and nothing else changed.
   *   3. GREEN   — the same delivery now records failed_permanent/session_not_live.
   *   4. REVERT  — restore the byte-identical captured definition.
   *   5. RED AGAIN — verified revert, so the green cannot be an artefact of
   *                  anything but the repair.
   *
   * Step 2 is NOT a migration and does not touch db/migrations. It is a
   * disposable in-memory repair whose only purpose is to identify the cause;
   * the fix itself is a shared-object change to 019 and belongs to whoever
   * sequences that migration.
   *
   * When 019 is properly repaired, step 1 stops raising and this test goes RED
   * — loudly, and in the right direction.
   */
  it('a Teammate wake at an exited target writes one settled row with source provenance', async () => {
    const source = await newSession(database, fx, 'G11 dead source');
    const target = await newSession(database, fx, 'G11 dead target', 'exited');
    const message = await newTeammateMessage(database, fx, source, 'nobody home');
    const proc = boot(deliveryUrl, [target]);
    let error: string | null = null;
    try {
      await deliver(proc, message, target, 'into the void');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      await proc.shutdown();
    }
    expect(error).toBeNull();

    const rows = await database.query<{
      status: string;
      failure_reason: string;
      source_work_session_id: string | null;
    }>(
      `select status, failure_reason, source_work_session_id::text
         from public.session_message_deliveries where message_id = $1`,
      [message],
    );
    // ZERO rows was the defect. Exactly one is the repair.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('failed_permanent');
    expect(row.failure_reason).toBe('session_not_live');
    expect(row.source_work_session_id).toBe(source);
  }, 120_000);

  /**
   * 168 — THE REPAIR. This assertion used to be its exact inverse: a
   * `team_member`-authored message with no `authored_from` edge was REFUSED at
   * reservation, and the test asserted the refusal and zero rows.
   *
   * That guard was written in 019, when the only Teammate that could speak WAS
   * a work session, so a missing edge meant provenance had been lost. It stopped
   * meaning that. TM8 Chat teammates (104/105) and 103's forge watcher are
   * authenticated Teammates that do not speak from a session and never carry the
   * edge — so on the live node every message they addressed to a session was
   * dropped here: stored, routed, 200, and zero delivery rows. 19 routes, 19
   * drops, no exceptions, since the class first appeared.
   *
   * The message now reserves with `source_work_session_id` NULL, which is what a
   * Member author has always done, and the envelope renders that null as
   * `attribution="recorded_only"` — it never claims a session that did not
   * speak. The `verified` attribution still requires the edge, and the edge
   * still has exactly one writer.
   */
  it('168: a Teammate message with no source session is DELIVERED, attributed recorded_only', async () => {
    const target = await newSession(database, fx, 'G11 no-provenance target');
    // Deliberately NOT newTeammateMessage(): that helper writes the
    // `authored_from` edge, which is exactly the provenance being withheld here.
    const message = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>(
        `select internal.new_id()::text id`,
      )).rows[0]!.id;
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by)
         values ($1, $2, 'message', $3)`,
        [id, fx.spaceId, fx.teammateId],
      );
      await client.query(
        `insert into public.messages(entity_id, anchor_id, author_id, body)
         values ($1, $2, $3, 'no provenance')`,
        [id, fx.channelId, fx.teammateId],
      );
      return id;
    });

    const proc = boot(deliveryUrl, [target]);
    try {
      const attempt = await deliver(proc, message, target, 'a steer with no session behind it');
      expect(attempt.reserved).toBe(true);
      expect(attempt.outcome).toBe('delivered');
      // The bytes reached the terminal, which is the whole point: a stored
      // message that never enters the PTY is the defect this file now pins.
      expect(proc.pty.deliveries).toHaveLength(1);
      expect(proc.pty.deliveries[0]!.sessionId).toBe(target);
    } finally {
      await proc.shutdown();
    }

    const rows = await database.query<{
      status: string; source_work_session_id: string | null;
    }>(
      `select status, source_work_session_id::text
         from public.session_message_deliveries where message_id = $1`,
      [message],
    );
    // ZERO rows was the defect. Exactly one, with a NULL source, is the repair.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('delivered');
    expect(rows[0]!.source_work_session_id).toBeNull();
  }, 120_000);

  /**
   * KNOWN-BAD half, and it SURVIVES both `040` and `168` — which is the property
   * the coordinator required and the reason this guard is worth anything.
   *
   * A detector that loses its red at the moment of the fix cannot demonstrate it
   * would still catch a regression; it can only demonstrate that today is fine.
   * The red used to be taken from the no-provenance refusal — which `168` has
   * now deliberately removed, so it can no longer serve. It is taken instead
   * from another still-live guard on the same function: SELF-CONTACT, where a
   * message's `authored_from` session IS the delivery target.
   *
   * That raise sits between the provenance branch `168` rewrote and the
   * `target_status in ('exited','failed')` branch `040` rewrote, so neither file
   * touches it. It is a real production guard producing a real refusal — not a
   * synthetic mutation — which is why it can still prove the harness detects a
   * refusal at all.
   */
  it('...and the detector keeps a live known-bad: a session may not be handed its own message', async () => {
    const session = await newSession(database, fx, 'G11 self-contact session');
    // WITH provenance this time, and pointing at the delivery target itself.
    const message = await newTeammateMessage(database, fx, session, 'talking to myself');

    const proc = boot(deliveryUrl, [session]);
    let error: string | null = null;
    try {
      await deliver(proc, message, session, 'into the void');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      await proc.shutdown();
    }
    expect(error).toMatch(/self-contact is forbidden/);

    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.session_message_deliveries where message_id = $1`,
      [message],
    );
    expect(rows[0]!.n).toBe('0');
  }, 120_000);

  it('cleanup runs on the existing owner path — no fourth delivery RPC', async () => {
    // Last on purpose: `w1_prune_operational_state` is node-wide, and running it
    // earlier would prune rows the tests above are still asserting on.
    //
    // The sessions are alive for the delivery and retired afterwards THROUGH
    // `work_session_transition` — R29's single writer. A fixture that inserted
    // them already-exited would take the 019 branch above and never reach the
    // retention path this test is about; a fixture that forged
    // `tm8.work_session_transition` to UPDATE the column directly would be a
    // test defeating a production guard for its own convenience.
    const source = await newSession(database, fx, 'G11 done source');
    const target = await newSession(database, fx, 'G11 done target');
    const message = await newTeammateMessage(database, fx, source, 'last words');
    const proc = boot(deliveryUrl, [target]);
    try {
      expect((await deliver(proc, message, target, 'final')).outcome).toBe('delivered');
    } finally {
      await proc.shutdown();
    }

    for (const sessionId of [source, target]) {
      await database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id', $1, true)`, [fx.identityId]);
        await client.query(
          `select public.work_session_transition($1, 'exited', 0, null, null, $2)`,
          [sessionId, `g11-exit-${randomUUID()}`],
        );
      });
    }

    const pruned = (await database.query<{
      result: { deliveriesDeleted: number; budgetsDeleted?: number };
    }>(
      `select internal.w1_prune_operational_state(now() + interval '31 days') as result`,
    ))[0]!.result;
    expect(pruned.deliveriesDeleted).toBeGreaterThanOrEqual(1);
    expect(pruned).not.toHaveProperty('budgetsDeleted');
    const retained = await database.query<{ n: string }>(
      `select count(*)::text n from public.session_message_deliveries where message_id=$1`,
      [message],
    );
    expect(retained[0]!.n).toBe('0');

    // The delivery role's surface is still exactly three functions.
    const granted = await database.query<{ proname: string }>(
      `select p.proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('tm8_delivery_worker', p.oid, 'EXECUTE')
        order by p.proname`,
    );
    expect(granted.map((r) => r.proname)).toEqual([
      'claim_session_message_delivery',
      'reserve_session_message_delivery',
      'settle_session_message_delivery',
    ]);
  }, 60_000);
});
