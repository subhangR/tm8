/**
 * #1427 ac5 (B1b-5 over B1b-2's runtime, real bootstrap()): withdrawing a
 * connection's offer pauses its bridges in the database, and the runtime's
 * allowlist follows. The pushed list drops the group, with a higher version,
 * within 5 s (§7.3 item 12).
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
const ownerIdentity = `b1b5-ac5-${randomUUID()}`, ownerAccount = randomUUID();
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
  database = await createW1ScratchDatabase('bridges_b1b5_ac5');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-b1b5-'));
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values ($1,$2,'b1b5-ac5',true,true)`,
      [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Bridges ac5',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
      [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b5', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, ownerIdentity, ownerMember, `b1b5-${randomUUID()}`]);
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
      new Date(Date.now() + 3_600_000).toISOString(), null, 'b1b5 browser']));
  browserToken = formatToken(row.id, secret);
  const configured = loadConfig({
    ...process.env, TM8_BIND: '127.0.0.1', TM8_PORT: '4613', TM8_NODE_MODE: 'single',
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
