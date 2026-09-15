/**
 * The due-loop sweep sees every space and fires each loop as the person
 * entitled to run it (migration *_due_loops_sweep.sql + scheduler/jobs/loops.ts).
 *
 * This file exists because of a measurement, not a hypothesis. On production
 * (read-only, 2026-09-15) public.loops held 21 rows, all enabled; 16 were due
 * and had NEVER run — no last_run_at, no last_error, entity version 1 — and
 * every one of them lived in a space the node's loopback owner is not a member
 * of. Bound exactly as the executor binds (owner identity, node_admin = true),
 * the executor's own due-loop read returned 0 of those 16 and saw 1 of the
 * node's 21 loops in total. `loops_select` is membership and nothing else;
 * node-admin does not widen it (002), and the executor read as the owner.
 *
 * So the regression is proved against REAL row-level security through the
 * production `PgDb` (claims bound, role dropped to tm8_app), never through a
 * fake: two spaces with two different owners, both with a loop overdue, and
 * one sweep tick as the node owner. Before the fix the tick fires the owner's
 * loop and never learns the other exists. After it, both fire — each under the
 * identity that owns the teammate it runs — and the other user's loop advances
 * through `update_loop`, which proves the write-back half as well as the read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { DbClaims } from '../../src/db/types.js';
import { createLoopsJob, type DueLoop, type LoopExecutorPort } from '../../src/scheduler/jobs/loops.js';
import { nextRunAt } from '../../src/scheduler/schedule.js';
import type { JobContext } from '../../src/scheduler/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const NODE_OWNER = 'sweep-node-owner';
const OTHER_USER = 'sweep-other-user';

interface Fixture {
  /** The owner's space: the ONE space the pre-fix sweep could see. */
  ownerSpaceId: string;
  ownerMemberId: string;
  ownerTeammateId: string;
  /** Another user's space: seeded by them, invisible to the owner under RLS. */
  otherSpaceId: string;
  otherMemberId: string;
  otherTeammateId: string;
  otherDispatcherId: string;
}

interface Loops {
  /** Owner's space, names the owner's teammate, overdue. */
  ownerDue: string;
  /** Owner's space, names NO teammate, and the space has no dispatcher: nobody may run it. */
  ownerUnrunnable: string;
  /** Other user's space, names their teammate, overdue. THE regression. */
  otherDue: string;
  /** Other user's space, names no teammate → routed through their dispatcher. */
  otherViaDispatcher: string;
  /** Other user's space, not due yet: the control. */
  otherFuture: string;
}

let database: W1ScratchDatabase;
let db: PgDb;
let fixture: Fixture;
let loops: Loops;

async function seed(scratch: W1ScratchDatabase): Promise<Fixture> {
  return scratch.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select internal.new_id()::text "ownerSpaceId",
              internal.new_id()::text "ownerMemberId",
              internal.new_id()::text "ownerTeammateId",
              internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "otherMemberId",
              internal.new_id()::text "otherTeammateId",
              internal.new_id()::text "otherDispatcherId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'Node owner'),($2,'Other user')`,
      [NODE_OWNER, OTHER_USER],
    );
    // The node owner has an account and is a node admin — the claim the real
    // executor binds for it. The other user deliberately has NO account row:
    // membership is what entitles them, and the sweep must not need more.
    await client.query(
      `insert into public.accounts(identity_id,username,display_name,is_owner,is_node_admin)
       values($1,'sweepowner','Node owner',true,true)`,
      [NODE_OWNER],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity)
       values($1,'Owner space',$2),($3,'Other space',$4)`,
      [f.ownerSpaceId, NODE_OWNER, f.otherSpaceId, OTHER_USER],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1),
       ($4,$6,'member',null,0,$4),($5,$6,'team_member',null,1,$4),($7,$6,'team_member',null,2,$4)`,
      [
        f.ownerMemberId, f.ownerTeammateId, f.ownerSpaceId,
        f.otherMemberId, f.otherTeammateId, f.otherSpaceId, f.otherDispatcherId,
      ],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Node owner'),($4,$5,$6,'owner','Other user')`,
      [f.ownerMemberId, f.ownerSpaceId, NODE_OWNER, f.otherMemberId, f.otherSpaceId, OTHER_USER],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity,mode)
       values($1,$2,'Dreamer','','persona','worker'),
             ($3,$4,'Dreamer','','persona','worker'),
             ($5,$4,'Dispatcher','','persona','dispatcher')`,
      [f.ownerTeammateId, f.ownerMemberId, f.otherTeammateId, f.otherMemberId, f.otherDispatcherId],
    );
    return f;
  });
}

/** The doors as tm8_app sees them, bound as one identity — how a real request runs. */
async function asIdentity<T>(
  identityId: string,
  nodeAdmin: boolean,
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin',$2,true),set_config('tm8.request_id','req-sweep-pg',true)`,
      [identityId, nodeAdmin ? 'true' : 'false'],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/** Each user creates their own loop through the real door, as `spaces.create` seeding does. */
