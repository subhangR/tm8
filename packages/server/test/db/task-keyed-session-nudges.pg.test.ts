/**
 * 207 — task-keyed session nudges, and the task_state loop's detection.
 *
 * Spec §6.1 #11: the loop fires ONCE per (session, task, loop), SURVIVES A
 * RESTART through the database, and is NOT RE-SENT. Every read below happens
 * in a fresh transaction on a pooled connection, with nothing held in process
 * between them — which is all a restart takes away. The dedup answer has to
 * come from Postgres, or these fail.
 *
 * The decision (own transition, not live) is TypeScript and is covered by
 * test/tracking/task-nudges.test.ts. This file proves the facts that decision
 * is handed are the right ones, and that the send door holds the ledger.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let database: W1ScratchDatabase;

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  otherTeammateId: string;
}

let f: Fixture;

type Q = (sql: string, params?: readonly unknown[]) => Promise<Record<string, unknown>[]>;

async function owner<T>(fn: (q: Q) => Promise<T>, actorId?: string): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    if (actorId) await client.query(`select set_config('tm8.actor_id', $1, true)`, [actorId]);
    return fn(async (sql, params = []) => (await client.query(sql, [...params])).rows);
  });
}

async function asMember<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [f.identityId]);
    await client.query(`select set_config('tm8.auth_kind', 'browser', true)`);
    return fn(client);
  });
}

async function seedFixture(): Promise<Fixture> {
  const fx: Fixture = {
    identityId: `task-nudge-${randomUUID()}`,
    spaceId: randomUUID(),
    memberId: randomUUID(),
    teammateId: randomUUID(),
    otherTeammateId: randomUUID(),
  };
  await owner(async (q) => {
    await q(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Lead')`,
      [fx.identityId]);
    await q(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Nudges', $2)`,
      [fx.spaceId, fx.identityId]);
    await q(
      `insert into public.entities(id, space_id, kind, position, created_by, visibility)
       values ($1,$4,'member',0,$1,'space'), ($2,$4,'team_member',1,$1,'space'),
              ($3,$4,'team_member',2,$1,'space')`,
      [fx.memberId, fx.teammateId, fx.otherTeammateId, fx.spaceId],
    );
    await q(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Lead')`,
      [fx.memberId, fx.spaceId, fx.identityId],
    );
    await q(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$3,'Worker','worker','m','claude-code'), ($2,$3,'Other','worker','m','claude-code')`,
      [fx.teammateId, fx.otherTeammateId, fx.memberId],
    );
  });
  return fx;
}

async function seedTask(title: string, assignees: string[]): Promise<string> {
  const taskId = randomUUID();
  await owner(async (q) => {
    await q(
      `insert into public.entities(id, space_id, kind, position, created_by, visibility)
       values ($1,$2,'task',10,$3,'space')`,
      [taskId, f.spaceId, f.memberId],
    );
    await q(`insert into public.tasks(entity_id, title, work_status) values ($1,$2,'working')`,
      [taskId, title]);
    for (const assignee of assignees) {
      await q(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1,$2,$3,'assigned_to',$4)`,
        [f.spaceId, taskId, assignee, f.memberId],
      );
    }
  });
  return taskId;
}

/** A work session of `teammate`, `working_on` `taskId`, as execution_spawn draws it. */
async function seedSession(
  taskId: string,
  teammate: string,
  options: { status?: string; kind?: 'agent' | 'credential' } = {},
): Promise<string> {
  const sessionId = randomUUID();
  await owner(async (q) => {
    await q(
      `insert into public.entities(id, space_id, kind, position, created_by, visibility)
       values ($1,$2,'work_session',20,$3,'space')`,
      [sessionId, f.spaceId, f.memberId],
    );
    await q(
      `insert into public.work_sessions(entity_id, title, status, share_mode, session_kind, workdir_mode)
       values ($1,'worker',$2,'space',$3, 'scratch')`,
      [sessionId, options.status ?? 'running', options.kind ?? 'agent'],
    );
    await q(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1,$2,$3,'working_on',$5), ($1,$2,$4,'relates_to',$5)`,
      [f.spaceId, sessionId, taskId, teammate, f.memberId],
    );
  });
  return sessionId;
}

async function setStatus(taskId: string, status: string, actorId: string): Promise<void> {
  await owner(async (q) => {
    await q(`update public.tasks set work_status = $2 where entity_id = $1`, [taskId, status]);
  }, actorId);
}

async function pendingFor(taskId: string): Promise<Record<string, unknown>[]> {
  return owner((q) => q(
    `select work_session_id::text as session, cause, status, actor_id::text as actor,
            teammate_id::text as teammate, state, retire_reason
       from public.pending_task_nudges where task_id = $1 order by detected_at, id`,
    [taskId],
  ));
}

async function claimPending(): Promise<Record<string, unknown>[]> {
  return asMember(async (client) => {
    const row = (await client.query<{ r: { pending: Record<string, unknown>[] } }>(
      `select public.claim_pending_task_nudges(100, 24) r`)).rows[0]!;
    return row.r.pending;
  });
}

async function post(pendingId: string, body: string): Promise<Record<string, unknown>> {
  return asMember(async (client) => (
    await client.query<{ r: Record<string, unknown> }>(
      `select public.post_task_nudge($1, $2, $3) r`,
      [pendingId, body, `test-${randomUUID()}`],
    )
  ).rows[0]!.r);
}

async function messagesOn(sessionId: string): Promise<string[]> {
  const rows = await owner((q) => q(
    `select body from public.messages where anchor_id = $1 order by created_at`,
    [sessionId],
  ));
  return rows.map((r) => String(r.body));
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('task_nudges_207');
  database.apply(migrationFiles());
  f = await seedFixture();
});

afterAll(async () => {
  await database?.destroy();
});

describe('207 — task_state detection', () => {
  it('enqueues one row per live agent session working the task, with actor and teammate', async () => {
    const task = await seedTask('cancel me', [f.teammateId]);
    const live = await seedSession(task, f.teammateId);
    await seedSession(task, f.teammateId, { status: 'exited' });
    await seedSession(task, f.teammateId, { kind: 'credential' });

    await setStatus(task, 'cancelled', f.memberId);

    expect(await pendingFor(task)).toEqual([{
      session: live, cause: 'cancelled', status: 'cancelled', actor: f.memberId,
      teammate: f.teammateId, state: 'pending', retire_reason: null,
    }]);
  });

  it('records a self-completion with actor = the session teammate, for the decision to drop', async () => {
    const task = await seedTask('finish me', [f.teammateId]);
    const live = await seedSession(task, f.teammateId);

    await setStatus(task, 'done', f.teammateId);

    expect(await pendingFor(task)).toMatchObject([{
      session: live, cause: 'completed', status: 'done', actor: f.teammateId, teammate: f.teammateId,
    }]);
  });

  it('ignores transitions that are not into done or cancelled', async () => {
    const task = await seedTask('block me', [f.teammateId]);
    await seedSession(task, f.teammateId);
    await setStatus(task, 'blocked', f.memberId);
    expect(await pendingFor(task)).toEqual([]);
  });

  it('on unassignment, enqueues only the unassigned teammate\'s sessions', async () => {
    const task = await seedTask('share me', [f.teammateId, f.otherTeammateId]);
    const mine = await seedSession(task, f.teammateId);
    await seedSession(task, f.otherTeammateId);

    await owner(async (q) => {
      await q(`delete from public.edges where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
        [task, f.teammateId]);
    }, f.memberId);

    expect(await pendingFor(task)).toMatchObject([{
      session: mine, cause: 'unassigned', status: null, actor: f.memberId, teammate: f.teammateId,
    }]);
  });

  it('never fails the write it observes: hard-deleting a task still commits', async () => {
    const task = await seedTask('delete me', [f.teammateId]);
    await seedSession(task, f.teammateId);
    await owner(async (q) => {
      await q(`delete from public.entities where id = $1`, [task]);
    }, f.memberId);
    const left = await owner((q) => q(`select 1 from public.entities where id = $1`, [task]));
    expect(left).toEqual([]);
  });
});

