/**
 * WHY THE SEEDED `Dreamer daily sweep` NEVER FIRED, and what 375 changed.
 *
 * THE MEASUREMENT (prod, 26 Oct 2026). The loop seeded into space 01a0fb3d was
 * enabled, due 2026-10-03, and 23 days later had `last_run_at` NULL,
 * `last_error` NULL and zero `triggered_by` edges. The executor was registered
 * and ticking the whole time.
 *
 * THE CAUSE. `createLoopExecutorPort` read every due loop as the node's
 * LOOPBACK OWNER, and the due read was a direct select on
 * `public.loops join public.entities` — so `entities_select` applied:
 * `space_id = any(internal.member_space_ids())`. The node owner is a member of
 * the spaces the NODE created and nothing else, and `member_space_ids()` has no
 * node-admin bypass. A loop in a space a human created was therefore INVISIBLE,
 * not merely unauthorised: zero rows, `{skipped: 'no loops are due'}`, and
 * never a line of `recordRun` — which is the only writer of `last_error`. That
 * is why 23 days of not firing left no trace for anyone to find.
 *
 * WHAT THIS FILE PINS. `loops-job.test.ts` already covers the firing logic
 * against a fake `Db`, and `wired.pg.test.ts` that the job is registered on a
 * real composition root. Both passed throughout the outage, because neither
 * asks the question that actually decided it:
 *
 *   CAN THE IDENTITY THE JOB READS AS SEE THE LOOP ROW?
 *
 * So these tests run the REAL job against REAL Postgres with REAL RLS, in the
 * shape that broke: a space the node owner is not a member of. Only `fire` is
 * faked — spawning a PTY is not what is under test, and `LoopExecutorPort`
 * exists so it need not be. Every read, every claim and `recordRun`'s write
 * through `update_loop` are the production ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { JobContext } from '../../src/scheduler/types.js';
import { createLoopsJob, type DueLoop, type LoopExecutorPort } from '../../src/scheduler/jobs/loops.js';
import { createTestDb, type TestDb } from '../events/pg-harness.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

/** The node's loopback owner: the single `is_owner` account, as `main.ts` resolves it. */
const nodeOwner = `identity_${randomUUID()}`;
/** The human who creates the space and the loop — a different identity, as on a real node. */
const spaceOwner = `identity_${randomUUID()}`;

const claims = (identityId: string, nodeAdmin = false): DbClaims => ({
  identityId,
  nodeAdmin,
  requestId: `req_${randomUUID()}`,
});

/**
 * Run one write AS A HUMAN AT A BROWSER.
 *
 * `stamp_loop_armed_by` (343) fails closed on every non-human shape, so without
 * an `auth_kind` the seeded loop would carry `armed_by = null` and this suite
 * would silently only ever exercise the space-owner fallback.
 *
 * Bound inside the transaction rather than taught to `applyClaims`, on purpose:
 * the harness has never bound this claim, and starting to would change what
 * every human-gated door does in four other pg suites — a blast radius this
 * fix has no business taking on.
 */
async function asHuman<T>(
  db: TestDb,
  identityId: string,
  fn: (q: Querier) => Promise<T>,
): Promise<T> {
  return db.tx(claims(identityId), async (q) => {
    await q.query('select set_config($1, $2, true)', ['tm8.auth_kind', 'browser']);
    return fn(q);
  });
}

/** Exactly what `createLoopExecutorPort.dueReadClaims` builds in production. */
const executorClaims = (): DbClaims => ({
  ...claims(nodeOwner, true),
  backgroundJob: 'loops.execute-due',
});

interface Warned { warnings: string[] }

function ctx(warned: Warned, firedAt = new Date()): JobContext {
  return {
    name: 'loops.execute-due',
    firedAt,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (m: string) => void warned.warnings.push(m),
      error: () => {},
    } as never,
    signal: new AbortController().signal,
  };
}

/** The real job; `readAs` is the one line whose identity decides visibility. */
function jobFor(db: Db, readAs: DbClaims): {
  run: (warned: Warned) => Promise<unknown>;
  fired: string[];
  firedAs: string[];
} {
  const fired: string[] = [];
  const firedAs: string[] = [];
  const port: LoopExecutorPort = {
    dueReadClaims: async () => readAs,
    claimsForLoop: (loop, actAsIdentity) => ({
      identityId: actAsIdentity,
      nodeAdmin: false,
      requestId: `loop-executor:${loop.entityId}`,
    }),
    liveSessionIds: () => [],
    fire: async (loop, firingClaims) => {
      fired.push(loop.entityId);
      firedAs.push(String(firingClaims.identityId));
      // No session row exists for a fake firing; the run keeps session_id null
      // and the sweep settles it after the launch grace period.
      return { taskId: null, sessionId: `00000000-0000-4000-8000-${String(fired.length).padStart(12, '0')}` };
    },
    stopSession: async () => {},
  };
  const job = createLoopsJob({ db, port });
  return { run: (warned) => job.run(ctx(warned)), fired, firedAs };
}