async function createLoop(
  as: string,
  spaceId: string,
  title: string,
  teamMemberId: string | null,
  nextRunAt: Date,
): Promise<string> {
  const rows = await asIdentity(as, false, (q) =>
    q(
      `select public.create_loop($1,$2,null,'every 1d',$3,null,'sweep',$4::jsonb,true,$5::timestamptz,null,null,$6) result`,
      [spaceId, title, teamMemberId, '{}', nextRunAt.toISOString(), `sweep-pg-${title}-${Math.random()}`],
    ));
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
}

interface LoopRow {
  last_run_at: Date | null;
  next_run_at: Date | null;
  last_error: string | null;
  enabled: boolean;
  version: number;
}

async function loopRow(id: string): Promise<LoopRow> {
  const rows = await database.query<LoopRow>(
    `select l.last_run_at, l.next_run_at, l.last_error, l.enabled, e.version
       from public.loops l join public.entities e on e.id = l.entity_id
      where l.entity_id = $1`,
    [id],
  );
  return rows[0]!;
}

interface Firing {
  loopId: string;
  claims: DbClaims;
}

/**
 * The port as the job sees it: the sweep's claims are the NODE OWNER's — the
 * exact binding `createLoopExecutorPort.claimsFor` makes in production — and a
 * firing is recorded rather than spawned. What the test measures is which loops
 * the tick reaches and under whose identity, which is the port's input, not
 * its output.
 */
function ownerPort(rec: Firing[]): LoopExecutorPort {
  return {
    claimsFor: async () => ({ identityId: NODE_OWNER, nodeAdmin: true, requestId: 'loop-executor' }),
    liveSessionIds: () => [],
    fire: async (loop: DueLoop, claims: DbClaims) => {
      rec.push({ loopId: loop.entityId, claims });
      return { taskId: `task-${rec.length}`, sessionId: `session-${rec.length}` };
    },
  };
}

function tick(firedAt: Date, warnings: string[] = []): JobContext {
  return {
    name: 'loops.execute-due',
    firedAt,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (line: string) => { warnings.push(line); },
      error: () => {},
    } as never,
    signal: new AbortController().signal,
  };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('loops_sweep');
  database.apply(migrationFiles());
  fixture = await seed(database);
  db = new PgDb({ databaseUrl: database.url, max: 4 });

  const overdue = new Date(Date.now() - 60 * 60_000);
  const future = new Date(Date.now() + 60 * 60_000);
  loops = {
    ownerDue: await createLoop(NODE_OWNER, fixture.ownerSpaceId, 'Owner due', fixture.ownerTeammateId, overdue),
    ownerUnrunnable: await createLoop(NODE_OWNER, fixture.ownerSpaceId, 'Owner unrunnable', null, overdue),
    otherDue: await createLoop(OTHER_USER, fixture.otherSpaceId, 'Other due', fixture.otherTeammateId, overdue),
    otherViaDispatcher: await createLoop(OTHER_USER, fixture.otherSpaceId, 'Other via dispatcher', null, overdue),
    otherFuture: await createLoop(OTHER_USER, fixture.otherSpaceId, 'Other future', fixture.otherTeammateId, future),
  };
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('the blocking condition, measured rather than assumed', () => {
  it('a plain read of public.loops as the node owner sees only the owner\'s own space', async () => {
    // This is the executor's pre-fix read, verbatim, under the claims it bound.
    // It stays green after the fix because it is a fact about RLS, not about
    // the executor — and it is WHY the sweep needs a door of its own.
    const seen = await db.query<{ id: string }>(
      { identityId: NODE_OWNER, nodeAdmin: true, requestId: 'probe' },
      `select l.entity_id::text id
         from public.loops l join public.entities e on e.id = l.entity_id
        where l.enabled and e.deleted_at is null
          and l.next_run_at is not null and l.next_run_at <= now()`,
    );
    const ids = seen.map((row) => row.id).sort();
    expect(ids).toEqual([loops.ownerDue, loops.ownerUnrunnable].sort());
    expect(ids).not.toContain(loops.otherDue);
  });

  it('the sweep door refuses anyone who is not a node admin', async () => {
    // The door enumerates loops across every space, which no ordinary member
    // may do; the other user is a space owner and still gets 42501.
    await expect(asIdentity(OTHER_USER, false, (q) => q('select public.list_due_loops(25)')))
      .rejects.toThrow(/node admin/);
  });
});

