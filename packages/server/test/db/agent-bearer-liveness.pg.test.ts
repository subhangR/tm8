/**
 * An agent bearer dies with its agent — migration 109.
 *
 * 072 shipped this clause with a stated rationale; 074 redefined the same
 * function to add a field and dropped it, and 074 is last in the chain. So an
 * agent token has outlived its work session ever since.
 *
 * Measured on a restored copy of the production database: 178 agent tokens are
 * live by row state, and only 29 of them belong to a session that is still
 * running. Applying this clause makes the other 149 stop resolving immediately,
 * without any sweep running.
 *
 * The ORDERING is the interesting part and is asserted here too: restoring this
 * clause makes "mark this session exited" equivalent to "revoke this session's
 * credential". That was unsafe while any space member could flip the status —
 * it would have been a one-call DoS on anyone's live agent — and is safe now
 * only because 108 made exited/failed a `manage`-level act.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;
interface Fx {
  space: string; idOwner: string; idMember: string;
  mOwner: string; mMember: string; persona: string; session: string;
}
let fx: Fx;
const AGENT_HASH = 'a'.repeat(64);
const HUMAN_HASH = 'b'.repeat(64);

async function asApp<T>(identity: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identity]);
    return fn(client);
  });
}
async function asOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}
async function resolves(hash: string): Promise<boolean> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    const r = await client.query<{ v: unknown }>(`select public.resolve_auth_session($1) v`, [hash]);
    return r.rows[0]!.v !== null;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('agent_bearer_liveness');
  database.apply(migrationFiles());
  fx = await asOwner(async (c) => {
    const f: Fx = {
      space: randomUUID(), idOwner: `id_${randomUUID()}`, idMember: `id_${randomUUID()}`,
      mOwner: randomUUID(), mMember: randomUUID(), persona: randomUUID(), session: randomUUID(),
    };
    for (const [i, n] of [[f.idOwner, 'O'], [f.idMember, 'M']] as const) {
      await c.query(`insert into public.user_profiles(identity_id,display_name) values ($1,$2)`, [i, n]);
      await c.query(`insert into public.accounts(id,identity_id,username) values ($1,$2,$3)`,
        [randomUUID(), i, `L-${String(i).slice(3, 12)}`]);
    }
    await c.query(`insert into public.spaces(id,name,created_by_identity) values ($1,'S',$2)`,
      [f.space, f.idOwner]);
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility) values
        ($1,$5,'member',$1,'space'),($2,$5,'member',$2,'space'),
        ($3,$5,'team_member',$1,'space'),($4,$5,'work_session',$3,'space')`,
      [f.mOwner, f.mMember, f.persona, f.session, f.space]);
    await c.query(
      `insert into public.members(entity_id,space_id,identity_id,role) values ($1,$3,$4,'owner'),($2,$3,$5,'member')`,
      [f.mOwner, f.mMember, f.space, f.idOwner, f.idMember]);
    await c.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values ($1,$2,'Ag','worker','p')`, [f.persona, f.mOwner]);
    await c.query(
      `insert into public.work_sessions(entity_id,title,status,node_id) values ($1,'s','running','n:1')`,
      [f.session]);
    await c.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by)
       values ($1,$2,$3,'participates_in',$2)`, [f.space, f.persona, f.session]);
    return f;
  });

  await asApp(fx.idOwner, (c) =>
    c.query(`select public.issue_agent_auth_session($1,$2,$3,now()+interval '48 hours','agent')`,
      [fx.session, fx.persona, AGENT_HASH]));
  // A human session, to prove the clause does not touch browser/CLI tokens.
  await asOwner(async (c) => {
    const acct = await c.query<{ id: string }>(
      `select id from public.accounts where identity_id=$1`, [fx.idOwner]);
    await c.query(
      `insert into public.auth_sessions(account_id,kind,token_hash,expires_at)
       values ($1,'cli',$2,now()+interval '48 hours')`, [acct.rows[0]!.id, HUMAN_HASH]);
  });
}, 180_000);
afterAll(async () => { await database?.destroy(); }, 180_000);

describe('109 — the restored liveness clause', () => {
  it('resolves an agent bearer while its session is running', async () => {
    expect(await resolves(AGENT_HASH)).toBe(true);
  });

  it('STOPS resolving the moment its session ends — no sweep involved', async () => {
    await asApp(fx.idOwner, (c) =>
      c.query(`select public.work_session_transition($1,'exited',0,null,null,$2)`,
        [fx.session, randomUUID()]));
    expect(await resolves(AGENT_HASH)).toBe(false);
    // The row is still there and unrevoked — the clause is what denies it, so a
    // node that rolls 109 back gets the old behaviour rather than a dead token.
    const row = await asOwner(async (c) =>
      (await c.query<{ n: string }>(
        `select count(*)::text n from public.auth_sessions
          where token_hash=$1 and revoked_at is null and expires_at > now()`, [AGENT_HASH])).rows[0]!.n);
    expect(row).toBe('1');
  });

  it('leaves human sessions alone — they name no work session', async () => {
    expect(await resolves(HUMAN_HASH)).toBe(true);
  });
});

describe('109 — the ordering that made this safe', () => {
  it('an ordinary member cannot end a session, so cannot revoke another’s agent', async () => {
    // THIS is why the clause could not be restored in Phase 0. With
    // work_session_transition gated on membership alone, the test below would
    // pass and hand every member a one-call DoS on anyone's live agent.
    const live = randomUUID();
    await asOwner(async (c) => {
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility)
         values ($1,$2,'work_session',$3,'space')`, [live, fx.space, fx.persona]);
      await c.query(
        `insert into public.work_sessions(entity_id,title,status,node_id) values ($1,'x','running','n:1')`,
        [live]);
    });
    await expect(asApp(fx.idMember, (c) =>
      c.query(`select public.work_session_transition($1,'exited',0,null,null,$2)`,
        [live, randomUUID()])))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('109 — an agent session must name a work session', () => {
  it('refuses an agent-kind row with no work_session_id', async () => {
    await expect(asOwner(async (c) => {
      const acct = await c.query<{ id: string }>(
        `select id from public.accounts where identity_id=$1`, [fx.idOwner]);
      await c.query(
        `insert into public.auth_sessions(account_id,kind,token_hash,expires_at)
         values ($1,'agent',$2,now()+interval '1 hour')`,
        [acct.rows[0]!.id, 'c'.repeat(64)]);
    })).rejects.toMatchObject({ code: '23514' });
  });
});
