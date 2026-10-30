/**
 * Bridges B1b-2 over the real server (migration 398, bridges/runtime/*).
 *
 * ac8 / §2.5: the node mints a bridge_runtime session; it reaches its own doors
 * and nothing else — every catalog operation and the events socket refuse it.
 * ac2 / §7.3 item 5: the doors refuse every other kind of caller.
 * ac4 / §7.3 item 12: the allowlist is pushed on the runtime's socket on
 * change, and a pause takes the group off within 5 s.
 * ac7 / D35: allowlist versions keep growing across a server restart.
 * ac1 / §7.3 item 3: an @tm8 message over HTTP starts a turn; the answer is
 * dispatched on the socket signed with the teammate and settles `sent`.
 * ac10: messages.post answers a refused bridged post with its reason.
 * ac6: the watchdog job raises the fyi and reacts ⚠️ through the outbox.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { OPERATIONS, TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, type AllowlistFrame, type ServerFrame } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { bridgeWatchdogJob } from '../../src/scheduler/jobs/bridge-watchdog.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
let dataDir = '';
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), chat = randomUUID();
const ownerIdentity = `b1b2-srv-${randomUUID()}`, ownerAccount = randomUUID();
const connection = randomUUID();
const GROUP = '120363777@g.us';
let bridge = '';
let runtimeToken = '';
let browserToken = '';
const sockets: WebSocket[] = [];

async function boot(): Promise<BootstrappedServer> {
  const configured = loadConfig({
    ...process.env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4611',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: dataDir,
    TM8_DISABLE_AUTO_OWNER: '1',
  });
  return bootstrap({ config: { ...configured, port: 0 } });
}

async function call(path: string, token: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; body: any }> {
  const response = await fetch(new URL(path, server.url), {
    method,
    headers: {
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      authorization: `Bearer ${token}`,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

/** The runtime's push socket: every frame it receives, in order. */
function runtimeSocket(runtimeId: string): Promise<{ frames: ServerFrame[]; ws: WebSocket }> {
  const url = new URL('/v2/ws', server.url);
  url.protocol = 'ws:';
  url.searchParams.set('bridgeRuntime', runtimeId);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${runtimeToken}` } } as unknown as string[]);
  sockets.push(ws);
  const frames: ServerFrame[] = [];
  ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)) as ServerFrame);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ frames, ws });
    ws.onerror = () => reject(new Error('runtime socket refused'));
  });
}

async function until<T>(probe: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const hello = (runtimeId: string) => call('/v2/bridge-runtime/hello', runtimeToken,
  { provider: 'whatsapp', version: 1, runtimeId, capabilities: {} });

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridges_b1b2_srv');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-b1b2-'));
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values ($1,$2,'b1b2-srv',true,true)`,
      [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges server',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
      [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b2', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, ownerIdentity, ownerMember, `b1b2-${randomUUID()}`]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9494','linked')`,
      [connection, ownerAccount]);
  });
  const created = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
    q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, GROUP,
      JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 4 }), chat,
      JSON.stringify({ trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'anyone', voice: 'named', style: null }),
      teammate, null, null, true, null, null, randomUUID()]));
  bridge = created.entity.id;
  runtimeToken = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'whatsapp-runtime')).token;
  const secret = generateSecret();
  const row = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [ownerAccount, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'b1b2 browser']));
  browserToken = formatToken(row.id, secret);
  server = await boot();
});

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
});

describe('the bridge_runtime session reaches its doors and nothing else (ac2, ac8)', () => {
  it('answers hello with each connection, a 32-byte stateKey and an allowlist', async () => {
    const r = await hello('wa-srv');
    expect(r.status).toBe(200);
    const mine = r.body.connections.find((c: { connectionId: string }) => c.connectionId === connection);
    expect(Buffer.from(mine.stateKey, 'base64')).toHaveLength(32);
    expect(mine.allowlist).toMatchObject({ type: 'allowlist', connectionId: connection, conversationIds: [GROUP] });
  });

  it('every catalog operation refuses it forbidden, messages.post included', async () => {
    const other: string[] = [];
    for (const op of OPERATIONS) {
      // The /v2/ws upgrades (events.subscribe, containers.stream) are not HTTP calls;
      // the socket's refusal is its own test below.
      if ((op.method as string) === 'WS') continue;
      const path = op.path.replace(/:[A-Za-z]+/g, () => randomUUID());
      const r = await call(path, runtimeToken, {}, op.method);
      if (r.status !== 403) other.push(`${op.name} ${r.status}`);
    }
    expect(other).toEqual([]);
    const post = await call('/v2/messages', runtimeToken, { anchorIds: [bridge], body: 'x', clientMutationId: randomUUID() });
    expect(post.status).toBe(403);
    expect(post.body.error?.code ?? post.body.code).toBe('forbidden');
  });

  it('the events socket refuses it; only the ?bridgeRuntime socket admits it', async () => {
    const url = new URL('/v2/ws', server.url);
    url.protocol = 'ws:';
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${runtimeToken}` } } as unknown as string[]);
    sockets.push(ws);
    const opened = await new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); });
    expect(opened).toBe(false);
  });

  it("the owner's own session list keeps its human sessions and never shows the runtime's (398 replaces list_auth_sessions)", async () => {
    const listed = await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
      q.rpc<{ kind: string }[]>('list_auth_sessions', [null]));
    const kinds = listed.map((s) => s.kind);
    expect(kinds).toContain('browser');
    expect(kinds).not.toContain('bridge_runtime');
    const [live] = await database.query<{ n: number }>(`select count(*)::int as n from public.auth_sessions
      where kind = 'bridge_runtime' and revoked_at is null`);
    expect(live!.n).toBe(1);
  });

  it('the doors refuse a human session', async () => {
    const r = await call('/v2/bridge-runtime/inbound', browserToken, { connectionId: connection });
    expect(r.status).toBe(403);
    const h = await call('/v2/bridge-runtime/hello', browserToken, { provider: 'whatsapp', runtimeId: 'x', version: 1 });
    expect(h.status).toBe(403);
  });
});

