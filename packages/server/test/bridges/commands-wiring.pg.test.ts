/**
 * Bridges B1b-4 ac6: the command executor is WIRED. Boots the real server
 * (`bootstrap`, so main.ts's composition), posts an inbound `/help` from a
 * linked number through the real runtime door (`POST /v2/bridge-runtime/inbound`
 * with a bridge_runtime bearer), and waits for the command to be settled
 * `done` with a reply queued in bridge_outbox. If main.ts does not fill the
 * `bridgeCommands` slot, the message is not a command at all and this fails.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let server: BootstrappedServer;
let base = '';
let token = '';
let bridgeId = '';
const space = randomUUID(), member = randomUUID(), account = randomUUID(), persona = randomUUID();
const chat = randomUUID(), connection = randomUUID();
const identity = `b1b4-wiring-${randomUUID()}`;
const GROUP = '120363-wiring@g.us', PHONE = '919000000101@s.whatsapp.net';

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  return database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    return (await c.query(text, params)).rows as T[];
  });
}

async function post(route: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/v2/bridge-runtime/${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridge_commands_wiring');
  database.apply(migrationFiles());
  await sql('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identity]);
  await sql('insert into public.accounts(id,identity_id,username,display_name,is_node_admin,is_owner) values($1,$2,$2,$2,true,true)', [account, identity]);
  await sql("insert into public.spaces(id,name,created_by_identity) values($1,'Wiring',$2)", [space, identity]);
  await sql("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
  await sql("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3)", [member, space, identity]);
  await sql("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
  await sql("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Infra','','persona')", [persona, member]);
  await sql("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [chat, space, member]);
  await sql(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
      chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
    values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/b1b4w', gen_random_uuid(), $4, $5, $6)`,
    [chat, space, persona, identity, member, `b1b4w-${randomUUID()}`]);
  await sql(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
    values ($1,'whatsapp',$2,'+91 …0101','linked')`, [connection, account]);
  await sql(`insert into public.bridge_identity_links(provider, external_id, identity_id, method, verified_at)
    values ('whatsapp',$1,$2,'code',now())`, [PHONE, identity]);

  const configured = loadConfig({
    ...process.env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4611',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: await mkdtemp(join(tmpdir(), 'tm8-b1b4w-')),
    TM8_DISABLE_AUTO_OWNER: '1',
  });
  server = await bootstrap({ config: { ...configured, port: 0 } });
  base = server.url;
  const db = server.db!;

  // D32 (#1427): a bridge rides its connection's offered credential in the space.
  await db.rpc({ identityId: identity, nodeAdmin: false, authKind: 'cli', requestId: 'b1b4w-offer' }, 'offer_bridge_connection',
    [connection, space, 'public', null, `b1b4w-${randomUUID()}`]);
  const created = await db.rpc<{ entity: { id: string } }>(
    { identityId: identity, nodeAdmin: false, authKind: 'cli', requestId: 'b1b4w-create' }, 'create_bridge',
    [space, connection, GROUP, JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 3 }), chat, '{}', persona,
      null, null, true, null, null, `b1b4w-${randomUUID()}`]);
  bridgeId = created.entity.id;

  // The node mints the runtime's own session (398); its bearer is the only key to the runtime doors.
  const secret = generateSecret();
  const session = await db.rpc<{ id: string }>({ identityId: identity, nodeAdmin: true, requestId: 'b1b4w-runtime' },
    'issue_bridge_runtime_session', [hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'b1b4-wiring']);
  token = formatToken(session.id, secret);
});

afterAll(async () => {
  await server?.server.close();
  await server?.db?.end();
  await database?.destroy();
});

describe('ac6: main.ts injects the command executor', () => {
  it('an inbound /help from a linked number is executed, settled done and answered through the outbox', async () => {
    const hello = await post('hello', { provider: 'whatsapp', version: 1, runtimeId: 'wa-wiring', capabilities: {} });
    expect(hello.status, JSON.stringify(hello.json)).toBe(200);
    const inbound = await post('inbound', {
      connectionId: connection, conversationId: GROUP, externalMessageId: `3EB0W${Date.now()}`,
      sender: { externalId: PHONE, altId: null, name: 'Owner', fromMe: false },
      body: '/help', kind: 'text', media: [], replyTo: null, mentions: [], ts: Math.floor(Date.now() / 1000),
    });
    expect(inbound.status, JSON.stringify(inbound.json)).toBe(200);
    expect(inbound.json).toMatchObject({ status: 'stored', command: true });
    const messageId = inbound.json.messageId as string;

    let state: string | null = null;
    for (let i = 0; i < 100 && state !== 'done'; i++) {
      [{ command_state: state }] = await sql<{ command_state: string | null }>(
        'select command_state from public.message_origins where message_id = $1', [messageId]);
      if (state !== 'done') await new Promise(resolve => setTimeout(resolve, 200));
    }
    expect(state).toBe('done');
    const replies = await sql<{ n: number }>(
      `select count(*)::int n from public.bridge_outbox ob join public.messages m on m.entity_id = ob.message_id
        where ob.bridge_id = $1 and m.body like '%commands here%'`, [bridgeId]);
    expect(replies[0]!.n).toBe(1);
  });
});