describe('one sweep tick as the node owner', () => {
  const firedAt = new Date();
  const fired: Firing[] = [];
  const warnings: string[] = [];
  let outcome: Awaited<ReturnType<ReturnType<typeof createLoopsJob>['run']>>;

  beforeAll(async () => {
    outcome = await createLoopsJob({ db, port: ownerPort(fired) }).run(tick(firedAt, warnings));
  });

  it('fires the overdue loop in the OTHER user\'s space — the 16 production loops that never ran', () => {
    expect(fired.map((f) => f.loopId)).toContain(loops.otherDue);
  });

  it('still fires the owner\'s own loop, exactly as before', () => {
    expect(fired.map((f) => f.loopId)).toContain(loops.ownerDue);
  });

  it('routes a teammate-less loop through the space\'s dispatcher', () => {
    expect(fired.map((f) => f.loopId)).toContain(loops.otherViaDispatcher);
  });

  it('leaves a loop that is not due yet alone', () => {
    expect(fired.map((f) => f.loopId)).not.toContain(loops.otherFuture);
  });

  it('binds each firing to the identity that owns the teammate it runs, not to the sweep\'s owner', () => {
    const byLoop = new Map(fired.map((f) => [f.loopId, f.claims]));
    expect(byLoop.get(loops.ownerDue)).toMatchObject({ identityId: NODE_OWNER, nodeAdmin: true });
    expect(byLoop.get(loops.otherDue)).toMatchObject({ identityId: OTHER_USER, nodeAdmin: false });
    expect(byLoop.get(loops.otherViaDispatcher)).toMatchObject({ identityId: OTHER_USER, nodeAdmin: false });
  });

  it('advances the other user\'s loop through update_loop under their identity — the write-back half', async () => {
    // The read half alone would leave the loop re-selected every tick: this is
    // the proof that a firing in a foreign space can also be recorded.
    const row = await loopRow(loops.otherDue);
    expect(row.last_run_at).not.toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.enabled).toBe(true);
    expect(row.version).toBe(2);
    expect(new Date(row.next_run_at!).toISOString())
      .toBe(nextRunAt('every 1d', firedAt)!.toISOString());
  });

  it('reports a loop nobody may run instead of silently skipping it', async () => {
    // No teammate and no dispatcher in that space: there is no identity that
    // could spawn for it, and none that could write the error on it either.
    // The tick says so out loud and counts it, and the loop is left untouched
    // for a human to fix.
    expect(fired.map((f) => f.loopId)).not.toContain(loops.ownerUnrunnable);
    expect(outcome).toMatchObject({ detail: { due: 4, fired: 3, failed: 1 } });
    expect(warnings.some((line) => line.includes(loops.ownerUnrunnable))).toBe(true);
    const row = await loopRow(loops.ownerUnrunnable);
    expect(row.last_run_at).toBeNull();
    expect(row.version).toBe(1);
  });
});
