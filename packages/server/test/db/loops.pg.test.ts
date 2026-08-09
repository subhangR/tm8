/**
 * Migration 086 — the `loop` core kind (Dreamer/Dispatcher P4, design §4.4).
 *
 * Applied as an UPGRADE, not a fresh install: everything before 086 first, then
 * 086 on top. A migration that only ever runs as part of a from-scratch chain
 * has not been tested against the database anyone actually has.
 *
 * The assertions that matter here are the ones a "did it return without
 * throwing" test would miss:
 *  - `internal.entity_content` resolves the `loop` arm. A missing arm is SILENT
 *    — content becomes `{}`::jsonb forever and every success check stays green.
 *    This is the exact failure 011 exists because of, and why
 *    db/test/loop_rpcs.test.mjs tells new kinds to assert their content.
 *  - the doors REFUSE cross-space `team_member_id` / `subject_id`. A loop is a
 *    standing grant of the creator's authority on a timer; one that can name an
 *    entity in another space is a scheduled confused deputy.
 *  - `enabled`/`next_run_at` round-trip through `update_loop`, because that is
 *    the door the executor itself advances state through.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DREAMER_LOOP_TITLE,
  DREAMER_SEED_NAME,
  ensureDefaultTeammates,
} from '../../src/bootstrap/default-teammates.js';
import type { Querier } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATION_086 = '086_loops.sql';

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
  otherSpaceId: string;
  otherMemberId: string;
  otherTeamMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seedPre086(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'loops-owner'::text "identityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId",
              internal.new_id()::text "teamMemberId",
              internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "otherMemberId",
              internal.new_id()::text "otherTeamMemberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Loops owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Loops',$2),($3,'Elsewhere',$2)`,
      [f.spaceId, f.identityId, f.otherSpaceId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1),
       ($4,$6,'member',null,0,$4),($5,$6,'team_member',null,1,$4)`,
      [f.memberId, f.teamMemberId, f.spaceId, f.otherMemberId, f.otherTeamMemberId, f.otherSpaceId],
    );
    // A teammate's owner must be a member of the SAME space (the DB says so),
    // so the far space needs its own member before it can hold a stranger.
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Loops owner'),($4,$5,$3,'owner','Elsewhere owner')`,
      [f.memberId, f.spaceId, f.identityId, f.otherMemberId, f.otherSpaceId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Runner','','persona'),($3,$4,'Stranger','','persona')`,
      [f.teamMemberId, f.memberId, f.otherTeamMemberId, f.otherMemberId],
    );
    return f;
  });
}

/**
 * The doors as tm8_app sees them — the role tm8-server actually connects as,
 * with the same claim triple the facade sets. Calling them as the graph owner
 * would prove the SQL parses and nothing about whether a real caller may run it.
 */
