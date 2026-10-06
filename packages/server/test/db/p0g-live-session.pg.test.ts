/**
 * P0g (task 01a111b2-aaf2) against a real Postgres, on top of 302's claim
 * lifecycle (Spec D1):
 * - ac3: `badges.liveSession` — the "no live session" flag on working and
 *   blocked tasks (owner policy, form 01a111ba-85b5: flag only);
 * - ac4: the `task_still_working` nudge on a session's own results.
 *
 * Sessions are made through the real `execution_spawn` door, as tm8_app; an
 * agent's own calls carry `tm8.work_session_id`, as the server forwards it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadTaskLiveSessionBadges } from '../../src/tracking/live-session-projection.js';
import { stillWorkingWarnings, TASK_STILL_WORKING } from '../../src/tracking/status-nudge.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

let database: W1ScratchDatabase;
let fixture: Fixture;
let unique = 0;
const cmid = (label: string): string => `p0g-${label}-${(unique += 1)}`;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'p0g-owner'::text "identityId", internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId", internal.new_id()::text "teamMemberId"`,
      )
    ).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Owner')`, [
      f.identityId,
    ]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'P0g',$2)`, [
      f.spaceId,
      f.identityId,
    ]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [f.memberId, f.teamMemberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Worker','','persona')`,
      [f.teamMemberId, f.memberId],
    );
    return f;
  });
}

/**
 * As tm8_app. `asSession` makes the call the way an agent inside that session
 * does: acting as its teammate, with the verified work-session claim set.
 */
async function asApp<T>(fn: (q: Q) => Promise<T>, asSession?: string): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id',$2,true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-p0g',true),
              set_config('tm8.work_session_id',$3,true)`,
      [fixture.identityId, asSession ? fixture.teamMemberId : '', asSession ?? ''],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/** Postgres error → `{code, reason}` so refusals can be asserted by their named reason. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; reason: string | undefined; detail: unknown }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: string; detail?: string };
    let detail: unknown = e.detail;
    try {
      detail = e.detail ? JSON.parse(e.detail) : undefined;
    } catch {
      /* plain-text detail */
    }
    return { code: e.code ?? '', reason: (detail as { reason?: string } | undefined)?.reason, detail };
  }
  throw new Error('expected a refusal, the call succeeded');
}

async function createTask(title: string): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.create_task($1,$2,null,'',$3::jsonb,null,null,'medium','[]'::jsonb,null,null,null,null,'attached_to',$4) result`,
      [fixture.spaceId, title, '{}', cmid('task')],
    ),
  );
  return (rows[0]!.result as { entity: { id: string } }).entity.id;
}

async function spawn(taskIds: string[], cap = 64): Promise<string> {
  const rows = await asApp((q) =>
    q(
      `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => $3::uuid[],
         p_workdir_mode => 'scratch', p_model => 'claude-opus-5', p_agent_tool => 'claude',
         p_title => 'Run', p_node_id => 'node-local', p_confirm_untrusted => true,
         p_session_cap => $4, p_client_mutation_id => $5) result`,
      [fixture.spaceId, fixture.teamMemberId, taskIds, cap, cmid('spawn')],
    ),
  );
  const id = (rows[0]!.result as { entity: { id: string } }).entity.id;
  await settle(id);
  return id;
}

/** The launcher records the credential binding before the PTY runs (273). */
async function settle(id: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `select internal.settle_credential_binding($1, '{"effectiveCredentialSources":{"anthropic":"node"}}'::jsonb)`,
      [id],
    );
  });
}

async function transition(sessionId: string, status: string, endedKind: string | null = null): Promise<void> {
  await asApp((q) =>
    q(`select public.work_session_transition($1,$2,null,null,null,$3,$4,null)`, [
      sessionId,
      status,
      cmid(status),
      endedKind,
    ]),
  );
}

async function running(taskIds: string[]): Promise<string> {
  const id = await spawn(taskIds);
  await transition(id, 'running');
  return id;
}

/**
 * A message on `anchorId`, written as the owner. The post door is not what is
 * under test, and the legacy `post_message` is not granted to tm8_app; the row
 * shape is what `w2_post_message_batch` writes. `asSession` makes the agent the
 * author (its teammate), as an agent's own `tm8 message send` would.
 */
async function post(anchorId: string, body: string, asSession?: string): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const author = asSession ? fixture.teamMemberId : fixture.memberId;
    const id = (
      await client.query<{ id: string }>(
        `insert into public.entities(space_id,kind,parent_id,position,created_by)
         values($1,'message',null,0,$2) returning id`,
        [fixture.spaceId, author],
      )
    ).rows[0]!.id;
    await client.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body) values($1,$2,$3,$4)`,
      [id, anchorId, author, body],
    );
    return id;
  });
}

async function setWork(taskId: string, status: string, opts: { claim?: boolean; asSession?: string } = {}) {
  return asApp(
    (q) =>
      q(`select public.set_work_state($1,$2,null,null,null,$3,false,$4) result`, [
        taskId,
        status,
        cmid('work'),
        opts.claim ?? false,
      ]),
    opts.asSession,
  );
}

async function completeTask(taskId: string): Promise<void> {
  const v = await database.query<{ version: number }>(`select version from public.entities where id=$1`, [taskId]);
  await asApp((q) => q(`select public.complete_task($1,$2,'{}',null,$3)`, [taskId, v[0]!.version, cmid('done')]));
}

const complete = (sessionId: string, receipt: string | null = null, asSession?: string) =>
  asApp(
    (q) => q(`select public.complete_work_session($1,$2,null,$3) result`, [sessionId, receipt, cmid('complete')]),
    asSession,
  );
const stop = (sessionId: string, note: string | null = null) =>
  asApp((q) => q(`select public.stop_work_session($1,$2,null,$3) result`, [sessionId, note, cmid('stop')]));
async function resume(sessionId: string): Promise<void> {
  await asApp((q) => q(`select public.execution_resume($1,64,null,$2,null) result`, [sessionId, cmid('resume')]));
  await settle(sessionId);
}


/** The loaders take a Querier; a test one runs inside `asApp`'s transaction. */
function querier(q: Q): Querier {
  return {
    query: async <R,>(sql: string, params?: readonly unknown[]) => (await q(sql, [...(params ?? [])])) as R[],
    rpc: async () => { throw new Error('read-only querier'); },
  } as Querier;
}

const liveSession = (taskId: string) =>
  asApp(async (q) => (await loadTaskLiveSessionBadges(querier(q), [{ id: taskId, kind: 'task' }])).get(taskId));

/** A person's claim as the 2 Oct bulk import wrote it: member → task, no session. */
async function memberClaim(taskId: string, at: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by,created_at)
       values($1,$2,$3,'working_on','{}'::jsonb,$2,$4)`,
      [fixture.spaceId, fixture.memberId, taskId, at],
    );
    // The claim trigger stamps `startedAt` at insert; an old claim started then.
    await client.query(
      `update public.edges set props = props || jsonb_build_object('startedAt', $3::text)
        where src_id=$1 and dst_id=$2 and type='working_on'`,
      [fixture.memberId, taskId, at],
    );
  });
}

