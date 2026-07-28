/**
 * W2 G11 — B2, proved by execution against a real Postgres.
 *
 * B2: every Teammate-authored live delivery uses ONE DURABLE UNORDERED PAIR
 * BUDGET, so that no thread root and no process restart mints a fresh
 * allowance. Both adjectives are load-bearing and both are proved here by
 * OBSERVATION rather than by reading that a value was stored:
 *
 *   DURABLE   — the process is destroyed. The `W2ExecutionDeliveryService`,
 *               the `W2MessageDeliveryAdapter` inside it and the pg `Pool`
 *               underneath it are all torn down and rebuilt from nothing, and
 *               the budget is then observed to CONTINUE rather than restart.
 *               A comment saying "the counter lives in Postgres" is not this
 *               test; a fresh process that gets four more wakes would fail it.
 *   UNORDERED — {A,B} and {B,A} are shown to be one row and one counter, by
 *               driving a wake in each direction and counting both.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT RE-PROVE. 015's own suite already
 * establishes the schema-level facts (5-way concurrent reserve → 4 pending + 1
 * `failed_permanent`, budget {wakes: 4, version: 4}, claim/settle, the Member
 * reset). Re-asserting them here would inflate the evidence without adding
 * any. What was NOT covered anywhere, and is the entire reason G11 exists, is
 * that NOTHING IN THE SERVER EVER CALLED ANY OF IT: `mintSystemDeliveryPrincipal`
 * had zero production call sites, `W2MessageDeliveryAdapter` had zero
 * production instantiations, and the `options.messageDelivery` seam G04 cut and
 * labelled "G11 owns this" was filled by no caller in src or test. A written
 * authorizer that nothing invokes is a comment, not a defence. So this file's
 * subject is the SERVER PATH, end to end, over the real RPCs.
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
 * `authored_from` edges are what make a message a TEAMMATE wake — 015's
 * `reserve_session_message_delivery` refuses a team_member-authored message
 * with no source session, because a wake with no provenance cannot be charged
 * to a pair.
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

/** A Member reply under a Teammate message — the human turn that resets B2. */
async function newMemberReply(
  database: W1ScratchDatabase,
  fx: Fixture,
  parentMessageId: string,
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, parent_id, created_by)
       values ($1, $2, 'message', $3, $4)`,
      [id, fx.spaceId, parentMessageId, fx.memberId],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body)
       values ($1, $2, $3, $4, 'human turn')`,
      [id, fx.channelId, parentMessageId, fx.memberId],
    );
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
 * dedup map, new PTY. If any wake state were process-local, a fresh boot would
 * hand out a fresh allowance, and that is the failure this test is shaped to
 * catch.
 */
