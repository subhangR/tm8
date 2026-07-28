// =============================================================================
// W2.SEC-1 STAGE 2 (migration 036) — the replay RESOURCE binding at the
//                                    entities.create LABEL, and the two repairs.
//
// THE RULE THIS FILE EXISTS TO ENFORCE, AND IT IS THE WHOLE POINT:
//
//   internal.ledger_replay keys on (cmid, operation_label) and CANNOT TELL
//   CALLERS APART. 'entities.create' has ELEVEN live doors, all granted to
//   tm8_app. A guard at one door does nothing at the other ten.
//
//   So a green that only exercised create_task would prove exactly what the fix
//   must not be allowed to prove. EVERY NEGATIVE BELOW IS DRIVEN THROUGH EVERY
//   DOOR — eleven same-door negatives AND eleven cross-door negatives, where the
//   row is recorded through one door and the replay is attempted through the
//   next. If any single door were left unbound, one of the twenty-two goes red.
//
// SAME-PRINCIPAL IS THE POINT. Phase-1 runs a single loopback identity, so the
// measured defect is same-principal: the caller names Space B, replays a cmid
// recorded against Space A, and receives Space A's entity under a 201. Every
// negative here therefore runs as the SAME identity that recorded the cmid. A
// suite that only exercised cross-principal replay would go green against a
// build that fixes nothing, because 033 already closed that half globally.
//
// BOTH HALVES ON EVERY DOOR. Each door's negative is paired with the positive it
// must be able to distinguish: same principal, same cmid, SAME Space still
// returns the stored entity. That is what separates a resource binding from a
// guard that refuses everyone — and refusing everyone would pass every negative
// in this file.
//
// FIXTURE: the full official chain from migrationFiles(), plus the 036 candidate
// applied from an absolute path outside the repository. SEC1_036_CANDIDATE=none
// runs against the landed chain to capture the red. Once 036 lands,
// migrationFiles() carries it and the candidate application is skipped.
// =============================================================================

import { readFileSync } from 'node:fs';

import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

const CANDIDATE_ENV = process.env['SEC1_036_CANDIDATE'];
const CANDIDATE_PATH =
  CANDIDATE_ENV ??
  '/private/tmp/claude-503/-Users-subhang-Desktop-Projects-tm8/16c40cc0-0cae-4681-8ecc-1b4425f7c889/scratchpad/sec1-036/036_w2_sec1_stage2_entities_create_resource_binding.sql';
const CANDIDATE_IS_LANDED = migrationFiles().some((file) => file.startsWith('036_'));

const OWNER = 'w2-sec1-036-owner';
const SUBJECT_MESSAGE = 'belongs to another space';

/**
 * All ELEVEN doors onto the 'entities.create' ledger label, measured from
 * pg_catalog rather than assumed. Each takes p_space_id plus one required name,
 * so a named-argument call reaches every one of them without reproducing eleven
 * different positional signatures.
 */
// Each door's REQUIRED arguments, taken from its live signature. Four of the
// eleven reject the generic case and the fixture must satisfy them, or the
// POSITIVE half cannot be established and the negative proves nothing:
//   create_channel   — public.channels.name is checked ^[a-z0-9][a-z0-9_-]{0,79}$
//                      (001:503), so every name here is a lowercase slug.
//   create_pull_request_entity — rejects unless p_url, p_repo and p_number >= 1.
//   create_commit_entity       — rejects unless p_repo and p_sha are present.
//   create_custom_entity       — the kind must be `c:*` AND registered in the
//                      Space (001:368); beforeAll registers c:note in both.
// These validations all run AFTER the replay check, so they do not weaken the
// negatives — but the positives would be unobtainable without them, and a
// negative with no positive beside it is exactly what this file refuses to ship.
const DOORS = [
  { fn: 'create_task', extra: 'p_title => $2' },
  { fn: 'create_document', extra: 'p_title => $2' },
  { fn: 'create_channel', extra: 'p_name => $2' },
  { fn: 'create_collection', extra: 'p_name => $2' },
  { fn: 'create_team_member', extra: 'p_name => $2' },
  { fn: 'create_file_entity', extra: 'p_title => $2' },
  { fn: 'create_spell_entity', extra: 'p_title => $2' },
  { fn: 'create_skill_entity', extra: 'p_title => $2' },
  {
    fn: 'create_pull_request_entity',
    // repo derived from the per-test subject name: public.pull_requests is unique
    // on (space, repo, number), so a constant would collide between the same-door
    // and cross-door tests and mask the binding under a 23505.
    extra: "p_title => $2, p_url => 'https://example.invalid/pr/1', p_repo => $2, p_number => 1",
  },
  // same reason: public.commits is unique on (space, repo, sha).
  { fn: 'create_commit_entity', extra: 'p_title => $2, p_repo => $2, p_sha => $2' },
  { fn: 'create_custom_entity', extra: "p_kind => 'c:note', p_title => $2" },
] as const;

