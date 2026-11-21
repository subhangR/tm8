/**
 * Secure Vault's paste guard over the real server (src/vault/paste-guard.ts, TM8_VAULT_PASTE_GUARD).
 *
 * MSG 6 Journey A step 3, and acceptance test 20's "no raw secret reaches ...": with the knob on, the
 * secret-shaped text a PERSON sends is redacted before it is stored, wherever it arrives, and the person
 * is told it is exposed anyway. Proven here on a booted node, over HTTP, on every migration:
 *  - messages.post stores `[redacted:<kind>]` and answers the vault_paste_redacted warning first;
 *  - messages.edit refuses a secret-shaped edit, the message keeps its text, and a clean edit still saves;
 *  - a bridged person's message is stored redacted with one notice threaded on it in the chat (queued in
 *    the outbox); the same frame again adds no second notice; a provider edit is redacted with its own;
 *  - NO TABLE in the database, no file in the data directory and no line the server logged holds any value
 *    a person sent: a request ledger or a stored frame keeping the raw text fails here, not only the body;
 *  - an agent's post is not scanned (a known limit, plan §10), pinned so that changing it is a decision;
 *  - with the knob unset, the default, the same node stores exactly what it is sent and warns nobody.
 * chat.start is proven without a database in paste-guard-chat-start.test.ts: a test node has no chat runtime.
 *
 * Every secret-shaped value is assembled at runtime, and no assertion prints one.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, VAULT_PASTE_WARNING_CODE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueAgentRuntimeSession, issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createPasteGuard, type PasteKind } from '../../src/vault/paste-guard.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
let dataDir = '';
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), chat = randomUUID();
const ownerIdentity = `paste-guard-${randomUUID()}`, ownerAccount = randomUUID();
const connection = randomUUID();
const GROUP = '120363888@g.us';
let bridge = '';
let anchor = '';
let runtimeToken = '';
let browserToken = '';

/** What the guarded node is expected to store: the guard's own answer, as the server builds it (vault off). */
const expected = createPasteGuard({ vaultAvailable: false });
/** Every value a person sent while the guard was on. None may be stored anywhere. */
const sent: string[] = [];
/** Every line the server logged, through console, while this file ran. */
const logged: string[] = [];

const github = (fill = 'A') => 'gh' + 'p_' + fill.repeat(36);
const aws = () => 'AK' + 'IA' + 'Q'.repeat(16);
const jwt = () => [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), 'e30', Buffer.alloc(32, 7).toString('base64url')].join('.');
const card = () => ['4111', '1111', '1111', '1111'].join(' ');
const passwordWord = () => ['Tr0ub', '4dor&3'].join('');
const leaks = (text: string, value: string) => text.toLowerCase().includes(value.toLowerCase());

const person = { externalId: '919800000002@s.whatsapp.net', altId: null, name: 'Meera', fromMe: false };
const frame = (externalMessageId: string, body: string, extra: Record<string, unknown> = {}) => ({
  connectionId: connection, conversationId: GROUP, externalMessageId, sender: person,
  body, kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_100, ...extra,
});

async function boot(guard: 'on' | null): Promise<BootstrappedServer> {
  const configured = loadConfig({
    ...process.env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4612',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: dataDir,
    TM8_DISABLE_AUTO_OWNER: '1',
  });
  // main.ts reads the knob from process.env as it boots, beside the vault relay's knobs.
  const before = process.env.TM8_VAULT_PASTE_GUARD;
  if (guard) process.env.TM8_VAULT_PASTE_GUARD = guard;
  else delete process.env.TM8_VAULT_PASTE_GUARD;
  try {
    return await bootstrap({ config: { ...configured, port: 0 } });
  } finally {
    if (before === undefined) delete process.env.TM8_VAULT_PASTE_GUARD;
    else process.env.TM8_VAULT_PASTE_GUARD = before;
  }
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

async function eventually<T>(probe: () => Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const bodyOf = async (messageId: string) =>
  (await database.query<{ body: string }>('select body from public.messages where entity_id = $1', [messageId]))[0]?.body ?? '';

const noticeFor = (key: string) => eventually(async () =>
  (await database.query<{ message_id: string }>('select message_id::text from public.bridge_notices where idempotency_key = $1', [key]))[0]);

const noticeCount = async (prefix: string) =>
  (await database.query<{ n: number }>("select count(*)::int as n from public.bridge_notices where idempotency_key like $1 || '%'", [prefix]))[0]!.n;

const pasteWarned = (data: { warnings?: { code: string }[] }) => (data.warnings ?? []).some((w) => w.code === VAULT_PASTE_WARNING_CODE);

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

beforeAll(async () => {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
      original(...args);
    });
  }
  database = await createW1ScratchDatabase('vault_paste_guard');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-paste-guard-'));
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values ($1,$2,'paste-guard',true,true)`,
      [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Paste guard',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
      [teammate, ownerMember]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/paste-guard', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, ownerIdentity, ownerMember, `paste-guard-${randomUUID()}`]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status) values ($1,'whatsapp',$2,'+91 …9595','linked')`,
      [connection, ownerAccount]);
  });
  await db.tx({ identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() }, (q) =>
    q.rpc('offer_bridge_connection', [connection, spaceId, 'public', null, randomUUID()]));
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
      new Date(Date.now() + 3_600_000).toISOString(), null, 'paste guard browser']));
  browserToken = formatToken(row.id, secret);
  server = await boot('on');
  const made = await call('/v2/entities', browserToken, {
    clientMutationId: randomUUID(), spaceId, kind: 'task', title: 'Paste guard anchor', content: { priority: 'medium' },
  });
  expect([200, 201], JSON.stringify(made.body?.error ?? null)).toContain(made.status);
  anchor = (made.body.data ?? made.body).entity.id;
});