function boot(deliveryUrl: string, liveSessions: readonly string[]): ServerProcess {
  const rpc = PgW2DeliveryRpcPort.fromConnectionString(deliveryUrl, 8);
  const pty = new RecordingPty(liveSessions);
  const service = new W2ExecutionDeliveryService({ rpc, pty });
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

describe('W2 G11 — B2 durable unordered pair budget, over the real delivery RPCs', () => {
  let database: W1ScratchDatabase;
  let fx: Fixture;
  let deliveryUrl: string;
  let appUrl: string;

  const budgetOf = async (a: string, b: string) =>
    (await database.query<{ consecutive_agent_wakes: number; version: number }>(
      `select consecutive_agent_wakes, version from public.session_wake_budgets
        where low_work_session_id = least($1::uuid, $2::uuid)
          and high_work_session_id = greatest($1::uuid, $2::uuid)`,
      [a, b],
    ))[0] ?? null;

  const budgetRowCount = async (a: string, b: string) =>
    Number(
      (await database.query<{ n: string }>(
        `select count(*)::text n from public.session_wake_budgets
          where (low_work_session_id, high_work_session_id)
                in ((least($1::uuid,$2::uuid), greatest($1::uuid,$2::uuid)))`,
        [a, b],
      ))[0]!.n,
    );

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
                'public.claim_session_message_delivery(uuid,uuid,uuid,integer)', 'EXECUTE') as claim,
              has_function_privilege('tm8_app',
                'public.settle_session_message_delivery(uuid,uuid,uuid,integer,text,text)', 'EXECUTE') as settle`,
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

  // -- B2: one budget across thread roots -------------------------------------

  it('a top-level wake and a reply wake share ONE budget — no thread root mints an allowance', async () => {
    const source = await newSession(database, fx, 'G11 source');
    const target = await newSession(database, fx, 'G11 target');
    const proc = boot(deliveryUrl, [target]);
    try {
      const root = await newTeammateMessage(database, fx, source, 'top level');
      const reply = await newTeammateMessage(database, fx, source, 'in thread', root);

      // Concurrent, because a budget that only holds when calls are serialized
      // is not a budget — 015 takes `for update` on the pair row and this is
      // what exercises it from the server path.
      const [a, b] = await Promise.all([
        deliver(proc, root, target, 'wake one'),
        deliver(proc, reply, target, 'wake two'),
      ]);
      expect([a.outcome, b.outcome]).toEqual(['delivered', 'delivered']);

      expect(await budgetRowCount(source, target)).toBe(1);
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 2 });
      expect(proc.pty.bytes).toBeGreaterThan(0);
    } finally {
      await proc.shutdown();
    }
  }, 60_000);

  it('{A,B} and {B,A} are the SAME budget — the pair is unordered', async () => {
    const alpha = await newSession(database, fx, 'G11 alpha');
    const beta = await newSession(database, fx, 'G11 beta');
    const proc = boot(deliveryUrl, [alpha, beta]);
    try {
      const fromAlpha = await newTeammateMessage(database, fx, alpha, 'alpha speaks');
      expect((await deliver(proc, fromAlpha, beta, 'a to b')).outcome).toBe('delivered');
      expect(await budgetOf(alpha, beta)).toMatchObject({ consecutive_agent_wakes: 1 });

      // The other direction. If direction minted its own row this would read 1.
      const fromBeta = await newTeammateMessage(database, fx, beta, 'beta answers');
      expect((await deliver(proc, fromBeta, alpha, 'b to a')).outcome).toBe('delivered');

      expect(await budgetRowCount(alpha, beta)).toBe(1);
      expect(await budgetRowCount(beta, alpha)).toBe(1);
      expect(await budgetOf(beta, alpha)).toMatchObject({ consecutive_agent_wakes: 2 });
    } finally {
      await proc.shutdown();
    }
  }, 60_000);

  // -- B2: the restart proof --------------------------------------------------

  it('SURVIVES A PROCESS RESTART: a fresh process does not mint a fresh allowance', async () => {
    const source = await newSession(database, fx, 'G11 restart source');
    const target = await newSession(database, fx, 'G11 restart target');
    const messages: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      messages.push(await newTeammateMessage(database, fx, source, `wake ${i}`));
    }

    // ── process 1 ──
    const first = boot(deliveryUrl, [target]);
    expect((await deliver(first, messages[0]!, target, 'one')).outcome).toBe('delivered');
    expect((await deliver(first, messages[1]!, target, 'two')).outcome).toBe('delivered');
    expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 2 });
    const bytesBefore = first.pty.bytes;
    expect(bytesBefore).toBeGreaterThan(0);

    // ── the restart. Pool, adapter, dedup map and PTY are all destroyed. ──
    await first.shutdown();

    // ── process 2: shares no object with process 1 ──
    const second = boot(deliveryUrl, [target]);
    try {
      expect(second.pty.bytes).toBe(0);

      // A fresh allowance would let all four through. The budget continues, so
      // exactly two remain.
      expect((await deliver(second, messages[2]!, target, 'three')).outcome).toBe('delivered');
      expect((await deliver(second, messages[3]!, target, 'four')).outcome).toBe('delivered');
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 4 });

      // The fifth is refused, and refused BEFORE any byte: `reserve` returns
      // null, so nothing is minted, claimed or written.
      const bytesAtLimit = second.pty.bytes;
      const fifth = await deliver(second, messages[4]!, target, 'five');
      expect(fifth).toEqual({ reserved: false, outcome: null });
      expect(second.pty.bytes).toBe(bytesAtLimit);
      expect(second.pty.deliveries).toHaveLength(2);

      const refused = (await database.query<{ status: string; failure_reason: string }>(
        `select status, failure_reason from public.session_message_deliveries
          where message_id = $1 and target_work_session_id = $2`,
        [messages[4]!, target],
      ))[0]!;
      expect(refused).toEqual({
        status: 'failed_permanent',
        failure_reason: 'automated_wake_limit',
      });

      // ── and once more, to close the loophole a restart-at-the-limit would be ──
      await second.shutdown();
      const third = boot(deliveryUrl, [target]);
      try {
        const afterRestartAtLimit = await deliver(third, messages[5]!, target, 'six');
        expect(afterRestartAtLimit).toEqual({ reserved: false, outcome: null });
        expect(third.pty.bytes).toBe(0);
        expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 4 });
      } finally {
        await third.shutdown();
      }
    } finally {
      await second.shutdown().catch(() => undefined);
    }
  }, 120_000);

  // -- B2: Member reset and retry ---------------------------------------------

  it('a Member reply resets the budget, and the SAME pair then wakes again', async () => {
    const source = await newSession(database, fx, 'G11 reset source');
    const target = await newSession(database, fx, 'G11 reset target');
    const proc = boot(deliveryUrl, [target]);
    try {
      const first = await newTeammateMessage(database, fx, source, 'before the human');
      expect((await deliver(proc, first, target, 'pre-reset')).outcome).toBe('delivered');
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 1 });

      const reply = await newMemberReply(database, fx, first);
      // A BOUND caller: `tm8.identity_id` names a real member of the space.
      // Deliberately so — the authorization on this RPC is tightening in a
      // migration authored elsewhere, and a proof that depended on an UNBOUND
      // caller reaching it would be a proof of the defect, not of B2.
      const reset = await database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id', $1, true)`, [fx.identityId]);
        return (await client.query<{ reset: { reset: boolean } }>(
          `select public.reset_session_wake_budget_for_member_reply($1, $2) as reset`,
          [reply, `g11-reset-${randomUUID()}`],
        )).rows[0]!.reset;
      });
      expect(reset).toMatchObject({ reset: true });
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 0 });

      // Still ONE row: a reset is a reset, not a new budget.
      expect(await budgetRowCount(source, target)).toBe(1);
      const after = await newTeammateMessage(database, fx, source, 'after the human');
      expect((await deliver(proc, after, target, 'post-reset')).outcome).toBe('delivered');
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 1 });
    } finally {
      await proc.shutdown();
    }
  }, 60_000);

  it('a RETRY consumes the same allowance rather than a fresh one', async () => {
    const source = await newSession(database, fx, 'G11 retry source');
    const target = await newSession(database, fx, 'G11 retry target');
    // The target has NO live terminal, so the first attempt settles refused —
    // which is exactly the situation that produces a retry.
    const proc = boot(deliveryUrl, []);
    try {
      const message = await newTeammateMessage(database, fx, source, 'retry me');
      expect((await deliver(proc, message, target, 'attempt one')).outcome).toBe('refused');
      expect(proc.pty.bytes).toBe(0);
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 1 });

      const stored = (await database.query<{ status: string; failure_reason: string }>(
        `select status, failure_reason from public.session_message_deliveries
          where message_id = $1 and attempt_no = 1`,
        [message],
      ))[0]!;
      expect(stored).toEqual({ status: 'failed_retryable', failure_reason: 'no_live_terminal' });

      // Attempt 2 is a NEW delivery id against the SAME message and target, and
      // it charges the same pair again. A retry that reset the count would read 1.
      expect((await deliver(proc, message, target, 'attempt two', 2)).outcome).toBe('refused');
      expect(await budgetOf(source, target)).toMatchObject({ consecutive_agent_wakes: 2 });
      expect(await budgetRowCount(source, target)).toBe(1);
    } finally {
      await proc.shutdown();
    }
  }, 60_000);

  // -- retention, through the path that already owns it -----------------------

  /**
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
  /**
   * REGRESSION GUARD, replacing the expired causation pin above.
   *
   * KNOWN-GOOD half: the behaviour `040` repaired. A Teammate-authored wake at an
   * exited target must write exactly ONE `failed_permanent` / `session_not_live`
   * row WITH its three `pair_*` columns populated. Before `040` this raised 23514
   * and wrote ZERO rows; if `040` is ever reverted or overwritten by a later
   * `create or replace`, this goes red on the row count and the pair columns.
   *
   * THE PAIR COLUMNS ARE ASSERTED INDIVIDUALLY AND NOT JUST THE STATUS. The
   * status pair was already reachable for a MEMBER-authored message before `040`
   * — that branch always worked — so asserting only `failed_permanent` /
   * `session_not_live` would be satisfied by the half that was never broken.
   * The `pair_*` columns are what distinguishes the repaired Teammate path.
   */
  it('REGRESSION GUARD (040): a Teammate wake at an exited target writes ONE row WITH pair columns', async () => {
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
      pair_low_session_id: string | null;
      pair_high_session_id: string | null;
      pair_budget_version: number | null;
    }>(
      `select status, failure_reason, source_work_session_id::text,
              pair_low_session_id::text, pair_high_session_id::text, pair_budget_version
         from public.session_message_deliveries where message_id = $1`,
      [message],
    );
    // ZERO rows was the defect. Exactly one is the repair.
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.status).toBe('failed_permanent');
    expect(row.failure_reason).toBe('session_not_live');
    // A Teammate carries provenance, so `pair_shape` requires all four together.
    expect(row.source_work_session_id).not.toBeNull();
    expect(row.pair_low_session_id).not.toBeNull();
    expect(row.pair_high_session_id).not.toBeNull();
    expect(row.pair_budget_version).not.toBeNull();
    // ...and the pair is the unordered {source, target} identity, not an arbitrary pair.
    expect([row.pair_low_session_id, row.pair_high_session_id].sort())
      .toEqual([source, target].sort());
  }, 120_000);

  /**
   * KNOWN-BAD half, and it SURVIVES `040` — which is the property the coordinator
   * required and the reason this guard is worth anything.
   *
   * A detector that loses its red at the moment of the fix cannot demonstrate it
   * would still catch a regression; it can only demonstrate that today is fine.
   * So the red is taken from a DIFFERENT, still-live guard on the same function:
   * a `team_member`-authored message with NO `authored_from` edge.
   *
   * MEASURED on the landed 37-file chain via `pg_get_functiondef`, not read off a
   * migration: that raise sits at the top of `reserve_session_message_delivery`,
   * BEFORE the `target_status in ('exited','failed')` branch `040` rewrote, so
   * `040` does not touch it. It is a real production guard producing a real
   * refusal — not a synthetic mutation — which is why it can prove the harness
   * still detects a refusal at all.
   */
  it('...and the detector keeps a live known-bad: a Teammate message with no provenance is refused', async () => {
    const target = await newSession(database, fx, 'G11 no-provenance target', 'exited');
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
    let error: string | null = null;
    try {
      await deliver(proc, message, target, 'into the void');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      await proc.shutdown();
    }
    expect(error).toMatch(/Teammate delivery requires immutable source-session provenance/);

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
    const proc = boot(deliveryUrl, [target]);
    try {
      const message = await newTeammateMessage(database, fx, source, 'last words');
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

    // Eligibility is derived, not asserted by the delivery role: both sessions
    // are terminal and nothing is pending or dispatching.
    await database.query(`select internal.w1_refresh_wake_budget_cleanup_eligibility()`);
    const eligible = (await database.query<{ eligible_for_cleanup_at: string | null }>(
      `select eligible_for_cleanup_at from public.session_wake_budgets
        where low_work_session_id = least($1::uuid,$2::uuid)
          and high_work_session_id = greatest($1::uuid,$2::uuid)`,
      [source, target],
    ))[0]!;
    expect(eligible.eligible_for_cleanup_at).not.toBeNull();

    const pruned = (await database.query<{ result: { budgetsDeleted: number } }>(
      `select internal.w1_prune_operational_state(now() + interval '31 days') as result`,
    ))[0]!.result;
    expect(pruned.budgetsDeleted).toBeGreaterThanOrEqual(1);
    expect(await budgetRowCount(source, target)).toBe(0);

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
