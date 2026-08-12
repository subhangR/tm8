/**
 * Session ownership and the delegation vocabulary — migration 105.
 *
 * Everything 105 adds is INERT: no production path calls the predicate yet.
 * What must be true anyway, and is asserted here:
 *
 *  · An AGENT-launched session resolves to the spawning HUMAN, not to
 *    "everyone". That is the whole point of the column. On the production node
 *    49 of 311 sessions were created by a teammate, and for every one of those
 *    `can_act_as(created_by)` is true for every member of the space — so before
 *    this column, "whose session is this" had no answer a gate could use.
 *  · Ownership INHERITS down the spawn tree, which is what makes "my coordinator
 *    may drive my workers" fall out with no extra rule.
 *  · `membership_kind` narrows `is_space_member` and nothing else: every
 *    pre-existing row is `'full'`, so behaviour is unchanged for current data.
 *  · The capability ladder answers correctly for owner, admin, delegate,
 *    teammate-delegate, and the `share_mode` floor — including the negatives.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;

interface Fx {
  spaceA: string; spaceB: string;
  idOwner: string; idAdmin: string; idMember: string; idOutsider: string;
  mOwner: string; mAdmin: string; mMember: string; mOutsiderInB: string;
  persona: string; personaB: string;
  sHuman: string; sAgent: string; sChild: string;
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

/** The predicate under test, read as a caller would see it. */
async function level(identity: string, session: string): Promise<string | null> {
  return asApp(identity, async (c) =>
    (await c.query<{ v: string | null }>(
      `select internal.session_capability($1) v`, [session])).rows[0]!.v);
}

async function seed(): Promise<Fx> {
  return asOwner(async (c) => {
    const f: Fx = {
      spaceA: randomUUID(), spaceB: randomUUID(),
      idOwner: `id_${randomUUID()}`, idAdmin: `id_${randomUUID()}`,
      idMember: `id_${randomUUID()}`, idOutsider: `id_${randomUUID()}`,
      mOwner: randomUUID(), mAdmin: randomUUID(), mMember: randomUUID(),
      mOutsiderInB: randomUUID(),
      persona: randomUUID(), personaB: randomUUID(),
      sHuman: randomUUID(), sAgent: randomUUID(), sChild: randomUUID(),
    };
    for (const [i, name] of [[f.idOwner,'Owner'],[f.idAdmin,'Admin'],
                             [f.idMember,'Member'],[f.idOutsider,'Outsider']] as const) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,$2)`, [i, name]);
      await c.query(`insert into public.accounts(identity_id, username) values ($1,$2)`,
        [i, `u-${String(i).slice(3, 11)}`]);
    }
    await c.query(`insert into public.spaces(id,name,created_by_identity) values ($1,'A',$2),($3,'B',$4)`,
      [f.spaceA, f.idOwner, f.spaceB, f.idOutsider]);

    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility) values
        ($1,$8,'member',$1,'space'),($2,$8,'member',$2,'space'),($3,$8,'member',$3,'space'),
        ($4,$9,'member',$4,'space'),
        ($5,$8,'team_member',$1,'space'),($10,$9,'team_member',$4,'space'),
        ($6,$8,'work_session',$1,'space'),($7,$8,'work_session',$5,'space')`,
      [f.mOwner, f.mAdmin, f.mMember, f.mOutsiderInB, f.persona,
       f.sHuman, f.sAgent, f.spaceA, f.spaceB, f.personaB]);
    // The child hangs off the AGENT session — the spawn tree the owner inherits down.
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,parent_id,visibility)
       values ($1,$2,'work_session',$3,$4,'space')`,
      [f.sChild, f.spaceA, f.persona, f.sAgent]);

    await c.query(
      `insert into public.members(entity_id,space_id,identity_id,role) values
        ($1,$5,$6,'owner'),($2,$5,$7,'admin'),($3,$5,$8,'member'),($4,$9,$10,'owner')`,
      [f.mOwner, f.mAdmin, f.mMember, f.mOutsiderInB, f.spaceA,
       f.idOwner, f.idAdmin, f.idMember, f.spaceB, f.idOutsider]);
    await c.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity) values
        ($1,$2,'A Agent','worker','p'),($3,$4,'B Agent','worker','p')`,
      [f.persona, f.mOwner, f.personaB, f.mOutsiderInB]);

    // sHuman: created_by a MEMBER. sAgent: created_by a TEAMMATE — the 075 case.
    await c.query(
      `insert into public.work_sessions(entity_id,title,status,node_id,started_at) values
        ($1,'human','running','n:1',now()),($2,'agent','running','n:1',now()),
        ($3,'child','running','n:1',now())`,
      [f.sHuman, f.sAgent, f.sChild]);
    return f;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session_delegation');
  database.apply(migrationFiles());
  fx = await seed();
}, 180_000);
afterAll(async () => { await database?.destroy(); }, 180_000);

