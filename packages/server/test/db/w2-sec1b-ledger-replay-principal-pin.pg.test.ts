// =============================================================================
// W2.SEC-1b — the command-ledger replay principal pin, INSIDE
//             internal.ledger_replay, UNDER THE ADVISORY LOCK.
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// PROVES: a stored replay is not returned to a principal other than the one that
// recorded it, at a call site that 031 does NOT touch, under concurrency as well
// as sequentially, fail-closed on both null-identity cases, with the 23514
// existence/operation-label oracle removed — and that none of that disturbs the
// server-side nested-call paths or same-principal idempotency.
//
// DOES NOT PROVE, AND CANNOT: anything about SAME-PRINCIPAL resource confusion.
// internal.ledger_replay receives only a cmid and an operation label, so it
// cannot know which resource the current request addresses. W3's measured invite
// leak (POST /v2/spaces/{B}/invites replaying Space A's cmid returns A's live
// invite code) is a SAME-principal leak — Phase-1 runs a single loopback
// auto-owner — so the pin below matches, passes, and does not stop it. That half
// is per-site work in 031 and this file must not be read as covering it.
//
// SITE CHOICE IS LOAD-BEARING. Every cross-principal assertion here runs through
// public.create_task ('entities.create'), which has ZERO matches in 031. If these
// tests used one of 031's six sites, a green would be attributable to 031's
// pre-check rather than to the callee pin, and the file would prove nothing about
// 033. The one place 031's sites appear is the regression direction: its own
// suite is run unmodified alongside this one.
//
// POSITIVE CONTROLS ARE MANDATORY HERE, NOT DECORATIVE. A guard that compares
// command_ledger.identity_id is SILENTLY INERT against a harness that binds no
// identity: every row stores NULL, every caller reads NULL, and a cross-principal
// negative passes because nothing was ever compared. So before any negative is
// believed, this file reads tm8.identity_id back INSIDE the transaction and
// asserts it is non-null, and reads command_ledger.identity_id back out of
// storage and asserts the recorded principal is non-null and is who we think.
// Every negative below is paired with the positive it must be able to detect.
//
// FIXTURE: the FULL official chain from migrationFiles(). 033 HAS NOW LANDED, so
// migrationFiles() carries it and the out-of-repo candidate is never read —
// CANDIDATE_IS_LANDED short-circuits it. The transition happened without editing
// this file, which is what the mechanism was for; the candidate machinery is
// retained only so SEC1B_CANDIDATE=none can still reproduce the pre-033 red
// against a chain that no longer contains the fix. The archived red from before
// the landing is at w2-sec1b-pre-033-red.txt in this directory.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  MIGRATIONS_DIR,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * Prove the attacker is parked on THE VICTIM'S OWN advisory lock.
 *
 * The previous form of this assertion was
 *     select count(*) from pg_locks where locktype = 'advisory' and not granted
 * with NO pid predicate, NO lock-key predicate and NO database filter, against a
 * view that is CLUSTER-WIDE. Any ungranted advisory lock held by any connection
 * to any database on the instance satisfied it — including other suites running
 * concurrently on the same host, and including this schema's own unrelated
 * advisory locks. It could not produce a false green of the security property,
 * but it COULD produce a false claim of RACE COVERAGE: satisfied on the first
 * poll by somebody else's lock, the test proceeds to COMMIT before the attacker
 * has even reached internal.ledger_replay, and then passes as a sequential test
 * wearing a concurrency label.
 *
 * This form joins the attacker's UNGRANTED row to the victim's GRANTED row on
 * (classid, objid, objsubid) and pins BOTH pids, so the only thing that can
 * satisfy it is the attacker waiting on exactly the lock this victim holds. It
 * needs no hash arithmetic: the victim's own held lock supplies the key.
 */
async function awaitParkedOnVictimAdvisoryLock(
  database: W1ScratchDatabase,
  victimPid: number,
  attackerPid: number,
): Promise<{ classid: string; objid: string }> {
  for (let poll = 0; poll < 200; poll += 1) {
    const rows = await database.query<{ classid: string; objid: string }>(
      `select attacker.classid::text as classid, attacker.objid::text as objid
         from pg_catalog.pg_locks attacker
         join pg_catalog.pg_locks victim
           on victim.locktype = 'advisory'
          and victim.granted
          and victim.pid = $2
          and victim.classid = attacker.classid
          and victim.objid = attacker.objid
          and victim.objsubid is not distinct from attacker.objsubid
        where attacker.locktype = 'advisory'
          and not attacker.granted
          and attacker.pid = $1`,
      [attackerPid, victimPid],
    );
    if (rows.length > 0) return rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `attacker pid ${attackerPid} never parked on an advisory lock held by victim pid ${victimPid}` +
      ' — the race was NOT exercised and any pass below would be sequential',
  );
}


