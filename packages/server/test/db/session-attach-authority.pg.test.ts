/**
 * Stream-attach authority — migration 107. THE REGRESSION GATE.
 *
 * Before 107, an ordinary member could be granted DRIVE on another member's
 * running agent PTY. `evidence/stream-attach-pre-107-red.txt` records that
 * behaviour captured against the chain through 106, so this file is a gate with
 * a demonstrated failure rather than an assertion nobody has seen fail.
 *
 * Why it happened: `grant_stream_attach` gated drive on
 * `can_act_as(created_by, space)`. For an AGENT-launched session `created_by`
 * is a `team_members` row, and 075 widened `can_act_as` so any member may act
 * as any teammate in the space — so the gate was true for everyone. On the
 * production node 49 of 311 sessions are in exactly that shape.
 *
 * The four things that must all hold together:
 *   1. a plain member is REFUSED drive on an agent-launched session;
 *   2. the OWNER is unaffected — this must not be a denial-of-service;
 *   3. a cross-space DELEGATE is admitted, without being a member;
 *   4. `tm8_app` can no longer read a live `token_hash`.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;
interface Fx {
  space: string; idOwner: string; idMember: string; idOutsider: string;
  mOwner: string; mMember: string; persona: string; session: string; humanSession: string;
}
let fx: Fx;

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
function attach(session: string, mode: 'view' | 'drive', hash: string) {
  return `select public.grant_stream_attach('${session}','${mode}','${hash}',
            interval '30 seconds', '${randomUUID()}')`;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session_attach_authority');
  database.apply(migrationFiles());
  fx = await asOwner(async (c) => {
    const f: Fx = {
      space: randomUUID(), idOwner: `id_${randomUUID()}`, idMember: `id_${randomUUID()}`,
      idOutsider: `id_${randomUUID()}`, mOwner: randomUUID(), mMember: randomUUID(),
      persona: randomUUID(), session: randomUUID(), humanSession: randomUUID(),
    };
    for (const [i, n] of [[f.idOwner,'Own'],[f.idMember,'Mem'],[f.idOutsider,'Out']] as const) {
      await c.query(`insert into public.user_profiles(identity_id,display_name) values ($1,$2)`, [i, n]);
      await c.query(`insert into public.accounts(identity_id,username) values ($1,$2)`,
        [i, `a-${String(i).slice(3, 12)}`]);
    }
    await c.query(`insert into public.spaces(id,name,created_by_identity) values ($1,'S',$2)`,
      [f.space, f.idOwner]);
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility) values
        ($1,$6,'member',$1,'space'),($2,$6,'member',$2,'space'),
        ($3,$6,'team_member',$1,'space'),
        ($4,$6,'work_session',$3,'space'),($5,$6,'work_session',$1,'space')`,
      [f.mOwner, f.mMember, f.persona, f.session, f.humanSession, f.space]);
    await c.query(
      `insert into public.members(entity_id,space_id,identity_id,role) values ($1,$3,$4,'owner'),($2,$3,$5,'member')`,
      [f.mOwner, f.mMember, f.space, f.idOwner, f.idMember]);
    await c.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values ($1,$2,'Ag','worker','p')`, [f.persona, f.mOwner]);
    // The agent-launch shape: created_by is the TEAMMATE.
    await c.query(
      `insert into public.work_sessions(entity_id,title,status,share_mode) values
        ($1,'agent-launched','running','none'),($2,'human-launched','running','none')`,
      [f.session, f.humanSession]);
    return f;
  });
}, 180_000);
afterAll(async () => { await database?.destroy(); }, 180_000);

describe('107 — the 075 regression is closed', () => {
  it('REFUSES a plain member drive on an agent-launched session', async () => {
    // RED against the chain through 106 — see evidence/stream-attach-pre-107-red.txt
    await expect(asApp(fx.idMember, (c) => c.query(attach(fx.session, 'drive', 'a'.repeat(64)))))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('REFUSES a plain member even view on an unshared session', async () => {
    await expect(asApp(fx.idMember, (c) => c.query(attach(fx.session, 'view', 'b'.repeat(64)))))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('does NOT refuse the owner — this must not be a denial of service', async () => {
    await asApp(fx.idOwner, (c) => c.query(attach(fx.session, 'drive', 'c'.repeat(64))));
    await asApp(fx.idOwner, (c) => c.query(attach(fx.humanSession, 'drive', 'd'.repeat(64))));
  });

  it('admits a plain member at WATCH once share_mode is space, and no higher', async () => {
    await asOwner(async (c) => {
      await c.query(`update public.work_sessions set share_mode='space' where entity_id=$1`, [fx.humanSession]);
    });
    await asApp(fx.idMember, (c) => c.query(attach(fx.humanSession, 'view', 'e'.repeat(64))));
    await expect(asApp(fx.idMember, (c) => c.query(attach(fx.humanSession, 'drive', 'f'.repeat(64)))))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('107 — a delegate is admitted without being a member', () => {
  it('grants drive across the space boundary', async () => {
    await asApp(fx.idOwner, (c) =>
      c.query(`select public.grant_session_delegation($1,$2,null,'session',$3,null,'drive',null,null,$4)`,
        [fx.space, fx.idOutsider, fx.session, randomUUID()]));
    await asApp(fx.idOutsider, (c) => c.query(attach(fx.session, 'drive', '1'.repeat(64))));
    // ...and is still not a member.
    expect(await asApp(fx.idOutsider, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.is_space_member($1) v`, [fx.space])).rows[0]!.v))
      .toBe(false);
  });
});

describe('107 — the ride-alongs', () => {
  it('records granted_by as the CALLER, not the session creator', async () => {
    await asApp(fx.idOwner, (c) => c.query(attach(fx.session, 'view', '2'.repeat(64))));
    const by = await asOwner(async (c) =>
      (await c.query<{ granted_by: string }>(
        `select granted_by from public.stream_grants
          where work_session_id=$1 and subject_identity=$2 and mode='view'`,
        [fx.session, fx.idOwner])).rows[0]!.granted_by);
    expect(by).toBe(fx.mOwner);
  });

  it('makes stream_grants unreadable by tm8_app, so no live token_hash leaks', async () => {
    await expect(asApp(fx.idOwner, (c) => c.query(`select 1 from public.stream_grants`)))
      .rejects.toMatchObject({ code: '42501' });
  });

  it("refuses share_mode='explicit', which failed OPEN", async () => {
    await expect(asOwner((c) =>
      c.query(`update public.work_sessions set share_mode='explicit' where entity_id=$1`, [fx.session])))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('107 — session_access tells the client what it may do', () => {
  it('reports level and provenance for the owner', async () => {
    const a = await asApp(fx.idOwner, async (c) =>
      (await c.query<{ v: { level: string; via: string } }>(
        `select public.session_access($1) v`, [fx.session])).rows[0]!.v);
    expect(a).toMatchObject({ level: 'manage', via: 'owner' });
  });

  it('reports the delegation for a delegate', async () => {
    const a = await asApp(fx.idOutsider, async (c) =>
      (await c.query<{ v: { level: string; via: string } }>(
        `select public.session_access($1) v`, [fx.session])).rows[0]!.v);
    expect(a).toMatchObject({ level: 'drive', via: 'delegation' });
  });

  it('reports a null level for someone with no standing — so the UI can grey the input', async () => {
    const a = await asApp(fx.idMember, async (c) =>
      (await c.query<{ v: { level: string | null } }>(
        `select public.session_access($1) v`, [fx.session])).rows[0]!.v);
    expect(a.level).toBeNull();
  });
});
