// =============================================================================
// W2.SEC-1 — command-ledger replay must be pinned to the recording PRINCIPAL
//            *and* to the ADDRESSED RESOURCE.
//
// THE DEFECT this file proves and then locks shut.
//
// `internal.ledger_replay(p_cmid, p_operation)` (live definition
// `016_w2_identity_spaces.sql:17`) selects the stored projection with
//
//     select * into ledger_row from public.command_ledger
//      where client_mutation_id = p_cmid;
//
// There is NO identity, actor, Space, or input predicate — the only guard is an
// operation-label comparison. Four RPCs return that stored projection BEFORE any
// authorization runs, so:
//
//   1. a caller who is not the recording principal receives the recorder's
//      stored result (cross-principal disclosure), and
//   2. a caller who IS the recording principal, but addresses a DIFFERENT
//      resource, receives the first resource's stored result under HTTP 200
//      (resource-confusion). The operation label cannot catch this: both calls
//      carry the same operation.
//
// Failure mode 2 was proved through the real HTTP boundary by the W3 gate:
// `PATCH /v2/spaces/{B}` replaying Space A's clientMutationId returned Space A's
// id and projection with status 200 and error null.
//
// A third, independent shape: `public.join_public_space` and
// `public.redeem_invite` SHARE the operation string 'spaces.invites.redeem', so
// a cmid recorded by one is replayable through the OTHER without ever tripping
// the operation-label mismatch check. That crossing gets its own test here
// rather than being covered by adjacency.
//
// `clientMutationId` is a correlation identifier, NOT a capability — the program
// explicitly declined a "cmids must be unguessable" law because the same dossier
// mandates `message_batch_id = clientMutationId` and `handoffId =
// clientMutationId` and publishes both in read DTOs. So no assertion below leans
// on a cmid being hard to guess; the two-part binding is the only belt.
//
// FIXTURE: the FULL official chain, built from `migrationFiles()` — never a
// hand-listed slice. `w2-identity-spaces.pg.test.ts` applies a 001-016 slice and
// is therefore an isolation proof that cannot observe the fix at all; this file
// is the full-chain proof. `w2-migration-order.pg.test.ts` remains the chain
// coverage citation.
// =============================================================================

import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

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


// The migrations whose behavior this file depends on, asserted present by name.
// 004 defines command_ledger (including the identity_id/actor_id columns the
// guard reads), 007 defines three of the four sites, 012 and 016 are the live
// ledger_record / ledger_replay definitions, 015 defines create_space, and 031
// is the fix.
const REQUIRED_MIGRATIONS = [
  '001_core_graph.sql',
  '002_identity.sql',
  '004_ledgers.sql',
  '006_execution_side.sql',
  '007_rpc_catalog.sql',
  '008_rls_policies.sql',
  '012_ledger_reserve_cmid.sql',
  '015_w1_foundations.sql',
  '016_w2_identity_spaces.sql',
  '031_w2_sec1_replay_principal_resource_binding.sql',
] as const;

// A floor, deliberately not an exact number: sibling groups are landing
// migrations concurrently, and an exact count would turn an unrelated sibling
// landing into a spurious red on this security suite. The "not a hand-listed
// slice" property that the exact count was meant to protect is asserted
// directly and more strongly instead — APPLIED_MIGRATIONS is compared for
// identity against migrationFiles(), so no migration can be silently omitted.
const MIGRATION_COUNT_FLOOR = 27;

const APPLIED_MIGRATIONS: readonly string[] = migrationFiles();

const ADMIN_IDENTITY = 'w2-sec1-admin';
const OUTSIDER_IDENTITY = 'w2-sec1-outsider';
const JOINER_IDENTITY = 'w2-sec1-joiner';
const REDEEMER_IDENTITY = 'w2-sec1-redeemer';
// A second, legitimate Space owner. Sites 5 and 6 are reachable by a caller who
// is a genuine owner/admin of their OWN Space: 029's guard is bound to the
// caller-supplied route argument, so naming your own Space passes it honestly
// while the replay still hands back somebody else's stored projection.
const RIVAL_ADMIN_IDENTITY = 'w2-sec1-rival-admin';

const REPLAY_PRINCIPAL_MESSAGE = 'clientMutationId belongs to another principal';

interface SpaceFixture {
  spaceId: string;
  memberId: string;
}

/** Outcome of an RPC call: either a value, or the PostgreSQL error it raised. */
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

/** Renders an outcome into a failure message, so a red run SHOWS the leak. */
function describeOutcome(outcome: Outcome<unknown>): string {
  return outcome.ok
    ? `RETURNED a value (no error raised): ${JSON.stringify(outcome.value)}`
    : `raised ${outcome.code}: ${outcome.message}`;
}

