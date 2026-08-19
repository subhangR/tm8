/**
 * 155 against a real Postgres: a session's CATEGORY follows its LIFECYCLE.
 *
 * ## What could not be said before this file
 *
 * 152's suite proves a bare `work_session` ENVELOPE is born with a status, and
 * that is where it stopped — it never creates the `work_sessions` detail row, so
 * it could not notice that nothing ever moved the envelope again. That was the
 * defect: measured on the reporting node, 420 of 420 sessions sat under the To
 * Do tab (In Progress 0 / Done 0 / Cancelled 0) with sessions that had been
 * `exited` or `failed` for over a week among them, while the per-row status
 * glyph — which reads `work_sessions.status` — was right the whole time.
 *
 * So every case here writes the DETAIL row and asks what happened to the
 * envelope, which is the one question the earlier suites cannot pose.
 *
 * ## The case that shapes the whole mapping
 *
 * `spawning -> to_do` is not a taste call, and `resume returns an exited session
 * to to_do` below is why. `public.execution_resume` (062) moves an exited or
 * failed session back to `spawning`. Under `spawning -> to_do` that is
 * `done -> to_do`, which 149's `internal.category_transition_allowed` names as
 * THE REOPEN. Under `spawning -> in_progress` it would be `done -> in_progress`,
 * which that function does not allow at all — the bridge would have turned every
 * resume in the product into a 23514. The test is here so the next person to
 * find `spawning` filed under To Do "surprising" gets the reason as a red test
 * rather than as a paragraph they can skip.
 *
 * The one-event case is the other structural claim: a spawn is still exactly one
 * `entity.upsert`. It holds because the mapping agrees with birth (149 forces
 * the workflow's initial state into `to_do`, and a session is born `spawning` on
 * every insert path), so the bridge's INSERT arm resolves the state the row is
 * already in and writes zero rows. Nothing special-cases it, which is precisely
 * what makes it worth pinning.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `session-category-155-${label}-${unique}`;
}

async function asOwner<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function asApp<T>(
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-155',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'session-category-155-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Session owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Sessions',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Session owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

/**
 * A session as the product makes one: the envelope, then the detail row born
 * `spawning`. Written as the owner rather than through `work_session_spawn`
 * because the door needs a node, a persona and a concurrency cap that say
 * nothing about the trigger under test — and the trigger is on
 * `public.work_sessions`, so it fires for every door identically.
 */
async function createSession(title = 'A run'): Promise<string> {
  const rows = await asOwner(async (q) => {
    const created = await q(
      `insert into public.entities(space_id,kind,parent_id,position,created_by)
       values($1,'work_session',null,0,$2) returning id`,
      [fixture.spaceId, fixture.memberId],
    );
    const id = created[0]!.id as string;
    await q(`insert into public.work_sessions(entity_id,title,status) values($1,$2,'spawning')`, [id, title]);
    return created;
  });
  return rows[0]!.id as string;
}

async function transition(sessionId: string, status: string): Promise<void> {
  await asApp((q) =>
    q(`select public.work_session_transition($1,$2,null,null,null,$3)`, [sessionId, status, cmid(status)]),
  );
}

interface StatusRow {
  status_category: string | null;
  state_name: string | null;
  session_status: string | null;
}

async function statusOf(sessionId: string): Promise<StatusRow> {
  const rows = await database.query<StatusRow>(
    `select e.status_category, s.name state_name, ws.status session_status
       from public.entities e
       left join public.workflow_states s on s.id = e.status_id
       left join public.work_sessions ws on ws.entity_id = e.id
      where e.id = $1`,
    [sessionId],
  );
  return rows[0]!;
}