describe('207 — the ledger fires once per (session, task, loop) and survives a restart', () => {
  it('posts once, then refuses every later attempt from the database alone', async () => {
    const task = await seedTask('stop me', [f.teammateId]);
    const session = await seedSession(task, f.teammateId);
    await setStatus(task, 'cancelled', f.memberId);

    const [first] = (await claimPending()).filter((r) => r.taskId === task);
    expect(first).toMatchObject({ workSessionId: session, cause: 'cancelled', sessionStatus: 'running' });
    const body = `Task ${task} is now cancelled: stop and report.`;
    const sent = await post(String(first!.pendingId), body);
    expect(sent).toMatchObject({ posted: true, workSessionId: session });

    const ledger = await owner((q) => q(
      `select loop_kind, fired_at is not null as stamped, message_id::text as message
         from public.session_task_nudges where work_session_id = $1 and task_id = $2`,
      [session, task],
    ));
    expect(ledger).toEqual([{ loop_kind: 'task_state', stamped: true, message: sent.messageId }]);

    // Replaying the same row: already settled, nothing sent.
    expect(await post(String(first!.pendingId), body))
      .toMatchObject({ posted: false, reason: 'already_settled' });

    // "Restart", then a NEW transition for the same (session, task): the
    // teammate is now unassigned too. A fresh pending row is detected, and the
    // ledger — not any process memory — refuses it.
    await owner(async (q) => {
      await q(`delete from public.edges where src_id = $1 and dst_id = $2 and type = 'assigned_to'`,
        [task, f.teammateId]);
    }, f.memberId);
    const [second] = (await claimPending()).filter((r) => r.taskId === task);
    expect(second!.pendingId).not.toBe(first!.pendingId);
    expect(await post(String(second!.pendingId), body))
      .toMatchObject({ posted: false, reason: 'duplicate' });

    expect(await pendingFor(task)).toMatchObject([
      { state: 'delivered' },
      { state: 'retired', retire_reason: 'duplicate' },
    ]);
    expect((await messagesOn(session)).filter((b) => b === body)).toHaveLength(1);
  });

  it('does not claim the ledger for a session that exited before the send', async () => {
    const task = await seedTask('too late', [f.teammateId]);
    const session = await seedSession(task, f.teammateId);
    await setStatus(task, 'cancelled', f.memberId);
    await owner(async (q) => {
      // R29's single-writer guard; the fixture stands in for the transition function.
      await q(`select set_config('tm8.work_session_transition', 'on', true)`);
      await q(`update public.work_sessions set status = 'exited' where entity_id = $1`, [session]);
    });

    const [row] = (await claimPending()).filter((r) => r.taskId === task);
    expect(row).toMatchObject({ sessionStatus: 'exited' });
    expect(await post(String(row!.pendingId), 'x'))
      .toMatchObject({ posted: false, reason: 'session_not_live' });
    const ledger = await owner((q) => q(
      `select 1 from public.session_task_nudges where work_session_id = $1`, [session]));
    expect(ledger).toEqual([]);
  });

  it('settles a declined row with the decision\'s reason', async () => {
    const task = await seedTask('mine', [f.teammateId]);
    await seedSession(task, f.teammateId);
    await setStatus(task, 'done', f.teammateId);
    const [row] = (await claimPending()).filter((r) => r.taskId === task);
    await asMember((client) => client.query(
      `select public.settle_pending_task_nudge($1, 'own_transition', null)`, [row!.pendingId]));
    expect(await pendingFor(task)).toMatchObject([{ state: 'retired', retire_reason: 'own_transition' }]);
  });
});