describe('the push socket, the allowlist and a restart (ac4, ac7)', () => {
  let lastVersion = 0;
  it('pausing the bridge pushes a list without the group, with a higher version, within 5 s', async () => {
    const { frames } = await runtimeSocket('wa-srv');
    const first = await hello('wa-srv');
    lastVersion = first.body.connections[0].allowlist.version;
    const [v] = await database.query<{ version: number }>('select version from public.entities where id = $1', [bridge]);
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
      q.rpc('pause_bridge', [bridge, v!.version, null, randomUUID()]));
    const pushed = await until(() => frames.find((f): f is AllowlistFrame => f.type === 'allowlist' && f.version > lastVersion));
    expect(pushed.conversationIds).toEqual([]);
    lastVersion = pushed.version;
    const [w] = await database.query<{ version: number }>('select version from public.entities where id = $1', [bridge]);
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
      q.rpc('resume_bridge', [bridge, w!.version, null, randomUUID()]));
    const back = await until(() => frames.find((f): f is AllowlistFrame => f.type === 'allowlist' && f.version > lastVersion));
    expect(back.conversationIds).toEqual([GROUP]);
    lastVersion = back.version;
  });

  it('after a server restart the next allowlist version is higher than the last one sent (D35)', async () => {
    for (const ws of sockets) ws.close();
    await server.server.close();
    await server.db?.end();
    server = await boot();
    const again = await hello('wa-srv');
    expect(again.status).toBe(200);
    expect(again.body.connections[0].allowlist.version).toBeGreaterThan(lastVersion);
  });
});

