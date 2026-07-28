// =============================================================================
// W2.NULL-PRINCIPAL — can a public.command_ledger row be recorded with
//                     identity_id NULL, and can it then be REPLAYED?
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE SEC-1b SUITE.
//
// The 033 candidate pins a replay to the principal that recorded it by comparing
// public.command_ledger.identity_id against the calling identity. That guard is
// SILENTLY INERT in the NULL-vs-NULL case: `null is distinct from null` is FALSE,
// so the compact form of the comparison does not fire, and a harness that binds
// no identity stores NULL on every row and reads NULL for every caller — so a
// cross-principal negative PASSES because nothing was ever compared. A suite that
// only shows "the guard did not error" is worthless against that failure mode.
//
// So this file does not ask "does it error". It asks, executably:
//
//   1. WHICH STATEMENTS CAN WRITE public.command_ledger.identity_id AT ALL, and
//      is that set complete? Established from the LIVE pg_catalog of the applied
//      database, not from a grep of db/migrations — because the migration files
//      supersede each other and a file-level read gets the live definition wrong.
//      (Concretely: 012 added a reservation INSERT inside internal.ledger_replay;
//      016 redefined ledger_replay WITHOUT it. Reading 012 alone tells you there
//      are two insert sites on the live chain. There is one.)
//   2. CAN internal.identity_id() BE NULL, and under exactly which claim values?
//   3. CAN AN APPLICATION CALLER REACH THE WRITER WITH A NULL IDENTITY and commit?
//   4. What does the chain actually do in each of the four cases
//      (stored non-null | NULL) x (caller non-null | NULL)?
//
// ⚠ THE ANSWER TO (3) WAS YES. IT IS NOW NO, AND THE PATH FROM ONE TO THE OTHER
//   IS WHAT THIS FILE IS FOR.
//
//   public.reset_session_wake_budget_for_member_reply (015:1497), granted to
//   tm8_app at 015:2178, returned internal.ledger_record from its not-found branch
//   with internal.require_space_member on the NEXT line. An unbound caller passing
//   any unknown uuid took that branch and COMMITTED a command_ledger row whose
//   identity_id was NULL — measured here, not argued. Migration 033 made such a
//   row unusable for REPLAY but did not stop it being WRITTEN; migration 037 put
//   an identity gate AHEAD of the early return, so the write is now refused 28000
//   before the ledger is reached. Section 3 proves the closure the same way it
//   proved the hole: executably.
//
// THIS FILE HAS BEEN RE-BOUND THREE TIMES, AND THE REBINDINGS ARE THE RESULT.
//
//   It was written against the pre-033 chain and deliberately asserted that 033
//   was ABSENT, so that its readings could not be silently re-labelled when the
//   chain rotated. When 032/033/034 landed, that guard fired along with four of
//   the five case readings — which is the outcome it existed to produce. The
//   table in section 4 now records BOTH states, pre and post, because the
//   movement is the evidence: every cell except CASE 1 went from "replayed" to
//   23514, and CASE 1 stayed, so the pin did not buy its refusals by refusing
//   everyone.
//
//   The cell that matters most is CASE 5, both sides NULL. `null is distinct from
//   null` is FALSE, so a compact guard would have left exactly that cell serving
//   the stored result while every other cell moved — enforced-looking and inert.
//   It moved. That is the executable proof that 033 wrote the NULL cases out
//   explicitly instead of inheriting them.
//
//   Then 037 landed and FIVE more assertions fired, all of them findings of this
//   file being closed: the ungated write, the resulting row count, the replay
//   through that path, and both halves of the claim_text whitespace defect. Each
//   was re-bound to the new behaviour with the OLD behaviour kept in the comment,
//   because a test that silently adopts the current answer stops being able to
//   tell you the answer changed.
//
// POSITIVE CONTROLS ARE LOad-BEARING, NOT DECORATIVE. Every negative and every
// four-case reading is preceded by: identity read back INSIDE the transaction
// and asserted non-null and distinct; and the recorded principal read back OUT
// OF STORAGE and asserted to be who we think. And because "the guard did not
// fire" and "there is no guard" are indistinguishable to an apparatus that could
// not observe a refusal in the first place, this file additionally shows a
// refusal it CAN observe on the landed chain (the live DEV-9 operation-label
// guard), which is the probe-red for the apparatus itself.
// =============================================================================

