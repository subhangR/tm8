/**
 * The second byte path, and session lifecycle — migration 108.
 *
 * 107 closed the WebSocket route into a running agent. This covers the other
 * one — a message anchored on, or @-mentioning, a session is delivered to that
 * session's stdin — plus terminate / resume / rename / transition.
 *
 * TWO CARVE-OUTS ARE THE POINT OF THIS FILE. Each would break the product if
 * done the obvious way, so each is asserted rather than assumed:
 *
 *   1. REPLY routes are NOT gated. A reply targets the session that authored
 *      the message being answered; gating it would 403 anyone replying in a
 *      channel thread to anything an agent ever said.
 *   2. `work_session_transition` is SPLIT, not gated. `running`/`idle` stay
 *      member-gated because `reconcileNodeGhosts` runs under the node owner's
 *      identity by design — a blanket gate strands ghost reconciliation and
 *      pins the concurrency cap forever.
 *
 * Route rows are inserted as the TABLE'S OWNER (`tm8`) with the caller's
 * identity claim bound. That isolates the trigger: `tm8_app` holds no INSERT on
 * any table, so a `tm8_app` insert fails with "permission denied" — which is
 * ALSO SQLSTATE 42501 and would make a refusal indistinguishable from a
 * privilege error. Learned by writing that ambiguous probe first.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;
interface Fx {
  space: string; idOwner: string; idMember: string;
  mOwner: string; mMember: string; session: string;
  agentMessage: string; replyMessage: string;
}
let fx: Fx;

/** As the table owner, with an identity bound — isolates the trigger. */
async function asTableOwner<T>(identity: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('reset role');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identity]);
    return fn(client);
  });
}
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

/**
 * A real `messages` row. Route targets are FK-bound to it, so a random uuid
 * only works for the NEGATIVE cases — a BEFORE INSERT trigger fires ahead of
 * foreign-key checks, which is why the refusals are genuinely the trigger's.
 */
async function mintMessage(): Promise<string> {
  const id = randomUUID();
  await asOwner(async (c) => {
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility)
       values ($1,$2,'message',$3,'space')`, [id, fx.space, fx.mOwner]);
    await c.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body) values ($1,$2,$3,'m')`,
      [id, fx.session, fx.mOwner]);
  });
  return id;
}

function route(target: string, session: string, source: string) {
  return {
    text: `insert into public.session_message_reply_routes
             (target_message_id,target_work_session_id,source_anchor_id,source_message_id,addressing_kind)
           values ($1,$2,$3,$4,'anchored_message')`,
    values: [target, session, session, source],
  };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('message_lifecycle_authority');
  database.apply(migrationFiles());
  fx = await asOwner(async (c) => {
    const f: Fx = {
      space: randomUUID(), idOwner: `id_${randomUUID()}`, idMember: `id_${randomUUID()}`,
      mOwner: randomUUID(), mMember: randomUUID(), session: randomUUID(),
      agentMessage: randomUUID(), replyMessage: randomUUID(),
    };
    for (const [i, n] of [[f.idOwner, 'O'], [f.idMember, 'M']] as const) {
      await c.query(`insert into public.user_profiles(identity_id,display_name) values ($1,$2)`, [i, n]);
      await c.query(`insert into public.accounts(identity_id,username) values ($1,$2)`,
        [i, `q-${String(i).slice(3, 12)}`]);
    }
    await c.query(`insert into public.spaces(id,name,created_by_identity) values ($1,'S',$2)`,
      [f.space, f.idOwner]);
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility) values
        ($1,$4,'member',$1,'space'),($2,$4,'member',$2,'space'),($3,$4,'work_session',$1,'space')`,
      [f.mOwner, f.mMember, f.session, f.space]);
    await c.query(
      `insert into public.members(entity_id,space_id,identity_id,role) values ($1,$3,$4,'owner'),($2,$3,$5,'member')`,
      [f.mOwner, f.mMember, f.space, f.idOwner, f.idMember]);
    await c.query(
      `insert into public.work_sessions(entity_id,title,status,node_id) values ($1,'sess','running','n:1')`,
      [f.session]);

    // The reply shape: a message the SESSION authored, and a second message
    // whose parent is that one. `parent_id` is immutable after insert, so it is
    // set at creation — the first attempt tried to UPDATE it and was refused.
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,visibility)
       values ($1,$2,'message',$3,'space')`, [f.agentMessage, f.space, f.mOwner]);
    await c.query(
      `insert into public.entities(id,space_id,kind,created_by,parent_id,visibility)
       values ($1,$2,'message',$3,$4,'space')`,
      [f.replyMessage, f.space, f.mMember, f.agentMessage]);
    // A threaded reply must carry the thread root; the schema checks it.
    await c.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body) values ($1,$2,$3,'agent said')`,
      [f.agentMessage, f.session, f.mOwner]);
    await c.query(
      `insert into public.messages(entity_id,anchor_id,author_id,body,root_message_id)
       values ($1,$2,$3,'human replied',$4)`,
      [f.replyMessage, f.session, f.mMember, f.agentMessage]);
    // The edge that makes it a reply TO THE SESSION. `authored_from` is
    // recorder-owned (066:123-128): a plain insert is refused unless the writer
    // is declared, which is the schema protecting its own provenance.
    await c.query(`select internal.w1_set_writer('message_recorder')`);
    await c.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by)
       values ($1,$2,$3,'authored_from',$4)`,
      [f.space, f.agentMessage, f.session, f.mOwner]);
    await c.query(`select internal.w1_set_writer(null)`);
    return f;
  });
}, 180_000);
afterAll(async () => { await database?.destroy(); }, 180_000);

