/**
 * Bridges B1b-8 end to end through the real server (ac1, ac7; closes §7.3
 * item 4 for B1b-3):
 *
 *   - a group message `@handle …` arrives on the runtime's own HTTP door and is
 *     delivered to that worker session as a tm8.session-input whose
 *     `<origin kind="bridge">` says directed="true" with an unread count; an
 *     un-directed message wakes no worker;
 *   - the worker (a NON-teammate session: its own persona, its own agent
 *     bearer) replies with messages.post; the outbox row quotes the right
 *     message (replyTo = its provider id) and is signed `Title (handle): …`,
 *     and the frame reaches the runtime's socket;
 *   - a group reply to the worker's sent post is directed to the worker again;
 *   - the same worker posting on a SECOND bridge carries the SAME handle (D23).
 *
 * The server boots without an execution runtime, so the PTY is the one thing
 * not in the loop: delivery runs the server's own createBridgeSessionDelivery
 * (413 §5) and dispatch loop with a capturing delivery port.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, type ServerFrame } from '@tm8/contract';

import { createBridgeSessionDelivery } from '../../src/bridges/runtime/deliver.js';
import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import type { MessageDeliveryPort } from '../../src/facade/services/w2/message-dispatch.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
const spaceId = randomUUID(), ownerMember = randomUUID(), chatTeammate = randomUUID(), workerPersona = randomUUID();
const chatA = randomUUID(), chatB = randomUUID(), worker = randomUUID();
const ownerIdentity = `b1b8-e2e-${randomUUID()}`, ownerAccount = randomUUID(), connection = randomUUID();
const GROUP_A = '120363101@g.us', GROUP_B = '120363102@g.us';
const RAHUL = '919800000003@s.whatsapp.net';
let bridgeA = '', bridgeB = '';
let runtimeToken = '';
let workerToken = '';
let handle = '';
let seq = 0;
const sockets: WebSocket[] = [];

async function call(path: string, token: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, server.url), {
    method: 'POST',
    headers: { [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function inbound(conversationId: string, body: string, replyTo: string | null = null) {
  seq += 1;
  return call('/v2/bridge-runtime/inbound', runtimeToken, {
    connectionId: connection, conversationId, externalMessageId: `3EB0E2E${seq}`,
    sender: { externalId: RAHUL, altId: null, name: 'Rahul', fromMe: false },
    body, kind: 'text', media: [], mentions: [], ts: 1_790_300_000 + seq,
    replyTo: replyTo ? { externalMessageId: replyTo, senderExternalId: null, media: null } : null,
  });
}

function runtimeSocket(): Promise<ServerFrame[]> {
  const url = new URL('/v2/ws', server.url);
  url.protocol = 'ws:';
  url.searchParams.set('bridgeRuntime', 'wa-e2e');
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${runtimeToken}` } } as unknown as string[]);
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  ws.onmessage = (ev) => {
    const frame = JSON.parse(String(ev.data)) as ServerFrame;
    frames.push(frame);
    if (frame.type === 'react') void call('/v2/bridge-runtime/sent', runtimeToken, { outboxId: frame.outboxId, connectionId: frame.connectionId, externalMessageId: `react-${frame.outboxId}` });
  };
  return new Promise((resolve, reject) => { ws.onopen = () => resolve(frames); ws.onerror = () => reject(new Error('socket refused')); });
}

async function until<T>(probe: () => T | undefined | Promise<T | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

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

describe('a worker in the group, end to end through the real server (B1b-8 ac1, ac7)', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('bridges_b1b8_e2e');
    database.apply(migrationFiles());
    db = createDb(database.url, { max: 4 });
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
      await c.query(`insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values ($1,$2,'b1b8-e2e',true,true)`,
        [ownerAccount, ownerIdentity]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'B1b-8 e2e',$2)`, [spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
        [ownerMember, spaceId, ownerIdentity]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values
        ($1,$3,'team_member',$4,'space'), ($2,$3,'team_member',$4,'space')`, [chatTeammate, workerPersona, spaceId, ownerMember]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values
        ($1,$3,'Infra Bot','worker','persona'), ($2,$3,'Deploy Bot','worker','persona')`, [chatTeammate, workerPersona, ownerMember]);
      for (const [id, title] of [[chatA, 'Infra main'], [chatB, 'Ops main']] as const) {
        await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [id, spaceId, ownerMember]);
        await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
            chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
          values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b8', gen_random_uuid(), $5, $6, $7)`,
          [id, spaceId, title, chatTeammate, ownerIdentity, ownerMember, `b1b8-${randomUUID()}`]);
      }
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
        [worker, spaceId, workerPersona]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Deploy fixer','running','none',now())`, [worker]);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'participates_in',$2)`,
        [spaceId, workerPersona, worker]);
      await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9494','linked')`,
        [connection, ownerAccount]);
    });
    const human = { identityId: ownerIdentity, authKind: 'browser' as const, requestId: randomUUID() };
    // D32 (#1427): a bridge rides its connection's offered credential in the space.
    await db.tx(human, (q) => q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
    const policy = JSON.stringify({ trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'anyone', voice: 'named', style: null });
    for (const [group, chat] of [[GROUP_A, chatA], [GROUP_B, chatB]] as const) {
      const created = await db.tx(human, (q) => q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, group,
        JSON.stringify({ kind: 'group', title: group === GROUP_A ? 'Infra' : 'Ops', memberCount: 4 }), chat, policy,
        chatTeammate, null, null, true, null, null, randomUUID()]));
      if (group === GROUP_A) bridgeA = created.entity.id; else bridgeB = created.entity.id;
    }
    runtimeToken = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'b1b8-e2e')).token;
    const secret = generateSecret();
    const agent = await db.tx(human, (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      worker, workerPersona, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'b1b8 worker']));
    workerToken = formatToken(agent.id, secret);
    handle = (await database.query<{ h: string }>('select internal.bridge_assign_handle($1, $2, $3) as h', [spaceId, worker, 'Deploy fixer']))[0]!.h;
    server = await bootstrap({ config: { ...loadConfig({
      ...process.env, TM8_BIND: '127.0.0.1', TM8_PORT: '4612', TM8_NODE_MODE: 'single', TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-b1b8-')), TM8_DISABLE_AUTO_OWNER: '1',
    }), port: 0 } });
  });

  afterAll(async () => {
    for (const ws of sockets) ws.close();
    await server?.server.close();
    await server?.db?.end();
    await db?.end();
    await database?.destroy();
  });

  it('directed in, signed reply out quoting the right message, a reply to the worker re-directs it, and one handle in two groups', async () => {
    const frames = await runtimeSocket();
    expect((await call('/v2/bridge-runtime/hello', runtimeToken, { provider: 'whatsapp', version: 3, runtimeId: 'wa-e2e', capabilities: {} })).status).toBe(200);
    const { port, sent } = capturingPort();
    const deliver = createBridgeSessionDelivery({ db, delivery: port });

    // Un-directed: no worker is woken.
    const chatter = await inbound(GROUP_A, 'morning all');
    expect(chatter.body).toMatchObject({ status: 'stored' });
    await deliver(chatter.body.messageId);
    expect(sent.filter((s) => s.session === worker)).toEqual([]);

    // @handle: delivered to the worker, directed, with unread.
    const ask = await inbound(GROUP_A, `@${handle} is the deploy done?`);
    await deliver(ask.body.messageId);
    const woke = sent.filter((s) => s.session === worker);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.content).toMatch(new RegExp(`<origin kind="bridge" bridge_id="${bridgeA}"[^>]*participant="Rahul"[^>]*directed="true" unread="[1-9]\\d*"`));

    // The worker replies with its own bearer: stored, queued, quoting the right message, signed Title (handle).
    const reply = await call('/v2/messages', workerToken, { replyToMessageId: ask.body.messageId, body: 'deployed at 10:40', clientMutationId: randomUUID() });
    expect(reply.status).toBe(200);
    const replyData = reply.body.data ?? reply.body;
    const replyId: string = replyData.messages[0].id;
    expect(replyData.bridgeDelivery).toEqual([expect.objectContaining({ messageId: replyId, bridgeId: bridgeA, status: 'pending' })]);
    const [row] = await database.query<{ poster: string; session_id: string; directed: boolean; external_reply_to: string;
      payload: { text: string; replyTo: { externalMessageId: string; fromMe: boolean; text: string } } }>(
      `select poster, session_id, directed, external_reply_to, payload from public.bridge_outbox where message_id = $1 and kind = 'send'`, [replyId]);
    expect(row).toMatchObject({ poster: 'worker', session_id: worker, directed: true, external_reply_to: `3EB0E2E${seq}` });
    expect(row!.payload.text).toBe(`Deploy fixer (${handle}): deployed at 10:40`);
    expect(row!.payload.replyTo).toMatchObject({ externalMessageId: `3EB0E2E${seq}`, fromMe: false, text: `@${handle} is the deploy done?` });
    const send = await until(() => frames.find((f): f is Extract<ServerFrame, { type: 'send' }> => f.type === 'send' && f.text === row!.payload.text));
    expect(send).toMatchObject({ connectionId: connection, conversationId: GROUP_A, replyTo: { externalMessageId: `3EB0E2E${seq}` } });
    expect((await call('/v2/bridge-runtime/sent', runtimeToken,
      { outboxId: send.outboxId, connectionId: connection, externalMessageId: 'BAE5E2E1', message: { conversation: 'x' } })).body)
      .toMatchObject({ status: 'sent' });

    // A group reply to the worker's sent post is directed to the worker again.
    const followUp = await inbound(GROUP_A, 'thanks, and the db?', 'BAE5E2E1');
    expect(followUp.body).toMatchObject({ status: 'stored' });
    await deliver(followUp.body.messageId);
    const again = sent.filter((s) => s.session === worker);
    expect(again).toHaveLength(2);
    expect(again[1]!.content).toMatch(/directed="true"/);
    expect(again[1]!.content).toContain('thanks, and the db?');

    // The same worker posts unprompted in the second group: the same handle (D23).
    const other = await call('/v2/messages', workerToken, { anchorIds: [bridgeB], body: 'heads up: deploying Ops', clientMutationId: randomUUID() });
    expect(other.status).toBe(200);
    const otherId: string = (other.body.data ?? other.body).messages[0].id;
    const [rowB] = await database.query<{ payload: { text: string }; bridge_id: string; directed: boolean }>(
      `select payload, bridge_id, directed from public.bridge_outbox where message_id = $1 and kind = 'send'`, [otherId]);
    expect(rowB).toMatchObject({ bridge_id: bridgeB, directed: false });
    expect(rowB!.payload.text).toBe(`Deploy fixer (${handle}): heads up: deploying Ops`);
    const appearances = await database.query<{ bridge_id: string }>(
      `select bridge_id from public.bridge_handle_appearances where space_id = $1 and handle = $2 order by bridge_id`, [spaceId, handle]);
    expect(appearances.map((a) => a.bridge_id).sort()).toEqual([bridgeA, bridgeB].sort());
  });
});