afterAll(async () => {
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
  vi.restoreAllMocks();
});

describe('TM8_VAULT_PASTE_GUARD=on: what a person sends', () => {
  let posted = { id: '', version: 0 };
  const postText = () => `deploy key: ${github()}`;

  it('messages.post stores the redacted text and answers the paste warning first', async () => {
    const r = await call('/v2/messages', browserToken, { anchorIds: [anchor], body: postText(), clientMutationId: randomUUID() });
    expect(r.status).toBe(200);
    sent.push(github());
    const data = r.body.data ?? r.body;
    posted = { id: data.messages[0].id, version: data.messages[0].version };
    const stored = await bodyOf(posted.id);
    expect(stored).toBe(expected.redact(postText()).text);
    expect(stored.includes('[redacted:github_token]')).toBe(true);
    expect(data.warnings?.[0]?.code).toBe(VAULT_PASTE_WARNING_CODE);
    expect(data.warnings[0].message.includes('Treat it as exposed anyway')).toBe(true);
    expect(leaks(JSON.stringify(r.body), github())).toBe(false);
  });

  it('messages.edit refuses a secret-shaped edit and the message keeps its text; a clean edit still saves', async () => {
    const before = await bodyOf(posted.id);
    const refused = await call(`/v2/messages/${posted.id}`, browserToken,
      { clientMutationId: randomUUID(), expectedVersion: posted.version, body: `card ${card()}` }, 'PATCH');
    sent.push(card());
    const error = refused.body.error ?? refused.body;
    expect(refused.status, JSON.stringify(error.code)).toBe(400);
    expect(error.code).toBe('invalid_input');
    expect(error.details?.reason).toBe(VAULT_PASTE_WARNING_CODE);
    expect(error.details?.kinds).toEqual(['card_number']);
    expect(leaks(JSON.stringify(refused.body), card())).toBe(false);
    expect(await bodyOf(posted.id)).toBe(before);

    const clean = await call(`/v2/messages/${posted.id}`, browserToken,
      { clientMutationId: randomUUID(), expectedVersion: posted.version, body: 'deploy key rotated, see the runbook' }, 'PATCH');
    expect(clean.status, JSON.stringify(clean.body)).toBe(200);
    expect(await bodyOf(posted.id)).toBe('deploy key rotated, see the runbook');
  });

  it("a bridged person's message is stored redacted, with one notice in the chat; the same frame again adds none", async () => {
    const text = `the session is ${jwt()}`;
    const inbound = await call('/v2/bridge-runtime/inbound', runtimeToken, frame('3EB0PASTE1', text));
    sent.push(jwt());
    expect(inbound.status, JSON.stringify(inbound.body?.status)).toBe(200);
    expect(inbound.body).toMatchObject({ status: 'stored', bridgeId: bridge });
    expect(await bodyOf(inbound.body.messageId)).toBe(expected.redact(text).text);

    const notice = await noticeFor(`vault-paste:${bridge}:3EB0PASTE1`);
    expect(await bodyOf(notice.message_id)).toBe(expected.bridgeNotice(['jwt']));
    // The notice goes back out to the group, where the person who pasted will read it.
    const [queued] = await database.query<{ n: number }>('select count(*)::int as n from public.bridge_outbox where message_id = $1', [notice.message_id]);
    expect(queued!.n).toBe(1);

    const again = await call('/v2/bridge-runtime/inbound', runtimeToken, frame('3EB0PASTE1', text));
    expect(again.body).toMatchObject({ status: 'duplicate', messageId: inbound.body.messageId });
    await new Promise((r) => setTimeout(r, 500));
    expect(await noticeCount(`vault-paste:${bridge}:3EB0PASTE1`)).toBe(1);
  });

  it('a provider edit that adds a secret is stored redacted, with its own notice', async () => {
    const first = await call('/v2/bridge-runtime/inbound', runtimeToken, frame('3EB0PASTE2', 'deploying staging now'));
    expect(first.body).toMatchObject({ status: 'stored' });
    expect(await noticeCount(`vault-paste:${bridge}:3EB0PASTE2`)).toBe(0);
    const text = `the password is ${passwordWord()}`;
    const changed = await call('/v2/bridge-runtime/inbound', runtimeToken,
      frame('3EB0PASTE2', text, { edit: { editedAt: 1_790_000_300 } }));
    sent.push(passwordWord());
    expect(changed.body).toMatchObject({ status: 'edited', messageId: first.body.messageId });
    const stored = await bodyOf(first.body.messageId);
    expect(stored).toBe(expected.redact(text).text);
    expect(stored.includes('[redacted:password_assignment]')).toBe(true);
    const kinds: PasteKind[] = ['password_assignment'];
    const notice = await noticeFor(`vault-paste:${bridge}:3EB0PASTE2:edit:1790000300`);
    expect(await bodyOf(notice.message_id)).toBe(expected.bridgeNotice(kinds));
  });

  it('nothing a person sent is in any table, any data-directory file or any line the server logged', async () => {
    expect(sent).toHaveLength(4);
    const tables = await database.query<{ s: string; t: string }>(
      `select table_schema as s, table_name as t from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema') order by 1, 2`);
    // A sweep over a handful of tables would pass for the wrong reason.
    expect(tables.length).toBeGreaterThan(100);
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const match = sent.map((_, i) => `strpos(lower(x::text), lower($${i + 1})) > 0`).join(' or ');
    const holding: string[] = [];
    for (const { s, t } of tables) {
      const [row] = await database.query<{ n: number }>(`select count(*)::int as n from ${quote(s)}.${quote(t)} x where ${match}`, sent);
      if (row!.n > 0) holding.push(`${s}.${t}`);
    }
    expect(holding).toEqual([]);
    // CONTROL: the sweep does find a value that was stored, so an empty answer means something.
    const [control] = await database.query<{ n: number }>(
      `select count(*)::int as n from public.messages x where strpos(lower(x::text), lower($1)) > 0`, ['deploy key rotated']);
    expect(control!.n).toBeGreaterThan(0);

    const files = await filesUnder(dataDir);
    const fileHolding: string[] = [];
    for (const file of files) {
      const content = await readFile(file, 'latin1').catch(() => '');
      if (sent.some((value) => leaks(content, value))) fileHolding.push(file.slice(dataDir.length));
    }
    expect(fileHolding).toEqual([]);
    expect(logged.length).toBeGreaterThan(0);
    expect(sent.some((value) => logged.some((line) => leaks(line, value)))).toBe(false);
  });

  it("an agent's post is not scanned: the guard is for people (plan §10), and this pins that boundary", async () => {
    const runtime = await issueAgentRuntimeSession(db, { identityId: ownerIdentity, authKind: 'browser', requestId: randomUUID() },
      { chatId: chat, teamMemberId: teammate });
    const value = aws();
    const r = await call('/v2/messages', runtime.token, { anchorIds: [anchor], body: `agent note ${value}`, clientMutationId: randomUUID() });
    expect(r.status, JSON.stringify(r.body?.error?.code ?? null)).toBe(200);
    const data = r.body.data ?? r.body;
    expect(leaks(await bodyOf(data.messages[0].id), value)).toBe(true);
    expect(pasteWarned(data)).toBe(false);
  });
});

