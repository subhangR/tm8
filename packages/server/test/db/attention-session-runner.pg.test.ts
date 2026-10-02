/**
 * Migration 277 — attention goes to whoever runs the session.
 *
 * A request raised from a work session (source_session_id) with no assignee is
 * assigned to the active member running that session: the human who created
 * it, else the account on its agent token, else its parent session's runner.
 * An explicit assignee wins; an unresolvable session leaves it unassigned.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  spaceId: string;
  memberId: string;
  otherMemberId: string;
  leftMemberId: string;
  agentId: string;
  taskId: string;
}

describe.sequential('attention: assign to the session runner (migration 277)', () => {
  let database: W1ScratchDatabase;
  let f: Fixture;

  const asOwner = <T>(fn: (c: PoolClient) => Promise<T>) =>
    database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      return fn(c);
    });

  const newSession = (createdBy: string, parentId: string | null = null) =>
    asOwner(async (c) => {
      const id = (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await c.query(`insert into public.entities(id,space_id,kind,parent_id,position,created_by)
                     values($1,$2,'work_session',$3,0,$4)`, [id, f.spaceId, parentId, createdBy]);
      await c.query(`insert into public.work_sessions(entity_id,status) values($1,'running')`, [id]);
      return id;
    });

  const agentToken = (sessionId: string, identityId: string, revoked = false) =>
    asOwner((c) => c.query(
      `insert into public.auth_sessions(account_id,kind,token_hash,expires_at,work_session_id,revoked_at,space_id)
       select a.id, 'agent', encode(sha256(gen_random_uuid()::text::bytea),'hex'), now() + interval '1 day', $2,
              case when $3 then now() end, $4::uuid
         from public.accounts a where a.identity_id = $1`,
      [identityId, sessionId, revoked, f.spaceId],
    ));

  const raise = (sessionId: string | null, assigneeId: string | null = null) =>
    asOwner(async (c) => (await c.query<{ assignee_id: string | null }>(
      `insert into public.attention_requests(space_id,entity_id,reason,points,requested_by,source_session_id,assignee_id)
       values($1,$2,'Pick one',40,$3,$4,$5) returning assignee_id::text`,
      [f.spaceId, f.taskId, f.agentId, sessionId, assigneeId],
    )).rows[0]!.assignee_id);

  beforeAll(async () => {
    database = await createW1ScratchDatabase('attention_session_runner');
    database.apply(migrationFiles());
    f = await asOwner(async (c) => {
      const x = (await c.query<Fixture>(
        `select internal.new_id()::text "spaceId", internal.new_id()::text "memberId",
                internal.new_id()::text "otherMemberId", internal.new_id()::text "leftMemberId",
                internal.new_id()::text "agentId", internal.new_id()::text "taskId"`,
      )).rows[0]!;
      await c.query(`insert into public.user_profiles(identity_id,display_name)
                     values('runner-a','A'),('runner-b','B'),('runner-c','C')`);
      await c.query(`insert into public.accounts(identity_id,username)
                     values('runner-a','runner-a'),('runner-b','runner-b'),('runner-c','runner-c')`);
      await c.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Runner','runner-a')`, [x.spaceId]);
      await c.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
           ($1,$2,'member',null,0,$1), ($3,$2,'member',null,1,$3), ($4,$2,'member',null,2,$4),
           ($5,$2,'team_member',null,3,$1), ($6,$2,'task',null,4,$1)`,
        [x.memberId, x.spaceId, x.otherMemberId, x.leftMemberId, x.agentId, x.taskId],
      );
      await c.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name)
                     values($1,$4,'runner-a','owner','A'),($2,$4,'runner-b','member','B'),($3,$4,'runner-c','member','C')`,
        [x.memberId, x.otherMemberId, x.leftMemberId, x.spaceId]);
      await c.query(`update public.members set status = 'left', left_at = now() where entity_id = $1`, [x.leftMemberId]);
      await c.query(`insert into public.tasks(entity_id,title,work_status) values($1,'Task','open')`, [x.taskId]);
      return x;
    });
  }, 240_000);

  afterAll(async () => database?.destroy(), 30_000);

  it('a session a human launched assigns its requests to that human', async () => {
    const session = await newSession(f.memberId);
    expect(await raise(session)).toBe(f.memberId);
  });

  it('a persona-created session resolves through its agent token account', async () => {
    const session = await newSession(f.agentId);
    await agentToken(session, 'runner-a', true);
    await agentToken(session, 'runner-b');
    // The live token (the resumer's) wins over the revoked one.
    expect(await raise(session)).toBe(f.otherMemberId);
  });

  it("an agent's child session inherits its parent's runner", async () => {
    const parent = await newSession(f.otherMemberId);
    const child = await newSession(f.agentId, parent);
    expect(await raise(child)).toBe(f.otherMemberId);
  });

  it('an explicit assignee wins', async () => {
    const session = await newSession(f.memberId);
    expect(await raise(session, f.otherMemberId)).toBe(f.otherMemberId);
  });

  it('stays unassigned when no runner resolves, or the runner has left, or there is no session', async () => {
    expect(await raise(await newSession(f.agentId))).toBeNull();
    expect(await raise(await newSession(f.leftMemberId))).toBeNull();
    expect(await raise(null)).toBeNull();
  });
});
