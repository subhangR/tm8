/**
 * 156 against a real Postgres: A USER CAN FILE A SESSION UNDER DONE WITHOUT
 * ENDING IT.
 *
 * ## The claim, and why only a real database can check it
 *
 * The ruling (2026-08-19) is one sentence — "tick marks the session done, but
 * does not close it" — and the whole of it lives in triggers. `set_session_done`
 * writes `entities.status_id`; that fires `entities_status_from_state`, which
 * consults 149's transition algebra; the process meanwhile keeps writing
 * `work_sessions.status`, which fires 155's bridge, which writes the same
 * column back. Three writers, two triggers, one column. No unit test reaches
 * any of it.
 *
 * ## The case this file exists for
 *
 * `a ticked session survives its own process going idle`. 155's bridge derived
 * the envelope from the status unconditionally. The moment a user could put a
 * RUNNING session into `done`, the next status write asked for
 * `done -> in_progress` — which the algebra refuses outright — and the raise
 * would have landed INSIDE `public.work_session_transition`, the node's own
 * writer, on a path with no user in front of it. A tick would have started
 * breaking the session lifecycle seconds later.
 *
 * So the guard is not a nicety. Two tests pin it from opposite sides: the
 * behaviour (the mark sticks) and the mechanism (the status write does not
 * raise). Either alone would pass against a subtly wrong fix — swallowing the
 * exception would satisfy the second and fail the first; skipping every bridge
 * write would satisfy both and break 155.
 *
 * ## The tripwire
 *
 * `the tick's stickiness is the algebra's ruling` asserts the ABSENCE of a
 * `done -> in_progress` arm. That is what makes the mark stick, and it is
 * borrowed rather than owned: adding that arm to 149 would silently un-stick
 * every tick in the product with no error and no other failing test. This is
 * the one that goes red.
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
  return `session-done-156-${label}-${unique}`;
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
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-156',true)`,
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
        `select 'session-done-156-owner'::text "identityId",
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

/** 155's own fixture shape: envelope, then the detail row born `spawning`. */
async function createSession(title = 'A run'): Promise<string> {
  const rows = await asOwner(async (q) => {
    const created = await q(
      `insert into public.entities(space_id,kind,parent_id,position,created_by)
       values($1,'work_session',null,0,$2) returning id`,
      [fixture.spaceId, fixture.memberId],
    );
    const id = created[0]!.id as string;
    await q(`insert into public.work_sessions(entity_id,title,status) values($1,$2,'spawning')`, [id, title]);
    // The launcher records the binding before the PTY exists (session_credential_binding);
    // a node-rung manifest settles it `legacy`, so the row may leave spawning.
    await q(`select internal.settle_credential_binding($1, '{"effectiveCredentialSources":{"anthropic":"node"}}'::jsonb)`, [id]);
    return created;
  });
  return rows[0]!.id as string;
}

async function transition(sessionId: string, status: string): Promise<void> {
  await asApp((q) =>
    q(`select public.work_session_transition($1,$2,null,null,null,$3)`, [sessionId, status, cmid(status)]),
  );
}

interface Row {
  status_category: string | null;
  session_status: string | null;
  version: number;
}

async function rowOf(sessionId: string): Promise<Row> {
  const rows = await database.query<Row>(
    `select e.status_category, e.version, ws.status session_status
       from public.entities e
       left join public.work_sessions ws on ws.entity_id = e.id
      where e.id = $1`,
    [sessionId],
  );
  return rows[0]!;
}

