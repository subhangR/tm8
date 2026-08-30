/**
 * Migration 174 — `public.note_tracking_refresh_stop`, against a real database.
 *
 * A FakeDb cannot see any of this. Every property that makes this door safe is
 * plpgsql: that it writes `error` and touches NOTHING else, that
 * `internal.is_space_member` keeps it out of another space's rows, that a
 * non-`running` request is not editable, and that a miss is a `noted: false`
 * rather than an exception. A unit test with a stubbed `rpc` would assert only
 * that the observer sent the right arguments — which the observer suite already
 * does, and which proves nothing about the door.
 *
 * WHY THE DOOR EXISTS. `runTrackingObserverTick` has three ways to stop mid
 * request — the GitHub rate limit, the abort signal, and the target budget —
 * and all three deliberately do NOT call `complete_tracking_refresh`, because
 * completing a request whose targets were never fetched writes a success
 * receipt for work no process did. Correct, but it left the row claimed and
 * SILENT: `error` is written only by the completion door, so all three reasons
 * were an identical NULL, and a row that stopped because GitHub refused looked
 * exactly like a row that stopped on the clock.
 *
 * On the node this was written for, that silence hid an observer making
 * ANONYMOUS GitHub calls at 60 requests/hour for the whole host. Once a backfill
 * spent the hour's budget, every subsequent tick stopped on its first target
 * with no row, no log line and no error text to say so.
 *
 * The load-bearing subtlety, and the reason the status predicate is asserted
 * twice below: the note must NOT terminate the request. It stays `running` with
 * `completed_at` null so 081's stale window still returns it to the queue. A
 * note that quietly completed a row would replace a silent stall with a silent
 * LIE, which is strictly worse.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

/**
 * Resolved by SUFFIX, not by number — this file's prefix moves whenever another
 * lane lands a migration first (this one already moved once), and a hard-coded
 * number turns a mechanical rename into a failing suite at the worst possible
 * moment. Same reasoning as loops.pg.test.ts.
 */
const STOP_NOTE_SUFFIX = '_tracking_refresh_says_why_it_stopped.sql';

interface Fixture {
  identityId: string;
  outsiderIdentityId: string;
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  outsiderMemberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'stopnote-owner'::text "identityId",
              'stopnote-outsider'::text "outsiderIdentityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "memberId",
              internal.new_id()::text "outsiderMemberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'Stop note owner'),($2,'Stop note outsider')`,
      [f.identityId, f.outsiderIdentityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Mine',$3),($2,'Theirs',$4)`,
      [f.spaceId, f.otherSpaceId, f.identityId, f.outsiderIdentityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$4,'member',null,0,$2)`,
      [f.memberId, f.outsiderMemberId, f.spaceId, f.otherSpaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values
       ($1,$3,$5,'owner','Stop note owner'),($2,$4,$6,'owner','Stop note outsider')`,
      [f.memberId, f.outsiderMemberId, f.spaceId, f.otherSpaceId,
        f.identityId, f.outsiderIdentityId],
    );
    return f;
  });
}

/** A request row in whatever state a test needs, created as the graph owner. */
async function makeRequest(
  spaceId: string,
  requestedBy: string,
  status: 'queued' | 'running' | 'completed' | 'failed',
  error: string | null = null,
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const rows = await client.query<{ id: string }>(
      `insert into public.tracking_refresh_requests(space_id,requested_by,entity_ids,status,started_at,error)
       values($1,$2,null,$3, case when $3 in ('running','completed','failed') then now() end, $4)
       returning id::text`,
      [spaceId, requestedBy, status, error],
    );
    return rows.rows[0]!.id;
  });
}

/**
 * The door as tm8_app sees it — the role tm8-server connects as. Calling it as
 * the graph owner would prove the SQL parses and nothing about whether a real
 * caller may run it, or about whether RLS-shaped predicates bite.
 */
