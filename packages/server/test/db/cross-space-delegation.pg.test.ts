/**
 * The cross-space read — migration 106.
 *
 * This is the novel claim of the whole delegation design: B can reach ONE of
 * A's sessions without becoming a member of A's space. A test that only proved
 * "B can see the session" would be worthless — the interesting half is
 * everything B must still NOT see, so that is asserted explicitly, row by row,
 * for every other kind in the grantor's space.
 *
 * Also pinned: `is_space_member` stays false throughout (a delegate is not a
 * member, which is the property the delegate member row exists to preserve),
 * revocation removes both the reach and the delegate row, and a caller holding
 * zero delegations pays only the short-circuit.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;

interface Fx {
  spaceA: string;
  idA: string; idB: string;
  mA: string;
  session: string; otherSession: string;
  transcript: string; message: string;
  task: string; doc: string; channel: string;
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
/** Can this identity SELECT this entity at all, through RLS? */
async function canSee(identity: string, id: string): Promise<boolean> {
  return asApp(identity, async (c) =>
    (await c.query(`select 1 from public.entities where id=$1`, [id])).rowCount === 1);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('cross_space_delegation');
  database.apply(migrationFiles());

  fx = await asOwner(async (c) => {
    const f: Fx = {
      spaceA: randomUUID(), idA: `id_${randomUUID()}`, idB: `id_${randomUUID()}`,
      mA: randomUUID(), session: randomUUID(), otherSession: randomUUID(),
      transcript: randomUUID(), message: randomUUID(),
      task: randomUUID(), doc: randomUUID(), channel: randomUUID(),
    };
    for (const [i, n] of [[f.idA, 'A'], [f.idB, 'B']] as const) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,$2)`, [i, n]);
      await c.query(`insert into public.accounts(identity_id, username) values ($1,$2)`,
        [i, `x-${String(i).slice(3, 12)}`]);
    }
    await c.query(`insert into public.spaces(id,name,created_by_identity) values ($1,'A space',$2)`,
      [f.spaceA, f.idA]);
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility) values
        ($1,$9,'member',$1,'space'),
        ($2,$9,'work_session',$1,'space'),($3,$9,'work_session',$1,'space'),
        ($4,$9,'doc',$1,'space'),($5,$9,'message',$1,'space'),
        ($6,$9,'task',$1,'space'),($7,$9,'doc',$1,'space'),($8,$9,'channel',$1,'space')`,
      [f.mA, f.session, f.otherSession, f.transcript, f.message,
       f.task, f.doc, f.channel, f.spaceA]);
    await c.query(`insert into public.members(entity_id,space_id,identity_id,role) values ($1,$2,$3,'owner')`,
      [f.mA, f.spaceA, f.idA]);
    await c.query(`insert into public.channels(entity_id,space_id,name) values ($1,$2,'general')`,
      [f.channel, f.spaceA]);
    await c.query(
      `insert into public.documents(entity_id,title,body)
       values ($1,'Transcript','transcript'),($2,'Private','private doc')`,
      [f.transcript, f.doc]);
    await c.query(`insert into public.tasks(entity_id,title) values ($1,'A task')`, [f.task]);
    await c.query(
      `insert into public.work_sessions(entity_id,title,status,transcript_doc_id) values
        ($1,'granted','running',$3),($2,'not granted','running',null)`,
      [f.session, f.otherSession, f.transcript]);
    await c.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body)
       values ($1,$2,$3,'hello session')`,
      [f.message, f.session, f.mA]);
    return f;
  });
}, 180_000);
afterAll(async () => { await database?.destroy(); }, 180_000);

describe('106 — before any grant, B sees nothing in A’s space', () => {
  it('cannot see the session, and is not a member', async () => {
    expect(await canSee(fx.idB, fx.session)).toBe(false);
    expect(await asApp(fx.idB, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.is_space_member($1) v`, [fx.spaceA])).rows[0]!.v))
      .toBe(false);
  });
});

