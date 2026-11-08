/**
 * Bridges B1b-5/B1b-7 over the REAL composition root (bootstrap()): the
 * connection doors wired to B1b-2's runtime hub and doors, so neither can ship
 * unwired again.
 *
 * - begin reaches the hub ('connecting', a `connect` frame on the runtime's
 *   socket), and the runtime's `auth` door relays the code to the begin
 *   caller's own events socket.
 * - #1427 ac5: withdrawing the offer pushes an allowlist without the group,
 *   with a higher version, within 5 s.
 * - bridges.conversations.list asks the runtime live and answers its items.
 * - bridges.connections.remove ends the bridges and sends `disconnect {logout}`.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, type AllowlistFrame, type ServerFrame } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), chat = randomUUID();
const ownerIdentity = `b1b7-wire-${randomUUID()}`, ownerAccount = randomUUID();
const connection = randomUUID();
const GROUP = '120363999@g.us';
const RUNTIME = 'wa-wire';
let bridge = '';
let runtimeToken = '';
let browserToken = '';
const sockets: WebSocket[] = [];
let runtimeFrames: ServerFrame[] = [];
let helloAllowlist: AllowlistFrame | undefined;

const human = { identityId: ownerIdentity, authKind: 'browser' as const };

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

function socket(token: string, runtimeId?: string): Promise<{ frames: string[]; ws: WebSocket }> {
  const url = new URL('/v2/ws', server.url);
  url.protocol = 'ws:';
  if (runtimeId) url.searchParams.set('bridgeRuntime', runtimeId);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
  sockets.push(ws);
  const frames: string[] = [];
  ws.onmessage = (ev) => frames.push(String(ev.data));
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ frames, ws });
    ws.onerror = () => reject(new Error('socket refused'));
  });
}

async function until<T>(probe: () => T | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridges_b1b7_wire');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-b1b7-'));
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values ($1,$2,'b1b7-wire',true,true)`,
      [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges wiring',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
      [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b7', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, ownerIdentity, ownerMember, `b1b7-${randomUUID()}`]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, runtime_id)
      values ($1,'whatsapp',$2,'+91 …9494','linked',$3)`, [connection, ownerAccount, RUNTIME]);
  });
  await db.tx({ ...human, requestId: randomUUID() }, (q) =>
    q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
  const created = await db.tx({ ...human, requestId: randomUUID() }, (q) =>
    q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connection, GROUP,
      JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 4 }), chat, '{}', teammate, null, null, true, null, null, randomUUID()]));
  bridge = created.entity.id;
  runtimeToken = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'whatsapp-runtime')).token;
  const secret = generateSecret();
  const row = await db.tx({ ...human, requestId: randomUUID() }, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [ownerAccount, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'b1b7 browser']));
  browserToken = formatToken(row.id, secret);
  const configured = loadConfig({
    ...process.env, TM8_BIND: '127.0.0.1', TM8_PORT: '4612', TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url, TM8_DATA_DIR: dataDir, TM8_DISABLE_AUTO_OWNER: '1',
  });
  server = await bootstrap({ config: { ...configured, port: 0 } });
  const rt = await socket(runtimeToken, RUNTIME);
  runtimeFrames = [];
  rt.ws.onmessage = (ev) => runtimeFrames.push(JSON.parse(String(ev.data)) as ServerFrame);
  const hello = await call('/v2/bridge-runtime/hello', runtimeToken, { provider: 'whatsapp', version: 1, runtimeId: RUNTIME, capabilities: {} });
  expect(hello.status).toBe(200);
  helloAllowlist = hello.body.connections.find((c: { connectionId: string }) => c.connectionId === connection)?.allowlist;
});

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
});

describe('begin is wired to the hub and the auth door (B1b-7)', () => {
  it('begin answers connecting, the runtime gets connect, and the code reaches the caller\'s own socket', async () => {
    const mine = await socket(browserToken);
    const begun = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'whatsapp', label: 'New phone' });
    expect(begun.status, JSON.stringify(begun.body)).toBe(200);
    expect(begun.body.data.runtime).toBe('connecting');
    const id = begun.body.data.connection.id as string;
    await until(() => runtimeFrames.find((f) => f.type === 'connect' && f.connectionId === id));
    const code = `WIRE-${randomUUID().slice(0, 4)}`;
    const relayed = await call('/v2/bridge-runtime/auth', runtimeToken,
      { connectionId: id, pairingCode: code, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(relayed.status).toBeLessThan(300);
    const frame = await until(() => mine.frames.find((f) => f.includes(code)));
    expect(JSON.parse(frame)).toMatchObject({ type: 'bridge.connection.auth', connectionId: id, pairingCode: code });
  });
});

describe('#1427 ac5: a withdraw reaches the runtime', () => {
  it('withdrawing the offer pushes an allowlist without the group, with a higher version, within 5 s', async () => {
    const latest = () => runtimeFrames.filter((f): f is AllowlistFrame => f.type === 'allowlist' && f.connectionId === connection).at(-1);
    // The list the runtime holds now: the last one pushed, else hello's.
    const before = latest() ?? helloAllowlist!;
    expect(before.conversationIds).toContain(GROUP);
    const started = Date.now();
    const withdrawn = await call(`/v2/me/bridge-connections/${connection}/withdraw`, browserToken, { clientMutationId: randomUUID(), spaceId });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.data.pausedBridgeIds).toEqual([bridge]);
    const after = await until(() => {
      const f = latest();
      return f && f.version > before.version && !f.conversationIds.includes(GROUP) ? f : undefined;
    }, 5000);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(after.conversationIds).toEqual([]);
  });
});

describe('bridges.conversations.list (B1b-7 ac3)', () => {
  it('asks the runtime live and answers its items', async () => {
    const pending = call(`/v2/me/bridge-connections/${connection}/conversations`, browserToken, undefined, 'GET');
    const ask = await until(() => runtimeFrames.find((f): f is Extract<ServerFrame, { type: 'conversation.list' }> =>
      f.type === 'conversation.list' && f.connectionId === connection));
    const items = [{ conversationId: GROUP, kind: 'group', name: 'Infra', size: 4, canSend: true, reason: null }];
    expect((await call('/v2/bridge-runtime/conversations', runtimeToken, { requestId: ask.requestId, connectionId: connection, items })).status)
      .toBeLessThan(300);
    const listed = await pending;
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toEqual({ connectionId: connection, items });
    const [stored] = await database.query<{ n: number }>(
      `select (select count(*) from public.workspace_events where payload::text like '%120363999@g.us%' and payload::text like '%"canSend"%')
            + (select count(*) from public.command_ledger where coalesce(result::text,'') like '%"canSend"%')::int as n`);
    expect(Number(stored!.n)).toBe(0);
  });
});

describe('bridges.connections.remove (B1b-7 ac2)', () => {
  it('ends every bridge on the connection, revokes its offers and logs the device out', async () => {
    const removed = await call(`/v2/me/bridge-connections/${connection}/remove`, browserToken, { clientMutationId: randomUUID() });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.data).toMatchObject({ endedBridgeIds: [bridge], runtime: 'logged_out', connection: { id: connection, status: 'removed' } });
    await until(() => runtimeFrames.find((f) => f.type === 'disconnect' && f.connectionId === connection && f.logout === true));
    const [b] = await database.query<{ ended_at: Date | null }>('select ended_at from public.bridges where entity_id = $1', [bridge]);
    expect(b!.ended_at).not.toBeNull();
    const listed = await call('/v2/me/bridge-connections', browserToken, undefined, 'GET');
    expect(listed.body.data.items.map((c: { id: string }) => c.id)).not.toContain(connection);
  });
});