async function asApp<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-loops-pg',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function createLoop(
  title: string,
  overrides: {
    schedule?: string;
    teamMemberId?: string | null;
    subjectId?: string | null;
    enabled?: boolean;
    nextRunAt?: string | null;
    spaceId?: string;
  } = {},
): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_loop($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::timestamptz,null,null,$11) result`,
      [
        overrides.spaceId ?? fixture.spaceId,
        title,
        fixture.memberId,
        overrides.schedule ?? 'every 1d',
        overrides.teamMemberId === undefined ? fixture.teamMemberId : overrides.teamMemberId,
        overrides.subjectId ?? null,
        'do the thing',
        JSON.stringify({ model: 'claude-opus-5' }),
        overrides.enabled ?? true,
        overrides.nextRunAt ?? null,
        `loops-test-${title}-${Math.random()}`,
      ],
    ));
  const result = rows[0]!.result as { entity: { id: string } };
  return result.entity.id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('loops');
  const files = migrationFiles();
  expect(files).toContain(MIGRATION_086);
  // Upgrade shape: the whole chain except 086, seed a pre-086 world, then 086.
  database.apply(files.filter((f) => f !== MIGRATION_086));
  fixture = await seedPre086(database);
  database.apply([MIGRATION_086]);
});

afterAll(async () => {
  await database?.destroy();
});

describe('086 registers loop as a core kind', () => {
  it('seeds the kind row with core origin and no owning space', async () => {
    const rows = await database.query<{ origin: string; space_id: string | null }>(
      `select origin, space_id from public.entity_kinds where kind = 'loop'`,
    );
    expect(rows).toEqual([{ origin: 'core', space_id: null }]);
  });

  it('registers triggered_by from task and work_session to loop', async () => {
    const rows = await database.query<{ src_kinds: string[]; dst_kinds: string[]; append_only: boolean }>(
      `select src_kinds, dst_kinds, append_only from public.edge_types where type = 'triggered_by'`,
    );
    expect(rows[0]?.dst_kinds).toEqual(['loop']);
    expect(rows[0]?.src_kinds.sort()).toEqual(['task', 'work_session']);
    // Run history is a log, not an epistemic claim: it must be purgeable with
    // its loop rather than raising the way the 056 append-only edges do.
    expect(rows[0]?.append_only).toBe(false);
  });
});

describe('create_loop', () => {
  it('creates the entity and a detail row the content arm can resolve', async () => {
    const id = await createLoop('Nightly sweep');

    const detail = await database.query<{ title: string; schedule: string; enabled: boolean }>(
      `select title, schedule, enabled from public.loops where entity_id = $1`, [id],
    );
    expect(detail[0]).toMatchObject({ title: 'Nightly sweep', schedule: 'every 1d', enabled: true });

    // THE assertion this file exists for. A missing `entity_content` arm returns
    // a perfectly valid `{}`::jsonb and nothing else in the suite would notice.
    const content = await database.query<{ content: Record<string, unknown> }>(
      `select internal.entity_content($1) content`, [id],
    );
    expect(content[0]!.content).toMatchObject({
      title: 'Nightly sweep',
      schedule: 'every 1d',
      enabled: true,
      prompt: 'do the thing',
      config: { model: 'claude-opus-5' },
    });
    expect(content[0]!.content).not.toEqual({});
    expect(content[0]!.content).not.toHaveProperty('entity_id');
  });

  it('records an initial version so the entity is patchable under a guard', async () => {
    const id = await createLoop('Versioned');
    const rows = await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [id],
    );
    expect(rows[0]!.version).toBe(1);
  });

  it('accepts a null team_member_id — that is "route through the dispatcher"', async () => {
    const id = await createLoop('Dispatcher-routed', { teamMemberId: null });
    const rows = await database.query<{ team_member_id: string | null }>(
      `select team_member_id from public.loops where entity_id = $1`, [id],
    );
    expect(rows[0]!.team_member_id).toBeNull();
  });

  it('refuses a teammate from another space', async () => {
    await expect(createLoop('Cross-space teammate', { teamMemberId: fixture.otherTeamMemberId }))
      .rejects.toThrow(/team_member_id must name a live team_member in this space/);
  });

  it('refuses a subject from another space', async () => {
    await expect(createLoop('Cross-space subject', { subjectId: fixture.otherTeamMemberId }))
      .rejects.toThrow(/subject_id must name a live entity in this space/);
  });

  it('refuses a blank schedule', async () => {
    await expect(createLoop('No schedule', { schedule: '   ' }))
      .rejects.toThrow(/schedule is required/);
  });
});

/**
 * The half of "both read arms" that a jsonb-shaped test cannot see.
 *
 * `internal.command_result` runs `jsonb_strip_nulls` (007:53), and it is
 * RECURSIVE — so the content envelope a command returns has no key at all for a
 * null column. `teamMemberId: null` is not a gap for a loop, it is the value
 * that means "route through the dispatcher", so the HTTP read arms
 * (facade/entity-read.ts and events/projector.ts) must NOT be fed from that
 * jsonb. Both select the column explicitly. This proves the column path keeps
 * the distinction the jsonb path destroys.
 */
describe('null-carrying columns survive the explicit projection', () => {
  it('is stripped from entity_content but present and null on the column', async () => {
    const id = await createLoop('Dispatcher-routed null', { teamMemberId: null });

    const content = await database.query<{ content: Record<string, unknown> }>(
      `select internal.entity_content($1) content`, [id],
    );
    // to_jsonb keeps the key here (entity_content itself does not strip)...
    expect(content[0]!.content).toHaveProperty('team_member_id');
    expect(content[0]!.content.team_member_id).toBeNull();

    // ...but the command envelope, which is what a client actually receives,
    // has dropped it entirely.
    const envelope = await database.query<{ result: { entity: { content: Record<string, unknown> } } }>(
      `select internal.command_entity($1) entity`, [id],
    ).then((rows) => rows as unknown as Array<{ entity: { content: Record<string, unknown> } }>);
    expect(envelope[0]!.entity.content).toHaveProperty('team_member_id');

    // The shape the read arms are built on: an explicit column list, where a
    // null is a null and not an absence.
    const projected = await database.query<{ loop_team_member_id: string | null; loop_schedule: string }>(
      `select lp.team_member_id::text as loop_team_member_id, lp.schedule as loop_schedule
         from public.entities e
         left join public.loops lp on lp.entity_id = e.id
        where e.id = $1`,
      [id],
    );
    expect(projected[0]!.loop_team_member_id).toBeNull();
    expect(projected[0]!.loop_schedule).toBe('every 1d');
  });
});

describe('update_loop', () => {
  it('round-trips the executor-owned columns under a version guard', async () => {
    const id = await createLoop('Executor state');
    const when = '2026-08-10T03:00:00.000Z';

    await asApp((q) =>
      q(`select public.update_loop($1,1,$2,null,null,null,false,null,false,null,null,$3,$4::timestamptz,false,$5::timestamptz,null,false,$6)`,
        [id, fixture.memberId, false, when, when, `loops-update-${id}`]));

    const rows = await database.query<{ enabled: boolean; next_run_at: Date; last_run_at: Date }>(
      `select enabled, next_run_at, last_run_at from public.loops where entity_id = $1`, [id],
    );
    expect(rows[0]!.enabled).toBe(false);
    expect(new Date(rows[0]!.next_run_at).toISOString()).toBe(when);
    expect(new Date(rows[0]!.last_run_at).toISOString()).toBe(when);
  });

  it('refuses a stale expected version', async () => {
    const id = await createLoop('Guarded');
    await expect(asApp((q) =>
      q(`select public.update_loop($1,99,$2,'Renamed',null,null,false,null,false,null,null,null,null,false,null,null,false,$3)`,
        [id, fixture.memberId, `loops-stale-${id}`])))
      .rejects.toThrow();
  });

  it('clears next_run_at only when explicitly told to', async () => {
    const id = await createLoop('Clearable', { nextRunAt: '2026-08-10T03:00:00.000Z' });
    // A bare null must MERGE (leave it alone), or every unrelated patch would
    // silently unschedule the loop.
    await asApp((q) =>
      q(`select public.update_loop($1,1,$2,null,'every 2h',null,false,null,false,null,null,null,null,false,null,null,false,$3)`,
        [id, fixture.memberId, `loops-merge-${id}`]));
    let rows = await database.query<{ next_run_at: Date | null }>(
      `select next_run_at from public.loops where entity_id = $1`, [id]);
    expect(rows[0]!.next_run_at).not.toBeNull();

    const version = (await database.query<{ version: number }>(
      `select version from public.entities where id = $1`, [id]))[0]!.version;
    await asApp((q) =>
      q(`select public.update_loop($1,$2,$3,null,null,null,false,null,false,null,null,null,null,true,null,null,false,$4)`,
        [id, version, fixture.memberId, `loops-clear-${id}`]));
    rows = await database.query<{ next_run_at: Date | null }>(
      `select next_run_at from public.loops where entity_id = $1`, [id]);
    expect(rows[0]!.next_run_at).toBeNull();
  });
});

describe('the due-loop query the executor runs', () => {
  it('returns only enabled loops whose next_run_at has passed', async () => {
    const due = await createLoop('Due now', { nextRunAt: '2020-01-01T00:00:00.000Z' });
    const future = await createLoop('Not yet', { nextRunAt: '2999-01-01T00:00:00.000Z' });
    const disabled = await createLoop('Off', { nextRunAt: '2020-01-01T00:00:00.000Z', enabled: false });

    const rows = await database.query<{ entity_id: string }>(
      `select entity_id from public.loops
        where enabled and next_run_at is not null and next_run_at <= now()`,
    );
    const ids = rows.map((r) => r.entity_id);
    expect(ids).toContain(due);
    expect(ids).not.toContain(future);
    expect(ids).not.toContain(disabled);
  });
});

/**
 * P5's seeding, against the REAL doors (D7/D8).
 *
 * The unit tests for this run against a fake that records calls, which proves
 * the seeder was ASKED to create a loop and nothing about whether the arguments
 * it passed are ones `create_loop` accepts — argument-order and same-space
 * mistakes both survive a call-recording fake perfectly. This runs it for real.
 */
describe('bootstrap seeds the Dreamer and its daily loop', () => {
  /** ensureDefaultTeammates needs a Querier; the scratch pool provides one. */
  async function seedInto(spaceId: string): Promise<{ loopsCreated?: number; created: number }> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
                set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-seed',true)`,
        [fixture.identityId],
      );
      const q: Querier = {
        query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
          (await client.query(sql, [...params])).rows as R[],
        rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
          const placeholders = args.map((_, i) => `$${i + 1}`).join(',');
          const rows = await client.query(`select ${fn}(${placeholders}) result`, [...args]);
          return rows.rows[0].result as T;
        },
      };
      return ensureDefaultTeammates(q, spaceId);
    });
  }

  it('creates the Dreamer and an ENABLED daily loop pointed at it', async () => {
    const result = await seedInto(fixture.spaceId);
    expect(result.loopsCreated).toBe(1);

    const rows = await database.query<{
      title: string; schedule: string; enabled: boolean;
      team_member_id: string; next_run_at: Date | null; dreamer: string;
    }>(
      `select l.title, l.schedule, l.enabled, l.team_member_id::text, l.next_run_at,
              t.name dreamer
         from public.loops l
         join public.entities e on e.id = l.entity_id
         join public.team_members t on t.entity_id = l.team_member_id
        where e.space_id = $1 and l.title = $2`,
      [fixture.spaceId, DREAMER_LOOP_TITLE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.schedule).toBe('every 1d');
    // Seeded ENABLED on purpose (D8): a cleanup pass that ships disabled is one
    // nobody ever turns on, and the graph rots in exactly the untended spaces.
    expect(rows[0]!.enabled).toBe(true);
    // Named runner, not a null — this loop is the Dreamer's, not the
    // dispatcher's to route.
    expect(rows[0]!.dreamer).toBe(DREAMER_SEED_NAME);
    // Scheduled, not waiting for a human to save it once.
    expect(rows[0]!.next_run_at).not.toBeNull();
  });

  it('is idempotent — a second boot pass adds neither a teammate nor a loop', async () => {
    const again = await seedInto(fixture.spaceId);
    expect(again.loopsCreated).toBe(0);
    expect(again.created).toBe(0);

    const count = await database.query<{ n: string }>(
      `select count(*)::text n from public.loops l
         join public.entities e on e.id = l.entity_id
        where e.space_id = $1 and l.title = $2`,
      [fixture.spaceId, DREAMER_LOOP_TITLE],
    );
    expect(count[0]!.n).toBe('1');
  });
});