describe('TM8_VAULT_PASTE_GUARD unset (the default): nothing changes', () => {
  beforeAll(async () => {
    await server.server.close();
    await server.db?.end();
    server = await boot(null);
  });

  it('the same node stores what it is sent, warns nobody and posts no notice', async () => {
    const value = github('B');
    const r = await call('/v2/messages', browserToken, { anchorIds: [anchor], body: `deploy key: ${value}`, clientMutationId: randomUUID() });
    expect(r.status).toBe(200);
    const data = r.body.data ?? r.body;
    expect(leaks(await bodyOf(data.messages[0].id), value)).toBe(true);
    expect(pasteWarned(data)).toBe(false);

    const edit = await call(`/v2/messages/${data.messages[0].id}`, browserToken,
      { clientMutationId: randomUUID(), expectedVersion: data.messages[0].version, body: `card ${card()}` }, 'PATCH');
    expect(edit.status).toBe(200);

    const inbound = await call('/v2/bridge-runtime/inbound', runtimeToken, frame('3EB0PASTE3', `key ${value}`));
    expect(inbound.body).toMatchObject({ status: 'stored' });
    expect(leaks(await bodyOf(inbound.body.messageId), value)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await noticeCount(`vault-paste:${bridge}:3EB0PASTE3`)).toBe(0);
  });
});
