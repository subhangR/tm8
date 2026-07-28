/**
 * W5 Duo A — `internal.require_delivery_principal` (015:1339-1385), measured.
 *
 * ## The defect
 *
 * `015:1346-1347` is an `AND`:
 *
 * ```sql
 * if session_user <> 'tm8_delivery_worker'
 *    and coalesce(current_setting('role', true), '') <> 'tm8_delivery_worker' then
 * ```
 *
 * It raises only if BOTH limbs are false, so satisfying EITHER passes. A
 * superuser that issues `set local role tm8_delivery_worker` satisfies the
 * second limb. The guard therefore admits any principal *permitted to assume*
 * the role — a maintenance script, a second node, a `psql` session.
 *
 * ## THIS FILE IS WORLD-DETECTING, AND THE FIRST VERSION WAS NOT
 *
 * **Rewritten after the first landing attempt of `039`, which this file failed
 * in the wrong way.** v1 assumed the shipped chain was always the PERMISSIVE
 * one and derived the tightened guard from it. The moment `039` landed, that
 * assumption was false, the derivation guard threw in `beforeAll`, and:
 *
 * - all 8 tests **skipped**, so the defect pin never ran and **its inversion
 *   instruction printed ZERO times** — the guidance written for exactly that
 *   moment was silenced by the probe protecting it;
 * - the acceptance criterion never ran either, so the landing got **no positive
 *   confirmation that `039` worked** at the one moment that confirmation was
 *   most valuable;
 * - `destroy()` ran in both the `beforeAll` catch and `afterAll`, producing
 *   `Called end on pool more than once` at `w1-pg.ts:111`.
 *
 * That is the program's own dominant shape, produced here: **v1 was written for
 * the world it was written in, and never asked what it would do in the world it
 * was creating.** §24.3 names it exactly.
 *
 * So this version **classifies the live guard first** and pins BOTH worlds:
 *
 * - `permissive` — a database whose guard carries the two-limb condition
 * - `tightened`  — a database whose guard carries the one-limb condition
 *
 * One of the two is the shipped chain; the other is derived from it. **Which
 * one the shipped chain is** is asserted by exactly ONE test — the defect pin —
 * so the transition produces exactly one red, carrying its instruction, while
 * every other assertion keeps running and keeps confirming the guard's
 * behaviour in both directions.
 *
 * ## Instrument notes
 *
 * - The guard is read with `pg_get_functiondef` from a freshly-migrated scratch
 *   database, never from a migration file. `019` redefines
 *   `reserve_session_message_delivery`; a migration file is not the definition
 *   of its own function.
 * - The discriminator is the ERROR TEXT, not the code. The role check and the
 *   tuple check both raise `42501`.
 * - No fixture graph is needed: a call with unknown ids that gets PAST the guard
 *   fails in the body with `message not found`. "Which error" is the whole
 *   measurement.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DELIVERY_ROLE, deliveryPrincipalUrl } from '../../db/delivery-principal.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from '../../db/w1-pg.js';

// LOAD-SENSITIVE TIMEOUTS. vitest ships TWO INDEPENDENT defaults — testTimeout
// 5s (a NAMED test failure) and hookTimeout 10s (an UNNAMED file-level abort) —
// and a generous argument on `beforeAll` covers NEITHER. MEASURED on this
// machine: one scratch-database `destroy()` costs ~5.0s at load 20, and the wave
// drives load to ~48, where the same assertions on the same tree take >5x longer.
// Per-hook arguments below still win where present; this raises the floor for
// every `it` in the file. Precedent: test/integration/inbox.test.ts:39.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** The role check fired. */
const ROLE_REFUSAL = /system delivery adapter database role required/;
/** The guard was PASSED and the function body was entered. */
const PAST_THE_GUARD = /message not found/;

const PERMISSIVE_CONDITION =
  `if session_user <> 'tm8_delivery_worker'\n` +
  `     and coalesce(current_setting('role', true), '') <> 'tm8_delivery_worker' then`;