async function tick(sessionId: string, label = 'tick'): Promise<void> {
  const { version } = await rowOf(sessionId);
  await asApp((q) =>
    q(`select public.set_session_done($1,$2,null,$3)`, [sessionId, version, cmid(label)]),
  );
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session-mark-done-156');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

/**
 * 299 (Spec D1) REDEFINED THE TICK. `set_session_done` is now `session
 * complete`: it settles the session's OUTCOME as completed, which needs a
 * receipt (the session's latest message on its anchor) and passes the claim
 * check. It is no longer a toggle — completed is final — and the "mark
 * survives the process" property is now structural: the category comes from
 * the outcome first, so no process write can move a completed row.
 */
async function closeOut(sessionId: string, body = 'Close-out: done.'): Promise<string> {
  // The session's teammate writes it, as an agent's own close-out would: a
  // message author is always a member or teammate, and the receipt rule reads
  // the session's teammate through its `relates_to` edge.
  return asOwner(async (q) => {
    const tm = await q(
      `insert into public.entities(space_id,kind,parent_id,position,created_by)
       values($1,'team_member',null,0,$2) returning id`,
      [fixture.spaceId, fixture.memberId],
    );
    const teammate = tm[0]!.id as string;
    await q(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Worker','','persona')`,
      [teammate, fixture.memberId],
    );
    await q(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'relates_to',$4)`,
      [fixture.spaceId, sessionId, teammate, fixture.memberId],
    );
    const m = await q(
      `insert into public.entities(space_id,kind,parent_id,position,created_by)
       values($1,'message',null,0,$2) returning id`,
      [fixture.spaceId, teammate],
    );
    const id = m[0]!.id as string;
    await q(`insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)`, [
      id,
      sessionId,
      teammate,
      body,
    ]);
    return id;
  });
}

async function outcomeOf(sessionId: string): Promise<string> {
  const rows = await database.query<{ outcome: string }>(
    `select outcome from public.work_sessions where entity_id = $1`,
    [sessionId],
  );
  return rows[0]!.outcome;
}

async function refused(p: Promise<unknown>): Promise<{ code: string; reason?: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; detail?: string };
    let reason: string | undefined;
    try {
      reason = (JSON.parse(e.detail ?? '{}') as { reason?: string }).reason;
    } catch {
      reason = undefined;
    }
    return { code: e.code ?? '', ...(reason === undefined ? {} : { reason }) };
  }
  throw new Error('expected a refusal');
}

describe('the tick completes a session (299)', () => {
  it('moves a RUNNING session to done, completed, and leaves the process alone', async () => {
    const sessionId = await createSession('ticked');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    await tick(sessionId);
    expect(await rowOf(sessionId)).toMatchObject({ status_category: 'done', session_status: 'running' });
    expect(await outcomeOf(sessionId)).toBe('completed');
  });

  it('needs a receipt: with no message on the anchor it refuses receipt_required and changes nothing', async () => {
    const sessionId = await createSession('no-receipt');
    await transition(sessionId, 'running');
    expect((await refused(tick(sessionId))).reason).toBe('receipt_required');
    expect(await rowOf(sessionId)).toMatchObject({ status_category: 'in_progress' });
    expect(await outcomeOf(sessionId)).toBe('open');
  });

  it('bumps the version, so a client that pinned the old one conflicts', async () => {
    const sessionId = await createSession('versioned');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    const before = (await rowOf(sessionId)).version;
    await tick(sessionId);
    expect((await rowOf(sessionId)).version).toBeGreaterThan(before);
  });

  it('refuses a stale expectedVersion', async () => {
    const sessionId = await createSession('stale');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    const { version } = await rowOf(sessionId);
    const r = await refused(
      asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [sessionId, version - 1, cmid('stale')])),
    );
    expect(r.code).not.toBe('');
    expect(await outcomeOf(sessionId)).toBe('open');
  });

  it('refuses a task — completion for those goes through complete_task', async () => {
    const taskId = await asOwner(async (q) => {
      const t = await q(
        `insert into public.entities(space_id,kind,parent_id,position,created_by)
         values($1,'task',null,0,$2) returning id, version`,
        [fixture.spaceId, fixture.memberId],
      );
      return t[0]!.id as string;
    });
    const r = await refused(asApp((q) => q(`select public.set_session_done($1,1,null,$2)`, [taskId, cmid('task')])));
    expect(r.code).not.toBe('');
  });
});

describe('a completed session stays completed whatever its process does', () => {
  it('idle, exit and failure after completion move the process only', async () => {
    const sessionId = await createSession('sticky');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    await tick(sessionId);
    await transition(sessionId, 'idle');
    expect(await rowOf(sessionId)).toMatchObject({ status_category: 'done', session_status: 'idle' });
    await transition(sessionId, 'failed');
    expect(await rowOf(sessionId)).toMatchObject({ status_category: 'done', session_status: 'failed' });
    expect(await outcomeOf(sessionId)).toBe('completed');
  });

  it('resuming a completed session is refused — a follow-up session does more work', async () => {
    const sessionId = await createSession('no-resume');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    await tick(sessionId);
    await transition(sessionId, 'exited');
    const r = await refused(
      asApp((q) => q(`select public.execution_resume($1,8,null,$2,null)`, [sessionId, cmid('resume')])),
    );
    expect(r.reason).toBe('session_completed');
  });

  it('an unticked session follows its process — and an ended open session is in_progress, not done', async () => {
    const sessionId = await createSession('follows');
    await transition(sessionId, 'running');
    expect((await rowOf(sessionId)).status_category).toBe('in_progress');
    await transition(sessionId, 'exited');
    expect(await rowOf(sessionId)).toMatchObject({ status_category: 'in_progress', session_status: 'exited' });
  });
});

describe('the tick is no longer a toggle', () => {
  it('un-ticking a completed session is refused with session_completed', async () => {
    const sessionId = await createSession('untick');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    await tick(sessionId);
    expect((await refused(tick(sessionId, 'untick'))).reason).toBe('session_completed');
    expect(await outcomeOf(sessionId)).toBe('completed');
  });

  it('replaying one clientMutationId returns the stored result and changes nothing', async () => {
    const sessionId = await createSession('replay');
    await transition(sessionId, 'running');
    await closeOut(sessionId);
    const { version } = await rowOf(sessionId);
    const id = cmid('replayed');
    await asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [sessionId, version, id]));
    const after = await rowOf(sessionId);
    await asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [sessionId, version, id]));
    expect(await rowOf(sessionId)).toEqual(after);
    expect(await outcomeOf(sessionId)).toBe('completed');
  });
});