/**
 * The 033 candidate, authored outside the repository. Override with
 * SEC1B_CANDIDATE=<abs path> to point at a mutated copy (the guard mutation
 * test), or SEC1B_CANDIDATE=none to capture the RED against the landed chain.
 */
const CANDIDATE_ENV = process.env['SEC1B_CANDIDATE'];
// Points at the LIVE session's copy. The previous default pointed into a session
// that no longer exists; had that directory been reaped, readFileSync would throw
// inside beforeAll and the whole suite would ERROR rather than go red — an outcome
// readable as either "the pin works" or "the pin is broken", which is the worst
// possible failure mode for a security suite. Same bytes as the old path, verified
// sha256 42ae16a8f14027d9f9edcb80645f6af5f341fd56fece221f1c9c838c0ccebed9 on both.
// NOW MOOT IN PRACTICE: 033 has landed, CANDIDATE_IS_LANDED is true, and this path
// is not opened. Kept because it is still the override target for SEC1B_CANDIDATE.
// ⚠ It is also a PATH, NOT AN ARTIFACT: the file it names was rewritten in place
// (42ae16a8 -> 3ee5e036) an hour after this pointer was set, while both were
// byte-identical at the moment of setting. Verify a hash before trusting it again.
const CANDIDATE_PATH =
  CANDIDATE_ENV ??
  '/private/tmp/claude-503/-Users-subhang-Desktop-Projects-tm8/f13f7187-27af-421a-8f82-077847586100/scratchpad/i04/033_w2_sec1b_ledger_replay_principal_pin.sql';

/** True once 033 has landed in db/migrations and arrives via migrationFiles(). */
const CANDIDATE_IS_LANDED = migrationFiles().some((file) => file.startsWith('033_'));

// Migrations this file's behaviour depends on, asserted present BY NAME. 004
// defines command_ledger including the identity_id column the pin reads, 007
// defines create_task and create_invite, 012 is the live ledger_record, 016 is
// the ledger_replay this migration supersedes, 018 and 020 hold the server-side
// nested calls the purpose-built negative exercises, and 031 is the per-site
// work this migration is ADDITIVE to.
const REQUIRED_MIGRATIONS = [
  '001_core_graph.sql',
  '002_identity.sql',
  '004_ledgers.sql',
  '007_rpc_catalog.sql',
  '008_rls_policies.sql',
  '012_ledger_reserve_cmid.sql',
  '015_w1_foundations.sql',
  '016_w2_identity_spaces.sql',
  '018_w2_edges_placements.sql',
  '020_w2_collections_graph_undo.sql',
  '031_w2_sec1_replay_principal_resource_binding.sql',
] as const;

// NEITHER an exact count NOR a comparison of migrationFiles() against itself.
//
// The exact count was removed for a good reason — sibling groups land migrations
// concurrently and an exact count turns an unrelated landing into a spurious red
// on a security suite, which trains people to ignore it. But what replaced it
// could not fail: APPLIED_MIGRATIONS was literally migrationFiles(), so
// `expect(APPLIED_MIGRATIONS).toEqual([...migrationFiles()].sort())` compared
// migrationFiles() to its own sort and proved only that readdirSync output is
// sorted, and a `>= 28` floor is monotonic on a list that only ever grows.
// Neither could detect the thing the assertion is for: a fixture that applies a
// hand-listed SLICE of the chain.
//
// So the expectation and the observation are now produced by DIFFERENT
// MECHANISMS, which is what makes them able to disagree:
//
//   expected — parsed out of each migration file's TEXT on disk (the top-level
//              objects that file declares);
//   observed — read back out of the SCRATCH DATABASE's pg_catalog after the
//              fixture applied whatever it applied.
//
// There is no migration-tracking table to read filenames from — w1-pg.ts:77
// shells psql per file and records nothing, and nothing in db/migrations creates
// a schema_migrations equivalent — so the applied chain is identified by the
// objects it left behind. Truncate the chain and the later files' tables and
// functions are simply absent.
//
// BOTH HALVES ARE PROVED, not argued: the test below shows it GREEN on the real
// applied chain, and its companion shows the SAME predicate going RED when the
// observed catalog is missing exactly what one migration declares. A check seen
// only green cannot be told apart from a check that cannot fail — which is the
// defect this replaced, one level up.
const APPLIED_MIGRATIONS: readonly string[] = migrationFiles();

