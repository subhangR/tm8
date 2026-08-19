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

describe('the tick files a session under Done', () => {
  it('moves a RUNNING session to done and leaves the process alone', async () => {
    const id = await createSession('still going');
    await transition(id, 'running');
    expect((await rowOf(id)).status_category).toBe('in_progress');

    await tick(id);

    const after = await rowOf(id);
    expect(after.status_category).toBe('done');
    // THE RULING, in one assertion: the row is filed, the process is not
    // touched. A `set_session_done` that also stopped the session would pass
    // every other test in this file.
    expect(after.session_status).toBe('running');
  });

  it('bumps the version, so a client that pinned the old one conflicts', async () => {
    const id = await createSession('versioned');
    await transition(id, 'running');
    const before = await rowOf(id);

    await tick(id);

    expect((await rowOf(id)).version).toBeGreaterThan(before.version);
  });

  it('refuses a stale expectedVersion', async () => {
    const id = await createSession('stale pin');
    await transition(id, 'running');
    const { version } = await rowOf(id);

    await expect(
      asApp((q) =>
        q(`select public.set_session_done($1,$2,null,$3)`, [id, version - 1, cmid('stale')]),
      ),
    ).rejects.toThrow();
  });

  it('refuses a task — completion for those goes through complete_task', async () => {
    const taskId = await asOwner(async (q) => {
      const created = await q(
        `insert into public.entities(space_id,kind,parent_id,position,created_by)
         values($1,'task',null,0,$2) returning id`,
        [fixture.spaceId, fixture.memberId],
      );
      return created[0]!.id as string;
    });
    const { version } = await rowOf(taskId);

    await expect(
      asApp((q) =>
        q(`select public.set_session_done($1,$2,null,$3)`, [taskId, version, cmid('task')]),
      ),
    ).rejects.toThrow();
  });
});

describe('the mark survives the process moving underneath it', () => {
  /**
   * THE CASE THIS FILE EXISTS FOR. See the header: without 156's guard this is
   * a 23514 raised inside the node's own status writer, not a wrong category.
   */
  it('a ticked session stays done when its process goes idle', async () => {
    const id = await createSession('goes quiet');
    await transition(id, 'running');
    await tick(id);
    expect((await rowOf(id)).status_category).toBe('done');

    await transition(id, 'idle');

    const after = await rowOf(id);
    expect(after.status_category).toBe('done');
    expect(after.session_status).toBe('idle');
  });

  it('and the status write itself does not raise', async () => {
    // The other side of the same guard. A fix that swallowed the exception
    // somewhere above would satisfy this and fail the test before it; a fix
    // that stopped the bridge writing at all would satisfy both and break 155,
    // which is what `an unticked session still follows its process` catches.
    const id = await createSession('no raise');
    await transition(id, 'running');
    await tick(id);

    await expect(transition(id, 'idle')).resolves.toBeUndefined();
  });

  it('a ticked session stays done when its process exits — no reopen on the way', async () => {
    const id = await createSession('exits later');
    await transition(id, 'running');
    await tick(id);

    await transition(id, 'exited');

    expect((await rowOf(id)).status_category).toBe('done');
  });

  it('but RESUMING one reopens it — the clearest statement that you are not done', async () => {
    const id = await createSession('resumed');
    await transition(id, 'running');
    await tick(id);
    await transition(id, 'exited');

    /* Through `execution_resume`, not `work_session_transition` — R29's guard
       refuses `exited -> spawning` outright, and resume is precisely the caller
       that takes the escape hatch around it. Calling the transition function
       here would test a path no resume uses.

       The bridge then sees `spawning` -> to_do from a row sitting in `done`,
       which is 149's ruled REOPEN, so the guard added by 156 permits it. This
       is the one direction a marked-done session moves on its own, and it
       should: resuming is the clearest possible statement that you are not
       finished with it. */
    await asApp((q) =>
      q(`select public.execution_resume($1,8,null,$2,null)`, [id, cmid('resume')]),
    );

    expect(await rowOf(id)).toMatchObject({
      session_status: 'spawning',
      status_category: 'to_do',
    });
  });

  it('an unticked session still follows its process exactly as 155 left it', async () => {
    // 156 must be invisible to every row nobody has ticked. This is the
    // regression that a too-eager guard would cause.
    const id = await createSession('untouched');
    await transition(id, 'running');
    expect((await rowOf(id)).status_category).toBe('in_progress');
    await transition(id, 'idle');
    expect((await rowOf(id)).status_category).toBe('in_progress');
    await transition(id, 'exited');
    expect((await rowOf(id)).status_category).toBe('done');
  });
});

describe('the tick is a toggle', () => {
  it('un-ticking a running session puts it back under In Progress', async () => {
    const id = await createSession('back to work');
    await transition(id, 'running');
    await tick(id, 'on');
    expect((await rowOf(id)).status_category).toBe('done');

    await tick(id, 'off');

    const after = await rowOf(id);
    // Reopen is two ruled moves — done -> to_do, then to_do -> in_progress —
    // because the algebra has no `done -> in_progress` arm. The row genuinely
    // passes through reopen; what matters to a viewer is where it lands.
    expect(after.status_category).toBe('in_progress');
    expect(after.session_status).toBe('running');
  });

  it('un-ticking an EXITED session is a no-op — the process really did finish', async () => {
    const id = await createSession('really done');
    await transition(id, 'running');
    await transition(id, 'exited');
    expect((await rowOf(id)).status_category).toBe('done');

    await tick(id, 'off-exited');

    expect((await rowOf(id)).status_category).toBe('done');
  });

  it('replaying one clientMutationId does not flip it back', async () => {
    /* The standing objection to a stateful toggle: a caller that loses the
       response cannot tell "it worked" from "it never ran". Answered by the
       ledger rather than by a `done` argument — which is what lets this ship
       without amending `CompleteTaskInputSchema`, a `.strict()` schema shared
       with every task completion. */
    const id = await createSession('replayed');
    await transition(id, 'running');
    const { version } = await rowOf(id);
    const once = cmid('replay');

    await asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [id, version, once]));
    expect((await rowOf(id)).status_category).toBe('done');

    await asApp((q) => q(`select public.set_session_done($1,$2,null,$3)`, [id, version, once]));
    expect((await rowOf(id)).status_category).toBe('done');
  });
});

describe('the tick’s stickiness is borrowed from the algebra', () => {
  /**
   * THE TRIPWIRE. 156 stores no `marked_done` column: a tick sticks purely
   * because `done -> in_progress` is not a ruled transition, so the bridge's
   * guard declines to undo it. That is a deliberate choice — one fact instead
   * of two that could disagree — and its whole cost is this dependency.
   *
   * Adding the arm to 149 would un-stick every tick in the product with no
   * error and no other failing test. This is where that shows up.
   */
  it('149 still has no done -> in_progress arm', async () => {
    const rows = await database.query<{ allowed: boolean }>(
      `select internal.category_transition_allowed('done','in_progress') allowed`,
    );
    expect(rows[0]!.allowed).toBe(false);
  });

  it('and the reopen it forces instead is still ruled', async () => {
    const rows = await database.query<{ reopen: boolean; start: boolean }>(
      `select internal.category_transition_allowed('done','to_do') reopen,
              internal.category_transition_allowed('to_do','in_progress') start`,
    );
    expect(rows[0]!.reopen).toBe(true);
    expect(rows[0]!.start).toBe(true);
  });
});
