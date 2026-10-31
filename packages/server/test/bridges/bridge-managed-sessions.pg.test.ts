/**
 * Migration 425: the bridge manages its session (R11) and the routing fixes
 * R1 (direction: out), R3 (no Move across the channel line) and R8
 * (target.live).
 *
 * A bridge targets a work session. The inbound frame goes through the
 * runtime's own door under a minted bridge_runtime session; the keeper and the
 * delivery run the server's real code, with fakes only for the PTY host (spawn
 * and resume write the session row) and the outbox notice.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createBridgeSessionDelivery } from '../../src/bridges/runtime/deliver.js';
import { createBridgeSessionKeeper } from '../../src/bridges/runtime/keeper.js';
import type { SpawnWorkerRequest } from '../../src/bridges/commands/ports.js';
import type { MessageDeliveryPort } from '../../src/facade/services/w2/message-dispatch.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let scratch: W1ScratchDatabase;
let db: Db;
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), session = randomUUID(), channel = randomUUID();
const ownerIdentity = `r11-${randomUUID()}`, ownerAccount = randomUUID(), connection = randomUUID();
const GROUP = '120363777@g.us';
let bridge = '';
let runtimeSession = '';
let seq = 0;

const runtime = (): DbClaims => ({ identityId: ownerIdentity, authKind: 'bridge_runtime', authSessionId: runtimeSession, requestId: randomUUID() });
const human = (): DbClaims => ({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() });
const owner = <T>(sql: string, params: unknown[] = []) => scratch.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});
type Inbound = { status: string; messageId: string; routed: boolean; bridgeId: string; targetSession?: { sessionId: string; live: boolean } };
const inbound = (body: string) => {
  seq += 1;
  return db.rpc<Inbound>(runtime(), 'bridge_runtime_inbound', [JSON.stringify({
    connectionId: connection, conversationId: GROUP, externalMessageId: `3EB0R11${seq}`,
    sender: { externalId: '919800000002@s.whatsapp.net', altId: null, name: 'Rahul', fromMe: false },
    body, kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_300_000 + seq,
  }), false]);
};
const setStatus = (id: string, status: string) => scratch.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  await c.query("select set_config('tm8.work_session_transition', 'on', true)");
  await c.query('update public.work_sessions set status = $2, status_changed_at = now() where entity_id = $1', [id, status]);
});
const newSession = async (title: string, status = 'running') => {
  const id = randomUUID();
  await owner(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`, [id, spaceId, teammate]);
  await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,$2,$3,'none',now())`, [id, title, status]);
  return id;
};
const targetOf = async () => (await owner<{ target_id: string }>('select target_id::text from public.bridges where entity_id = $1', [bridge]))[0]!.target_id;
const setPolicy = (patch: Record<string, unknown>) =>
  owner(`update public.bridges set policy = policy || $2::jsonb where entity_id = $1`, [bridge, JSON.stringify(patch)]);

function capturingPort(): { port: MessageDeliveryPort; sent: { session: string; content: string }[] } {
  const sent: { session: string; content: string }[] = [];
  return {
    sent,
    port: {
      async reserve(intent) { sent.push({ session: intent.targetWorkSessionId, content: intent.content }); return { deliveryId: randomUUID() }; },
      adapter: { dispatch: async () => undefined, reject: async () => undefined },
      principalFor: () => ({}),
    },
  };
}

/** The PTY host, faked: resume flips the row to running unless told to fail; spawn writes a new running session. */
let failResume = false;
const resumes: string[] = [];
const spawns: SpawnWorkerRequest[] = [];
const notices: string[] = [];
const keeper = () => createBridgeSessionKeeper({
  db,
  async resumeWorker(_claims, sessionId) {
    resumes.push(sessionId);
    if (failResume) throw new Error('nothing to resume');
    await setStatus(sessionId, 'running');
    return { sessionId };
  },
  async spawnWorker(_claims, request) {
    spawns.push(request);
    return { sessionId: await newSession(request.title) };
  },
  async postNotice(_db, input) { notices.push(input.text); return {}; },
});