/** Slug-safe and unique per (test, door): satisfies the channel name check. */
function subjectName(kind: string, door: string): string {
  return `036-${kind}-${door.replace(/_/g, '-')}`;
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

function describeOutcome(outcome: Outcome<unknown>): string {
  return outcome.ok
    ? `RETURNED a value (no error raised): ${JSON.stringify(outcome.value).slice(0, 400)}`
    : `raised ${outcome.code}: ${outcome.message}`;
}

interface EntityResult {
  readonly entity: { readonly id: string; readonly space_id: string };
}

describe.sequential('W2.SEC-1 036 entities.create resource binding', () => {
  let database: W1ScratchDatabase;
  let spaceA: string;
  let spaceB: string;

  async function asApp<T>(fn: (client: PoolClient) => Promise<T>, nodeAdmin = false): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', $2, true),
                set_config('tm8.request_id', 'w2-sec1-036', true)`,
        [OWNER, nodeAdmin ? 'true' : 'false'],
      );
      return fn(client);
    });
  }

  async function appValue<T>(sql: string, params: readonly unknown[] = [], nodeAdmin = false): Promise<T> {
    return asApp(async (client) => {
      const result = await client.query<{ value: T }>(sql, [...params]);
      return result.rows[0]!.value;
    }, nodeAdmin);
  }

  async function ownerRows<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const result = await client.query<R>(sql, [...params]);
      return result.rows;
    });
  }

  /** A named-argument call through one specific door. */
  function doorSql(door: (typeof DOORS)[number]): string {
    return `select public.${door.fn}(p_space_id => $1, ${door.extra}, p_client_mutation_id => $3) value`;
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_sec1_036');
    database.apply(migrationFiles());
    if (!CANDIDATE_IS_LANDED && CANDIDATE_ENV !== 'none') {
      await database.query(readFileSync(CANDIDATE_PATH, 'utf8'));
    }

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.user_profiles(identity_id, display_name) values ($1, $1)`,
        [OWNER],
      );
      await client.query(
        `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
         values ($1, $1, $1, false, true)`,
        [OWNER],
      );
    });

    const a = await appValue<{ space: { id: string } }>(
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['036 space A', '036-space-a'],
    );
    const b = await appValue<{ space: { id: string } }>(
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['036 space B', '036-space-b'],
    );
    spaceA = a.space.id;
    spaceB = b.space.id;

    // create_custom_entity requires a `c:*` kind REGISTERED in the Space it is
    // called against (001:368). Registered in BOTH, so the cross-Space negative
    // is refused by the resource binding and not incidentally by a missing kind.
    await ownerRows(
      `insert into public.entity_kinds(kind, origin, space_id) values ('c:note','custom',$1),('c:note','custom',$2)`,
      [spaceA, spaceB],
    );
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  describe('controls', () => {
    it('binds a non-null identity and two genuinely distinct Spaces', async () => {
      const bound = await asApp(async (client) => {
        const r = await client.query<{ bound: string | null }>(`select internal.identity_id() bound`);
        return r.rows[0]!.bound;
      });
      expect(bound, 'harness bound no identity — every negative would be vacuous').toBe(OWNER);
      expect(spaceA).toBeTruthy();
      expect(spaceB).toBeTruthy();
      expect(spaceA, 'the two Spaces are the same — every subject negative is vacuous').not.toBe(
        spaceB,
      );
    });

    it('all ELEVEN entities.create doors exist and are granted to tm8_app', async () => {
      const rows = await ownerRows<{ proname: string; granted: boolean }>(
        `select p.proname, has_function_privilege('tm8_app', p.oid, 'EXECUTE') granted
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1::text[]) order by 1`,
        [DOORS.map((d) => d.fn)],
      );
      expect(rows.length, 'a door named in this suite does not exist on the chain').toBe(
        DOORS.length,
      );
      expect(
        rows.filter((r) => !r.granted).map((r) => r.proname),
        'a door is not granted — the door list is stale',
      ).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // 1. EVERY DOOR, SAME DOOR. Record in Space A, replay addressing Space B.
  // ---------------------------------------------------------------------------
  describe('same-door replay addressing a different Space', () => {
    for (const [index, door] of DOORS.entries()) {
      it(`${door.fn}: positive in Space A, refused when addressed at Space B`, async () => {
        const cmid = `036-same-${door.fn}`;
        const name = subjectName('same', door.fn);
        const first = await appValue<EntityResult>(doorSql(door), [spaceA, name, cmid]);
        expect(first.entity.id, `${door.fn} did not create anything`).toBeTruthy();
        expect(first.entity.space_id, 'the entity was not created in Space A').toBe(spaceA);

        // POSITIVE — same principal, same cmid, SAME Space still replays.
        const replay = await appValue<EntityResult>(doorSql(door), [spaceA, name, cmid]);
        expect(replay.entity.id, `${door.fn}: idempotency was traded away, not preserved`).toBe(
          first.entity.id,
        );

        // NEGATIVE — same principal, DIFFERENT Space.
        const outcome = await attempt(() =>
          appValue<EntityResult>(doorSql(door), [spaceB, name, cmid]),
        );
        expect(
          outcome.ok,
          `SEC-1 STAGE 2 [door ${index + 1}/11 ${door.fn}]: a same-principal replay addressing ` +
            `another Space ${describeOutcome(outcome)}`,
        ).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe('23514');
        expect(outcome.message).toContain(SUBJECT_MESSAGE);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. EVERY DOOR, CROSS-DOOR. Record through one door, replay through the NEXT.
  //
  // This is the half that a per-function fix cannot pass. All eleven share the
  // 'entities.create' label, so ledger_replay resolves the row regardless of
  // which door asks — and only a binding present at the REPLAYING door refuses.
  // ---------------------------------------------------------------------------
  describe('cross-door replay: recorded at one door, replayed at another', () => {
    for (const [index, recorder] of DOORS.entries()) {
      const replayer = DOORS[(index + 1) % DOORS.length]!;
      it(`recorded via ${recorder.fn}, refused when replayed via ${replayer.fn}`, async () => {
        const cmid = `036-cross-${recorder.fn}`;
        const first = await appValue<EntityResult>(doorSql(recorder), [
          spaceA,
          subjectName('cross', recorder.fn),
          cmid,
        ]);
        expect(first.entity.id).toBeTruthy();

        const outcome = await attempt(() =>
          appValue<EntityResult>(doorSql(replayer), [spaceB, subjectName('ride', replayer.fn), cmid]),
        );
        expect(
          outcome.ok,
          `SEC-1 STAGE 2 CROSS-DOOR: a row recorded via ${recorder.fn} was served through ` +
            `${replayer.fn} — ${describeOutcome(outcome)}`,
        ).toBe(false);
        if (outcome.ok) return;
        expect(outcome.code).toBe('23514');
        expect(outcome.message).toContain(SUBJECT_MESSAGE);
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 3. THE TWO REPAIRS. These are not new sites — they are doors that make a
  //    binding we ALREADY SHIPPED walkable around. The negative therefore records
  //    through the BOUND sibling and replays through the door that was left open,
  //    which is the actual bypass rather than a re-test of the bound door.
  // ---------------------------------------------------------------------------
  describe('repairs: a shipped binding that was bypassable through its sibling', () => {
    it('spaces.update — recorded via the BOUND w2_update_space, refused via update_space', async () => {
      const cmid = '036-repair-spaces-update';
      const first = await appValue<{ space: { id: string } }>(
        `select public.w2_update_space($1, $2, $3) value`,
        [spaceA, JSON.stringify({ name: 'A renamed' }), cmid],
      );
      expect(first.space.id, 'the bound sibling did not record').toBe(spaceA);

      const outcome = await attempt(() =>
        appValue(`select public.update_space($1, $2, null, null, null, $3) value`, [
          spaceB,
          'B renamed',
          cmid,
        ]),
      );
      expect(
        outcome.ok,
        `031's spaces.update binding is still bypassable via update_space: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain(SUBJECT_MESSAGE);
    });

    it('projects.update — recorded via the BOUND update_project_w2, refused via update_project', async () => {
      const projects = await ownerRows<{ id: string }>(
        `insert into public.projects(name, working_dir, trust)
         values ('036 project A', '/tmp/a', 'trusted'), ('036 project B', '/tmp/b', 'trusted')
         returning id`,
      );
      const [projectA, projectB] = [projects[0]!.id, projects[1]!.id];
      const cmid = '036-repair-projects-update';

      const first = await appValue<{ project: { id: string } }>(
        `select public.update_project_w2($1, $2, $3) value`,
        [projectA, JSON.stringify({ name: 'A renamed' }), cmid],
        true,
      );
      expect(first.project.id, 'the bound sibling did not record').toBe(projectA);

      const outcome = await attempt(() =>
        appValue(
          `select public.update_project($1, $2, null, null, null, null, $3) value`,
          [projectB, 'B renamed', cmid],
          true,
        ),
      );
      expect(
        outcome.ok,
        `032's projects.update binding is still bypassable via update_project: ${describeOutcome(outcome)}`,
      ).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe('23514');
      expect(outcome.message).toContain('belongs to another project');
    });
  });
});