async function upsertEventCount(sessionId: string): Promise<number> {
  const rows = await database.query<{ n: string }>(
    `select count(*) n from public.workspace_events
      where event_type = 'entity.upsert' and payload ->> 'id' = $1`,
    [sessionId],
  );
  return Number(rows[0]!.n);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session-status-category-155');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. The mapping, end to end through the real transition door
// ---------------------------------------------------------------------------

describe('155 — the envelope category tracks work_sessions.status', () => {
  it('a newborn session is spawning, and spawning is to_do', async () => {
    const sessionId = await createSession('newborn');
    expect(await statusOf(sessionId)).toMatchObject({
      session_status: 'spawning',
      status_category: 'to_do',
    });
  });

  it('running and idle are in_progress', async () => {
    const sessionId = await createSession('running');

    await transition(sessionId, 'running');
    expect((await statusOf(sessionId)).status_category).toBe('in_progress');

    await transition(sessionId, 'idle');
    expect((await statusOf(sessionId)).status_category).toBe('in_progress');
  });

  it('exited is done — the reported defect, in one line', async () => {
    const sessionId = await createSession('exited');
    await transition(sessionId, 'running');
    await transition(sessionId, 'exited');

    // Before 155 this row read `to_do` forever while its glyph read `exited`.
    expect(await statusOf(sessionId)).toMatchObject({
      session_status: 'exited',
      status_category: 'done',
    });
  });

  it('failed is done as well, and NOTHING is cancelled', async () => {
    // The client's standing ruling, mirrored rather than made in SQL: failure is
    // a runtime fact that gets a badge, and the run reached its end — nobody
    // cancelled it. `terminate` produces `exited`, so no session status maps to
    // `cancelled` at all.
    const sessionId = await createSession('failed');
    await transition(sessionId, 'running');
    await transition(sessionId, 'failed');
    expect((await statusOf(sessionId)).status_category).toBe('done');

    const cancelled = await database.query<{ n: string }>(
      `select count(*) n from public.entities e
         join public.work_sessions ws on ws.entity_id = e.id
        where e.status_category = 'cancelled'`,
    );
    expect(Number(cancelled[0]!.n)).toBe(0);
  });

  it('a session that dies before it ever ran still reaches done', async () => {
    // `to_do -> done` is ruled allowed (149), which is what lets a session that
    // never reported `running` — the twelve stuck `spawning` rows the cleanup
    // terminated — leave the To Do tab when it finally exits.
    const sessionId = await createSession('stillborn');
    await transition(sessionId, 'exited');
    expect((await statusOf(sessionId)).status_category).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 2. The two structural claims the mapping is chosen to satisfy
// ---------------------------------------------------------------------------

describe('155 — the mapping is what keeps resume and the one-event law working', () => {
  it('resume returns an exited session to to_do rather than being refused', async () => {
    const sessionId = await createSession('resumable');
    await transition(sessionId, 'running');
    await transition(sessionId, 'exited');
    expect((await statusOf(sessionId)).status_category).toBe('done');

    // THE case that fixes the mapping. `done -> to_do` is 149's reopen;
    // `done -> in_progress` is not allowed at all, so a `spawning ->
    // in_progress` mapping would make this call raise 23514.
    await asApp((q) =>
      q(`select public.execution_resume($1,8,null,$2,null)`, [sessionId, cmid('resume')]),
    );

    expect(await statusOf(sessionId)).toMatchObject({
      session_status: 'spawning',
      status_category: 'to_do',
    });
  });

  it('creating a session is still exactly ONE entity.upsert', async () => {
    // The bridge's INSERT arm resolves the state birth already picked, so its
    // `is distinct from` guard writes zero rows. Nothing special-cases the
    // insert; the mapping agreeing with birth is what buys this.
    const sessionId = await createSession('one-event');
    expect(await upsertEventCount(sessionId)).toBe(1);
  });

  it('a transition into a category the session is already in emits nothing new', async () => {
    const sessionId = await createSession('quiet');
    await transition(sessionId, 'running');
    const afterRunning = await upsertEventCount(sessionId);

    // `running -> idle` is in_progress -> in_progress: the same state row, so
    // the bridge writes nothing. The transition function's own version bump is
    // the only event, which is what `afterRunning + 1` says.
    await transition(sessionId, 'idle');
    expect(await upsertEventCount(sessionId)).toBe(afterRunning + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. The backfill, asserted as an invariant of the migrated database
// ---------------------------------------------------------------------------

describe('155 — the backfill left no session disagreeing with its status', () => {
  it('holds for every session row in the database', async () => {
    // The migration's own `$verify$` makes this claim at apply time against
    // whatever data was there; this makes it against the fixture, where the rows
    // above are known and the trigger — not the backfill — produced them.
    const rows = await database.query<{ n: string }>(
      `select count(*) n
         from public.entities e
         join public.work_sessions ws on ws.entity_id = e.id
        where e.status_category is distinct from internal.session_status_category(ws.status)`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('maps all five statuses the DDL CHECK allows, and nothing else', async () => {
    const rows = await database.query<{ status: string; category: string | null }>(
      `select s status, internal.session_status_category(s) category
         from unnest(array['spawning','running','idle','exited','failed','sleeping']) s`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, r.category]))).toEqual({
      spawning: 'to_do',
      running: 'in_progress',
      idle: 'in_progress',
      exited: 'done',
      failed: 'done',
      // No `else` arm: an unmappable status returns NULL and the bridge leaves
      // the category alone, rather than filing the row under a bucket nobody
      // chose. Unreachable through the DDL CHECK, which is the point.
      sleeping: null,
    });
  });
});