describe('106 — with a session-scoped grant, B reaches EXACTLY that session', () => {
  let delegationId: string;

  it('grants without B being a member of the space', async () => {
    const result = await asApp(fx.idA, async (c) =>
      (await c.query<{ v: { delegation: { id: string } } }>(
        `select public.grant_session_delegation($1,$2,null,'session',$3,null,'drive',null,'help me',$4) v`,
        [fx.spaceA, fx.idB, fx.session, randomUUID()])).rows[0]!.v);
    delegationId = result.delegation.id;
    expect(delegationId).toMatch(/[0-9a-f-]{36}/);
  });

  it('lets B see the session, its transcript, and messages anchored on it', async () => {
    expect(await canSee(fx.idB, fx.session)).toBe(true);
    expect(await canSee(fx.idB, fx.transcript)).toBe(true);
    expect(await canSee(fx.idB, fx.message)).toBe(true);
  });

  it('lets B see NOTHING ELSE in A’s space — the half that matters', async () => {
    // Enumerated rather than sampled: every other kind that exists in the space.
    for (const [label, id] of [
      ['another session', fx.otherSession],
      ['a task', fx.task],
      ['an unrelated doc', fx.doc],
      ['a channel', fx.channel],
      ["A's member row", fx.mA],
    ] as const) {
      expect(await canSee(fx.idB, id), label).toBe(false);
    }
  });

  it('keeps is_space_member FALSE for B — a delegate is not a member', async () => {
    expect(await asApp(fx.idB, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.is_space_member($1) v`, [fx.spaceA])).rows[0]!.v))
      .toBe(false);
  });

  it('reified the grant as a delegate member row, excluded from membership', async () => {
    const row = await asOwner(async (c) =>
      (await c.query<{ membership_kind: string }>(
        `select membership_kind from public.members where space_id=$1 and identity_id=$2`,
        [fx.spaceA, fx.idB])).rows[0]);
    expect(row?.membership_kind).toBe('delegate');
  });

  it('gives B the granted level and no more', async () => {
    expect(await asApp(fx.idB, async (c) =>
      (await c.query<{ v: string }>(`select internal.session_capability($1) v`, [fx.session])).rows[0]!.v))
      .toBe('drive');
    await expect(asApp(fx.idB, (c) =>
      c.query(`select internal.require_session_capability($1,'manage')`, [fx.session])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('revokes cleanly: reach gone, delegate row gone', async () => {
    await asApp(fx.idA, (c) =>
      c.query(`select public.revoke_session_delegation($1,$2)`, [delegationId, randomUUID()]));
    expect(await canSee(fx.idB, fx.session)).toBe(false);
    expect(await canSee(fx.idB, fx.transcript)).toBe(false);
    const row = await asOwner(async (c) =>
      (await c.query(`select 1 from public.members where space_id=$1 and identity_id=$2`,
        [fx.spaceA, fx.idB])).rowCount);
    expect(row).toBe(0);
  });
});

describe('106 — grant guards', () => {
  it('refuses delegating a session you cannot manage', async () => {
    await expect(asApp(fx.idB, (c) =>
      c.query(`select public.grant_session_delegation($1,$2,null,'session',$3,null,'watch',null,null,$4)`,
        [fx.spaceA, fx.idA, fx.session, randomUUID()])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a self-delegation', async () => {
    await expect(asApp(fx.idA, (c) =>
      c.query(`select public.grant_session_delegation($1,$2,null,'session',$3,null,'watch',null,null,$4)`,
        [fx.spaceA, fx.idA, fx.session, randomUUID()])),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses an unbounded-looking expiry beyond 30 days', async () => {
    await expect(asApp(fx.idA, (c) =>
      c.query(`select public.grant_session_delegation($1,$2,null,'session',$3,null,'watch',
                 now() + interval '90 days',null,$4)`,
        [fx.spaceA, fx.idB, fx.session, randomUUID()])),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses an unknown level', async () => {
    await expect(asApp(fx.idA, (c) =>
      c.query(`select public.grant_session_delegation($1,$2,null,'session',$3,null,'superuser',null,null,$4)`,
        [fx.spaceA, fx.idB, fx.session, randomUUID()])),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('106 — the hot path stays cheap for everyone else', () => {
  it('short-circuits for a caller holding zero delegations', async () => {
    const answer = await asApp(fx.idB, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.caller_has_any_delegation() v`)).rows[0]!.v);
    expect(answer).toBe(false);
    // And the reach predicate is false without touching the reach logic.
    expect(await asApp(fx.idB, async (c) =>
      (await c.query<{ v: boolean }>(`select internal.has_delegated_reach($1) v`, [fx.session])).rows[0]!.v))
      .toBe(false);
  });

  it('leaves an ordinary member’s own reads exactly as they were', async () => {
    for (const id of [fx.session, fx.task, fx.doc, fx.channel, fx.otherSession]) {
      expect(await canSee(fx.idA, id)).toBe(true);
    }
  });
});