describe('425: bridges manage their session', () => {
  beforeAll(async () => {
    scratch = await createW1ScratchDatabase('bridges_r11');
    scratch.apply(migrationFiles());
    db = createDb(scratch.url, { max: 4 });
    await scratch.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
      await c.query(`insert into public.accounts(id, identity_id, username, is_node_admin) values ($1,$2,'r11',true)`, [ownerAccount, ownerIdentity]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'R11',$2)`, [spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
        [ownerMember, spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
        [teammate, ownerMember]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
        [session, spaceId, teammate]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Infra desk','running','none',now())`, [session]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'channel',$3)`, [channel, spaceId, ownerMember]);
      await c.query(`insert into public.channels(entity_id, space_id, name) values ($1,$2,'deploys')`, [channel, spaceId]);
      await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9494','linked')`,
        [connection, ownerAccount]);
    });
    await db.tx(human(), (q) => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
    const created = await db.tx(human(), (q) =>
      q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, GROUP,
        JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 4 }), session,
        JSON.stringify({ trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'anyone', voice: 'named', style: null }),
        teammate, null, null, true, null, null, randomUUID()]));
    bridge = created.entity.id;
    runtimeSession = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'r11')).sessionId;
  });

  afterAll(async () => { await db?.end(); await scratch?.destroy(); });

  it('R1: direction "out" logs the message but routes and delivers nothing', async () => {
    await setPolicy({ direction: 'out' });
    const { port, sent } = capturingPort();
    const stored = await inbound('@tm8 are you there?');
    expect(stored).toMatchObject({ status: 'stored', routed: false });
    expect(await createBridgeSessionDelivery({ db, delivery: port })(stored.messageId)).toEqual([]);
    expect(sent).toEqual([]);
    const logged = await owner<{ n: number }>('select count(*)::int n from public.messages where entity_id = $1 and anchor_id = $2', [stored.messageId, bridge]);
    expect(logged[0]!.n).toBe(1);
    await setPolicy({ direction: 'both' });
    const live = await inbound('@tm8 are you there now?');
    expect(live).toMatchObject({ routed: true, targetSession: { sessionId: session, live: true } });
  });

  it('R8: the view says when the session target has stopped', async () => {
    await setStatus(session, 'exited');
    const view = await db.rpc<{ target: { live: boolean }; health: { detail: string | null } }>(human(), 'internal.bridge_view', [bridge]);
    expect(view.target.live).toBe(false);
    expect(view.health.detail).toMatch(/session has ended; the next message resumes it/);
  });

  it('R11: a stopped session is resumed before delivery, and the group is told', async () => {
    const { port, sent } = capturingPort();
    const stored = await inbound('@tm8 status of the deploy?');
    expect(stored.targetSession).toEqual({ sessionId: session, live: false });
    expect(await keeper().ensure(bridge, stored.messageId)).toBe('resumed');
    expect(resumes).toEqual([session]);
    expect(await targetOf()).toBe(session);
    await createBridgeSessionDelivery({ db, delivery: port })(stored.messageId);
    expect(sent.map((s) => s.session)).toEqual([session]);
    expect(sent[0]!.content).toContain('status of the deploy?');
    expect(notices.at(-1)).toBe('the session had stopped; resumed it');
  });

  it('R11: when resume fails, a new session is started, the bridge moves to it and the copy follows', async () => {
    await setStatus(session, 'exited');
    failResume = true;
    const { port, sent } = capturingPort();
    const stored = await inbound('@tm8 restart the job please');
    expect(await keeper().ensure(bridge, stored.messageId)).toBe('replaced');
    failResume = false;
    const spawn = spawns.at(-1)!;
    expect(spawn).toMatchObject({ teamMemberId: teammate, taskId: null, title: 'Infra desk' });
    const moved = await targetOf();
    expect(moved).not.toBe(session);
    expect((await owner<{ n: number }>(`select count(*)::int n from public.edges where src_id = $1 and type = 'bridged_to' and dst_id = $2`,
      [bridge, moved]))[0]!.n).toBe(1);
    await createBridgeSessionDelivery({ db, delivery: port })(stored.messageId);
    expect(sent.map((s) => s.session)).toEqual([moved]);
    expect(sent[0]!.content).toContain('restart the job please');
    expect(notices.at(-1)).toBe('the session had stopped and could not be resumed; started a new one');
    // A running target is left alone.
    expect(await keeper().ensure(bridge, stored.messageId)).toBe('live');
  });

  it('R11: only the bridges worker may read the managed context or move a bridge onto a session it started', async () => {
    const other = await newSession('Someone else');
    const before = await targetOf();
    // A member, an agent (its owner's identity, pinned to the space), and an
    // agent that also claims the worker's job: all refused by both doors.
    const callers: DbClaims[] = [
      human(),
      { identityId: ownerIdentity, authKind: 'agent', sessionSpaceId: spaceId, requestId: randomUUID() },
      { identityId: ownerIdentity, authKind: 'agent', sessionSpaceId: spaceId, backgroundJob: 'bridges.runtime', requestId: randomUUID() },
    ];
    for (const claims of callers) {
      await expect(db.rpc(claims, 'bridge_managed_context', [bridge])).rejects.toMatchObject({ code: 'forbidden' });
      await expect(db.rpc(claims, 'bridge_managed_retarget', [bridge, other, null, 'new'])).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await targetOf()).toBe(before);
  });

  it('R3: a chat or session bridge cannot be moved onto a channel (its log would change)', async () => {
    const version = (await owner<{ version: number }>('select version from public.entities where id = $1', [bridge]))[0]!.version;
    await expect(db.rpc(human(), 'retarget_bridge', [bridge, version, channel, null, randomUUID()]))
      .rejects.toThrow(/cannot move to a channel/);
    // Within the same side it still moves.
    const next = await newSession('Next desk');
    await db.rpc(human(), 'retarget_bridge', [bridge, version, next, null, randomUUID()]);
    expect(await targetOf()).toBe(next);
  });
});