describe('108 — caller-initiated delivery needs converse', () => {
  it('REFUSES a plain member anchoring a route on another member’s session', async () => {
    const r = route(randomUUID(), fx.session, randomUUID());
    await expect(asTableOwner(fx.idMember, (c) => c.query(r.text, r.values)))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('allows the session OWNER', async () => {
    const m = await mintMessage();
    const r = route(m, fx.session, m);
    await asTableOwner(fx.idOwner, (c) => c.query(r.text, r.values));
  });

  it('allows a DELEGATE holding converse', async () => {
    await asApp(fx.idOwner, (c) =>
      c.query(`select public.grant_session_delegation($1,$2,null,'session',$3,null,'converse',null,null,$4)`,
        [fx.space, fx.idMember, fx.session, randomUUID()]));
    const m = await mintMessage();
    const r = route(m, fx.session, m);
    await asTableOwner(fx.idMember, (c) => c.query(r.text, r.values));
    // Clean up so the reply case below proves the carve-out and not the grant.
    await asOwner((c) => c.query(`update public.session_delegations set revoked_at = now()`));
  });
});

describe('108 — CARVE-OUT ONE: replies are never gated', () => {
  it('lets a plain member reply to a message the session authored', async () => {
    // Without this, replying in a thread to anything an agent said would 403.
    const r = route(fx.replyMessage, fx.session, fx.replyMessage);
    await asTableOwner(fx.idMember, (c) => c.query(r.text, r.values));
  });

  it('still refuses the same member on a NON-reply route — the carve-out is narrow', async () => {
    const r = route(randomUUID(), fx.session, randomUUID());
    await expect(asTableOwner(fx.idMember, (c) => c.query(r.text, r.values)))
      .rejects.toMatchObject({ code: '42501' });
  });
});

describe('108 — CARVE-OUT TWO: the transition is split', () => {
  it('lets a plain member report idle — an activity report, not a byte path', async () => {
    await asApp(fx.idMember, (c) =>
      c.query(`select public.work_session_transition($1,'idle',null,null,null,$2)`,
        [fx.session, randomUUID()]));
  });

  it('REFUSES a plain member ending the session', async () => {
    await expect(asApp(fx.idMember, (c) =>
      c.query(`select public.work_session_transition($1,'exited',0,null,null,$2)`,
        [fx.session, randomUUID()])))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('lets the owner end it', async () => {
    await asApp(fx.idOwner, (c) =>
      c.query(`select public.work_session_transition($1,'exited',0,null,null,$2)`,
        [fx.session, randomUUID()]));
    const status = await asOwner(async (c) =>
      (await c.query<{ status: string }>(
        `select status from public.work_sessions where entity_id=$1`, [fx.session])).rows[0]!.status);
    expect(status).toBe('exited');
  });
});

describe('108 — terminate and prompt', () => {
  it('refuses a plain member terminating, and admits the owner', async () => {
    const live = randomUUID();
    await asOwner(async (c) => {
      await c.query(
        `insert into public.entities(id,space_id,kind,created_by,visibility)
         values ($1,$2,'work_session',$3,'space')`, [live, fx.space, fx.mOwner]);
      await c.query(
        `insert into public.work_sessions(entity_id,title,status,node_id) values ($1,'t','running','n:1')`, [live]);
    });
    await expect(asApp(fx.idMember, (c) =>
      c.query(`select public.record_execution_command($1,'execution.terminate','{}'::jsonb,null,$2)`,
        [live, randomUUID()])))
      .rejects.toMatchObject({ code: '42501' });
    await asApp(fx.idOwner, (c) =>
      c.query(`select public.record_execution_command($1,'execution.terminate','{}'::jsonb,null,$2)`,
        [live, randomUUID()]));
  });
});