describe('the loop executor reaches loops outside the node owner spaces (375)', () => {
  let database: W1ScratchDatabase;
  let db: TestDb;
  let spaceId: string;
  let loopId: string;
  let creatorMemberId: string;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('loops_space_visibility');
    database.apply(migrationFiles());
    db = createTestDb(database.url);

    // The node's loopback owner, as `resolveLoopbackOwner` makes it: the single
    // `is_owner` row, a node admin, and a member of NO space. Claim-free on
    // purpose — `ensure_account` admits that only while the node has zero
    // accounts, which is the first-run case this reproduces.
    await db.rpc({}, 'public.ensure_account', [
      nodeOwner, 'owner', 'Node Owner', null, true, true, null, null,
    ]);

    // A human signs up and creates their own space. Nothing in the product ever
    // admits the node owner to it, and this is the shape of every space a real
    // person creates.
    await db.rpc(claims(spaceOwner), 'public.upsert_user_profile', ['Subhang', null, null]);
    spaceId = (await db.rpc<{ space: { id: string } }>(claims(spaceOwner), 'public.create_space', [
      'tm8', 'the space the loop lives in', 'private', null, null,
    ])).space.id;
    creatorMemberId = (await db.query<{ entity_id: string }>(
      claims(spaceOwner),
      'select entity_id from public.members where space_id = $1 and identity_id = $2',
      [spaceId, spaceOwner],
    ))[0]!.entity_id;

    // The seeded daily sweep, already overdue — the prod row's shape. Armed as
    // a human so `armed_by_identity_id` (343) is stamped, which is the identity
    // the executor must resolve.
    loopId = (await asHuman(db, spaceOwner, (q) => q.rpc<{ entity: { id: string } }>(
      'public.create_loop',
      [
        spaceId, 'Dreamer daily sweep', null, 'every 1d', null, null,
        'Daily memory sweep.', JSON.stringify({}), true,
        new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
        null, null, `cmid_${randomUUID()}`,
      ],
    ))).entity.id;
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('GROUND TRUTH: the loop is enabled, overdue, and has never run', async () => {
    const [row] = await db.query<{ enabled: boolean; due: boolean; last_run_at: string | null }>(
      claims(spaceOwner),
      `select l.enabled, (l.next_run_at <= now()) due, l.last_run_at
         from public.loops l where l.entity_id = $1`,
      [loopId],
    );
    expect(row).toMatchObject({ enabled: true, due: true, last_run_at: null });
  });

  it('THE OLD READ still returns nothing, so RLS was not widened to fix this', async () => {
    // The pre-375 due read, verbatim, under the pre-375 claims — including
    // nodeAdmin, because `member_space_ids()` has no node-admin bypass. It must
    // STILL see zero rows: the fix is a narrow door, not a loosened policy, and
    // if this ever returns a row then general entity reads have been widened.
    const rows = await db.query(
      claims(nodeOwner, true),
      `select l.entity_id from public.loops l
         join public.entities e on e.id = l.entity_id
        where l.enabled and e.deleted_at is null
          and l.next_run_at is not null and l.next_run_at <= now()`,
    );
    expect(rows).toEqual([]);
  });

  it('THE DOOR refuses a caller that does not hold the job claim', async () => {
    // Same identity, same everything, minus `backgroundJob`. The function is
    // SECURITY DEFINER, so the claim is the ONLY thing standing between an
    // ordinary caller and every space's loops.
    const unclaimed = await db.query(
      claims(nodeOwner, true),
      'select entity_id from public.loops_due_for_executor($1)',
      [25],
    );
    expect(unclaimed).toEqual([]);

    // A space-pinned caller is refused TWICE over, and both layers are checked
    // here because either alone would be enough to hide a hole in the other.
    //
    //   1. db/client.ts never binds the claim for a pinned caller at all. The
    //      harness mirrors that, so this is the production suppression.
    const pinnedClient = await db.query(
      { ...claims(nodeOwner, true), backgroundJob: 'loops.execute-due', sessionSpaceId: spaceId },
      'select entity_id from public.loops_due_for_executor($1)',
      [25],
    );
    expect(pinnedClient).toEqual([]);

    //   2. `is_loops_worker()` refuses a pinned session even if the claim DID
    //      arrive, so the guard does not depend on the client behaving. Bound
    //      inside the transaction, after the claims, to reach that branch.
    const pinnedInSql = await db.tx(
      { ...claims(nodeOwner, true), backgroundJob: 'loops.execute-due' },
      async (q) => {
        await q.query('select set_config($1, $2, true)', ['tm8.session_space_id', spaceId]);
        return q.query('select entity_id from public.loops_due_for_executor($1)', [25]);
      },
    );
    expect(pinnedInSql).toEqual([]);
  });

  it('THE DOOR resolves the ARMING HUMAN as the identity to act as', async () => {
    // Guard the premise: if `armed_by` were null this assertion would still
    // pass via the space-owner fallback and prove nothing about branch 1.
    const [armed] = await db.query<{ armed_by_identity_id: string | null }>(
      claims(spaceOwner),
      'select armed_by_identity_id from public.loops where entity_id = $1',
      [loopId],
    );
    expect(armed!.armed_by_identity_id).toBe(spaceOwner);

    const [row] = await db.query<{ entity_id: string; act_as_identity: string; space_id: string }>(
      executorClaims(),
      'select entity_id, space_id, act_as_identity from public.loops_due_for_executor($1)',
      [25],
    );
    expect(row?.entity_id).toBe(loopId);
    expect(row?.space_id).toBe(spaceId);
    // The human the firing acts for (343), not the node.
    expect(row?.act_as_identity).toBe(spaceOwner);
  });

  it('THE FIX: the real job fires the loop, as the arming human, and records the run', async () => {
    const warned: Warned = { warnings: [] };
    const { run, fired, firedAs } = jobFor(db, executorClaims());

    const outcome = await run(warned) as { affected?: number; detail?: unknown };

    expect(fired).toEqual([loopId]);
    expect(outcome.affected).toBe(1);
    expect(outcome.detail).toMatchObject({ due: 1, fired: 1, failed: 0 });
    // Fired under the arming human's identity, so `resolve_actor` names their
    // member row and the derived task is attributed to them, not to the node —
    // the claims and 343's provenance root now agree.
    expect(firedAs).toEqual([spaceOwner]);
    expect(warned.warnings).toEqual([]);

    // The claim went through the REAL `loop_run_claim` (382) under the worker
    // claim, and the launch record through `loop_run_launched`. This is the
    // half that proves the bookkeeping path works and not just the read: the
    // outcome is on the row, and the loop is no longer due, so it cannot be
    // re-selected and re-fired on the next tick.
    const [row] = await db.query<{ last_run_at: string | null; last_error: string | null; due: boolean }>(
      claims(spaceOwner),
      `select l.last_run_at, l.last_error, (l.next_run_at <= now()) due
         from public.loops l where l.entity_id = $1`,
      [loopId],
    );
    expect(row!.last_run_at).not.toBeNull();
    expect(row!.last_error).toBeNull();
    expect(row!.due).toBe(false);

    // And the run row: one 'fired' run, as the arming human, under the loop.
    const runs = await db.query<{ launch: string; trigger: string; acted_as_identity_id: string; attempt: number }>(
      claims(spaceOwner),
      `select launch, trigger, acted_as_identity_id, attempt from public.loop_runs where loop_id = $1`,
      [loopId],
    );
    expect(runs).toEqual([{ launch: 'fired', trigger: 'schedule', acted_as_identity_id: spaceOwner, attempt: 1 }]);
  });

  it('an orphaned loop is parked with a reason, never skipped in silence', async () => {
    // The space's only member is gone (232 tombstone), so there is no identity
    // left to act as. Such a loop cannot be fired, so the executor parks it
    // LOUDLY (382 `loops_park_orphans`): `last_error` says 'needs arming', the
    // warn log names it, and it is no longer selected as due — so it can no
    // longer starve the queue, and the moment the space has an owner again it
    // fires once. A silent skip here is the original bug wearing a new hat.
    await db.asOwner(async (q) => {
      await q.query(
        `update public.loops set next_run_at = now() - interval '1 hour' where entity_id = $1`,
        [loopId],
      );
      // `members_left_at_matches_status` (232): a tombstone carries its instant.
      await q.query(
        `update public.members set status = 'removed', left_at = now() where entity_id = $1`,
        [creatorMemberId],
      );
    });

    const [row] = await db.query<{ act_as_identity: string | null }>(
      executorClaims(),
      'select act_as_identity from public.loops_due_for_executor($1)',
      [25],
    );
    expect(row?.act_as_identity).toBeNull();

    const warned: Warned = { warnings: [] };
    const { run, fired } = jobFor(db, executorClaims());

    const outcome = await run(warned) as { affected?: number; detail?: unknown };

    expect(fired).toEqual([]);
    expect(outcome.detail).toMatchObject({ due: 0, orphaned: 1 });
    expect(warned.warnings).toHaveLength(1);
    expect(warned.warnings[0]).toContain('no active member to act as');
    const [parked] = await db.query<{ last_error: string | null }>(
      executorClaims(),
      'select last_error from public.loops where entity_id = $1',
      [loopId],
    );
    expect(parked?.last_error ?? '').toContain('needs arming');

    // Parked once: a second tick neither re-warns nor re-writes the row.
    const again: Warned = { warnings: [] };
    const second = await run(again) as { skipped?: boolean; detail?: unknown };
    expect(again.warnings).toEqual([]);
    expect(second).toMatchObject({ skipped: true });
  });
});
