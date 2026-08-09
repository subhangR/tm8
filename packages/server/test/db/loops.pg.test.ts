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
import { createLoopExecutorPort } from '../../src/facade/execution-handlers.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/**
 * Resolved by SUFFIX, not by number.
 *
 * This wave's chain gets renumbered at integration (origin/main independently
 * took 085 and 086), and a hard-coded `'086_loops.sql'` would turn a mechanical
 * rename into a test failure someone has to debug during a merge — the worst
 * possible moment to be reading an unrelated suite. The number is the one part
 * of a migration's name that is NOT stable; `_loops.sql` is.
 */
const LOOPS_MIGRATION_SUFFIX = '_loops.sql';

function loopsMigration(files: readonly string[]): string {
  const matches = files.filter((file) => file.endsWith(LOOPS_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one *${LOOPS_MIGRATION_SUFFIX} migration, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0]!;
}

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
  const loops = loopsMigration(files);
  // Upgrade shape: the whole chain except the loops migration, seed a pre-loops
  // world, then apply it exactly as an upgrade would.
  database.apply(files.filter((f) => f !== loops));
  fixture = await seedPre086(database);
  database.apply([loops]);
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

/**
 * B1, proven at the mechanism rather than at the symptom.
 *
 * The bug was a `clientMutationId` built from (loop, derivedTask). Both are
 * stable across firings — `derive_task_for_entity` REUSES an open derived task
 * — so every firing after the first presented the same id to
 * `public.execution_spawn`, which opens with `internal.ledger_replay(cmid,
 * 'execution.spawn')` (043) gated only by `internal.idempotency_enabled()`,
 * which DEFAULTS ON (046).
 *
 * These two cases are the before and after of exactly that, against the real
 * RPC: same id returns the ORIGINAL session and marks itself replayed; distinct
 * ids mint distinct sessions. No PTY is needed because the replay decision is
 * made in SQL, before any process is booted.
 */
describe('B1: execution_spawn ledger replay is what made a stable id a silent no-op', () => {
  async function spawnWith(cmid: string, taskId: string): Promise<{ id: string; replayed: boolean }> {
    const rows = await asApp((q) =>
      q(
        `select public.execution_spawn($1,$2,array[$3]::uuid[],null,'scratch',null,null,
           null,'claude-opus-5','claude','Firing','node-local',true,64,null,$4) result`,
        [fixture.spaceId, fixture.teamMemberId, taskId, cmid],
      ));
    const result = rows[0]!.result as { entity: { id: string }; __tm8_replayed?: boolean };
    return { id: result.entity.id, replayed: result.__tm8_replayed === true };
  }

  async function freshTask(title: string): Promise<string> {
    const rows = await asApp((q) =>
      q(`select public.create_task($1,$2,null,'',$3::jsonb,null,null,'medium','[]'::jsonb,null,null,null,'attached_to',$4) result`,
        [fixture.spaceId, title, '{}', `task-${title}-${Math.random()}`]));
    return (rows[0]!.result as { entity: { id: string } }).entity.id;
  }

  it('idempotency is ON by default, which is why the stable id mattered', async () => {
    const rows = await asApp((q) => q(`select internal.idempotency_enabled() enabled`));
    // Measured, not assumed: 046 defaults the switch on and the server pool
    // sends `tm8.idempotency_enabled=on` unless TM8_IDEMPOTENCY_ENABLED=0.
    expect(rows[0]!.enabled).toBe(true);
  });

  it('THE BUG: the same clientMutationId returns the first session and boots nothing', async () => {
    const taskId = await freshTask('stable-cmid');
    const stable = `loop-fire:some-loop:${taskId}`;

    const first = await spawnWith(stable, taskId);
    const second = await spawnWith(stable, taskId);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // Day 2 of the seeded Dreamer loop, before the fix: same session id back,
    // no new session, and the executor recording a successful firing.
    expect(second.id).toBe(first.id);
  });

  it('THE FIX: folding the firing instant in yields two DISTINCT sessions', async () => {
    const taskId = await freshTask('firing-keyed');
    const loopId = 'some-loop';
    // Exactly the shape `fire()` now builds: `${loopId}:${firedAt.toISOString()}`.
    const day1 = await spawnWith(`loop-fire:${loopId}:2026-08-09T10:00:00.000Z`, taskId);
    const day2 = await spawnWith(`loop-fire:${loopId}:2026-08-10T10:00:00.000Z`, taskId);

    expect(day1.replayed).toBe(false);
    expect(day2.replayed).toBe(false);
    expect(day2.id).not.toBe(day1.id);
  });
});

/**
 * B2, proven end-to-end against the real doors.
 *
 * A null `team_member_id` means "route through the dispatcher". The first cut
 * resolved a dispatcher session and then told it NOTHING — no durable request,
 * no envelope — so the loop recorded a successful firing while the dispatcher
 * sat idle. Nothing in the graph said the firing had failed, which is the worst
 * shape a bug can take.
 *
 * The real `createLoopExecutorPort` runs here against real SQL. Only the two
 * process-local things are faked: the PTY map (so a dispatcher counts as live
 * without booting one) and SpawnService (which must therefore never be called
 * on this path — asserted).
 */
describe('B2: a null-runner firing leaves a request the dispatcher can read', () => {
  /** A Db that applies the port's claims exactly as the real pool does. */
  function appDb(): Db {
    const run = async <T>(claims: DbClaims, fn: (client: {
      query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[] }>;
    }) => Promise<T>): Promise<T> =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(
          `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
                  set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-loop-fire',true)`,
          [claims.identityId ?? fixture.identityId],
        );
        return fn(client as never);
      });

    return {
      query: async <R>(claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        run(claims, async (c) => (await c.query(sql, [...params])).rows as R[]),
      // `resolveAssignmentAnchors` reaches for db.rpc directly (064).
      rpc: async <T>(claims: DbClaims, name: string, args: readonly unknown[] = []): Promise<T> =>
        run(claims, async (c) => {
          const ph = args.map((_, i) => `$${i + 1}`).join(',');
          const rows = await c.query(`select ${name}(${ph}) result`, [...args]);
          return (rows.rows[0] as { result: T }).result;
        }),
      tx: async <T>(claims: DbClaims, fn: (q: unknown) => Promise<T>): Promise<T> =>
        run(claims, async (c) =>
          fn({
            query: async (sql: string, params: readonly unknown[] = []) =>
              (await c.query(sql, [...params])).rows,
            rpc: async (name: string, args: readonly unknown[] = []) => {
              const ph = args.map((_, i) => `$${i + 1}`).join(',');
              const rows = await c.query(`select ${name}(${ph}) result`, [...args]);
              return (rows.rows[0] as { result: unknown }).result;
            },
          })),
    } as unknown as Db;
  }

  /** A real work_session row in dispatcher mode, seeded as the graph owner. */
  async function seedDispatcherSession(): Promise<string> {
    return database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'work_session',null,0,$3)`,
        [id, fixture.spaceId, fixture.memberId],
      );
      // Space lives on the entity row, not here — `work_sessions` has no
      // space_id column; `findLiveDispatcherSession` joins to get it.
      await client.query(
        `insert into public.work_sessions(entity_id,title,status,mode,node_id)
         values($1,'Dispatcher','running','dispatcher','node-local')`,
        [id],
      );
      return id;
    });
  }

  it('posts a durable dispatch request on the derived task, addressed at the dispatcher', async () => {
    const dispatcherSessionId = await seedDispatcherSession();
    const loopId = await createLoop('Dispatcher-routed firing', { teamMemberId: null });

    let spawnCalls = 0;
    const port = createLoopExecutorPort({
      db: appDb(),
      pty: { liveSessionIds: () => [dispatcherSessionId] } as never,
      spawnService: {
        spawn: async () => { spawnCalls += 1; throw new Error('must not spawn: a dispatcher is live'); },
      } as never,
      resolveOwner: async () => ({ identityId: fixture.identityId, isNodeAdmin: true }) as never,
    });

    const claims: DbClaims = { identityId: fixture.identityId, nodeAdmin: false, requestId: 'req-loop-fire' };
    const fired = await port.fire(
      {
        entityId: loopId, spaceId: fixture.spaceId, title: 'Dispatcher-routed firing',
        schedule: 'every 1d', teamMemberId: null, subjectId: null,
        prompt: 'sweep the memory graph', config: null, version: 1,
      },
      claims,
      new Date('2026-08-09T10:00:00Z'),
    );

    // A live dispatcher is reused, never re-spawned.
    expect(spawnCalls).toBe(0);
    expect(fired.sessionId).toBe(dispatcherSessionId);

    // THE REGRESSION: before the fix this table was empty for this task and the
    // firing still reported success.
    const messages = await database.query<{ body: string; anchor_id: string }>(
      `select m.body, m.anchor_id::text
         from public.messages m
        where m.anchor_id = $1
        order by m.created_at`,
      [fired.taskId],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.body).toContain('Dispatch requested for this task');
    // The loop's instruction rides along as the requester note, so the
    // dispatcher knows what the loop wanted, not merely that it wanted something.
    expect(messages[0]!.body).toContain('sweep the memory graph');
  });

  it('records triggered_by for both the task and the dispatcher session', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.edges where type = 'triggered_by'`,
    );
    // Run history exists for the firing above: task -> loop and session -> loop.
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });
});