describe.sequential('W2.SEC-1 replay principal and resource binding', () => {
  let database: W1ScratchDatabase;

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
                set_config('tm8.request_id', 'w2-sec1-pg', true)`,
        [identityId, actorId],
      );
      return fn(client);
    });
  }

  async function appValue<T>(
    identityId: string,
    sql: string,
    params: readonly unknown[] = [],
    actorId = '',
  ): Promise<T> {
    return asApplication(
      identityId,
      async (client) => {
        const result = await client.query<{ value: T }>(sql, [...params]);
        return result.rows[0]!.value;
      },
      actorId,
    );
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

  async function seedAccounts(): Promise<void> {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      for (const identityId of [
        ADMIN_IDENTITY,
        OUTSIDER_IDENTITY,
        JOINER_IDENTITY,
        REDEEMER_IDENTITY,
        RIVAL_ADMIN_IDENTITY,
      ]) {
        await client.query(
          `insert into public.user_profiles(identity_id, display_name) values ($1, $2)`,
          [identityId, identityId],
        );
        await client.query(
          `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
           values ($1, $2, $3, $4, $4)`,
          [identityId, identityId, identityId, identityId === ADMIN_IDENTITY],
        );
      }
    });
  }

  async function createSpace(
    name: string,
    visibility: 'private' | 'public',
    mutationId: string,
    owner: string = ADMIN_IDENTITY,
  ): Promise<SpaceFixture> {
    const result = await appValue<{ space: { id: string }; memberId: string }>(
      owner,
      `select public.create_space($1, '', $2, null, $3) value`,
      [name, visibility, mutationId],
    );
    return { spaceId: result.space.id, memberId: result.memberId };
  }

  /** Read current revisions rather than assuming them, so test order cannot lie. */
  async function settingsRevision(spaceId: string): Promise<number> {
    const [row] = await ownerRows<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`,
      [spaceId],
    );
    return row!.settings_revision;
  }

  async function menuRevision(spaceId: string): Promise<number> {
    const [row] = await ownerRows<{ revision: number }>(
      `select revision from public.space_menu_configs where space_id = $1`,
      [spaceId],
    );
    return row!.revision;
  }

  /**
   * Seeds a work_session directly as the graph owner. execution_spawn needs a
   * team_member persona and a project link; this suite is testing the replay
   * guard on grant_stream_attach, not the spawn path, so the envelope is built
   * straight from internal.create_envelope with created_by set to the admin's
   * member id (which is what satisfies grant_stream_attach's share_mode check).
   */
  async function seedWorkSession(space: SpaceFixture, title: string): Promise<string> {
    const rows = await ownerRows<{ session_id: string }>(
      `select internal.create_envelope($1, 'work_session', $2, null, null) session_id`,
      [space.spaceId, space.memberId],
    );
    const sessionId = rows[0]!.session_id;
    await ownerRows(`insert into public.work_sessions(entity_id, title) values ($1, $2)`, [
      sessionId,
      title,
    ]);
    return sessionId;
  }

  let spaceA: SpaceFixture;
  let spaceB: SpaceFixture;
  let publicSpace: SpaceFixture;
  let rivalSpace: SpaceFixture;
  let sessionOne: string;
  let sessionTwo: string;
  let menuPayload: { schemaVersion: number; groups: unknown };

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_sec1');
    database.apply(APPLIED_MIGRATIONS);
    await seedAccounts();
    spaceA = await createSpace('SEC-1 Space A', 'private', 'sec1-seed-space-a');
    spaceB = await createSpace('SEC-1 Space B', 'private', 'sec1-seed-space-b');
    publicSpace = await createSpace('SEC-1 public Space', 'public', 'sec1-seed-space-public');
    rivalSpace = await createSpace(
      'SEC-1 rival Space',
      'private',
      'sec1-seed-space-rival',
      RIVAL_ADMIN_IDENTITY,
    );
    sessionOne = await seedWorkSession(spaceA, 'SEC-1 session one');
    sessionTwo = await seedWorkSession(spaceA, 'SEC-1 session two');
    // The one payload the system itself writes, so it is guaranteed to satisfy
    // internal.w2_normalize_menu_payload rather than encoding a guess here.
    const [row] = await ownerRows<{ payload: { groups: unknown } }>(
      `select internal.w1_default_menu_payload() payload`,
    );
    menuPayload = { schemaVersion: 1, groups: row!.payload.groups };
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  // ---------------------------------------------------------------------------
  // Fixture guard. Proves this suite runs the whole official chain.
  // ---------------------------------------------------------------------------
  it('applies the entire official migration chain in lexical order, not a slice', () => {
    expect(
      APPLIED_MIGRATIONS,
      'the fixture must be migrationFiles() itself, never a hand-listed subset',
    ).toEqual(migrationFiles());
    expect(APPLIED_MIGRATIONS).toEqual([...APPLIED_MIGRATIONS].sort());
    expect(new Set(APPLIED_MIGRATIONS.map((file) => file.slice(0, 3))).size).toBe(
      APPLIED_MIGRATIONS.length,
    );
    expect(
      APPLIED_MIGRATIONS.length,
      `expected at least ${MIGRATION_COUNT_FLOOR} migrations, applied: ${APPLIED_MIGRATIONS.join(', ')}`,
    ).toBeGreaterThanOrEqual(MIGRATION_COUNT_FLOOR);
    for (const required of REQUIRED_MIGRATIONS) {
      expect(APPLIED_MIGRATIONS, `missing required migration ${required}`).toContain(required);
    }
  });

  // ---------------------------------------------------------------------------
  // SITE 1 — public.w2_update_space / spaces.update (016:83-84).
  // ---------------------------------------------------------------------------
  describe('site 1: spaces.update', () => {
    it('refuses a replay from a principal that did not record the cmid', async () => {
      const cmid = 'sec1-site1-cross-principal';
      const recorded = await appValue<{ space: { id: string; name: string } }>(
        ADMIN_IDENTITY,
        `select public.w2_update_space($1, $2, $3) value`,
        [spaceA.spaceId, { name: 'SEC-1 A renamed by its admin' }, cmid],
      );
      expect(recorded.space.id).toBe(spaceA.spaceId);

      // The outsider is a member of NOTHING. It supplies only the cmid.
      const outcome = await attempt(() =>
        appValue(
          OUTSIDER_IDENTITY,
          `select public.w2_update_space($1, $2, $3) value`,
          [spaceA.spaceId, { name: 'SEC-1 A renamed by an outsider' }, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 1 cross-principal disclosure: a non-member replaying an admin's ` +
          `spaces.update cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
    });

    it('refuses a replay that addresses a different Space than the one recorded', async () => {
      // The exact scenario the W3 gate proved through HTTP: same principal, so
      // principal-pinning alone cannot catch it.
      const cmid = 'sec1-site1-space-crossing';
      const recorded = await appValue<{ space: { id: string } }>(
        ADMIN_IDENTITY,
        `select public.w2_update_space($1, $2, $3) value`,
        [spaceA.spaceId, { name: 'SEC-1 A renamed for the crossing test' }, cmid],
      );
      expect(recorded.space.id).toBe(spaceA.spaceId);

      const outcome = await attempt(() =>
        appValue<{ space: { id: string } }>(
          ADMIN_IDENTITY,
          `select public.w2_update_space($1, $2, $3) value`,
          [spaceB.spaceId, { name: 'SEC-1 B renamed' }, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 1 resource confusion: a request addressing Space B ` +
          `(${spaceB.spaceId}) replaying Space A's (${spaceA.spaceId}) cmid ` +
          `${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');

      // And the addressed Space was never actually renamed — today the caller is
      // told 200 while nothing happened to the resource it named.
      const [row] = await ownerRows<{ name: string }>(
        `select name from public.spaces where id = $1`,
        [spaceB.spaceId],
      );
      expect(row!.name).toBe('SEC-1 Space B');
    });

    it('still returns the identical stored result to the original recorder, with no second effect', async () => {
      const cmid = 'sec1-site1-idempotent';
      const first = await appValue<{ space: { id: string; name: string } }>(
        ADMIN_IDENTITY,
        `select public.w2_update_space($1, $2, $3) value`,
        [spaceA.spaceId, { name: 'SEC-1 A idempotency probe' }, cmid],
      );
      const [afterFirst] = await ownerRows<{ name: string; updated_at: string }>(
        `select name, updated_at from public.spaces where id = $1`,
        [spaceA.spaceId],
      );

      const replayed = await appValue<{ space: { id: string; name: string } }>(
        ADMIN_IDENTITY,
        `select public.w2_update_space($1, $2, $3) value`,
        [spaceA.spaceId, { name: 'SEC-1 A idempotency probe' }, cmid],
      );

      expect(replayed).toEqual(first);
      const [afterReplay] = await ownerRows<{ name: string; updated_at: string }>(
        `select name, updated_at from public.spaces where id = $1`,
        [spaceA.spaceId],
      );
      expect(afterReplay).toEqual(afterFirst);
      const [ledger] = await ownerRows<{ count: string }>(
        `select count(*) count from public.command_ledger where client_mutation_id = $1`,
        [cmid],
      );
      expect(ledger!.count).toBe('1');
    });

    // -------------------------------------------------------------------------
    // THE CONCURRENCY CASE. A sequential negative cannot cover this.
    //
    // internal.ledger_replay (016:17) takes pg_advisory_xact_lock at its OWN
    // line 10 and selects at line 12. A principal pre-check placed before that
    // call therefore runs with NO LOCK HELD, and against a victim's UNCOMMITTED
    // ledger row it reads "not found" and concludes "first use of this cmid:
    // nothing to pin". The attacker then blocks inside ledger_replay, the victim
    // commits, the attacker acquires the lock, re-selects, NOW sees the row, the
    // operation label matches — and the identity comparison never ran.
    //
    // The resource binding does not rescue this: it asserts only that the caller
    // ADDRESSED the same resource, and here the attacker deliberately names the
    // victim's Space. On the replay path require_space_admin is never reached.
    // So under the race the principal pin is the ONLY barrier, and it is the one
    // that gets skipped. The pin must therefore also run WHERE THE LOCK IS
    // ALREADY HELD — inside the replay branch, after ledger_replay returns.
    // -------------------------------------------------------------------------
    it('refuses a cross-principal replay raced against the victim\'s uncommitted ledger row', async () => {
      const cmid = 'sec1-site1-toctou-race';
      const victim = await database.pool.connect();
      const attacker = await database.pool.connect();
      try {
        // 1. Victim runs the command but does NOT commit. Its ledger row is
        //    written and it holds the advisory lock on the cmid.
        await victim.query('begin');
        await victim.query('set local role tm8_app');
        const victimPid = (await victim.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        )).rows[0]!.pid;
        await victim.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'w2-sec1-race-victim', true)`,
          [ADMIN_IDENTITY],
        );
        const victimResult = await victim.query<{ value: { space: { id: string } } }>(
          `select public.w2_update_space($1, $2, $3) value`,
          [spaceA.spaceId, { name: 'SEC-1 A renamed under the race' }, cmid],
        );
        expect(victimResult.rows[0]!.value.space.id).toBe(spaceA.spaceId);

        // 2. Attacker enters on the same cmid, naming the victim's Space so the
        //    resource binding cannot be what refuses it. This BLOCKS on the
        //    advisory lock, so it must not be awaited yet.
        await attacker.query('begin');
        await attacker.query('set local role tm8_app');
        const attackerPid = (await attacker.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        )).rows[0]!.pid;
        await attacker.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'w2-sec1-race-attacker', true)`,
          [OUTSIDER_IDENTITY],
        );
        const attackerCall = attacker
          .query<{ value: unknown }>(`select public.w2_update_space($1, $2, $3) value`, [
            spaceA.spaceId,
            { name: 'SEC-1 A renamed by the racing outsider' },
            cmid,
          ])
          .then((r) => ({ ok: true as const, value: r.rows[0]!.value }))
          .catch((error: { code?: string; message?: string }) => ({
            ok: false as const,
            code: error.code ?? '',
            message: error.message ?? String(error),
          }));

        // 3. Wait until the attacker is genuinely parked on the advisory lock,
        //    so this proves the race rather than a lucky interleaving.
        // Parked on THE VICTIM'S lock, both pids pinned and the key matched.
        await awaitParkedOnVictimAdvisoryLock(database, victimPid, attackerPid);

        // 4. Victim commits. The attacker now wakes and can see the row.
        await victim.query('commit');
        const outcome = await attackerCall;
        await attacker.query('rollback');

        expect(
          outcome.ok,
          `SEC-1 TOCTOU: a non-member racing the victim's uncommitted ledger row ` +
            `${describeOutcome(outcome)}`,
        ).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe('23514');
        expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
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

    it('keeps the frozen operation-label mismatch guard intact', async () => {
      const cmid = 'sec1-site1-operation-label';
      await appValue(
        ADMIN_IDENTITY,
        `select public.w2_update_space($1, $2, $3) value`,
        [spaceA.spaceId, { name: 'SEC-1 A operation label probe' }, cmid],
      );
      const outcome = await attempt(() =>
        appValue(ADMIN_IDENTITY, `select public.create_space($1, '', 'private', null, $2) value`, [
          'SEC-1 label crossing',
          cmid,
        ]),
      );
      expect(outcome.ok, describeOutcome(outcome)).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('already used for operation');
    });
  });

  // ---------------------------------------------------------------------------
  // SITE 2 — public.grant_stream_attach / execution.streams.attach (007:2195).
  // ---------------------------------------------------------------------------
  describe('site 2: execution.streams.attach', () => {
    it('refuses a replay from a principal that did not record the cmid', async () => {
      const cmid = 'sec1-site2-cross-principal';
      const recorded = await appValue<{ grant: { work_session_id: string; subject_identity: string } }>(
        ADMIN_IDENTITY,
        `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
        [sessionOne, cmid],
      );
      expect(recorded.grant.subject_identity).toBe(ADMIN_IDENTITY);

      const outcome = await attempt(() =>
        appValue(
          OUTSIDER_IDENTITY,
          `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
          [sessionOne, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 2 cross-principal disclosure: a non-member of the session's Space ` +
          `replaying the spawner's execution.streams.attach cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
    });

    it('refuses a replay that addresses a different work session', async () => {
      const cmid = 'sec1-site2-session-crossing';
      await appValue(
        ADMIN_IDENTITY,
        `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
        [sessionOne, cmid],
      );

      const outcome = await attempt(() =>
        appValue<{ grant: { work_session_id: string } }>(
          ADMIN_IDENTITY,
          `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
          [sessionTwo, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 2 resource confusion: a request addressing session ${sessionTwo} ` +
          `replaying session ${sessionOne}'s cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
    });

    it('refuses a replay that addresses a different stream mode', async () => {
      // mode is part of the grant's own uniqueness key, so a 'view' replay
      // answering a 'drive' request hands back a grant the caller did not ask
      // for while reporting success.
      const cmid = 'sec1-site2-mode-crossing';
      await appValue(
        ADMIN_IDENTITY,
        `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
        [sessionOne, cmid],
      );

      const outcome = await attempt(() =>
        appValue<{ grant: { mode: string } }>(
          ADMIN_IDENTITY,
          `select public.grant_stream_attach($1, 'drive', null, interval '15 minutes', $2) value`,
          [sessionOne, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 2 mode confusion: a 'drive' request replaying a 'view' cmid ` +
          `${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
    });

    // A second race, at a structurally different site. Sites differ in how much
    // they retain WITHOUT the principal pin:
    //   * site 5 has defence in depth — an attacker naming its OWN Space is
    //     caught by the resource binding, and one naming the VICTIM's Space is
    //     caught by w2_require_human_space_admin before the branch;
    //   * this site has NEITHER. There is no route-argument guard on the replay
    //     path, and the attacker can name the victim's exact session and mode so
    //     the resource binding matches. Under the race the principal pin is the
    //     sole barrier, on the execution surface, for a grant whose subject is
    //     the recorder. That makes this the site where the ordering matters most.
    it('refuses a cross-principal stream-grant replay raced against an uncommitted ledger row', async () => {
      const cmid = 'sec1-site2-toctou-race';
      const victim = await database.pool.connect();
      const attacker = await database.pool.connect();
      try {
        await victim.query('begin');
        await victim.query('set local role tm8_app');
        const victimPid = (await victim.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        )).rows[0]!.pid;
        await victim.query(
          `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'w2-sec1-race2-victim', true)`,
          [ADMIN_IDENTITY],
        );
        await victim.query(
          `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
          [sessionOne, cmid],
        );

        await attacker.query('begin');
        await attacker.query('set local role tm8_app');
        const attackerPid = (await attacker.query<{ pid: number }>(
          'select pg_backend_pid() pid',
        )).rows[0]!.pid;
        await attacker.query(
          `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'w2-sec1-race2-attacker', true)`,
          [OUTSIDER_IDENTITY],
        );
        // Same session AND same mode, so the resource binding cannot be what refuses it.
        const attackerCall = attacker
          .query<{ value: unknown }>(
            `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
            [sessionOne, cmid],
          )
          .then((r) => ({ ok: true as const, value: r.rows[0]!.value }))
          .catch((error: { code?: string; message?: string }) => ({
            ok: false as const,
            code: error.code ?? '',
            message: error.message ?? String(error),
          }));

        // Parked on THE VICTIM'S lock, both pids pinned and the key matched.
        await awaitParkedOnVictimAdvisoryLock(database, victimPid, attackerPid);

        await victim.query('commit');
        const outcome = await attackerCall;
        await attacker.query('rollback');

        expect(
          outcome.ok,
          `SEC-1 site 2 TOCTOU: a non-member racing the spawner's uncommitted grant ` +
            `${describeOutcome(outcome)}`,
        ).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe('23514');
        expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
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

    it('still returns the identical stored grant to the original recorder, with no second grant row', async () => {
      const cmid = 'sec1-site2-idempotent';
      const first = await appValue<{ grant: { id: string } }>(
        ADMIN_IDENTITY,
        `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
        [sessionTwo, cmid],
      );
      const replayed = await appValue<{ grant: { id: string } }>(
        ADMIN_IDENTITY,
        `select public.grant_stream_attach($1, 'view', null, interval '15 minutes', $2) value`,
        [sessionTwo, cmid],
      );
      expect(replayed).toEqual(first);
      const [grants] = await ownerRows<{ count: string }>(
        `select count(*) count from public.stream_grants
          where work_session_id = $1 and subject_identity = $2 and mode = 'view'`,
        [sessionTwo, ADMIN_IDENTITY],
      );
      expect(grants!.count).toBe('1');
    });
  });

  // ---------------------------------------------------------------------------
  // SITES 3 and 4 — join_public_space (007:569) and redeem_invite (007:657).
  //
  // These two RPCs share the operation string 'spaces.invites.redeem'. That is
  // its own failure mode, independent of principal: a cmid recorded by one is
  // replayable through the OTHER by the SAME principal, and the operation-label
  // guard cannot see it because the labels match exactly.
  // ---------------------------------------------------------------------------
  describe('sites 3 and 4: spaces.invites.redeem', () => {
    async function createInvite(space: SpaceFixture, mutationId: string): Promise<string> {
      const result = await appValue<{ invite: { code: string } }>(
        ADMIN_IDENTITY,
        `select public.create_invite($1, 5, null, null, $2) value`,
        [space.spaceId, mutationId],
      );
      return result.invite.code;
    }

    it('refuses a join_public_space cmid replayed through redeem_invite (shared operation string)', async () => {
      const cmid = 'sec1-shared-operation-join-then-redeem';
      const joined = await appValue<{ spaceId: string; memberId: string; joined: boolean }>(
        JOINER_IDENTITY,
        `select public.join_public_space($1, $2) value`,
        [publicSpace.spaceId, cmid],
      );
      expect(joined.spaceId).toBe(publicSpace.spaceId);
      expect(joined.joined).toBe(true);

      const code = await createInvite(spaceB, 'sec1-invite-for-join-then-redeem');
      const outcome = await attempt(() =>
        appValue<{ spaceId: string }>(JOINER_IDENTITY, `select public.redeem_invite($1, $2) value`, [
          code,
          cmid,
        ]),
      );

      expect(
        outcome.ok,
        `SEC-1 shared-operation-string crossing: redeem_invite for a Space B code ` +
          `replaying a join_public_space cmid recorded against ${publicSpace.spaceId} ` +
          `${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');

      // The crossing is silent today: the caller is told it succeeded while the
      // invite is never consumed and no membership is created.
      const [membership] = await ownerRows<{ count: string }>(
        `select count(*) count from public.members where space_id = $1 and identity_id = $2`,
        [spaceB.spaceId, JOINER_IDENTITY],
      );
      expect(membership!.count).toBe('0');
      const [invite] = await ownerRows<{ use_count: number }>(
        `select use_count from public.space_invites where code = $1`,
        [code],
      );
      expect(invite!.use_count).toBe(0);
    });

    it('refuses a redeem_invite cmid replayed through join_public_space (reverse crossing)', async () => {
      const cmid = 'sec1-shared-operation-redeem-then-join';
      const code = await createInvite(spaceB, 'sec1-invite-for-redeem-then-join');
      const redeemed = await appValue<{ spaceId: string; joined: boolean }>(
        REDEEMER_IDENTITY,
        `select public.redeem_invite($1, $2) value`,
        [code, cmid],
      );
      expect(redeemed.spaceId).toBe(spaceB.spaceId);
      expect(redeemed.joined).toBe(true);

      const outcome = await attempt(() =>
        appValue<{ spaceId: string }>(
          REDEEMER_IDENTITY,
          `select public.join_public_space($1, $2) value`,
          [publicSpace.spaceId, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 reverse crossing: join_public_space for ${publicSpace.spaceId} replaying a ` +
          `redeem_invite cmid recorded against ${spaceB.spaceId} ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');

      const [membership] = await ownerRows<{ count: string }>(
        `select count(*) count from public.members where space_id = $1 and identity_id = $2`,
        [publicSpace.spaceId, REDEEMER_IDENTITY],
      );
      expect(membership!.count).toBe('0');
    });

    it('refuses a join_public_space replay from a principal that did not record the cmid', async () => {
      const cmid = 'sec1-site3-cross-principal';
      await appValue(OUTSIDER_IDENTITY, `select public.join_public_space($1, $2) value`, [
        publicSpace.spaceId,
        cmid,
      ]);

      const outcome = await attempt(() =>
        appValue<{ memberId: string }>(
          REDEEMER_IDENTITY,
          `select public.join_public_space($1, $2) value`,
          [publicSpace.spaceId, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 3 cross-principal disclosure: another identity replaying the joiner's ` +
          `cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
    });

    it('refuses a redeem_invite replay from a principal that did not record the cmid', async () => {
      const cmid = 'sec1-site4-cross-principal';
      const code = await createInvite(spaceA, 'sec1-invite-for-cross-principal');
      await appValue(JOINER_IDENTITY, `select public.redeem_invite($1, $2) value`, [code, cmid]);

      const outcome = await attempt(() =>
        appValue<{ memberId: string }>(OUTSIDER_IDENTITY, `select public.redeem_invite($1, $2) value`, [
          code,
          cmid,
        ]),
      );

      expect(
        outcome.ok,
        `SEC-1 site 4 cross-principal disclosure: another identity replaying the redeemer's ` +
          `cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
    });

    it('still returns the identical stored result to the original recorder, with no duplicate membership', async () => {
      const cmid = 'sec1-site3-idempotent';
      const first = await appValue<{ spaceId: string; memberId: string; joined: boolean }>(
        JOINER_IDENTITY,
        `select public.join_public_space($1, $2) value`,
        [publicSpace.spaceId, cmid],
      );
      const replayed = await appValue<{ spaceId: string; memberId: string; joined: boolean }>(
        JOINER_IDENTITY,
        `select public.join_public_space($1, $2) value`,
        [publicSpace.spaceId, cmid],
      );
      expect(replayed).toEqual(first);
      const [membership] = await ownerRows<{ count: string }>(
        `select count(*) count from public.members where space_id = $1 and identity_id = $2`,
        [publicSpace.spaceId, JOINER_IDENTITY],
      );
      expect(membership!.count).toBe('1');
    });

    it('preserves a redeem_invite replay after the invite is later revoked', async () => {
      // The resource binding for redeem_invite resolves p_code to a Space. That
      // lookup must NOT raise when the invite has since been revoked, or a
      // legitimate retry would start failing after revocation.
      const cmid = 'sec1-site4-replay-after-revoke';
      const code = await createInvite(spaceA, 'sec1-invite-for-revoke-replay');
      const first = await appValue<{ spaceId: string; memberId: string }>(
        REDEEMER_IDENTITY,
        `select public.redeem_invite($1, $2) value`,
        [code, cmid],
      );
      await ownerRows(`update public.space_invites set revoked_at = now() where code = $1`, [code]);

      const replayed = await appValue<{ spaceId: string; memberId: string }>(
        REDEEMER_IDENTITY,
        `select public.redeem_invite($1, $2) value`,
        [code, cmid],
      );
      expect(replayed).toEqual(first);
    });
  });

  // ---------------------------------------------------------------------------
  // SITES 5 and 6 — 029's Space-settings commands.
  //
  // These two were originally scored SAFE because their authorization guard sits
  // BEFORE the replay return. Ordering was never the test: what the guard is
  // BOUND TO is the test. internal.w2_require_human_space_admin(p_space_id)
  // checks the caller's role in the Space named by the ROUTE ARGUMENT and never
  // consults the ledger row, so a genuine owner/admin of their own Space passes
  // it honestly and still receives another principal's stored projection.
  // ---------------------------------------------------------------------------
  describe('site 5: spaces.defaultChannel.set', () => {
    it('refuses a replay to a rival admin who legitimately passes the route-argument guard', async () => {
      const cmid = 'sec1-site5-cross-principal';
      const recorded = await appValue<{ space: { id: string } }>(
        ADMIN_IDENTITY,
        `select public.set_space_default_channel($1, null, $2, $3) value`,
        [spaceA.spaceId, await settingsRevision(spaceA.spaceId), cmid],
      );
      expect(recorded.space.id).toBe(spaceA.spaceId);

      // The rival is a real owner/admin — of its OWN Space. It names that Space,
      // so 029's guard is satisfied on its own terms.
      const rivalRevision = await settingsRevision(rivalSpace.spaceId);
      const outcome = await attempt(() =>
        appValue<{ space: { id: string } }>(
          RIVAL_ADMIN_IDENTITY,
          `select public.set_space_default_channel($1, null, $2, $3) value`,
          [rivalSpace.spaceId, rivalRevision, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 5 cross-principal disclosure: an admin of an unrelated Space ` +
          `replaying Space A's cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
    });

    it('refuses a replay that addresses a different Space, same principal', async () => {
      const cmid = 'sec1-site5-space-crossing';
      await appValue(
        ADMIN_IDENTITY,
        `select public.set_space_default_channel($1, null, $2, $3) value`,
        [spaceA.spaceId, await settingsRevision(spaceA.spaceId), cmid],
      );

      const bRevision = await settingsRevision(spaceB.spaceId);
      const outcome = await attempt(() =>
        appValue<{ space: { id: string } }>(
          ADMIN_IDENTITY,
          `select public.set_space_default_channel($1, null, $2, $3) value`,
          [spaceB.spaceId, bRevision, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 5 resource confusion: a request addressing Space B replaying ` +
          `Space A's cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
    });

    it('still returns the identical stored settings view to the original recorder', async () => {
      const cmid = 'sec1-site5-idempotent';
      const revision = await settingsRevision(spaceA.spaceId);
      const first = await appValue<{ space: { id: string } }>(
        ADMIN_IDENTITY,
        `select public.set_space_default_channel($1, null, $2, $3) value`,
        [spaceA.spaceId, revision, cmid],
      );
      const afterFirst = await settingsRevision(spaceA.spaceId);

      const replayed = await appValue<{ space: { id: string } }>(
        ADMIN_IDENTITY,
        `select public.set_space_default_channel($1, null, $2, $3) value`,
        [spaceA.spaceId, revision, cmid],
      );
      expect(replayed).toEqual(first);
      expect(await settingsRevision(spaceA.spaceId)).toBe(afterFirst);
    });
  });

  describe('site 6: spaces.menu.update', () => {
    it('refuses a replay to a rival admin who legitimately passes the route-argument guard', async () => {
      const cmid = 'sec1-site6-cross-principal';
      await appValue(
        ADMIN_IDENTITY,
        `select public.update_space_menu($1, $2, $3, $4) value`,
        [spaceA.spaceId, menuPayload, await menuRevision(spaceA.spaceId), cmid],
      );

      const rivalMenuRevision = await menuRevision(rivalSpace.spaceId);
      const outcome = await attempt(() =>
        appValue<{ menu: unknown }>(
          RIVAL_ADMIN_IDENTITY,
          `select public.update_space_menu($1, $2, $3, $4) value`,
          [rivalSpace.spaceId, menuPayload, rivalMenuRevision, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 6 cross-principal disclosure: an admin of an unrelated Space ` +
          `replaying Space A's menu cmid ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(REPLAY_PRINCIPAL_MESSAGE);
    });

    it('refuses a same-principal crossing whose menu revision does not match the request', async () => {
      // update_space_menu's stored projection carries no Space identity, so the
      // binding available here is the revision the command declares. Both write
      // branches leave the menu at p_expected_revision + 1, so a replay whose
      // stored revision disagrees with this request's expectation is refused.
      const cmid = 'sec1-site6-revision-binding';
      // Move Space A's menu ahead of Space B's so the two disagree.
      await appValue(ADMIN_IDENTITY, `select public.update_space_menu($1, $2, $3, $4) value`, [
        spaceA.spaceId,
        menuPayload,
        await menuRevision(spaceA.spaceId),
        'sec1-site6-advance-a',
      ]);
      const storedRevision = (await menuRevision(spaceA.spaceId)) + 1;
      await appValue(ADMIN_IDENTITY, `select public.update_space_menu($1, $2, $3, $4) value`, [
        spaceA.spaceId,
        menuPayload,
        await menuRevision(spaceA.spaceId),
        cmid,
      ]);
      const bRevision = await menuRevision(spaceB.spaceId);
      expect(bRevision + 1).not.toBe(storedRevision);

      const outcome = await attempt(() =>
        appValue<{ menu: unknown }>(
          ADMIN_IDENTITY,
          `select public.update_space_menu($1, $2, $3, $4) value`,
          [spaceB.spaceId, menuPayload, bRevision, cmid],
        ),
      );

      expect(
        outcome.ok,
        `SEC-1 site 6 resource confusion: a request addressing Space B at revision ` +
          `${bRevision} replaying a Space A menu stored at revision ${storedRevision} ` +
          `${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
    });

    it('still returns the identical stored menu to the original recorder, with no second bump', async () => {
      const cmid = 'sec1-site6-idempotent';
      const revision = await menuRevision(spaceA.spaceId);
      const first = await appValue<{ menu: { revision: number } }>(
        ADMIN_IDENTITY,
        `select public.update_space_menu($1, $2, $3, $4) value`,
        [spaceA.spaceId, menuPayload, revision, cmid],
      );
      const afterFirst = await menuRevision(spaceA.spaceId);

      const replayed = await appValue<{ menu: { revision: number } }>(
        ADMIN_IDENTITY,
        `select public.update_space_menu($1, $2, $3, $4) value`,
        [spaceA.spaceId, menuPayload, revision, cmid],
      );
      // The replay returns the stored ledger_result verbatim; the first call
      // additionally carries eventEffect, which 029 documents as non-replayable.
      expect(replayed.menu).toEqual(first.menu);
      expect(await menuRevision(spaceA.spaceId)).toBe(afterFirst);
    });
  });
});