/**
 * Top-level objects a migration file declares, as `schema.name`.
 *
 * Anchored at line start so `create ...` inside an indented dollar-quoted
 * function body is not mistaken for a declaration. Presence only, never
 * signature: 020:31 drops `public.undo_command(text, uuid)` and recreates the
 * name with a different signature, and that is not a truncated chain.
 */
/**
 * Objects an EARLIER migration declares that a LATER one deliberately drops.
 *
 * The chain is forward-only: 015 and 037 remain the exact record of what an
 * already-deployed database ran, so their `create` statements stay in the file
 * text forever even after 135 removes what they made. Without this set the
 * canary reads that text, finds the object absent from the catalog, and reports
 * a truncated chain — which is the one thing it exists to detect, so a false
 * positive here destroys the check's meaning rather than merely annoying.
 *
 * ENUMERATED, never a predicate. Every entry names the migration that drops it,
 * so adding one is a deliberate act a reviewer can weigh, and an object that
 * goes missing for any OTHER reason still fires. Do not replace this with a
 * name pattern.
 */
const DROPPED_BY_LATER_MIGRATION: ReadonlyMap<string, string> = new Map([
  // 146 removes the wake-budget machinery, including the surrogate pin 120 left
  // in place. See db/migrations/146_remove_wake_budget_machinery.sql.
  ['public.session_wake_budgets', '146_remove_wake_budget_machinery.sql'],
  ['internal.validate_wake_budget', '146_remove_wake_budget_machinery.sql'],
  ['public.reset_session_wake_budget_for_member_reply', '146_remove_wake_budget_machinery.sql'],
  ['internal.w1_refresh_wake_budget_cleanup_eligibility', '146_remove_wake_budget_machinery.sql'],
  // 147's two TRANSITIONAL status_category writers. 147's own header says phase 3's
  // doors are what replace them, and 150 is that phase: the birth seed becomes
  // `internal.seed_entity_initial_status` (writes `status_id`, lets 149's trigger
  // derive the category) and the maintenance trigger becomes
  // `internal.bridge_task_status_to_state`. Both old functions are DROPPED rather
  // than left orphaned, so that `entities.status_category` has exactly one
  // authority. See db/migrations/150_doors_resolve_categories.sql.
  ['internal.seed_entity_status_category', '150_doors_resolve_categories.sql'],
  ['internal.sync_entity_status_category', '150_doors_resolve_categories.sql'],
]);

function declaredObjects(sql: string): string[] {
  const patterns = [
    /^create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)\.([a-z0-9_]+)/gim,
    /^create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([a-z_]+)\.([a-z0-9_]+)/gim,
    /^create\s+(?:or\s+replace\s+)?function\s+([a-z_]+)\.([a-z0-9_]+)/gim,
  ];
  const found = new Set<string>();
  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) found.add(`${match[1]}.${match[2]}`);
  }
  return [...found];
}

const OWNER_IDENTITY = 'w2-sec1b-owner';
const RIVAL_IDENTITY = 'w2-sec1b-rival';

const PRINCIPAL_MESSAGE = 'clientMutationId belongs to another principal';