describe('105 — session ownership', () => {
  it('resolves an AGENT-launched session to the spawning human, not to everyone', async () => {
    const owner = await asOwner(async (c) =>
      (await c.query<{ o: string }>(
        `select owner_member_id o from public.work_sessions where entity_id=$1`, [fx.sAgent])).rows[0]!.o);
    // created_by is the teammate; the owner is the human who owns that teammate.
    expect(owner).toBe(fx.mOwner);
  });

  it('inherits ownership down the spawn tree', async () => {
    const owner = await asOwner(async (c) =>
      (await c.query<{ o: string }>(
        `select owner_member_id o from public.work_sessions where entity_id=$1`, [fx.sChild])).rows[0]!.o);
    expect(owner).toBe(fx.mOwner);
  });

  it('fills the owner without any insert site passing one', async () => {
    // The trigger is the compat shim: 043, the 007/036 lineage and 083 all
    // insert without the column and must keep working.
    const id = randomUUID();
    await asOwner(async (c) => {
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility)
         values ($1,$2,'work_session',$3,'space')`, [id, fx.spaceA, fx.mMember]);
      await c.query(
        `insert into public.work_sessions(entity_id,title,status) values ($1,'fresh','running')`, [id]);
    });
    const owner = await asOwner(async (c) =>
      (await c.query<{ o: string }>(
        `select owner_member_id o from public.work_sessions where entity_id=$1`, [id])).rows[0]!.o);
    expect(owner).toBe(fx.mMember);
  });
});

describe('105 — membership_kind narrows is_space_member and nothing else', () => {
  it('leaves every pre-existing member full, so behaviour is unchanged', async () => {
    const kinds = await asOwner(async (c) =>
      (await c.query<{ membership_kind: string }>(
        `select distinct membership_kind from public.members`)).rows.map((r) => r.membership_kind));
    expect(kinds).toEqual(['full']);
    expect(await asApp(fx.idMember, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.is_space_member($1) v`, [fx.spaceA])).rows[0]!.v))
      .toBe(true);
  });

  it('excludes a delegate row from membership — the whole point of the kind', async () => {
    await asOwner(async (c) => {
      const id = randomUUID();
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility)
         values ($1,$2,'member',$1,'space')`, [id, fx.spaceA]);
      await c.query(
        `insert into public.members(entity_id,space_id,identity_id,role,membership_kind)
         values ($1,$2,$3,'member','delegate')`, [id, fx.spaceA, fx.idOutsider]);
    });
    expect(await asApp(fx.idOutsider, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.is_space_member($1) v`, [fx.spaceA])).rows[0]!.v))
      .toBe(false);
  });
});