async function asApp<T>(
  identityId: string,
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-stopnote',true)`,
      [identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function readRequest(id: string): Promise<{
  status: string; error: string | null; completed_at: string | null; started_at: string | null;
}> {
  const rows = await database.query<{
    status: string; error: string | null; completed_at: string | null; started_at: string | null;
  }>(
    `select status, error, completed_at::text, started_at::text
       from public.tracking_refresh_requests where id=$1`,
    [id],
  );
  return rows[0]!;
}

describe.sequential('174 — a tracking refresh that stops early says why', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('stopnote');
    const files = migrationFiles();
    const matches = files.filter((f) => f.endsWith(STOP_NOTE_SUFFIX));
    expect(matches, `expected exactly one *${STOP_NOTE_SUFFIX} migration`).toHaveLength(1);
    // The WHOLE chain. The door leans on `internal.require_identity` and
    // `internal.is_space_member`, and a hand-picked slice is a fixture that
    // drifts out from under the file it is testing.
    database.apply(files);
    fixture = await seed(database);
  }, 240_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('records the reason on a RUNNING request and leaves it claimable', async () => {
    const id = await makeRequest(fixture.spaceId, fixture.memberId, 'running');
    const before = await readRequest(id);
    expect(before.error).toBeNull();

    const result = await asApp(fixture.identityId, (q) =>
      q(`select public.note_tracking_refresh_stop($1,$2) as r`,
        [id, 'stopped: GitHub rate limit — UNAUTHENTICATED. 0 of 4 target(s) refreshed first.']));
    expect((result[0]!['r'] as { noted: boolean }).noted).toBe(true);

    const after = await readRequest(id);
    expect(after.error).toContain('GitHub rate limit');
    // THE INVARIANT. Still running, never completed: 081's stale window has to
    // be able to hand this row back, and a note that terminated it would swap a
    // silent stall for a silent lie.
    expect(after.status).toBe('running');
    expect(after.completed_at).toBeNull();
    expect(after.started_at).toBe(before.started_at);
  });

  it('overwrites an earlier note, because the LATEST stop is the useful one', async () => {
    const id = await makeRequest(fixture.spaceId, fixture.memberId, 'running', 'stopped: an older reason');
    await asApp(fixture.identityId, (q) =>
      q(`select public.note_tracking_refresh_stop($1,$2)`, [id, 'stopped: the newer reason']));
    expect((await readRequest(id)).error).toBe('stopped: the newer reason');
  });

  it('refuses a request in ANOTHER space — same predicate the claim door enforces', async () => {
    // Not a hypothetical: the observer runs across every space its identity
    // belongs to, so the request id it holds and the space it may write are two
    // different facts. `noted: false`, and the row is untouched.
    const id = await makeRequest(fixture.otherSpaceId, fixture.outsiderMemberId, 'running');

    const result = await asApp(fixture.identityId, (q) =>
      q(`select public.note_tracking_refresh_stop($1,$2) as r`, [id, 'stopped: should not land']));

    expect((result[0]!['r'] as { noted: boolean }).noted).toBe(false);
    expect((await readRequest(id)).error).toBeNull();
  });

  it('will not edit a request that is already terminal', async () => {
    // A completed or failed request is a closed record. Its `error` carries the
    // per-target problems the completion door wrote, and a late note from a tick
    // that was still unwinding must not overwrite them.
    for (const status of ['completed', 'failed'] as const) {
      const id = await makeRequest(fixture.spaceId, fixture.memberId, status, 'per-target problems');
      const result = await asApp(fixture.identityId, (q) =>
        q(`select public.note_tracking_refresh_stop($1,$2) as r`, [id, 'stopped: too late']));
      expect((result[0]!['r'] as { noted: boolean }).noted, status).toBe(false);
      expect((await readRequest(id)).error, status).toBe('per-target problems');
    }
  });

  it('a completion AFTER a note replaces it — the finished request describes its targets', async () => {
    // Precedence, stated as behaviour: an interruption is what the row says
    // while it is stalled; once it finishes, what matters is which targets
    // failed. This is the ordering the observer actually produces on a request
    // that stalls, gets handed back, and then completes.
    const id = await makeRequest(fixture.spaceId, fixture.memberId, 'running');
    await asApp(fixture.identityId, (q) =>
      q(`select public.note_tracking_refresh_stop($1,$2)`, [id, 'stopped: rate limit']));
    await asApp(fixture.identityId, (q) =>
      q(`select public.complete_tracking_refresh($1,$2,$3)`,
        [id, 'abc: not found', 'completed']));

    const after = await readRequest(id);
    expect(after.error).toBe('abc: not found');
    expect(after.status).toBe('completed');
  });

  it('a missing request is `noted: false`, never an exception', async () => {
    // The observer calls this while unwinding a tick. If a race — another node
    // completing the row — could raise here, a diagnostic would be able to take
    // down the tick it exists to describe.
    const result = await asApp(fixture.identityId, (q) =>
      q(`select public.note_tracking_refresh_stop($1,$2) as r`,
        ['00000000-0000-7000-8000-0000000000ff', 'stopped: nobody home']));
    expect((result[0]!['r'] as { noted: boolean }).noted).toBe(false);
  });

  it('clips an unbounded reason rather than storing it whole', async () => {
    // The text interpolates provider messages. An operator reading this column
    // should not be handed a megabyte of someone else's error.
    const id = await makeRequest(fixture.spaceId, fixture.memberId, 'running');
    await asApp(fixture.identityId, (q) =>
      q(`select public.note_tracking_refresh_stop($1,$2)`, [id, 'x'.repeat(9_000)]));
    expect((await readRequest(id)).error).toHaveLength(2_000);
  });

  it('is exposed to tm8_app and NOT to public', async () => {
    const rows = await database.query<{ app: boolean; pub: boolean }>(
      `select has_function_privilege('tm8_app', p.oid, 'EXECUTE') app,
              has_function_privilege('public',  p.oid, 'EXECUTE') pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='note_tracking_refresh_stop'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ app: true, pub: false });
  });
});