import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const OWNER_IDENTITY = 'w2-nullprin-owner';
const RIVAL_IDENTITY = 'w2-nullprin-rival';

/**
 * Claim spellings that normalise to "no identity" (001:147).
 *
 * THIS LIST HAS BEEN RIGHT, THEN WRONG, THEN RIGHT AGAIN, AND THE HISTORY IS THE
 * FINDING. It first contained '\t' by assumption and the suite went RED: on the
 * original chain `btrim(string)` with no second argument stripped SPACES ONLY, so
 * a tab-only claim survived claim_text as the non-null string "\t". I corrected
 * the list to match the measurement. Migration 037 then FIXED claim_text to
 * normalise whitespace generally, and the corrected list went red in the opposite
 * direction. Tab and newline are back — not because the original assumption was
 * right, but because the code changed to meet it.
 */
const UNSET_CLAIM_SPELLINGS = ['', ' ', '   ', '\t', '\n', ' \t\n '] as const;

interface SpaceFixture {
  readonly spaceId: string;
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const pgError = error as { code?: string; message?: string };
    return { ok: false, code: pgError.code ?? '', message: pgError.message ?? String(error) };
  }
}

/** Renders an outcome so a red run SHOWS what happened rather than just failing. */
function describeOutcome(outcome: Outcome<unknown>): string {
  return outcome.ok
    ? `RETURNED a value with no error: ${JSON.stringify(outcome.value)}`
    : `raised ${outcome.code}: ${outcome.message}`;
}

interface ProcSource {
  readonly fn: string;
  readonly src: string;
}

/** An INSERT whose target is public.command_ledger, in live function source. */
const INSERTS_LEDGER = /insert\s+into\s+(?:public\.)?command_ledger/i;
/** A standalone UPDATE of public.command_ledger (the ON CONFLICT clause is not one). */
const UPDATES_LEDGER = /update\s+(?:public\.)?command_ledger\s+set/i;