describe('a message end to end (ac1, ac10, ac6)', () => {
  it('@tm8 is stored on the bridge as the participant, starts a turn, and the answer leaves signed and settles sent', async () => {
    const { frames } = await runtimeSocket('wa-srv');
    await hello('wa-srv');
    const inbound = await call('/v2/bridge-runtime/inbound', runtimeToken, {
      connectionId: connection, conversationId: GROUP, externalMessageId: '3EB0SRV1',
      sender: { externalId: '919800000001@s.whatsapp.net', altId: null, name: 'Rahul', fromMe: false },
      body: '@tm8 is the deploy done?', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_100,
    });
    expect(inbound.status).toBe(200);
    expect(inbound.body).toMatchObject({ status: 'stored', routed: true });
    const again = await call('/v2/bridge-runtime/inbound', runtimeToken, {
      connectionId: connection, conversationId: GROUP, externalMessageId: '3EB0SRV1',
      sender: { externalId: '919800000001@s.whatsapp.net', altId: null, name: 'Rahul', fromMe: false },
      body: '@tm8 is the deploy done?', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_100,
    });
    expect(again.body).toMatchObject({ status: 'duplicate', messageId: inbound.body.messageId });

    const [turn] = await database.query<{ turn_id: string }>('select turn_id from public.chat_turns where user_message_id = $1', [inbound.body.copyId]);
    const answer = randomUUID();
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [answer, spaceId, teammate]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'Yes, at 10:40.')`, [answer, chat, teammate]);
      await c.query(`update public.chat_turns set state = 'completed', agent_message_id = $2, completed_at = now() where turn_id = $1`, [turn!.turn_id, answer]);
    });
    const send = await until(() => frames.find((f): f is Extract<ServerFrame, { type: 'send' }> => f.type === 'send'));
    expect(send).toMatchObject({ connectionId: connection, conversationId: GROUP, text: 'Infra Bot: Yes, at 10:40.',
      replyTo: { externalMessageId: '3EB0SRV1', fromMe: false, text: '@tm8 is the deploy done?' } });
    const sent = await call('/v2/bridge-runtime/sent', runtimeToken,
      { outboxId: send.outboxId, connectionId: connection, externalMessageId: 'BAE5SRV1', message: { conversation: 'x' } });
    expect(sent.body).toMatchObject({ status: 'sent' });
    const badge = await db.rpc<{ status: string }[]>({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() },
      'internal.bridge_message_delivery', [[answer]]);
    expect(badge[0]).toMatchObject({ status: 'sent', externalMessageId: 'BAE5SRV1' });
  });

  it('messages.post on a paused bridge stores the message and answers bridge_paused (ac10)', async () => {
    const [v] = await database.query<{ version: number }>('select version from public.entities where id = $1', [bridge]);
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
      q.rpc('pause_bridge', [bridge, v!.version, null, randomUUID()]));
    const r = await call('/v2/messages', browserToken, { anchorIds: [bridge], body: 'heads up, deploying', clientMutationId: randomUUID() });
    expect(r.status).toBe(200);
    const data = r.body.data ?? r.body;
    expect(data.messages).toHaveLength(1);
    expect(data.bridgeDelivery).toEqual([expect.objectContaining({ bridgeId: bridge, status: 'refused', reason: 'bridge_paused' })]);
    const [w] = await database.query<{ version: number }>('select version from public.entities where id = $1', [bridge]);
    await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
      q.rpc('resume_bridge', [bridge, w!.version, null, randomUUID()]));
  });

  it('the watchdog job marks a silent runtime degraded with one fyi, and reacts ⚠️ on a failed turn (ac6)', async () => {
    const r = await call('/v2/bridge-runtime/inbound', runtimeToken, {
      connectionId: connection, conversationId: GROUP, externalMessageId: '3EB0SRV2',
      sender: { externalId: '919800000001@s.whatsapp.net', altId: null, name: 'Rahul', fromMe: false },
      body: '@tm8 this one fails', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_200,
    });
    await database.query(`update public.chat_turns set state = 'error' where user_message_id = $1`, [r.body.copyId]);
    await database.query(`update public.bridge_connections set heartbeat_at = now() - interval '5 minutes' where id = $1`, [connection]);
    const job = bridgeWatchdogJob({ db });
    const ctx = { name: 'bridges.watchdog', firedAt: new Date(), logger: console as never, signal: new AbortController().signal };
    const outcome = await job.run(ctx);
    expect(outcome).toMatchObject({ detail: { runtimeDown: 1, warned: 1 } });
    await job.run(ctx);
    const fyi = await database.query<{ n: number }>(`select count(*)::int as n from public.attention_requests
      where status = 'open' and level = 'fyi' and signal_key in ($1, $2)`, [`bridge.runtime_down:${connection}`, `bridge.turn_failed:${bridge}`]);
    expect(fyi[0]!.n).toBe(2);
    const reacts = await database.query<{ n: number }>(`select count(*)::int as n from public.bridge_outbox
      where message_id = $1 and kind = 'react' and payload ->> 'emoji' = '⚠️'`, [r.body.messageId]);
    expect(reacts[0]!.n).toBe(1);
  });
});
