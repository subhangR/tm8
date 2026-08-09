/**
 * 085 — `rename_work_session`, the only `entities.patch` door onto a work session.
 *
 * ## What needed proving that the sibling files cannot cover
 *
 * `entities-patch-replay-binding.pg.test.ts` proves this door carries 038's
 * replay binding, but it reads `prosrc` — it never CALLS the function, so it
 * cannot tell a bound door from a bound door that raises on every input.
 * `entities-patch-replay-positive.pg.test.ts` drives eleven doors and this is
 * not one of them: its subjects come from `create_*` doors, and a work session
 * has none — it is born from `execution_spawn`.
 *
 * ## The version bump is the load-bearing claim, and it is a HAND-WRITTEN one
 *
 * Every other patch door gets its `entities.version` bump from a
 * `snapshot_entity_version` trigger. `work_sessions` carries no such trigger, so
 * 085 bumps the row itself, copying `execution_resume` (062). A missing bump is
 * INVISIBLE to a rename test that only reads the title back: the rename would
 * still appear to work, and `internal.assert_version` would admit two concurrent
 * renames at the same expected version, silently discarding the loser. So this
 * file asserts the version MOVED, and then asserts a stale version is REFUSED —
 * the second is what makes the first mean something.
 *
 * ## And what the door must NOT do
 *
 * R29 gives `work_sessions.status` a single writer, `work_session_transition`.
 * A rename that widened into a status write would be a lifecycle escape wearing
 * a label edit. Asserted directly, against a session left in `spawning`.
 */
