/**
 * W5 Duo A — `038`'s eleven `entities.patch` doors ADMIT a legitimate replay.
 *
 * ## The gap this closes, and who named it
 *
 * `038` bound eleven doors with `internal.require_replay_subject`. Its author
 * drove the NEGATIVE at three doors (same-door, cross-door, and the odd
 * `p_task_id` door) and the POSITIVE at **one**, and then flagged the asymmetry
 * against its own work:
 *
 * > *"a projection-shape mismatch at an undriven door fails CLOSED, so the
 * > failure I could NOT have caught is a door OVER-REFUSING a legitimate
 * > replay."*
 *
 * That is the reassuring direction, and it is invisible: an over-refusing door
 * raises `invariant_violation` on a caller's honest retry, which reads exactly
 * like the guard working. **A guard that refuses everyone passes every negative
 * ever written.** `036`'s acceptance criterion made the same point in the other
 * direction and asserted its positive control *ahead* of its negative; this file
 * is that control, extended from one door to all eleven.
 *
 * ## What is asserted, and why the version check is the load-bearing half
 *
 * For each door: create a real entity of the matching kind, PATCH it under a
 * fresh `clientMutationId`, then call the **same door with the same cmid again**.
 * The replay must RETURN the stored projection and must not raise.
 *
 * The row-identity assertion alone would be weak — a door that simply re-executed
 * the update would also return the same id. So the test pins the **version**:
 *
 * - the first patch is made with `p_expected_version => 1`, which bumps the
 *   entity to version 2;
 * - the replay is made with `p_expected_version => 1` **again**, which a
 *   re-execution could not satisfy — the optimistic lock would reject it;
 * - and the version after the replay must be **unchanged**.
 *
 * So a pass here means the replay was served from the ledger, not re-applied.
 * **State what the check can be satisfied by:** it is satisfied only by a door
 * that recognises the cmid, matches the stored subject against the addressed
 * one, and returns the projection. It is NOT satisfied by an idempotent re-run.
 *
 * ## Scope, stated narrowly
 *
 * This is the SQL layer as `tm8_app`, same-principal and same-Space. It is **not**
 * the public HTTP boundary, and it does not re-measure `038`'s negatives — those
 * are its author's, driven at three doors, and are not restated here.
 */