async function forceStatus(taskId: string, status: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`update public.tasks set work_status=$2 where entity_id=$1`, [taskId, status]);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('p0g-live-session');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('ac3 — badges.liveSession on working and blocked tasks', () => {
  it('is live while the claiming session runs, and names it', async () => {
    const t = await createTask('live');
    const s = await running([t]);
    expect(await liveSession(t)).toMatchObject({ state: 'live', sessionId: s });
  });

  it('is session_down after a crash: the claim is kept (D1 R5), the chip says so', async () => {
    const t = await createTask('crash');
    const s = await running([t]);
    await transition(s, 'failed', 'crashed');
    const v = await liveSession(t);
    expect(v).toMatchObject({ state: 'session_down', sessionId: s });
    expect(v?.since).not.toBeNull();
  });

  it('is no_session after an operator stop, and the task keeps its status (flag only)', async () => {
    const t = await createTask('stopped');
    const s = await running([t]);
    await stop(s, 'stopping');
    const v = await liveSession(t);
    expect(v).toMatchObject({ state: 'no_session', sessionId: null });
    expect(v?.since).not.toBeNull(); // the claim's endedAt
    const status = await database.query<{ work_status: string }>(
      `select work_status from public.tasks where entity_id=$1`, [t]);
    expect(status[0]!.work_status).toBe('working');
  });

  it('is no_session after the session releases the task with a note', async () => {
    const t = await createTask('released');
    const s = await running([t]);
    await asApp((q) => q(`select public.release_task_claim($1,$2,null,$3)`, [t, 'handing off', cmid('rel')]), s);
    expect((await liveSession(t))?.state).toBe('no_session');
  });

  it('flags a blocked task the same way, and leaves in_review, open and done tasks unbadged', async () => {
    const t = await createTask('blocked');
    const s = await running([t]);
    await setWork(t, 'blocked', { asSession: s });
    expect((await liveSession(t))?.state).toBe('live');
    await stop(s);
    expect((await liveSession(t))?.state).toBe('no_session');
    await forceStatus(t, 'in_review');
    expect(await liveSession(t)).toBeUndefined();
    const open = await createTask('open');
    expect(await liveSession(open)).toBeUndefined();
  });

  it('person_idle for an old member claim with no activity, person once the holder posts on the task', async () => {
    const t = await createTask('person');
    await forceStatus(t, 'working');
    await memberClaim(t, '2026-09-01T06:44:00Z');
    expect((await liveSession(t))?.state).toBe('person_idle');
    await post(t, 'still on it');
    expect((await liveSession(t))?.state).toBe('person');
  });
});

describe('ac4 — task_still_working nudge for the calling session', () => {
  const nudges = (taskIds: string[], asSession?: string, explicit?: string | null) =>
    asApp((q) => stillWorkingWarnings(querier(q), taskIds, explicit), asSession);

  it('nudges the session that holds the task in working, with the next commands filled in', async () => {
    const t = await createTask('nudge');
    const s = await running([t]);
    const w = await nudges([t], s);
    expect(w).toHaveLength(1);
    expect(w[0]!.code).toBe(TASK_STILL_WORKING);
    expect(w[0]!.message).toContain(`tm8 task complete ${t} --expect-version`);
    expect(w[0]!.message).toContain(`tm8 task transition ${t} in_review`);
    expect(w[0]!.message).toContain(`tm8 task release ${t}`);
    // The explicit session id (message post resolves it from the bearer) gives the same answer.
    expect(await nudges([t], undefined, s)).toHaveLength(1);
  });

  it('is silent once the status moved, for another session, and for a person', async () => {
    const t = await createTask('moved');
    const s = await running([t]);
    await setWork(t, 'in_review', { asSession: s });
    expect(await nudges([t], s)).toEqual([]);

    const u = await createTask('other');
    const holder = await running([u]);
    const other = await running([]);
    expect(await nudges([u], other)).toEqual([]);
    expect(await nudges([u])).toEqual([]);
    expect(await nudges([u], holder)).toHaveLength(1);
  });

  it('is silent after the session released its claim', async () => {
    const t = await createTask('released-nudge');
    const s = await running([t]);
    await asApp((q) => q(`select public.release_task_claim($1,$2,null,$3)`, [t, 'later', cmid('rel2')]), s);
    expect(await nudges([t], s)).toEqual([]);
  });
});