describe.sequential('W2.NULL-PRINCIPAL — a NULL identity_id in the command ledger', () => {
  let database: W1ScratchDatabase;
  let spaceOwner: SpaceFixture;
  let spaceRival: SpaceFixture;
  let ledgerTouchingProcs: ProcSource[];

  async function asApplication<T>(
    identityId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'w2-nullprin-pg', true)`,
        [identityId],
      );
      return fn(client);
    });
  }

  async function appValue<T>(
    identityId: string,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<T> {
    return asApplication(identityId, async (client) => {
      const result = await client.query<{ value: T }>(sql, [...params]);
      return result.rows[0]!.value;
    });
  }

  async function ownerRows<R extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const result = await client.query<R>(sql, [...params]);
      return result.rows;
    });
  }

  /** The stored principal for a cmid, read straight out of storage as the owner. */
  async function recordedIdentity(cmid: string): Promise<string | null | undefined> {
    const rows = await ownerRows<{ identity_id: string | null }>(
      `select identity_id from public.command_ledger where client_mutation_id = $1`,
      [cmid],
    );
    return rows[0]?.identity_id;
  }

  function createTaskSql(): string {
    return `select public.create_task($1, $2, null, '', '{}'::jsonb, null, null, 'medium',
                                      '[]'::jsonb, null, null, null, 'attached_to', $3) value`;
  }

  /**
   * Inserts a ledger row with the given principal, as the graph owner.
   *
   * ⚠ THE PROJECTION MUST CARRY entity.space_id, AND THAT IS NOT COSMETIC.
   * Migration 036 added a RESOURCE binding at public.create_task comparing
   * `replay #>> '{entity,space_id}'` against the Space the request addresses. The
   * first version of this helper stored a bare `{entity:{id,title}}`, and when 036
   * landed CASE 1 — the same-principal POSITIVE — started failing with 23514
   * 'belongs to another space'. That was the new guard behaving correctly against
   * an unrealistic fixture, not a defect: a stored projection that names no Space
   * cannot match the Space being addressed. Seeding the real shape keeps CASE 1
   * measuring what it is for (the principal pin admits the recorder) instead of
   * incidentally measuring the resource binding.
   */
  async function seedLedgerRow(cmid: string, identityId: string | null): Promise<void> {
    await ownerRows(
      `insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation, result)
       values ($1, $2, null, 'entities.create', $3)`,
      [
        cmid,
        identityId,
        JSON.stringify({
          entity: { id: 'seeded', title: 'seeded stored result', space_id: spaceOwner.spaceId },
        }),
      ],
    );
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_null_principal');
    database.apply(migrationFiles());

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      for (const identityId of [OWNER_IDENTITY, RIVAL_IDENTITY]) {
        await client.query(
          `insert into public.user_profiles(identity_id, display_name) values ($1, $2)`,
          [identityId, identityId],
        );
        await client.query(
          `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
           values ($1, $2, $3, false, false)`,
          [identityId, identityId, identityId],
        );
      }
    });

    const owned = await appValue<{ space: { id: string } }>(
      OWNER_IDENTITY,
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['null-principal owner space', 'nullprin-fixture-owner-space'],
    );
    spaceOwner = { spaceId: owned.space.id };

    const rival = await appValue<{ space: { id: string } }>(
      RIVAL_IDENTITY,
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['null-principal rival space', 'nullprin-fixture-rival-space'],
    );
    spaceRival = { spaceId: rival.space.id };

    // Read every LIVE function whose body mentions the ledger table, straight out
    // of pg_proc. This is the sweep the whole enumeration rests on, so it is
    // taken once and asserted over in several places below.
    ledgerTouchingProcs = await ownerRows<ProcSource>(
      `select n.nspname || '.' || p.proname as fn, p.prosrc as src
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema')
          and p.prosrc ilike '%command_ledger%'
        order by 1`,
    );
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 0. THE APPARATUS ITSELF. Nothing below is believable until these pass.
  // ---------------------------------------------------------------------------
  describe('controls', () => {
    // THIS ASSERTION HAS ALREADY EARNED ITS KEEP. It was originally written the
    // other way round — "NOT 033" — so that the pre-033 baseline readings below
    // could not be silently re-labelled as post-033 behaviour when the chain
    // rotated. When 033 landed it fired immediately, along with the five case
    // readings, which is exactly what it was for. The file has since been re-bound
    // to post-033 semantics; this now pins the direction it was re-bound TO.
    it('measures the POST-033 chain — 033 and 032 are both landed', () => {
      const applied = migrationFiles();
      expect(applied, 'fixture applied a hand-listed slice').toContain(
        '031_w2_sec1_replay_principal_resource_binding.sql',
      );
      expect(
        applied.filter((file) => file.startsWith('033_')),
        '033 is NOT applied — every reading below describes a chain this is not running on',
      ).toHaveLength(1);
    });

    it('binds a genuinely non-null, genuinely distinct identity per transaction', async () => {
      const bound = async (identityId: string): Promise<string | null> =>
        asApplication(identityId, async (client) => {
          const result = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          return result.rows[0]!.bound;
        });

      const owner = await bound(OWNER_IDENTITY);
      const rival = await bound(RIVAL_IDENTITY);
      expect(owner, 'harness bound no identity — every reading here would be vacuous').toBe(
        OWNER_IDENTITY,
      );
      expect(rival).toBe(RIVAL_IDENTITY);
      expect(owner).not.toBe(rival);
    });

    // PROBE-RED FOR THE APPARATUS. On the landed chain there is no principal
    // guard to catch firing, so "no refusal" could mean either "no guard" or
    // "this harness cannot see a refusal". Point it at a guard that IS live
    // (DEV-9's operation-label check, 016:34) and show it observes the refusal.
    it('can observe a refusal at all: the live DEV-9 operation-label guard fires', async () => {
      const cmid = 'nullprin-apparatus-probe';
      await appValue(OWNER_IDENTITY, createTaskSql(), [
        spaceOwner.spaceId,
        'apparatus probe task',
        cmid,
      ]);
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const outcome = await attempt(() =>
        appValue(OWNER_IDENTITY, `select public.create_space($1, '', 'private', null, $2) value`, [
          'apparatus label crossing',
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `the apparatus cannot see a live refusal — every negative below is untrustworthy: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('already used for operation');
    });
  });

  // ---------------------------------------------------------------------------
  // 1. THE WRITER SET — established from the LIVE CATALOG, which is how
  //    completeness is claimed at all.
  //
  // The enumeration question is "every path by which a row can come to hold
  // identity_id NULL". Grepping db/migrations answers a DIFFERENT question,
  // because migrations supersede each other: 012:83 puts a reservation INSERT
  // inside internal.ledger_replay and 016:17 redefines that function without it.
  // pg_proc holds only what is live.
  // ---------------------------------------------------------------------------
  describe('every writer of command_ledger, from pg_catalog', () => {
    it('exactly one live function inserts into command_ledger: internal.ledger_record', () => {
      const writers = ledgerTouchingProcs
        .filter((proc) => INSERTS_LEDGER.test(proc.src) || UPDATES_LEDGER.test(proc.src))
        .map((proc) => proc.fn);
      expect(writers, `live ledger-touching functions: ${ledgerTouchingProcs.map((p) => p.fn).join(', ')}`).toEqual(
        ['internal.ledger_record'],
      );
    });

    it('the live ledger_replay does NOT insert — 012 reservation is superseded by 016', () => {
      const replay = ledgerTouchingProcs.find((proc) => proc.fn === 'internal.ledger_replay');
      expect(replay, 'internal.ledger_replay does not mention command_ledger at all').toBeDefined();
      expect(
        INSERTS_LEDGER.test(replay!.src),
        'the live ledger_replay reserves a row — there is a SECOND write path and the ' +
          'enumeration in this file is incomplete',
      ).toBe(false);
      // The 016 body is the one that is live: advisory lock, plain select.
      expect(replay!.src).toContain('pg_advisory_xact_lock');
    });

    it('the sole writer stores internal.identity_id() verbatim, with no null guard', () => {
      const record = ledgerTouchingProcs.find((proc) => proc.fn === 'internal.ledger_record');
      expect(record).toBeDefined();
      expect(record!.src).toContain('internal.identity_id()');
      // If a guard is ever added, this goes red and the enumeration is revisited.
      expect(
        /identity_id\(\)\s+is\s+null|require_identity/i.test(record!.src),
        'ledger_record now guards identity — the NULL-write path may be closed',
      ).toBe(false);
      // The ON CONFLICT branch must not rewrite the principal either.
      const onConflict = record!.src.slice(record!.src.toLowerCase().indexOf('on conflict'));
      expect(onConflict.slice(0, 200)).not.toContain('identity_id');
    });

    it('no trigger and no column default can supply or erase the principal', async () => {
      const triggers = await ownerRows<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = 'public.command_ledger'::regclass and not tgisinternal`,
      );
      expect(triggers.map((row) => row.tgname)).toEqual([]);

      const column = await ownerRows<{ is_nullable: string; column_default: string | null }>(
        `select is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'command_ledger'
            and column_name = 'identity_id'`,
      );
      // Structural fact: the column is nullable with no default, so whatever
      // ledger_record passes is what is stored.
      expect(column[0]!.is_nullable).toBe('YES');
      expect(column[0]!.column_default).toBeNull();
    });

    // MUTATION TEST OF THE SWEEP ITSELF. A catalog sweep that has never been
    // shown to notice a second writer is a sweep nobody has tested. Add one in
    // the scratch database, re-run the exact query, show it appears, drop it.
    it('the sweep would NOTICE a second writer (mutation test, scratch db only)', async () => {
      const sweep = async (): Promise<string[]> => {
        const procs = await ownerRows<ProcSource>(
          `select n.nspname || '.' || p.proname as fn, p.prosrc as src
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('pg_catalog', 'information_schema')
              and p.prosrc ilike '%command_ledger%'
            order by 1`,
        );
        return procs.filter((proc) => INSERTS_LEDGER.test(proc.src)).map((proc) => proc.fn);
      };

      expect(await sweep()).toEqual(['internal.ledger_record']);
      try {
        await ownerRows(
          `create function internal.nullprin_mutant_writer() returns void
           language plpgsql as $mutant$
           begin
             insert into public.command_ledger(client_mutation_id, identity_id, operation)
             values ('mutant', null, 'entities.create');
           end
           $mutant$`,
        );
        expect(await sweep(), 'the sweep did not notice an added writer').toEqual([
          'internal.ledger_record',
          'internal.nullprin_mutant_writer',
        ]);
      } finally {
        await ownerRows(`drop function if exists internal.nullprin_mutant_writer()`);
      }
      expect(await sweep(), 'the mutation was not reverted').toEqual(['internal.ledger_record']);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. WHEN IS internal.identity_id() NULL? The writer stores it verbatim, so
  //    this is the whole of the "stored NULL" precondition.
  // ---------------------------------------------------------------------------
  describe('the value the writer stores', () => {
    it('identity_id() is NULL for an unset claim and for every blank spelling', async () => {
      const unsetClaim = await database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        const result = await client.query<{ bound: string | null }>(
          `select internal.identity_id() bound`,
        );
        return result.rows[0]!.bound;
      });
      expect(unsetClaim, 'an entirely unbound transaction did not read NULL').toBeNull();

      for (const spelling of UNSET_CLAIM_SPELLINGS) {
        const bound = await database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(`select set_config('tm8.identity_id', $1, true)`, [spelling]);
          const result = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          return result.rows[0]!.bound;
        });
        expect(bound, `claim ${JSON.stringify(spelling)} did not normalise to NULL`).toBeNull();
      }
    });


    // POST-037: A BLANK-LOOKING CLAIM NOW AUTHORISES NOTHING.
    //
    // The history matters more than the current value. On the original chain this
    // test asserted the REVERSE and passed: public.create_space SUCCEEDED for a
    // tab-only claim, minting a Space whose created_by_identity was "\t" plus a
    // member row bearing it, because internal.require_identity() (001:195) tests
    // only for NULL and there is no accounts existence check on that path. I had
    // first assumed it would be refused, my own suite disproved me, and I recorded
    // the disproof. 037 then normalised claim_text, and the refusal I originally
    // assumed is now real — arrived at by fixing the code rather than by my having
    // been right.
    it('POST-037: a blank-looking claim is normalised away and authorises nothing', async () => {
      const cmid = 'nullprin-tab-claim';
      const outcome = await attempt(() =>
        appValue('\t', `select public.create_space($1, '', 'private', null, $2) value`, [
          'tab-claim space',
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `a tab-only identity still created a Space: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('28000');
      expect(await recordedIdentity(cmid), 'a ledger row survived the refusal').toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. REACHABILITY — can an APPLICATION caller drive the writer with a NULL
  //    identity and COMMIT the row? This is the question that decides whether a
  //    fail-closed guard would break something legitimate.
  //
  // The writer runs at the BOTTOM of an RPC body (create_task, 007:939), after
  // every guard, and it is the ONLY writer (section 1). So a NULL-principal row
  // commits only if some RPC body runs to completion with no identity bound.
  // ---------------------------------------------------------------------------
  describe('reachability of the writer with no identity bound', () => {
    it('tm8_app cannot write the ledger table directly — RLS with zero policies', async () => {
      const outcome = await attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `insert into public.command_ledger(client_mutation_id, identity_id, operation)
             values ('nullprin-direct-insert', null, 'entities.create')`,
          );
        }),
      );
      expect(outcome.ok, `tm8_app wrote the ledger directly: ${describeOutcome(outcome)}`).toBe(
        false,
      );
      if (outcome.ok) return;
      // 42501 insufficient_privilege (no grant) or 42501 via RLS — either way, denied.
      expect(outcome.code).toBe('42501');
    });

    it('an unbound caller is refused by an identity-gated RPC (28000) and records nothing', async () => {
      const cmid = 'nullprin-unbound-create-space';
      const outcome = await attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `select set_config('tm8.identity_id', '', true),
                    set_config('tm8.actor_id', '', true),
                    set_config('tm8.node_admin', 'false', true),
                    set_config('tm8.request_id', 'nullprin-unbound', true)`,
          );
          const bound = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          expect(bound.rows[0]!.bound, 'caller was NOT unbound — this probe is vacuous').toBeNull();
          const result = await client.query<{ value: unknown }>(
            `select public.create_space($1, '', 'private', null, $2) value`,
            ['unbound space', cmid],
          );
          return result.rows[0]!.value;
        }),
      );
      expect(outcome.ok, `an unbound caller created a Space: ${describeOutcome(outcome)}`).toBe(
        false,
      );
      if (outcome.ok) return;
      expect(outcome.code).toBe('28000');
      expect(await recordedIdentity(cmid), 'a ledger row survived the refusal').toBeUndefined();
    });

    it('an unbound caller is refused by a membership-gated RPC and records nothing', async () => {
      const cmid = 'nullprin-unbound-create-task';
      const outcome = await attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `select set_config('tm8.identity_id', '', true),
                    set_config('tm8.actor_id', '', true),
                    set_config('tm8.node_admin', 'false', true),
                    set_config('tm8.request_id', 'nullprin-unbound', true)`,
          );
          const bound = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          expect(bound.rows[0]!.bound, 'caller was NOT unbound — this probe is vacuous').toBeNull();
          const result = await client.query<{ value: unknown }>(createTaskSql(), [
            spaceOwner.spaceId,
            'task from an unbound caller',
            cmid,
          ]);
          return result.rows[0]!.value;
        }),
      );
      expect(outcome.ok, `an unbound caller created a task: ${describeOutcome(outcome)}`).toBe(
        false,
      );
      if (outcome.ok) return;
      expect(await recordedIdentity(cmid), 'a ledger row survived the refusal').toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // THE ONE THAT IS NOT GATED.
    //
    // Found by asking, of every live function that calls internal.ledger_record,
    // whether an identity-requiring helper appears in its source BEFORE that
    // call. 97 live callers; 94 pass through one of require_identity /
    // require_space_member / require_space_admin / require_human_space_admin /
    // require_node_admin / current_member_id / resolve_actor. Three did not, and
    // two of those (w2_complete_file_upload, w2_abort_file_upload) call
    // internal.w2_file_slot_for_identity (022:82) first, which itself does
    // require_space_member — so they ARE gated and the tool merely did not know
    // the helper. That leaves one.
    //
    // public.reset_session_wake_budget_for_member_reply (015:1497) is granted to
    // tm8_app (015:2178). Its FIRST branch — reply message not found, or its
    // author is not a member entity — returns internal.ledger_record(...)
    // DIRECTLY. internal.require_space_member is not reached until the line
    // AFTER that return. So an identity-less caller passing any unknown uuid
    // takes the ungated branch, records, and COMMITS.
    // -------------------------------------------------------------------------
    it('POST-037 CLOSED: the formerly ungated path now refuses an unbound caller', async () => {
      const cmid = 'nullprin-ungated-wake-budget';
      const outcome = await attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `select set_config('tm8.identity_id', '', true),
                    set_config('tm8.actor_id', '', true),
                    set_config('tm8.node_admin', 'false', true),
                    set_config('tm8.request_id', 'nullprin-ungated', true)`,
          );
          // Control: the caller genuinely has no identity, so a row it records
          // genuinely carries NULL rather than something that merely looks like it.
          const bound = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          expect(bound.rows[0]!.bound, 'caller was NOT unbound — this probe is vacuous').toBeNull();
          const result = await client.query<{ value: unknown }>(
            `select public.reset_session_wake_budget_for_member_reply(
                      '00000000-0000-4000-8000-0000000000ff'::uuid, $1) value`,
            [cmid],
          );
          return result.rows[0]!.value;
        }),
      );

      // 037 put an identity gate ahead of the early return, so the branch that
      // used to record now refuses. 28000 is the unauthenticated code.
      expect(
        outcome.ok,
        `the formerly ungated branch STILL commits a NULL-principal row: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('28000');

      // AND THE LEDGER IS UNCHANGED — the refusal wrote nothing.
      expect(
        await recordedIdentity(cmid),
        'the refusal still left a ledger row behind',
      ).toBeUndefined();
    });

    // THE COUNT, MEASURED. This is the reachability answer in one number. It is
    // 1 — the ungated path above — and NOT 0. Every other unbound attempt in this
    // describe block rolled back and contributed nothing, which is what makes
    // this count attributable to that one path rather than to the probes at large.
    it('ZERO NULL-principal rows arise through the application surface', async () => {
      const rows = await ownerRows<{ client_mutation_id: string; operation: string }>(
        `select client_mutation_id, operation from public.command_ledger
          where identity_id is null order by client_mutation_id`,
      );
      // Pre-037 this was exactly one — 'nullprin-ungated-wake-budget', recorded
      // through the ungated branch by a caller with no identity. It is now zero.
      expect(
        rows.map((row) => row.client_mutation_id),
        'an unbound application caller still COMMITS a NULL-principal ledger row',
      ).toEqual([]);
    });

    // BOTH HALVES ARE NOW CLOSED, AND BY TWO INDEPENDENT GUARDS.
    //
    // The full history of this one call, because the movement is the finding:
    //   PRE-033  — an unbound caller RECORDED a NULL-principal row and REPLAYED it.
    //   POST-033 — the record still succeeded; the replay was refused 23514 by the
    //              principal pin, which handled the NULL-vs-NULL cell explicitly
    //              rather than inheriting `is distinct from` semantics.
    //   POST-037 — the caller is now refused 28000 at an identity gate placed
    //              AHEAD of the early return, so it never reaches the ledger at all.
    //
    // The two guards are independent and both still matter. 037 stops the row
    // being written through THIS path; 033 stops any NULL-principal row being
    // served, whatever path produced it. CASE 5 in section 4 still exercises the
    // second half against a seeded row, which is the only way to reach it now that
    // the application surface cannot mint one — so if a NULL row ever arises by
    // some route this file has not found, it is still unreplayable.
    it('POST-037: refused at the identity gate, before the ledger is reached', async () => {
      const cmid = 'nullprin-ungated-wake-budget';
      const outcome = await attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `select set_config('tm8.identity_id', '', true),
                    set_config('tm8.actor_id', '', true),
                    set_config('tm8.node_admin', 'false', true),
                    set_config('tm8.request_id', 'nullprin-ungated-replay', true)`,
          );
          const result = await client.query<{ value: unknown }>(
            `select public.reset_session_wake_budget_for_member_reply(
                      '00000000-0000-4000-8000-0000000000ff'::uuid, $1) value`,
            [cmid],
          );
          return result.rows[0]!.value;
        }),
      );
      expect(
        outcome.ok,
        `an unbound caller was still served by this path: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      // 28000, not 23514: the identity gate fires FIRST now, so the principal pin
      // is never reached on this path. That ordering is the point — the caller is
      // stopped before the ledger, not after it.
      expect(outcome.code).toBe('28000');

      // Nothing was written, and nothing was left behind.
      const rows = await ownerRows<{ count: string }>(
        `select count(*) count from public.command_ledger where client_mutation_id = $1`,
        [cmid],
      );
      expect(rows[0]!.count).toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. THE FIVE CASES, NOW ON THE POST-033 CHAIN.
  //
  // This table was written as a PRE-033 baseline and every cell except CASE 1 has
  // since moved. The movement is the result, so it is recorded rather than
  // overwritten:
  //
  //   CASE 1  stored non-null, same caller      replayed  ->  replayed   (unchanged)
  //   CASE 2  stored non-null, different caller replayed  ->  23514
  //   CASE 3  stored non-null, caller NULL      replayed  ->  23514
  //   CASE 4  stored NULL,     caller non-null  replayed  ->  23514
  //   CASE 5  stored NULL,     caller NULL      replayed  ->  23514
  //
  // CASE 5 IS THE ONE THIS FILE WAS BUILT FOR. `null is distinct from null` is
  // FALSE, so a compact guard would have left exactly that cell unchanged while
  // every other cell moved — enforced-looking and inert. It moved. 033 wrote the
  // NULL cases out explicitly rather than inheriting them, and this is the
  // executable evidence that it did.
  //
  // CASE 1 not moving is equally load-bearing: the pin did not buy its refusals by
  // refusing everyone, and idempotency survives.
  //
  // A "stored NULL" row is seeded here as the graph owner. Stated as the
  // limitation it is: this section measures what internal.ledger_replay does WITH
  // such a row. That such a row ARISES on its own is proved separately in section
  // 3, and that path is still open.
  // ---------------------------------------------------------------------------
  describe('post-033: replay behaviour for each (stored, caller) principal pair', () => {
    async function replayAsBound(cmid: string, identityId: string): Promise<Outcome<unknown>> {
      return attempt(() =>
        appValue(identityId, createTaskSql(), [
          identityId === RIVAL_IDENTITY ? spaceRival.spaceId : spaceOwner.spaceId,
          'replay probe',
          cmid,
        ]),
      );
    }

    async function replayAsUnbound(cmid: string): Promise<Outcome<unknown>> {
      return attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `select set_config('tm8.identity_id', '', true),
                    set_config('tm8.actor_id', '', true),
                    set_config('tm8.node_admin', 'false', true),
                    set_config('tm8.request_id', 'nullprin-baseline', true)`,
          );
          const bound = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          expect(bound.rows[0]!.bound, 'caller was NOT unbound — this case is vacuous').toBeNull();
          const result = await client.query<{ value: unknown }>(createTaskSql(), [
            spaceOwner.spaceId,
            'replay probe',
            cmid,
          ]);
          return result.rows[0]!.value;
        }),
      );
    }

    it('CASE 1 — stored non-null, caller the SAME non-null: replayed (idempotency)', async () => {
      const cmid = 'nullprin-case1';
      await seedLedgerRow(cmid, OWNER_IDENTITY);
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const outcome = await replayAsBound(cmid, OWNER_IDENTITY);
      expect(outcome.ok, describeOutcome(outcome)).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value).toMatchObject({ entity: { id: 'seeded' } });
    });

    it('CASE 2 — stored non-null, caller a DIFFERENT non-null: REFUSED (was the SEC-1 defect)', async () => {
      const cmid = 'nullprin-case2';
      await seedLedgerRow(cmid, OWNER_IDENTITY);
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const outcome = await replayAsBound(cmid, RIVAL_IDENTITY);
      expect(
        outcome.ok,
        `a stranger still gets the stored result — 033's pin is not firing: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another principal');
    });

    it('CASE 3 — stored non-null, caller NULL: REFUSED', async () => {
      const cmid = 'nullprin-case3';
      await seedLedgerRow(cmid, OWNER_IDENTITY);
      const outcome = await replayAsUnbound(cmid);
      expect(
        outcome.ok,
        `an unbound caller still gets a bound principal's stored result: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another principal');
    });

    it('CASE 4 — stored NULL, caller non-null: REFUSED — an orphan belongs to no one', async () => {
      const cmid = 'nullprin-case4';
      await seedLedgerRow(cmid, null);
      expect(await recordedIdentity(cmid)).toBeNull();

      const outcome = await replayAsBound(cmid, OWNER_IDENTITY);
      expect(outcome.ok, `a NULL-principal row was claimed: ${describeOutcome(outcome)}`).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another principal');
    });

    // THE CASE THE WHOLE FILE EXISTS FOR. Both sides NULL, so `is distinct from`
    // evaluates FALSE and a compact guard would hand the stored result over while
    // appearing to enforce. This cell moving is the single most informative
    // assertion in the file: it is the difference between a pin that is enforced
    // and one that merely looks it.
    it('CASE 5 — stored NULL, caller NULL: REFUSED, despite `null is distinct from null` being FALSE', async () => {
      const cmid = 'nullprin-case5';
      await seedLedgerRow(cmid, null);
      expect(await recordedIdentity(cmid)).toBeNull();

      const outcome = await replayAsUnbound(cmid);
      expect(
        outcome.ok,
        `THE NULL-vs-NULL CELL IS INERT — the pin was written in the compact form: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe('23514');
        expect(outcome.message).toContain('belongs to another principal');
      }

      // The SQL fact the compact guard would rest on, asserted rather than argued.
      const logic = await ownerRows<{ distinct_form: boolean; equality_form: boolean | null }>(
        `select (null::text is distinct from null::text) distinct_form,
                (null::text = null::text) equality_form`,
      );
      expect(logic[0]!.distinct_form, 'a compact `is distinct from` guard WOULD fire here').toBe(
        false,
      );
      expect(logic[0]!.equality_form).toBeNull();
    });
  });
});