import { type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from '../../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const OWNER = 'w5-rename-session-owner';

describe.sequential('085 — rename_work_session: a session title is editable, and only the title', () => {
  let database: W1ScratchDatabase;
  let spaceId: string;
  let personaId: string;

  async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '', true),
                set_config('tm8.node_admin', 'false', true),
                set_config('tm8.request_id', 'w5-rename-session', true)`,
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

  /** Returns the raised message, or null if the call SUCCEEDED. */
  async function refusal(sql: string, params: readonly unknown[] = []): Promise<string | null> {
    try {
      await appValue(sql, params);
      return null;
    } catch (error) {
      return (error as { message?: string }).message ?? String(error);
    }
  }

  async function ownerRows<R extends QueryResultRow>(
    sql: string, params: readonly unknown[] = [],
  ): Promise<R[]> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const r = await client.query<R>(sql, [...params]);
      return r.rows;
    });
  }

  const versionOf = async (entityId: string): Promise<number> =>
    Number((await ownerRows<{ version: string }>(
      `select version::text from public.entities where id = $1`, [entityId],
    ))[0]!.version);

  const sessionRow = async (entityId: string) =>
    (await ownerRows<{ title: string; status: string; node_id: string | null; model: string | null }>(
      `select title, status, node_id, model from public.work_sessions where entity_id = $1`,
      [entityId],
    ))[0]!;

  /**
   * A fresh session in `spawning`, through the door that really makes them.
   *
   * `p_session_cap` is raised because every session this file makes stays live —
   * nothing here transitions one to a terminal status, and the default cap of 8
   * is reached partway through the file. Left at the default the later tests
   * fail with `session concurrency cap reached`, which is the SPAWN door
   * working and says nothing about the rename door under test.
   */
  async function spawn(suffix: string, title: string): Promise<string> {
    const spawned = await appValue<{ entity: { id: string } }>(
      `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2,
              p_title => $3, p_node_id => 'w5-rename-node', p_model => 'w5-rename-model',
              p_session_cap => 64, p_client_mutation_id => $4) value`,
      [spaceId, personaId, title, `w5-rename-spawn-${suffix}`],
    );
    return spawned.entity.id;
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w5_rename_work_session');
    // Chain DERIVED from migrationFiles(), never a hand-listed slice.
    database.apply(migrationFiles());

    await ownerRows(
      `insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [OWNER],
    );
    await ownerRows(
      `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
       values ($1, $1, $1, false, true)`, [OWNER],
    );

    const space = await appValue<{ space: { id: string } }>(
      `select public.create_space($1, '', 'private', null, $2) value`,
      ['w5 rename session space', 'w5-rename-session-space'],
    );
    spaceId = space.space.id;

    const persona = await appValue<{ entity: { id: string } }>(
      `select public.create_team_member(p_space_id => $1, p_name => $2,
              p_client_mutation_id => 'w5-rename-persona') value`,
      [spaceId, 'w5 rename persona'],
    );
    personaId = persona.entity.id;
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 120_000);

  it('CONTROL: the harness binds a real identity, and execution_spawn really produces a session', async () => {
    // Without this every refusal below could be an unbound principal being
    // turned away at the door rather than the rule under test firing.
    const bound = await asApp(async (client) =>
      (await client.query<{ bound: string | null }>(`select internal.identity_id() bound`)).rows[0]!.bound);
    expect(bound, 'harness bound no identity — every result here would be vacuous').toBe(OWNER);

    const id = await spawn('control', 'spawn-time title');
    const row = await sessionRow(id);
    expect(row.title).toBe('spawn-time title');
    expect(row.status).toBe('spawning');
    expect(await versionOf(id)).toBe(1);
  });

  it('renames the session, and BUMPS entities.version — the hand-written bump 085 owns', async () => {
    const id = await spawn('happy', 'the name the spawn guessed');
    expect(await versionOf(id)).toBe(1);

    const result = await appValue<{ entity: { id: string } }>(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => $2, p_client_mutation_id => 'w5-rename-happy') value`,
      [id, 'the name a person chose'],
    );
    expect(result.entity.id).toBe(id);
    expect((await sessionRow(id)).title).toBe('the name a person chose');
    expect(
      await versionOf(id),
      'the version did not move — work_sessions has no snapshot trigger, so without ' +
        "085's own bump two concurrent renames both pass and the loser vanishes",
    ).toBe(2);
  });

  it('a STALE expected_version is REFUSED — so the bump above is a working optimistic lock', async () => {
    const id = await spawn('stale', 'first');
    await appValue(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'second', p_client_mutation_id => 'w5-rename-stale-a') value`,
      [id],
    );
    expect(await versionOf(id)).toBe(2);

    const conflict = await refusal(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'third', p_client_mutation_id => 'w5-rename-stale-b') value`,
      [id],
    );
    expect(
      conflict,
      'a fresh cmid at a stale version was ADMITTED — the rename would silently ' +
        'overwrite an edit the caller never saw',
    ).toMatch(/version conflict/i);
    expect((await sessionRow(id)).title, 'the refusal still wrote').toBe('second');
  });

  it('leaves status and the execution block alone — a rename is not a lifecycle transition (R29)', async () => {
    const id = await spawn('untouched', 'before');
    const before = await sessionRow(id);
    await appValue(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'after', p_client_mutation_id => 'w5-rename-untouched') value`,
      [id],
    );
    const after = await sessionRow(id);
    expect(after.title).toBe('after');
    // status has a single writer, work_session_transition. If a rename could move
    // it, the guard trigger would have been bypassed by a door nobody reads as
    // lifecycle.
    expect(after.status).toBe(before.status);
    expect(after.status).toBe('spawning');
    expect(after.node_id).toBe(before.node_id);
    expect(after.model).toBe(before.model);
  });

  it('refuses an empty or whitespace-only title rather than storing one', async () => {
    const id = await spawn('blank', 'a real name');
    for (const [label, value] of [['empty', ''], ['whitespace', '   \t \n ']] as const) {
      const raised = await refusal(
        `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
                p_title => $2, p_client_mutation_id => $3) value`,
        [id, value, `w5-rename-blank-${label}`],
      );
      expect(
        raised ?? `NOT REFUSED — stored title is now ${JSON.stringify((await sessionRow(id)).title)}`,
        `a ${label} title was accepted`,
      ).toMatch(/must not be empty/i);
    }
    // And the refusals cost nothing: neither the title nor the version moved.
    expect((await sessionRow(id)).title).toBe('a real name');
    expect(await versionOf(id)).toBe(1);
  });

  it('refuses a title over 500 characters BY NAME, not as an integrity violation', async () => {
    const id = await spawn('long', 'short enough');
    const raised = await refusal(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => $2, p_client_mutation_id => 'w5-rename-long') value`,
      [id, 'x'.repeat(501)],
    );
    // 001 already caps the column at 500. Letting THAT surface would reach the
    // caller as an opaque check-constraint violation naming a constraint no
    // client has ever heard of.
    expect(raised).toMatch(/at most 500 characters/i);
    expect(raised).not.toMatch(/violates check constraint/i);
    // The boundary itself is accepted, so the limit is 500 and not 499.
    await appValue(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => $2, p_client_mutation_id => 'w5-rename-exactly-500') value`,
      [id, 'y'.repeat(500)],
    );
    expect((await sessionRow(id)).title).toHaveLength(500);
  });

  it('ADMITS a legitimate replay and serves it from the ledger instead of re-applying', async () => {
    const id = await spawn('replay', 'original');
    const cmid = 'w5-rename-replay';
    await appValue(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'renamed', p_client_mutation_id => $2) value`,
      [id, cmid],
    );
    expect(await versionOf(id)).toBe(2);

    // The same cmid at the now-stale version 1. A re-execution could not satisfy
    // the optimistic lock, so success here can only be the ledger — and 038's
    // binding must not over-refuse its own principal's honest retry.
    const replayed = await appValue<{ entity: { id: string } }>(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'renamed', p_client_mutation_id => $2) value`,
      [id, cmid],
    );
    expect(replayed.entity.id).toBe(id);
    expect(await versionOf(id), 'the replay re-applied instead of returning the stored projection').toBe(2);
  });

  it('REFUSES a replay addressed at a different entity — 038s subject binding, driven', async () => {
    // The reason this door exists in 038's list at all: ledger_replay resolves
    // from (cmid, label) alone, so without the subject binding this door would
    // hand back another door's stored projection for any entity id.
    const first = await spawn('subject-a', 'first session');
    const second = await spawn('subject-b', 'second session');
    const cmid = 'w5-rename-cross-subject';

    await appValue(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'renamed first', p_client_mutation_id => $2) value`,
      [first, cmid],
    );

    const raised = await refusal(
      `select public.rename_work_session(p_entity_id => $1, p_expected_version => 1,
              p_title => 'renamed second', p_client_mutation_id => $2) value`,
      [second, cmid],
    );
    expect(raised, 'the door served one entity a projection recorded for another').not.toBeNull();
    expect((await sessionRow(second)).title, 'and it did not rename either').toBe('second session');
    expect(await versionOf(second)).toBe(1);
  });
});