const TIGHTENED_CONDITION = `if session_user <> 'tm8_delivery_worker' then`;

type World = 'PERMISSIVE' | 'TIGHTENED';

interface ProbeOutcome {
  admitted: boolean;
  message: string;
}

async function probe(pool: Pool, options: { assumeRole: boolean }): Promise<ProbeOutcome> {
  const client = await pool.connect();
  const deliveryId = randomUUID();
  const messageId = randomUUID();
  const targetId = randomUUID();
  try {
    await client.query('begin');
    if (options.assumeRole) await client.query(`set local role ${DELIVERY_ROLE}`);
    await client.query(
      `select set_config('tm8.principal_type', 'system_delivery_adapter', true),
              set_config('tm8.delivery_id', $1, true),
              set_config('tm8.delivery_message_id', $2, true),
              set_config('tm8.delivery_target_work_session_id', $3, true),
              set_config('tm8.delivery_expires_at', (now() + interval '5 minutes')::text, true)`,
      [deliveryId, messageId, targetId],
    );
    await client.query(`select public.reserve_session_message_delivery($1, $2, $3, 1)`, [
      deliveryId,
      messageId,
      targetId,
    ]);
    return { admitted: true, message: '<no error at all>' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { admitted: PAST_THE_GUARD.test(message), message };
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function guardTextOf(database: W1ScratchDatabase): Promise<string> {
  return (await database.query<{ def: string }>(
    `select pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'internal' and p.proname = 'require_delivery_principal'`,
  ))[0]!.def;
}

describe.sequential('W5 Duo A — the delivery principal guard', () => {
  let shipped: W1ScratchDatabase;
  let derived: W1ScratchDatabase;
  let shippedWorld: World;
  let shippedGuardText = '';
  let derivedGuardText = '';
  /** Pools keyed by the world they observe, NOT by which chain is shipped. */
  let permissiveSuper: Pool;
  let tightenedSuper: Pool;
  let tightenedWorker: Pool;

  beforeAll(async () => {
    shipped = await createW1ScratchDatabase('w5a_guard_shipped');
    derived = await createW1ScratchDatabase('w5a_guard_derived');
    // NO teardown in a catch here. `afterAll` runs even when `beforeAll` throws
    // — measured, because v1's catch-destroy plus afterAll-destroy is exactly
    // what produced `Called end on pool more than once` at w1-pg.ts:111.
    // afterAll is the SOLE teardown.
    shipped.apply(migrationFiles());
    derived.apply(migrationFiles());

    shippedGuardText = await guardTextOf(shipped);
    const hasPermissive = shippedGuardText.includes(PERMISSIVE_CONDITION);
    const hasTightened = shippedGuardText.includes(TIGHTENED_CONDITION);

    // Classify, do not assume. Exactly one must match: the tightened condition
    // ends `'tm8_delivery_worker' then` while the permissive one continues onto
    // a second line, so neither is a substring of the other.
    if (hasPermissive === hasTightened) {
      throw new Error(
        `cannot classify the live guard: internal.require_delivery_principal matches ` +
          `permissive=${hasPermissive} tightened=${hasTightened}. Exactly one must match. ` +
          `The guard has changed shape or been redefined, and this file must be re-derived ` +
          `against the new text rather than skipped.\n--- live definition ---\n${shippedGuardText}`,
      );
    }
    shippedWorld = hasPermissive ? 'PERMISSIVE' : 'TIGHTENED';

    // Build the OTHER world from the shipped text, in whichever direction is needed.
    derivedGuardText =
      shippedWorld === 'PERMISSIVE'
        ? shippedGuardText.replace(PERMISSIVE_CONDITION, TIGHTENED_CONDITION)
        : shippedGuardText.replace(TIGHTENED_CONDITION, PERMISSIVE_CONDITION);
    if (derivedGuardText === shippedGuardText) throw new Error('derivation produced no change');

    await derived.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(derivedGuardText);
    });

    const permissiveDb = shippedWorld === 'PERMISSIVE' ? shipped : derived;
    const tightenedDb = shippedWorld === 'PERMISSIVE' ? derived : shipped;
    permissiveSuper = new Pool({ connectionString: permissiveDb.url, max: 2 });
    tightenedSuper = new Pool({ connectionString: tightenedDb.url, max: 2 });
    tightenedWorker = new Pool({ connectionString: deliveryPrincipalUrl(tightenedDb.url), max: 2 });
  }, 240_000);

  afterAll(async () => {
    // Pools end BEFORE the drops: w1-pg.ts:114 drops without `with (force)`, so
    // a surviving connection turns teardown into "database is being accessed by
    // other users" — a failure far from its cause.
    await Promise.all(
      [permissiveSuper, tightenedSuper, tightenedWorker]
        .filter(Boolean)
        .map((pool) => pool.end().catch(() => undefined)),
    );
    await shipped?.destroy();
    await derived?.destroy();
    // 60s raised to 120s. MEASURED at load ~20: one `destroy()` costs ~5.0s and
    // this hook does TWO plus three pool ends; the wave drives load to ~48.
    // vitest's hook default is 10s and `afterAll` is configured independently of
    // `beforeAll`, so the 240s above covers nothing here.
  }, 120_000);

  // -- the guard's identity, from the catalog --------------------------------

  it('has exactly ONE definition of the guard, and exactly three doors call it', async () => {
    const definitions = await shipped.query<{ n: string }>(
      `select count(*)::text n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'internal' and p.proname = 'require_delivery_principal'`,
    );
    expect(definitions[0]!.n).toBe('1');

    const callers = (await shipped.query<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosrc like '%require_delivery_principal%'
        order by 1`,
    )).map((row) => row.fn);
    expect(callers).toEqual([
      'public.claim_session_message_delivery',
      'public.reserve_session_message_delivery',
      'public.settle_session_message_delivery',
    ]);

    const granted = (await shipped.query<{ fn: string }>(
      `select p.proname as fn
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege($1, p.oid, 'EXECUTE')
          and p.proname like '%_session_message_delivery'
        order by 1`,
      [DELIVERY_ROLE],
    )).map((row) => row.fn);
    expect(granted).toEqual([
      'claim_session_message_delivery',
      'reserve_session_message_delivery',
      'settle_session_message_delivery',
    ]);
  });

  // -- WHICH WORLD IS SHIPPED. The one assertion that flips. ------------------
  //
  // INVERTED WHEN 039 LANDED. Recorded rather than quietly edited:
  //
  //   BEFORE  expected 'PERMISSIVE'  — asserted the DEFECT, on chain 34 / a799b7ef1b20a9b0
  //   AFTER   expects  'TIGHTENED'   — asserts the FIX,     on chain 37 / fff3995e1c2a5dcd
  //   the flip was observed as `expected 'TIGHTENED' to be 'PERMISSIVE'` in the landing gate,
  //   which is the pin firing on cue and is its last act as a defect pin.
  //
  // It is now a REGRESSION GUARD, and it is the only assertion in this file that
  // would notice a silent revert of 039: every other test here runs against BOTH
  // worlds by construction and stays green either way. That is deliberate — it is
  // what lets the known-bad half survive the fix — and it is exactly why this one
  // assertion has to carry the world question alone.

  it(
    'REGRESSION GUARD (was the §5.4 defect pin, inverted when 039 landed): the SHIPPED chain' +
      ' carries the TIGHTENED one-limb guard',
    () => {
      expect(
        shippedWorld,
        'The shipped chain has gone back to the PERMISSIVE two-limb guard. 039 tightened ' +
          "internal.require_delivery_principal to `session_user` alone; a 'PERMISSIVE' reading here " +
          'means that has been reverted, overwritten by a later `create or replace`, or lost in a ' +
          'chain rebuild — and the delivery RPCs once again admit any principal PERMITTED TO ASSUME ' +
          'the role, which is close-document §5.4 reopened. Do NOT relax this to accept either ' +
          'value: no other test in this file can see the difference.',
      ).toBe('TIGHTENED');
    },
  );

  // -- the PERMISSIVE world: the defect itself, still measurable after the fix -

  it('the PERMISSIVE guard admits a superuser that merely ASSUMES the role', async () => {
    const outcome = await probe(permissiveSuper, { assumeRole: true });
    expect(outcome.admitted).toBe(true);
    expect(outcome.message).toMatch(PAST_THE_GUARD);
    expect(outcome.message).not.toMatch(ROLE_REFUSAL);
    // Kept measurable in BOTH worlds deliberately: after 039 this database is
    // reverse-derived, so the detector can still SEE the hole it was built for.
    // A detector that loses its known-bad half at the moment of the fix cannot
    // prove it would still catch a regression.
  });

  // -- the TIGHTENED world: the acceptance criterion --------------------------

  it('ACCEPTANCE CRITERION for 039: the TIGHTENED guard REFUSES the assumed role', async () => {
    const outcome = await probe(tightenedSuper, { assumeRole: true });
    expect(outcome.admitted).toBe(false);
    expect(outcome.message).toMatch(ROLE_REFUSAL);
  });

  it('...and ADMITS the authenticated worker — it discriminates, it does not refuse everyone', async () => {
    const outcome = await probe(tightenedWorker, { assumeRole: false });
    expect(outcome.admitted).toBe(true);
    expect(outcome.message).toMatch(PAST_THE_GUARD);
  });

  it('...and still admits the worker when production ALSO issues `set local role` (execution.ts:394)', async () => {
    // The production delivery path sets the role unconditionally on top of an
    // authenticated connection. If `set role` to ITSELF failed for a `noinherit`
    // role with no memberships, 039 would break production while passing every
    // other test here.
    const outcome = await probe(tightenedWorker, { assumeRole: true });
    expect(outcome.admitted).toBe(true);
    expect(outcome.message).toMatch(PAST_THE_GUARD);
  });

  it('the two worlds differ in ONE limb and nothing else', async () => {
    // Whichever direction the derivation ran, the two texts must differ by
    // exactly the condition — no other edit smuggled in alongside it.
    const normalise = (text: string) => text.replace(PERMISSIVE_CONDITION, TIGHTENED_CONDITION);
    expect(normalise(shippedGuardText)).toBe(normalise(derivedGuardText));
    expect(normalise(shippedGuardText)).toContain(TIGHTENED_CONDITION);

    // The other four checks the guard performs are present in BOTH worlds.
    for (const surviving of [
      'delivery principal tuple mismatch',
      'delivery reservation version mismatch',
      'delivery principal expired',
      'delivery principal cannot carry actor claims',
    ]) {
      expect(shippedGuardText).toContain(surviving);
      expect(derivedGuardText).toContain(surviving);
    }
  });

  it('the tightened guard still fires its TUPLE check for an authenticated worker', async () => {
    // Narrowing the role limb must not widen anything else.
    const client = await tightenedWorker.connect();
    try {
      await client.query('begin');
      await client.query(
        `select set_config('tm8.principal_type', 'system_delivery_adapter', true),
                set_config('tm8.delivery_id', $1, true),
                set_config('tm8.delivery_message_id', $2, true),
                set_config('tm8.delivery_target_work_session_id', $3, true),
                set_config('tm8.delivery_expires_at', (now() + interval '5 minutes')::text, true)`,
        [randomUUID(), randomUUID(), randomUUID()],
      );
      await expect(
        client.query(`select public.reserve_session_message_delivery($1, $2, $3, 1)`, [
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ]),
      ).rejects.toThrow(/delivery principal tuple mismatch/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