interface SpaceFixture {
  readonly spaceId: string;
  readonly memberId: string;
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

/** Renders an outcome so a red run SHOWS the leak rather than just failing. */
function describeOutcome(outcome: Outcome<unknown>): string {
  return outcome.ok
    ? `RETURNED a value (no error raised): ${JSON.stringify(outcome.value)}`
    : `raised ${outcome.code}: ${outcome.message}`;
}

describe.sequential('W2.SEC-1b ledger_replay principal pin', () => {
  let database: W1ScratchDatabase;
  let spaceOwner: SpaceFixture;
  let spaceRival: SpaceFixture;

  async function asApplication<T>(
    identityId: string,
    fn: (client: PoolClient) => Promise<T>,
    actorId = '',
  ): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', $2, true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'w2-sec1b-pg', true)`,
        [identityId, actorId],
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

  /** The stored principal for a cmid, read straight out of storage. */
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

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_sec1b_pin');
    database.apply(migrationFiles());

    // 033 is authored outside db/migrations while the coordinator holds the sole
    // landing point. Applied here as the graph owner, exactly as psql would.
    if (!CANDIDATE_IS_LANDED && CANDIDATE_ENV !== 'none') {
      const sql = readFileSync(CANDIDATE_PATH, 'utf8');
      await database.query(sql);
    }

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

    const owned = await appValue<{ space: { id: string }; memberId: string }>(
      OWNER_IDENTITY,
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['SEC-1b owner space', 'sec1b-fixture-owner-space'],
    );
    spaceOwner = { spaceId: owned.space.id, memberId: owned.memberId };

    const rival = await appValue<{ space: { id: string }; memberId: string }>(
      RIVAL_IDENTITY,
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['SEC-1b rival space', 'sec1b-fixture-rival-space'],
    );
    spaceRival = { spaceId: rival.space.id, memberId: rival.memberId };
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // 0. FIXTURE INTEGRITY — structural, never an exact count.
  // ---------------------------------------------------------------------------
  describe('fixture', () => {
    /** Every object the chain's FILE TEXT declares but the DATABASE does not have. */
    function missingFromCatalog(present: ReadonlySet<string>): {
      missing: string[];
      expectedCount: number;
    } {
      const missing: string[] = [];
      let expectedCount = 0;
      for (const file of APPLIED_MIGRATIONS) {
        for (const object of declaredObjects(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))) {
          // A later migration dropping this on purpose is not a truncated chain.
          if (DROPPED_BY_LATER_MIGRATION.has(object)) continue;
          expectedCount += 1;
          if (!present.has(object)) missing.push(`${file} -> ${object}`);
        }
      }
      return { missing, expectedCount };
    }

    /** Every relation and function the scratch database actually has. */
    async function catalogObjects(): Promise<Set<string>> {
      const rows = await ownerRows<{ object: string }>(
        `select n.nspname || '.' || c.relname as object
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
            and c.relkind in ('r', 'p', 'v', 'm')
         union
         select n.nspname || '.' || p.proname
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname not in ('pg_catalog', 'information_schema')`,
      );
      return new Set(rows.map((row) => row.object));
    }

    // THE GREEN HALF — on the real, fully applied chain.
    it('applies the full official chain, not a hand-listed slice', async () => {
      for (const required of REQUIRED_MIGRATIONS) {
        expect(APPLIED_MIGRATIONS, `missing ${required}`).toContain(required);
      }
      const { missing, expectedCount } = missingFromCatalog(await catalogObjects());
      expect(missing, 'objects declared by the chain are absent from the applied database').toEqual(
        [],
      );
      expect(
        expectedCount,
        'nothing was parsed out of the chain — the check is empty',
      ).toBeGreaterThan(200);
    });

    // THE RED HALF — REQUIRED, because a check that has only ever been seen GREEN
    // is indistinguishable from a check that cannot fail. The inverse is equally
    // true and is why both halves are here: a detector that fires on EVERYTHING
    // passes a mutation test exactly as well as a correct one, so red-only proves
    // response but never DISCRIMINATION.
    //
    // The fixture is NOT narrowed to produce this. Narrowing the real chain would
    // mean applying a deliberately short slice and restoring it, which mutates
    // shared state mid-suite. Instead the catalog side is perturbed in memory —
    // exactly what a truncated chain would look like to this comparison — and the
    // same predicate is asked again. Nothing on disk or in the database changes.
    it('...and the same comparison NOTICES a chain that was truncated', async () => {
      const present = await catalogObjects();
      const baseline = missingFromCatalog(present);
      expect(baseline.missing, 'the green half is not green — red half is meaningless').toEqual([]);

      // Simulate the fixture having skipped 031: drop the objects it declares.
      const skipped = '031_w2_sec1_replay_principal_resource_binding.sql';
      const dropped = declaredObjects(readFileSync(join(MIGRATIONS_DIR, skipped), 'utf8'));
      expect(dropped.length, 'nothing parsed out of 031 — this red half is vacuous').toBeGreaterThan(
        0,
      );
      const truncated = new Set(present);
      for (const object of dropped) truncated.delete(object);

      const after = missingFromCatalog(truncated);
      expect(
        after.missing.length,
        'the comparison did NOT notice a truncated chain — it cannot detect the ' +
          'hand-listed slice it exists to catch',
      ).toBeGreaterThan(0);
      // ...and it names WHICH migration's objects went missing, so a real red is
      // actionable rather than just failing.
      expect(after.missing.join('\n')).toContain(skipped);
    });

    // THE CONTROL FOR EVERY NEGATIVE IN THIS FILE. If the harness bound no
    // identity, internal.identity_id() would be null everywhere, every ledger row
    // would store null, and a cross-principal negative would pass because the
    // comparison never had operands. Prove the claim is really bound, and that
    // two identities really are distinct, BEFORE trusting any refusal below.
    it('binds a genuinely non-null, genuinely distinct identity per transaction', async () => {
      const owner = await asApplication(OWNER_IDENTITY, async (client) => {
        const result = await client.query<{ bound: string | null }>(
          `select internal.identity_id() bound`,
        );
        return result.rows[0]!.bound;
      });
      const rival = await asApplication(RIVAL_IDENTITY, async (client) => {
        const result = await client.query<{ bound: string | null }>(
          `select internal.identity_id() bound`,
        );
        return result.rows[0]!.bound;
      });

      expect(owner, 'harness bound no identity — every negative here would be vacuous').toBe(
        OWNER_IDENTITY,
      );
      expect(rival).toBe(RIVAL_IDENTITY);
      expect(owner).not.toBe(rival);
    });
  });

  // ---------------------------------------------------------------------------
  // 1. THE PIN — sequential, at a site 031 does not touch.
  // ---------------------------------------------------------------------------
  describe('cross-principal replay at entities.create (no 031 coverage)', () => {
    it('records a non-null principal, replays for the recorder, refuses a stranger', async () => {
      const cmid = 'sec1b-cross-principal-create-task';

      const first = await appValue<{ entity: { id: string; title: string } }>(
        OWNER_IDENTITY,
        createTaskSql(),
        [spaceOwner.spaceId, 'owner task under the pin', cmid],
      );
      expect(first.entity.id).toBeTruthy();

      // POSITIVE CONTROL A — the row really carries a non-null principal, so the
      // comparison below has real operands on the stored side.
      expect(
        await recordedIdentity(cmid),
        'ledger row stored a NULL principal — the pin would be comparing nothing',
      ).toBe(OWNER_IDENTITY);

      // POSITIVE CONTROL B — the guard does not simply refuse everything. The
      // recorder still gets its own stored result back, byte-identical.
      const ownRetry = await appValue<{ entity: { id: string } }>(OWNER_IDENTITY, createTaskSql(), [
        spaceOwner.spaceId,
        'owner task under the pin',
        cmid,
      ]);
      expect(ownRetry.entity.id, 'idempotency was traded away, not preserved').toBe(
        first.entity.id,
      );

      // THE NEGATIVE — a genuinely different bound identity, addressing its own
      // Space, replaying the owner's cmid.
      const outcome = await attempt(() =>
        appValue(RIVAL_IDENTITY, createTaskSql(), [
          spaceRival.spaceId,
          'rival task riding the owner cmid',
          cmid,
        ]),
      );

      expect(
        outcome.ok,
        `SEC-1b: a different principal replaying entities.create ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(PRINCIPAL_MESSAGE);
    });

    it('still creates exactly one task, so the refusal caused no second effect', async () => {
      // `title` is on public.tasks (001:516), NOT on public.entities and not in a
      // `content` column — that shape only exists in the RPC's jsonb projection.
      // Two earlier revisions of this assertion raised 42703 and produced a red
      // that read like a security failure but was a test defect. Named here
      // because a 42703 in a security suite is exactly the kind of red that gets
      // mistaken for evidence.
      const rows = await ownerRows<{ count: string }>(
        `select count(*) count
           from public.tasks t
           join public.entities e on e.id = t.entity_id
          where t.title = 'owner task under the pin' and e.deleted_at is null`,
      );
      expect(rows[0]!.count).toBe('1');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. THE RACE — the reason the pin lives in the callee rather than at the site.
  //
  // A pre-check placed before internal.ledger_replay reads command_ledger with NO
  // LOCK HELD. Against a victim's UNCOMMITTED row it reads "not found", pins
  // nothing, then blocks INSIDE ledger_replay on the advisory lock, and after the
  // victim commits it sees the row with the comparison already skipped. The pin
  // under the lock has no such window.
  // ---------------------------------------------------------------------------
  describe('cross-principal replay raced against an uncommitted ledger row', () => {
    it("refuses the attacker parked on the victim's advisory lock", async () => {
      const cmid = 'sec1b-toctou-create-task';
      const victim = await database.pool.connect();
      const attacker = await database.pool.connect();
      try {
        // 1. Victim runs the command and does NOT commit. Its ledger row exists
        //    but is invisible to anyone else, and it holds the advisory lock.
        await victim.query('begin');
        await victim.query('set local role tm8_app');
        const victimPid = (await victim.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        )).rows[0]!.pid;
        await victim.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'sec1b-race-victim', true)`,
          [OWNER_IDENTITY],
        );
        const victimResult = await victim.query<{ value: { entity: { id: string } } }>(
          createTaskSql(),
          [spaceOwner.spaceId, 'victim task raced', cmid],
        );
        expect(victimResult.rows[0]!.value.entity.id).toBeTruthy();

        // POSITIVE CONTROL — the race is only meaningful if the victim's row is
        // genuinely invisible to an outside reader at this moment. That is what
        // makes an unlocked pre-check read "not found" and pin nothing.
        expect(
          await recordedIdentity(cmid),
          "victim's ledger row was already visible — the race is not being exercised",
        ).toBeUndefined();

        // 2. Attacker enters on the same cmid. This BLOCKS inside ledger_replay,
        //    so it must not be awaited yet.
        await attacker.query('begin');
        await attacker.query('set local role tm8_app');
        const attackerPid = (await attacker.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        )).rows[0]!.pid;
        await attacker.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'sec1b-race-attacker', true)`,
          [RIVAL_IDENTITY],
        );
        const attackerCall = attacker
          .query<{ value: unknown }>(createTaskSql(), [
            spaceRival.spaceId,
            'attacker task raced',
            cmid,
          ])
          .then((r) => ({ ok: true as const, value: r.rows[0]!.value }))
          .catch((error: { code?: string; message?: string }) => ({
            ok: false as const,
            code: error.code ?? '',
            message: error.message ?? String(error),
          }));

        // 3. Prove the attacker is GENUINELY parked on the advisory lock, so a
        //    lucky serial interleaving cannot pass as coverage of a race.
        // Parked on THE VICTIM'S lock, both pids pinned and the key matched.
        await awaitParkedOnVictimAdvisoryLock(database, victimPid, attackerPid);

        // 4. Victim commits; the attacker wakes and can now see the row.
        await victim.query('commit');
        const outcome = await attackerCall;
        await attacker.query('rollback');

        expect(
          outcome.ok,
          `SEC-1b TOCTOU: a stranger racing the victim's uncommitted ledger row ` +
            describeOutcome(outcome),
        ).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe('23514');
        expect(outcome.message).toContain(PRINCIPAL_MESSAGE);
      } finally {
        try {
          await victim.query('rollback');
        } catch {
          /* already committed */
        }
        try {
          await attacker.query('rollback');
        } catch {
          /* already settled */
        }
        victim.release();
        attacker.release();
      }
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // 3. FAIL-CLOSED — both null cases, decided explicitly rather than inherited.
  //
  // `null is distinct from null` is FALSE, so the compact form of this guard
  // would PASS when a null-identity row meets an identity-less caller. These two
  // tests are what distinguish the explicit three-way test from that compact
  // form; if someone "simplifies" the guard, the second one goes red.
  // ---------------------------------------------------------------------------
  describe('fail-closed on an unestablished principal', () => {
    const nullCmid = 'sec1b-null-identity-row';

    beforeAll(async () => {
      // A ledger row with NO recorded principal. Structurally producible today:
      // command_ledger.identity_id is nullable (004:81), internal.identity_id()
      // is a bare claim read (001:158), and ledger_record writes it verbatim
      // (012:130) with no guard.
      await ownerRows(
        `insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation, result)
         values ($1, null, null, 'entities.create', $2)`,
        [nullCmid, JSON.stringify({ entity: { id: 'stolen', title: 'unowned stored result' } })],
      );
    });

    it('control: the row really is stored with a NULL principal', async () => {
      expect(await recordedIdentity(nullCmid)).toBeNull();
    });

    it('refuses a bound caller — a replay with no recorded principal belongs to no one', async () => {
      const outcome = await attempt(() =>
        appValue(OWNER_IDENTITY, createTaskSql(), [spaceOwner.spaceId, 'claiming an orphan', nullCmid]),
      );
      expect(outcome.ok, `orphan replay ${describeOutcome(outcome)}`).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(PRINCIPAL_MESSAGE);
    });

    // THE ONE THAT CATCHES `is distinct from`. Both sides null: the compact form
    // evaluates FALSE and hands the stored result over.
    it('refuses an UNBOUND caller — null does not match null here', async () => {
      const outcome = await attempt(() =>
        database.transaction(async (client) => {
          await client.query('set local role tm8_app');
          await client.query(
            `select set_config('tm8.identity_id', '', true),
                    set_config('tm8.actor_id', '', true),
                    set_config('tm8.node_admin', 'false', true),
                    set_config('tm8.request_id', 'sec1b-unbound', true)`,
          );
          // Control inside the negative: the caller really is identity-less.
          const bound = await client.query<{ bound: string | null }>(
            `select internal.identity_id() bound`,
          );
          expect(bound.rows[0]!.bound, 'caller was NOT unbound — this negative is vacuous').toBeNull();
          // Through the PUBLIC RPC, which is the real attack surface. Calling
          // internal.ledger_replay directly would only prove that tm8_app lacks
          // EXECUTE on the internal schema (42501), not that the pin fires.
          const result = await client.query<{ value: unknown }>(createTaskSql(), [
            spaceOwner.spaceId,
            'unbound caller claiming an orphan',
            nullCmid,
          ]);
          return result.rows[0]!.value;
        }),
      );
      expect(
        outcome.ok,
        `an identity-less caller replaying a null-identity row ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(PRINCIPAL_MESSAGE);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. THE PURPOSE-BUILT NEGATIVE — written to FIND a legitimate cross-principal
  //    replay, not to pass.
  //
  // Server-side nested calls (018:337,343,357,361,375,382 and 020:104,113,119,132)
  // invoke ledgered RPCs from inside other ledgered RPCs. If any passed a
  // non-null cmid it would enter ledger_replay under the OUTER command's identity
  // and could legitimately trip the pin. Static reading says all pass NULL — but
  // a suite that passes because nothing exercised the risk is the vacuous-green
  // case, so these drive the paths for real, with a real caller-supplied cmid on
  // the OUTER call.
  // ---------------------------------------------------------------------------
  describe('server-side nested calls are undisturbed', () => {
    let taskA: string;
    let taskB: string;
    let memberEntity: string;
    let channelId: string;

    beforeAll(async () => {
      const a = await appValue<{ entity: { id: string } }>(OWNER_IDENTITY, createTaskSql(), [
        spaceOwner.spaceId,
        'nested source task',
        'sec1b-nested-task-a',
      ]);
      taskA = a.entity.id;
      const b = await appValue<{ entity: { id: string } }>(OWNER_IDENTITY, createTaskSql(), [
        spaceOwner.spaceId,
        'nested target task',
        'sec1b-nested-task-b',
      ]);
      taskB = b.entity.id;
      memberEntity = spaceOwner.memberId;

      const rows = await ownerRows<{ id: string }>(
        `select id from public.entities
          where space_id = $1 and kind = 'channel' and deleted_at is null
          order by created_at limit 1`,
        [spaceOwner.spaceId],
      );
      channelId = rows[0]!.id;
    });

    // place_entity -> write_edge (018:337). Outer call carries a REAL cmid; the
    // nested write_edge must still receive NULL and short-circuit.
    it('placements.apply attach reaches write_edge with a real outer cmid', async () => {
      const cmid = 'sec1b-nested-attach';
      const value = await appValue<{ patches: unknown }>(
        OWNER_IDENTITY,
        `select public.place_entity($1, $2, 'attach', null, null, null, $3) value`,
        [taskA, taskB, cmid],
      );
      expect(value).toBeTruthy();
      // The OUTER command recorded under the caller. The nested one recorded
      // nothing, which is exactly why the pin cannot fire on it.
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);
      const nested = await ownerRows<{ count: string }>(
        `select count(*) count from public.command_ledger where operation = 'edges.write'`,
      );
      expect(nested[0]!.count, 'a nested call recorded its own ledger row').toBe('0');
    });

    // place_entity -> write_edge (018:357), the assign branch.
    it('placements.apply assign reaches write_edge with a real outer cmid', async () => {
      const cmid = 'sec1b-nested-assign';
      const value = await appValue<unknown>(
        OWNER_IDENTITY,
        `select public.place_entity($1, $2, 'assign', null, null, null, $3) value`,
        [taskA, memberEntity, cmid],
      );
      expect(value).toBeTruthy();
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);
    });

    // place_entity -> write_edge (018:361), the depend branch.
    it('placements.apply depend reaches write_edge with a real outer cmid', async () => {
      const cmid = 'sec1b-nested-depend';
      const value = await appValue<unknown>(
        OWNER_IDENTITY,
        `select public.place_entity($1, $2, 'depend', null, null, null, $3) value`,
        [taskA, taskB, cmid],
      );
      expect(value).toBeTruthy();
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);
    });

    // place_entity -> move_entity (018:375), the subtask branch.
    it('placements.apply subtask reaches move_entity with a real outer cmid', async () => {
      const cmid = 'sec1b-nested-subtask';
      const value = await appValue<unknown>(
        OWNER_IDENTITY,
        `select public.place_entity($1, $2, 'subtask', null, null, null, $3) value`,
        [taskA, taskB, cmid],
      );
      expect(value).toBeTruthy();
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);
    });

    // place_entity -> post_message (018:382) AND the undo token that 020's
    // undo_command consumes, which is the entry to the four nested calls there.
    it('placements.apply embed reaches post_message, and undo_command reaches its inverse', async () => {
      const embedCmid = 'sec1b-nested-embed';
      const embed = await appValue<{ undo: { token: string } }>(
        OWNER_IDENTITY,
        `select public.place_entity($1, $2, 'embed', 'embedding under the pin', null, null, $3) value`,
        [taskA, channelId, embedCmid],
      );
      expect(await recordedIdentity(embedCmid)).toBe(OWNER_IDENTITY);
      const token = embed.undo.token;
      expect(token, 'no undo token issued — the 020 nested paths are not reachable').toBeTruthy();

      // undo_command -> w2_tombstone_message (020:132). Outer cmid is real and
      // belongs to the SAME principal that recorded the embed, which is the
      // legitimate case the pin must not disturb.
      const undoCmid = 'sec1b-nested-undo';
      const undone = await appValue<unknown>(
        OWNER_IDENTITY,
        `select public.undo_command($1, null, $2) value`,
        [token, undoCmid],
      );
      expect(undone).toBeTruthy();
      expect(await recordedIdentity(undoCmid)).toBe(OWNER_IDENTITY);

      const nested = await ownerRows<{ count: string }>(
        `select count(*) count from public.command_ledger
          where operation in ('messages.post', 'messages.delete', 'entities.move', 'edges.delete',
                              'entities.restore', 'edges.write')`,
      );
      expect(nested[0]!.count, 'a nested call recorded its own ledger row').toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. THE ORACLE — 016:35-36 interpolated the caller's cmid AND the true owner's
  //    operation label into a message that reaches the wire verbatim
  //    (db/errors.ts:82 -> http/errors.ts:89), turning every site into a guided
  //    search. The 23514 and the DEV-9 invariant stay; the interpolations go.
  // ---------------------------------------------------------------------------
  describe('the 23514 operation-label oracle is removed', () => {
    it('keeps the DEV-9 guard but names neither the cmid nor the recorded operation', async () => {
      const cmid = 'sec1b-oracle-probe';
      await appValue(OWNER_IDENTITY, createTaskSql(), [
        spaceOwner.spaceId,
        'oracle probe task',
        cmid,
      ]);
      // Control: the DEV-9 invariant is still enforced for the RECORDER, which is
      // the caller it was written to protect.
      expect(await recordedIdentity(cmid)).toBe(OWNER_IDENTITY);

      const outcome = await attempt(() =>
        appValue(OWNER_IDENTITY, `select public.create_space($1, '', 'private', null, $2) value`, [
          'oracle label crossing',
          cmid,
        ]),
      );
      expect(outcome.ok, `operation-label guard ${describeOutcome(outcome)}`).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('already used for operation');
      expect(outcome.message, 'the caller-supplied cmid is echoed back').not.toContain(cmid);
      expect(
        outcome.message,
        "the TRUE OWNER's operation label is disclosed — this is the oracle",
      ).not.toContain('entities.create');
    });

    // A stranger must learn NOTHING about the recorded operation — which is why
    // the principal check is ordered AHEAD of the operation-label check.
    it('tells a stranger nothing about the recorded operation', async () => {
      const cmid = 'sec1b-oracle-stranger';
      await appValue(OWNER_IDENTITY, createTaskSql(), [
        spaceOwner.spaceId,
        'stranger oracle probe',
        cmid,
      ]);
      const outcome = await attempt(() =>
        appValue(RIVAL_IDENTITY, `select public.create_space($1, '', 'private', null, $2) value`, [
          'stranger label crossing',
          cmid,
        ]),
      );
      expect(outcome.ok, describeOutcome(outcome)).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(PRINCIPAL_MESSAGE);
      expect(outcome.message).not.toContain('already used for operation');
      expect(outcome.message).not.toContain('entities.create');
    });
  });
});