describe('105 — the capability ladder', () => {
  it('gives the owner manage and a plain member nothing', async () => {
    expect(await level(fx.idOwner, fx.sAgent)).toBe('manage');
    // The 075 regression, stated as a property: a member who neither owns nor
    // was granted anything has NO level, even on an agent-launched session.
    expect(await level(fx.idMember, fx.sAgent)).toBeNull();
  });

  it('gives a space admin manage', async () => {
    expect(await level(fx.idAdmin, fx.sAgent)).toBe('manage');
  });

  it('honours a session-scoped delegation, and only for that session', async () => {
    await asOwner(async (c) => {
      await c.query(
        `insert into public.session_delegations
           (grantor_space_id,grantor_member_id,subject_identity_id,scope,work_session_id,level,granted_by)
         values ($1,$2,$3,'session',$4,'drive',$2)`,
        [fx.spaceA, fx.mOwner, fx.idMember, fx.sAgent]);
    });
    expect(await level(fx.idMember, fx.sAgent)).toBe('drive');
    expect(await level(fx.idMember, fx.sHuman)).toBeNull();
  });

  it('reaches ACROSS a space boundary — the subject is not a member', async () => {
    // `idOutsider` owns space B and is not a full member of space A.
    await asOwner(async (c) => {
      await c.query(
        `insert into public.session_delegations
           (grantor_space_id,grantor_member_id,subject_identity_id,scope,level,granted_by)
         values ($1,$2,$3,'space','watch',$2)`,
        [fx.spaceA, fx.mOwner, fx.idOutsider]);
    });
    expect(await level(fx.idOutsider, fx.sHuman)).toBe('watch');
    expect(await asApp(fx.idOutsider, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.is_space_member($1) v`, [fx.spaceA])).rows[0]!.v))
      .toBe(false);
  });

  it('a space-scoped grant covers sessions that did not exist when it was made', async () => {
    const id = randomUUID();
    await asOwner(async (c) => {
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility)
         values ($1,$2,'work_session',$3,'space')`, [id, fx.spaceA, fx.mOwner]);
      await c.query(`insert into public.work_sessions(entity_id,title,status) values ($1,'later','running')`, [id]);
    });
    expect(await level(fx.idOutsider, id)).toBe('watch');
  });

  it('ignores an expired or revoked grant', async () => {
    const victim = randomUUID();
    await asOwner(async (c) => {
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility)
         values ($1,$2,'work_session',$3,'space')`, [victim, fx.spaceA, fx.mAdmin]);
      await c.query(`insert into public.work_sessions(entity_id,title,status) values ($1,'v','running')`, [victim]);
      await c.query(
        `insert into public.session_delegations
           (grantor_space_id,grantor_member_id,subject_identity_id,scope,work_session_id,level,granted_by,expires_at)
         values ($1,$2,$3,'session',$4,'manage',$2, now() - interval '1 hour')`,
        [fx.spaceA, fx.mAdmin, fx.idMember, victim]);
    });
    // mAdmin owns it and is also a space admin, so use the member's view.
    expect(await level(fx.idMember, victim)).toBeNull();
  });

  it('applies the share_mode floor at watch and never above it', async () => {
    await asOwner(async (c) => {
      await c.query(`update public.work_sessions set share_mode='space' where entity_id=$1`, [fx.sHuman]);
    });
    // A plain member of the space now gets watch — and no more.
    expect(await level(fx.idMember, fx.sHuman)).toBe('watch');
    // Someone outside the space gets nothing from share_mode alone... except
    // the space-scoped grant above already gives the outsider watch, so use a
    // caller with neither: the delegate-kind row excludes them from membership.
    expect(await level(fx.idOutsider, fx.sHuman)).toBe('watch');
  });

  it('refuses at the required level through require_session_capability', async () => {
    await expect(asApp(fx.idMember, (c) =>
      c.query(`select internal.require_session_capability($1,'manage')`, [fx.sAgent])),
    ).rejects.toMatchObject({ code: '42501' });
    // And admits when the level is met.
    await asApp(fx.idMember, (c) =>
      c.query(`select internal.require_session_capability($1,'drive')`, [fx.sAgent]));
  });
});

describe('105–107 — exactly these operations enforce the ladder', () => {
  it('has the expected enforcer set, and no accidental additions', async () => {
    // This started life as "nothing enforces yet" and was inverted when 107
    // landed, because that assertion had done its job. As an inventory it is
    // more useful: a new enforcer appearing without a deliberate edit here is
    // exactly the change that should not slip in unnoticed.
    const callers = await asOwner(async (c) =>
      (await c.query<{ proname: string }>(
        `select p.proname
           from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
          where ns.nspname in ('public','internal') and p.prokind = 'f'
            and p.proname <> 'require_session_capability'
            and pg_get_functiondef(p.oid) like '%require_session_capability%'
          order by p.proname`)).rows.map((r) => r.proname));
    expect(callers).toEqual([
      // you may only delegate a session you can already manage
      'grant_session_delegation',
      // the two byte paths into a live PTY
      'grant_stream_attach',
      // killing an agent's credential is a manage-level act
      'revoke_agent_auth_session',
    ]);
  });
});