import { type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from '../../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const OWNER = 'w5a-patch-owner';

/**
 * The eleven doors, paired with the create door that produces a subject of the
 * matching kind. FROZEN EXACT LITERALS: a twelfth door or a rename makes this
 * stale, and a stale exact-literal list is a detector working.
 *
 * The create-side quirks are `036`'s findings, restated here only as the minimum
 * needed to obtain a subject — a positive control that cannot construct its own
 * subject is not a control:
 *   channel  — `public.channels.name` is checked `^[a-z0-9][a-z0-9_-]{0,79}$`
 *   pull_request — rejected unless url, repo and number >= 1
 *   commit   — rejected unless repo and sha
 *   custom   — kind must be `c:*` AND registered in the Space
 */
const DOORS = [
  { patch: 'update_channel', create: 'create_channel', mk: "p_name => $2", idArg: 'p_entity_id', set: "p_name => $2" },
  { patch: 'update_collection', create: 'create_collection', mk: "p_name => $2", idArg: 'p_entity_id', set: "p_name => $2" },
  { patch: 'update_document', create: 'create_document', mk: "p_title => $2", idArg: 'p_entity_id', set: "p_title => $2" },
  { patch: 'update_task_content', create: 'create_task', mk: "p_title => $2", idArg: 'p_task_id', set: "p_title => $2" },
  { patch: 'update_team_member', create: 'create_team_member', mk: "p_name => $2", idArg: 'p_entity_id', set: "p_name => $2" },
  { patch: 'update_file_entity', create: 'create_file_entity', mk: "p_title => $2", idArg: 'p_entity_id', set: "p_title => $2" },
  { patch: 'update_spell_entity', create: 'create_spell_entity', mk: "p_title => $2", idArg: 'p_entity_id', set: "p_title => $2" },
  { patch: 'update_skill_entity', create: 'create_skill_entity', mk: "p_title => $2", idArg: 'p_entity_id', set: "p_title => $2" },
  {
    patch: 'update_pull_request_entity',
    create: 'create_pull_request_entity',
    mk: "p_title => $2, p_url => 'https://example.invalid/pr/1', p_repo => $2, p_number => 1",
    idArg: 'p_entity_id',
    set: "p_title => $2",
  },
  { patch: 'update_commit_entity', create: 'create_commit_entity', mk: 'p_title => $2, p_repo => $2, p_sha => $2', idArg: 'p_entity_id', set: "p_title => $2" },
  { patch: 'update_custom_entity', create: 'create_custom_entity', mk: "p_kind => 'c:note', p_title => $2", idArg: 'p_entity_id', set: "p_title => $2" },
] as const;

/** Slug-safe and unique per door: satisfies the channel name check. */
function subjectName(door: string, suffix: string): string {
  return `w5a-${door.replace(/_/g, '-')}-${suffix}`;
}

describe.sequential('W5 Duo A — 038: every entities.patch door ADMITS a legitimate replay', () => {
  let database: W1ScratchDatabase;
  let spaceA: string;

  async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'w5a-patch-positive', true)`,
        [OWNER],
      );
      return fn(client);
    });
  }

  async function appValue<T>(sql: string, params: readonly unknown[] = []): Promise<T> {
    return asApp(async (client) => {
      const r = await client.query<{ value: T }>(sql, [...params]);
      return r.rows[0]!.value;
    });
  }

  async function ownerRows<R extends QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const r = await client.query<R>(sql, [...params]);
      return r.rows;
    });
  }

  const versionOf = async (entityId: string): Promise<number> =>
    Number(
      (await ownerRows<{ version: string }>(
        `select version::text from public.entities where id = $1`,
        [entityId],
      ))[0]!.version,
    );

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5a_patch_positive');
    // Chain DERIVED from migrationFiles(), never a hand-listed slice.
    database.apply(migrationFiles());

    await ownerRows(
      `insert into public.user_profiles(identity_id, display_name) values ($1, $1)`,
      [OWNER],
    );
    await ownerRows(
      `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
       values ($1, $1, $1, false, true)`,
      [OWNER],
    );

    const a = await appValue<{ space: { id: string } }>(
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['w5a patch space', 'w5a-patch-space'],
    );
    spaceA = a.space.id;

    await ownerRows(
      `insert into public.entity_kinds(kind, origin, space_id) values ('c:note','custom',$1)`,
      [spaceA],
    );
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  it('CONTROL: the harness binds a real identity and a real Space', async () => {
    // Without this, every "the replay was admitted" below could be an artefact of
    // an unbound principal taking some other path entirely.
    const bound = await asApp(async (client) =>
      (await client.query<{ bound: string | null }>(`select internal.identity_id() bound`)).rows[0]!.bound,
    );
    expect(bound, 'harness bound no identity — every result here would be vacuous').toBe(OWNER);
    expect(spaceA).toBeTruthy();
    expect(DOORS).toHaveLength(11);
    expect(new Set(DOORS.map((d) => d.patch)).size).toBe(11);
  });

  it('CONTROL: the optimistic lock is REAL, so an admitted stale-version replay can only be the ledger path', async () => {
    // The whole file rests on this. Every per-door assertion below replays at
    // `p_expected_version => 1` AFTER the version has moved to 2, and concludes
    // that success there means the ledger served it. THAT INFERENCE IS ONLY VALID
    // IF A NON-REPLAY CALL AT THE SAME STALE VERSION IS ACTUALLY REFUSED.
    // Measured here rather than assumed, on a subject of its own.
    const doc = await appValue<{ entity: { id: string } }>(
      `select public.create_document(p_space_id => $1, p_title => $2,
              p_client_mutation_id => $3) value`,
      [spaceA, 'w5a-lock-control', 'w5a-lock-control-create'],
    );
    const id = doc.entity.id;
    expect(await versionOf(id)).toBe(1);

    await appValue(
      `select public.update_document(p_entity_id => $1, p_expected_version => 1,
              p_title => $2, p_client_mutation_id => $3) value`,
      [id, 'w5a-lock-control-2', 'w5a-lock-control-A'],
    );
    expect(await versionOf(id)).toBe(2);

    // A FRESH cmid at the SAME now-stale version must be refused by
    // `internal.assert_version`. If this ever succeeds, the stale-version replay
    // below stops being evidence of anything and this file must be re-derived.
    let conflict: string | null = null;
    try {
      await appValue(
        `select public.update_document(p_entity_id => $1, p_expected_version => 1,
                p_title => $2, p_client_mutation_id => $3) value`,
        [id, 'w5a-lock-control-3', 'w5a-lock-control-B-fresh'],
      );
    } catch (error) {
      conflict = (error as { message?: string }).message ?? String(error);
    }
    expect(
      conflict,
      'a FRESH cmid succeeded at a stale expected_version — the optimistic lock is not ' +
        'enforcing, so every per-door replay below could be an ordinary re-execution ' +
        'and this file proves nothing',
    ).toMatch(/version conflict/i);
    // ...and the refusal did not move the row.
    expect(await versionOf(id)).toBe(2);
  });

  for (const door of DOORS) {
    it(`${door.patch}: a same-principal, same-Space replay is ADMITTED and does not re-apply`, async () => {
      // 1. A real subject of the matching kind, through the real create door.
      const created = await appValue<{ entity: { id: string } }>(
        `select public.${door.create}(p_space_id => $1, ${door.mk}, p_client_mutation_id => $3) value`,
        [spaceA, subjectName(door.patch, 'subject'), `w5a-create-${door.patch}`],
      );
      const entityId = created.entity.id;
      expect(entityId, `${door.create} produced no subject`).toBeTruthy();
      expect(await versionOf(entityId)).toBe(1);

      // 2. Patch it once, at version 1.
      const cmid = `w5a-patch-${door.patch}`;
      const patched = await appValue<{ entity: { id: string } }>(
        `select public.${door.patch}(${door.idArg} => $1, p_expected_version => 1, ${door.set},
                p_client_mutation_id => $3) value`,
        [entityId, subjectName(door.patch, 'patched'), cmid],
      );
      expect(patched.entity.id).toBe(entityId);
      const versionAfterPatch = await versionOf(entityId);
      expect(versionAfterPatch, 'the first patch did not apply — nothing to replay').toBe(2);

      // 3. THE SUBJECT OF THIS FILE. Same door, same cmid, same principal, same
      //    Space. `038`'s binding must ADMIT this. A door that over-refuses
      //    raises here, and that failure is invisible from the negatives alone.
      let replayError: string | null = null;
      let replayed: { entity: { id: string } } | null = null;
      try {
        replayed = await appValue<{ entity: { id: string } }>(
          `select public.${door.patch}(${door.idArg} => $1, p_expected_version => 1, ${door.set},
                  p_client_mutation_id => $3) value`,
          [entityId, subjectName(door.patch, 'patched'), cmid],
        );
      } catch (error) {
        const e = error as { code?: string; message?: string };
        replayError = `${e.code ?? ''}: ${e.message ?? String(error)}`;
      }
      expect(
        replayError,
        `${door.patch} REFUSED a legitimate same-principal, same-Space replay. ` +
          'That is 038 over-refusing: it fails CLOSED, so it is invisible to the ' +
          'cross-Space negatives and reads exactly like the guard working.',
      ).toBeNull();
      expect(replayed!.entity.id).toBe(entityId);

      // 4. And it was SERVED, not re-applied. `p_expected_version => 1` could not
      //    satisfy an optimistic lock now standing at 2, so a re-execution would
      //    have raised; and the version must not have moved.
      expect(
        await versionOf(entityId),
        'the replay re-applied the update instead of returning the stored projection',
      ).toBe(versionAfterPatch);
    });
  }
});
