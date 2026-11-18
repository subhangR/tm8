/**
 * Slack lane A (design 01a1ed5f-40af §6 step 1, migration 443) over the REAL
 * composition root: a FAKE SLACK RUNTIME (a test double speaking protocol v4
 * as provider slack) and a WhatsApp runtime connected to one server at once.
 *
 * - begin with pasted tokens: the Slack runtime gets `connect` with the
 *   credential, the WhatsApp runtime gets nothing; the tokens appear in no
 *   response, no log line and no database row.
 * - state.account is kept and shown on the owner's list (externalAccountId,
 *   label, detail); a long detail never breaks the list.
 * - inbound text (email auto-link), a thread reply, an edit and a delete.
 * - the answer leaves on the Slack socket with voice and threadTs and no
 *   prefix; a 429 with retryAfterSec waits; the retry settles sent.
 * - each connection reaches its own runtime only.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  SLACK_CAPABILITIES, TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, WHATSAPP_CAPABILITIES, type ServerFrame,
} from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { MIGRATIONS_DIR, createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

// Fake tokens in the contract's shapes, assembled at run time so no token-shaped
// literal sits in the source (secret scanners would flag one).
const BOT_TOKEN = ['xox' + 'b', '1234567890', '9876543210123', 'ZzSecretBotTokenQq9'].join('-');
const APP_TOKEN = ['xap' + 'p', '1', 'A0SLACKAPP', '9876543210123', '0f1e2d3c4b5a69788796a5b4c3d2e1f0'].join('-');
const SECRETS = [BOT_TOKEN, APP_TOKEN, 'ZzSecretBotTokenQq9', '0f1e2d3c4b5a69788796a5b4c3d2e1f0'];
const SLACK_EMAIL = 'Owner@Acme.Example';

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID();
const waChat = randomUUID(), slackChat = randomUUID();
const ownerIdentity = `slack-a-${randomUUID()}`, ownerAccount = randomUUID();
const waConnection = randomUUID();
const WA_GROUP = '120363777@g.us';
const CHANNEL = 'C0SLACKENG';
const BOT_USER = 'U0TM8BOT';
const PRIYA = 'U0PRIYA01';
const WA_RT = 'wa-mixed', SLACK_RT = 'slack-fake';
let runtimeToken = '';
let browserToken = '';
let slackConnection = '';
let slackBridge = '';
const sockets: WebSocket[] = [];
let waFrames: ServerFrame[] = [];
let slackFrames: ServerFrame[] = [];
const logged: string[] = [];

const human = () => ({ identityId: ownerIdentity, authKind: 'browser' as const, requestId: randomUUID() });

async function call(path: string, token: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; body: any; raw: string }> {
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
  return { status: response.status, body: text ? JSON.parse(text) : null, raw: text };
}

function runtimeSocket(runtimeId: string, into: ServerFrame[]): Promise<WebSocket> {
  const url = new URL('/v2/ws', server.url);
  url.protocol = 'ws:';
  url.searchParams.set('bridgeRuntime', runtimeId);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${runtimeToken}` } } as unknown as string[]);
  sockets.push(ws);
  ws.onmessage = (ev) => {
    const frame = JSON.parse(String(ev.data)) as ServerFrame;
    into.push(frame);
    // Progress reactions (427, now any provider that reacts) settle at once.
    if (frame.type === 'react') {
      void call('/v2/bridge-runtime/sent', runtimeToken, { outboxId: frame.outboxId, connectionId: frame.connectionId, externalMessageId: `react-${frame.outboxId}` });
    }
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('runtime socket refused'));
  });
}

async function until<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const inbound = (frame: Record<string, unknown>) => call('/v2/bridge-runtime/inbound', runtimeToken, {
  connectionId: slackConnection, conversationId: CHANNEL, kind: 'text', media: [], replyTo: null, mentions: [],
  ts: 1_790_000_000, ...frame,
});

/** A full member of the connection's own workspace, as the runtime reports it (SenderRef.team). */
const OWN_TEAM = { teamId: 'T0ACME', enterpriseId: null, guest: false, external: false };
/** 443's internal.bridge_outbox_voice, as written (a test restates it to poison one row, then restores it). */
const MIGRATION_443 = readFileSync(join(MIGRATIONS_DIR, '443_bridge_slack_provider.sql'), 'utf8');
const VOICE_FN = MIGRATION_443.slice(MIGRATION_443.indexOf('create or replace function internal.bridge_outbox_voice'),
  MIGRATION_443.indexOf('$$;', MIGRATION_443.indexOf('create or replace function internal.bridge_outbox_voice')) + 3);
const linksOf = (sender: string) => database.query<{ method: string; revoked: boolean; revoked_reason: string | null }>(
  `select method, revoked_at is not null as revoked, revoked_reason from public.bridge_identity_links
    where provider = 'slack' and external_id = $1 order by verified_at`, [sender]);

const account = {
  teamId: 'T0ACME', teamName: 'Acme', url: 'https://acme.slack.com/', enterpriseId: null, enterpriseName: null,
  isEnterpriseInstall: false, botUserId: BOT_USER, botId: 'B0TM8', botName: 'tm8', scopes: ['chat:write', 'chat:write.customize'],
};

beforeAll(async () => {
  // Every line the server writes, for the "never logged" check.
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write);
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console);
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
      original(...args);
    });
  }

  database = await createW1ScratchDatabase('bridges_slack_lane_a');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-slack-a-'));
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,'Owner')`, [ownerIdentity]);
    await c.query(`insert into public.accounts(id, identity_id, username, email, is_owner, is_node_admin) values ($1,$2,'slack-a','owner@acme.example',true,true)`,
      [ownerAccount, ownerIdentity]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Slack lane A',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Owner')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
      [teammate, ownerMember]);
    for (const [chat, title] of [[waChat, 'WA main'], [slackChat, 'Slack main']] as const) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, ownerMember]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$7,$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/slack-a', gen_random_uuid(), $4, $5, $6)`,
        [chat, spaceId, teammate, ownerIdentity, ownerMember, `slack-a-${randomUUID()}`, title]);
    }
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, runtime_id)
      values ($1,'whatsapp',$2,'+91 …9494','linked',$3)`, [waConnection, ownerAccount, WA_RT]);
  });
  await db.tx(human(), (q) => q.rpc('offer_bridge_connection', [waConnection, spaceId, 'public', null, randomUUID()]));
  await db.tx(human(), (q) => q.rpc('create_bridge', [spaceId, waConnection, WA_GROUP,
    JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 4 }), waChat, '{}', teammate, null, null, true, null, null, randomUUID()]));
  runtimeToken = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'bridge-runtime')).token;
  const secret = generateSecret();
  const row = await db.tx(human(), (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [ownerAccount, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'slack-a browser']));
  browserToken = formatToken(row.id, secret);
  const configured = loadConfig({
    ...process.env, TM8_BIND: '127.0.0.1', TM8_PORT: '4612', TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url, TM8_DATA_DIR: dataDir, TM8_DISABLE_AUTO_OWNER: '1',
  });
  server = await bootstrap({ config: { ...configured, port: 0 } });
  await runtimeSocket(WA_RT, waFrames);
  await runtimeSocket(SLACK_RT, slackFrames);
  expect((await call('/v2/bridge-runtime/hello', runtimeToken,
    { provider: 'whatsapp', version: 3, runtimeId: WA_RT, capabilities: WHATSAPP_CAPABILITIES })).status).toBe(200);
  // The Slack runtime's socket is open but it has not said hello yet: the restart window.
});

afterAll(async () => {
  for (const ws of sockets) ws.close();
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
  vi.restoreAllMocks();
});

describe('begin with pasted tokens (lane A ac1)', () => {
  it('the restart window: a Slack begin before the Slack runtime\'s hello answers offline and reaches no runtime (review finding 4)', async () => {
    const begun = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
      credential: { kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: APP_TOKEN } });
    expect(begun.status, begun.raw).toBe(200);
    expect(begun.body.data.runtime).toBe('offline');
    expect(begun.body.data.connection.runtimeId).toBeNull();
    const early = begun.body.data.connection.id as string;
    await new Promise((r) => setTimeout(r, 300));
    expect([...waFrames, ...slackFrames].filter((f) => f.type === 'connect')).toEqual([]);
    const hello = await call('/v2/bridge-runtime/hello', runtimeToken,
      { provider: 'slack', version: 4, runtimeId: SLACK_RT, capabilities: SLACK_CAPABILITIES });
    expect(hello.status).toBe(200);
    // A Slack runtime runs Slack connections only: the WhatsApp number is not in its hello reply; the
    // early connection is (with no credential: the runtime answers no_credential and the owner re-pastes).
    expect(hello.body.connections.map((c: { connectionId: string }) => c.connectionId)).toEqual([early]);
    expect(JSON.stringify(hello.body)).not.toContain(BOT_TOKEN);
    expect((await call(`/v2/me/bridge-connections/${early}/remove`, browserToken, { clientMutationId: randomUUID() })).status).toBe(200);
  });


  it('refuses a malformed token without echoing it', async () => {
    const bad = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
      credential: { kind: 'slack_tokens', botToken: `${BOT_TOKEN}!`, appToken: APP_TOKEN } });
    expect(bad.status).toBe(400);
    for (const s of SECRETS) expect(bad.raw).not.toContain(s);
  });

  it('a new Slack connection needs credential, refused before any SQL runs', async () => {
    const count = async () => (await database.query<{ n: number }>(
      `select ((select count(*) from public.bridge_connections) + (select count(*) from public.command_ledger))::int as n`))[0]!.n;
    const before = await count();
    const none = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack' });
    expect(none.status, none.raw).toBe(400);
    expect(none.body.error.code).toBe('invalid_input');
    const withQr = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
      authFlow: { kind: 'qr' }, credential: { kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: APP_TOKEN } });
    expect(withQr.status).toBe(400);
    for (const s of SECRETS) expect(withQr.raw).not.toContain(s);
    expect(await count()).toBe(before);
    expect(slackFrames.filter((f) => f.type === 'connect')).toEqual([]);
  });

  it('connects on the Slack runtime only, with the credential on the connect frame and in no answer', async () => {
    waFrames.length = 0;
    const begun = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
      credential: { kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: APP_TOKEN } });
    expect(begun.status, begun.raw).toBe(200);
    expect(begun.body.data.runtime).toBe('connecting');
    expect(begun.body.data.connection).toMatchObject({ provider: 'slack', label: 'Slack', status: 'connecting', runtimeId: SLACK_RT });
    for (const s of SECRETS) expect(begun.raw).not.toContain(s);
    slackConnection = begun.body.data.connection.id;
    const connect = await until(() => slackFrames.find((f): f is Extract<ServerFrame, { type: 'connect' }> =>
      f.type === 'connect' && f.connectionId === slackConnection));
    expect(connect.credential).toEqual({ kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: APP_TOKEN });
    expect(connect.stateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(connect.authFlow).toBeUndefined();
    expect(waFrames.filter((f) => f.type === 'connect')).toEqual([]);
  });

  it('one live connection per Slack app: a second begin on the same app is refused, naming the first (duplicate-app ruling)', async () => {
    const again = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
      credential: { kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: APP_TOKEN } });
    expect(again.status, again.raw).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'conflict',
      details: { reason: 'app_already_connected', label: 'Slack', connectionId: slackConnection } });
    expect(again.body.error.message).toContain('already connected here as "Slack"');
    for (const s of SECRETS) expect(again.raw).not.toContain(s);
    // A relink of the SAME connection with tokens of the same app is fine.
    const relink = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
      connectionId: slackConnection, credential: { kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: APP_TOKEN } });
    expect(relink.status, relink.raw).toBe(200);
    expect(relink.body.data.runtime).toBe('connecting');
    // A double click on Connect with another app's tokens: exactly one connection.
    const other = ['xap' + 'p', '1', 'A0SECONDAPP', '9876543210123', '00112233445566778899aabbccddeeff'].join('-');
    const both = await Promise.all([0, 1].map(() => call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(),
      provider: 'slack', credential: { kind: 'slack_tokens', botToken: BOT_TOKEN, appToken: other } })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.body.error.details.reason).toBe('app_already_connected');
    const [{ n }] = await database.query<{ n: number }>(
      `select count(*)::int as n from public.bridge_connections where provider_app_id = 'A0SECONDAPP' and status <> 'removed'`);
    expect(n).toBe(1);
    const made = both.find((r) => r.status === 200)!.body.data.connection.id as string;
    expect((await call(`/v2/me/bridge-connections/${made}/remove`, browserToken, { clientMutationId: randomUUID() })).status).toBe(200);
    // Removed frees the app.
    const [{ n: left }] = await database.query<{ n: number }>(
      `select count(*)::int as n from public.bridge_connections where provider_app_id = 'A0SECONDAPP' and status <> 'removed'`);
    expect(left).toBe(0);
  });

  it('a WhatsApp begin reaches the WhatsApp runtime only (mixed runtimes)', async () => {
    slackFrames.length = 0;
    const begun = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'whatsapp' });
    expect(begun.status, begun.raw).toBe(200);
    expect(begun.body.data.runtime).toBe('connecting');
    const id = begun.body.data.connection.id as string;
    await until(() => waFrames.find((f) => f.type === 'connect' && f.connectionId === id));
    expect(slackFrames.filter((f) => f.type === 'connect')).toEqual([]);
    expect((await call(`/v2/me/bridge-connections/${id}/remove`, browserToken, { clientMutationId: randomUUID() })).status).toBe(200);
  });
});

describe('state.account (lane A ac2)', () => {
  it('a runtime holding no tokens answers logged_out no_credential, accepted without a database error', async () => {
    const st = await call('/v2/bridge-runtime/state', runtimeToken, { connectionId: slackConnection, status: 'logged_out', detail: 'no_credential' });
    expect(st.status, st.raw).toBe(200);
    expect(st.body).toEqual({ connectionId: slackConnection, status: 'logged_out' });
    const conn = (await call('/v2/me/bridge-connections?provider=slack', browserToken, undefined, 'GET')).body.data.items[0];
    expect(conn).toMatchObject({ status: 'logged_out', detail: 'no_credential', account: null });
  });

  it('bad tokens: logged_out with Slack\'s error code as detail; a long detail is cut, never breaks the list', async () => {
    const st = await call('/v2/bridge-runtime/state', runtimeToken,
      { connectionId: slackConnection, status: 'logged_out', detail: `missing_scope: ${'chat:write '.repeat(90)}` });
    expect(st.status, st.raw).toBe(200);
    const listed = await call('/v2/me/bridge-connections', browserToken, undefined, 'GET');
    expect(listed.status, listed.raw).toBe(200);
    const conn = listed.body.data.items.find((c: { id: string }) => c.id === slackConnection);
    expect(conn.status).toBe('logged_out');
    expect(conn.detail.startsWith('missing_scope: chat:write chat:write')).toBe(true);
    expect(conn.detail.length).toBeLessThanOrEqual(200);
    expect(conn.account).toBeNull();
  });

  it('linked: the workspace is kept and shown; the bot is the connection\'s self id', async () => {
    const st = await call('/v2/bridge-runtime/state', runtimeToken,
      { connectionId: slackConnection, status: 'linked', detail: null, account });
    expect(st.status, st.raw).toBe(200);
    const listed = await call('/v2/me/bridge-connections?provider=slack', browserToken, undefined, 'GET');
    expect(listed.status, listed.raw).toBe(200);
    expect(listed.body.data.items).toEqual([expect.objectContaining({
      id: slackConnection, provider: 'slack', status: 'linked', label: 'Acme', externalAccountId: 'T0ACME', detail: null, account,
    })]);
    const [row] = await database.query<{ self_ids: string[] }>('select self_ids from public.bridge_connections where id = $1', [slackConnection]);
    expect(row!.self_ids).toEqual([BOT_USER]);
    // WhatsApp connections show no account.
    const wa = (await call('/v2/me/bridge-connections?provider=whatsapp', browserToken, undefined, 'GET')).body.data.items[0];
    expect(wa.account ?? null).toBeNull();
  });

  it('a WhatsApp state frame still records the number\'s own ids (398\'s door, restated in 443)', async () => {
    const st = await call('/v2/bridge-runtime/state', runtimeToken,
      { connectionId: waConnection, status: 'linked', detail: null, self: { id: '919800000009@s.whatsapp.net', lid: '12345@lid' } });
    expect(st.status, st.raw).toBe(200);
    const [row] = await database.query<{ self_ids: string[]; external_account_id: string; provider_account: unknown }>(
      'select self_ids, external_account_id, provider_account from public.bridge_connections where id = $1', [waConnection]);
    expect(row).toEqual({ self_ids: ['919800000009@s.whatsapp.net', '12345@lid'], external_account_id: '919800000009@s.whatsapp.net', provider_account: null });
  });

  it('an org-wide Enterprise Grid install is known by its org', async () => {
    const grid = { ...account, enterpriseId: 'E0ACME', enterpriseName: 'Acme Corp', isEnterpriseInstall: true };
    await call('/v2/bridge-runtime/state', runtimeToken, { connectionId: slackConnection, status: 'linked', detail: null, account: grid });
    const [row] = await database.query<{ external_account_id: string }>(
      'select external_account_id from public.bridge_connections where id = $1', [slackConnection]);
    expect(row!.external_account_id).toBe('E0ACME');
    await call('/v2/bridge-runtime/state', runtimeToken, { connectionId: slackConnection, status: 'linked', detail: null, account });
  });
});

describe('a Slack channel end to end (lane A ac3)', () => {
  let root = '';
  let rootMessage = '';
  let reply = '';

  it('the channel is bridged and its allowlist goes to the Slack runtime', async () => {
    await db.tx(human(), (q) => q.rpc('offer_bridge_connection', [slackConnection, spaceId, 'public', null, randomUUID()]));
    const created = await db.tx(human(), (q) => q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, slackConnection, CHANNEL,
      JSON.stringify({ kind: 'channel', title: 'eng-support', memberCount: 12 }), slackChat,
      JSON.stringify({ trigger: 'mention', direction: 'both', outbound: 'replies', whoMayTrigger: 'linked', voice: 'named', style: null }),
      teammate, null, null, true, null, null, randomUUID()]));
    slackBridge = created.entity.id;
    await until(() => slackFrames.find((f) => f.type === 'allowlist' && f.connectionId === slackConnection && f.conversationIds.includes(CHANNEL)));
    expect(waFrames.find((f) => f.type === 'allowlist' && f.conversationIds.includes(CHANNEL))).toBeUndefined();
  });

  it('inbound text: the sender is auto-linked by Slack email, and the mention of the bot triggers', async () => {
    root = '1790000000.000100';
    const res = await inbound({ externalMessageId: root, body: `<@${BOT_USER}> the login page 500s`, mentions: [BOT_USER],
      sender: { externalId: PRIYA, altId: null, name: 'Priya', fromMe: false, email: SLACK_EMAIL, avatarUrl: 'https://avatars.slack-edge.com/p.png', bot: false,
        team: OWN_TEAM } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ status: 'stored', routed: true, author: { kind: 'member', actorId: ownerMember, trust: 'asserted' } });
    rootMessage = res.body.messageId;
    const links = await database.query<{ method: string; space_id: string; identity_id: string }>(
      `select method, space_id, identity_id from public.bridge_identity_links where provider = 'slack' and external_id = $1 and revoked_at is null`, [PRIYA]);
    expect(links).toEqual([{ method: 'email', space_id: spaceId, identity_id: ownerIdentity }]);
  });

  it('email links only a full member of the connection\'s own install (review finding 2)', async () => {
    const cases: [string, unknown][] = [
      ['U0NOTEAM1', undefined],                                              // no team info: fail closed
      ['U0NULLTM1', null],
      ['U0GUEST01', { ...OWN_TEAM, guest: true }],                           // a Slack guest
      ['U0EXTRN01', { ...OWN_TEAM, external: true }],                        // Slack Connect
      ['U0OTHERT1', { ...OWN_TEAM, teamId: 'T0OTHER' }],                     // another workspace
      ['U0SIBLNG1', { teamId: 'T0SIB', enterpriseId: 'E0ACME', guest: false, external: false }], // same org, not an org-wide install
      ['U0PARTIAL', { teamId: 'T0ACME', enterpriseId: null }],               // flags missing
    ];
    for (const [i, [id, team]] of cases.entries()) {
      const res = await inbound({ externalMessageId: `1790000000.0003${String(i).padStart(2, '0')}`, body: `<@${BOT_USER}> hi`, mentions: [BOT_USER],
        sender: { externalId: id, altId: null, name: id, fromMe: false, email: SLACK_EMAIL, ...(team === undefined ? {} : { team }) } });
      expect(res.body, id).toMatchObject({ status: 'stored', routed: false, author: { kind: 'bridge', trust: 'guest' } });
      expect(await linksOf(id), id).toEqual([]);
    }
  });

  it('on an org-wide Grid install a sibling workspace of the same org links', async () => {
    const grid = { ...account, enterpriseId: 'E0ACME', enterpriseName: 'Acme Corp', isEnterpriseInstall: true };
    await call('/v2/bridge-runtime/state', runtimeToken, { connectionId: slackConnection, status: 'linked', detail: null, account: grid });
    const res = await inbound({ externalMessageId: '1790000000.000290', body: 'hello',
      sender: { externalId: 'U0SIBLNG2', altId: null, name: 'Sib', fromMe: false, email: SLACK_EMAIL,
        team: { teamId: 'T0SIB', enterpriseId: 'E0ACME', guest: false, external: false } } });
    expect(res.body.author).toMatchObject({ kind: 'member', actorId: ownerMember, trust: 'asserted' });
    expect(await linksOf('U0SIBLNG2')).toEqual([{ method: 'email', revoked: false, revoked_reason: null }]);
    await call('/v2/bridge-runtime/state', runtimeToken, { connectionId: slackConnection, status: 'linked', detail: null, account });
    // Back on a single-workspace install, the sibling no longer qualifies: the link follows the evidence.
    const again = await inbound({ externalMessageId: '1790000000.000291', body: 'hello again',
      sender: { externalId: 'U0SIBLNG2', altId: null, name: 'Sib', fromMe: false, email: SLACK_EMAIL,
        team: { teamId: 'T0SIB', enterpriseId: 'E0ACME', guest: false, external: false } } });
    expect(again.body.author).toMatchObject({ kind: 'bridge', trust: 'guest' });
    expect((await linksOf('U0SIBLNG2'))[0]!.revoked).toBe(true);
  });

  it('an automatic revoke never blocks a later auto-link; an admin\'s revoke does (review finding 3)', async () => {
    let n = 0;
    const say = (email: string) => inbound({ externalMessageId: `1790000000.0004${String(n++).padStart(2, '0')}`, body: 'hi',
      sender: { externalId: 'U0ROUND01', altId: null, name: 'Round', fromMe: false, email, team: OWN_TEAM } });
    expect((await say(SLACK_EMAIL)).body.author).toMatchObject({ kind: 'member', trust: 'asserted' });
    // Slack's email changes away and back: revoked automatically, then linked again.
    expect((await say('round.new@acme.example')).body.author).toMatchObject({ kind: 'bridge', trust: 'guest' });
    expect((await say(SLACK_EMAIL)).body.author).toMatchObject({ kind: 'member', trust: 'asserted' });
    expect(await linksOf('U0ROUND01')).toEqual([
      { method: 'email', revoked: true, revoked_reason: 'auto' },
      { method: 'email', revoked: false, revoked_reason: null },
    ]);
    // A space admin revokes it (bridges.participants.update memberId: null): that sticks.
    await db.tx(human(), (q) => q.rpc('update_bridge_participant', [slackBridge, 'U0ROUND01', JSON.stringify({ memberId: null }), null, randomUUID()]));
    expect((await say(SLACK_EMAIL)).body.author).toMatchObject({ kind: 'bridge', trust: 'guest' });
    expect((await linksOf('U0ROUND01')).at(-1)).toEqual({ method: 'email', revoked: true, revoked_reason: null });
  });

  it('a bot never links, and a non-matching email stays a guest', async () => {
    const res = await inbound({ externalMessageId: '1790000000.000150', body: 'deploy finished',
      sender: { externalId: 'U0OTHER01', altId: null, name: 'Sam', fromMe: false, email: 'sam@elsewhere.example', bot: false } });
    expect(res.body).toMatchObject({ status: 'stored', routed: false, author: { kind: 'bridge', trust: 'guest' } });
  });

  it('the bot is never the owner: its own post comes back a guest, unrouted, never a command (review finding 1)', async () => {
    // The reviewer's probe: the bot user id is in self_ids (for mentions).
    for (const [i, sender] of [
      { externalId: BOT_USER, altId: null, name: 'tm8', fromMe: false, bot: true },
      { externalId: BOT_USER, altId: null, name: 'tm8', fromMe: false },
    ].entries()) {
      const res = await inbound({ externalMessageId: `1790000000.00011${i}`, body: `<@${BOT_USER}> hello`, mentions: [BOT_USER], sender });
      expect(res.status, res.raw).toBe(200);
      expect(res.body).toMatchObject({ status: 'stored', routed: false, command: false,
        author: { kind: 'bridge', actorId: slackBridge, trust: 'guest' } });
      expect(res.body.author).not.toHaveProperty('ownNumber');
    }
    const cmd = await inbound({ externalMessageId: '1790000000.000119', body: '/mute 1h',
      sender: { externalId: BOT_USER, altId: null, name: 'tm8', fromMe: false, bot: true } });
    expect(cmd.body).toMatchObject({ status: 'stored', command: false, routed: false });
  });

  it('a thread reply threads under its root in the log', async () => {
    reply = '1790000000.000200';
    const res = await inbound({ externalMessageId: reply, body: 'can you also add a regression test?',
      thread: { rootExternalMessageId: root }, replyTo: { externalMessageId: root, senderExternalId: PRIYA, media: null },
      sender: { externalId: PRIYA, altId: null, name: 'Priya', fromMe: false, email: SLACK_EMAIL, team: OWN_TEAM } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.status).toBe('stored');
    const [m] = await database.query<{ parent_id: string; root_message_id: string }>(
      `select e.parent_id, m.root_message_id from public.entities e join public.messages m on m.entity_id = e.id where e.id = $1`, [res.body.messageId]);
    expect(m).toEqual({ parent_id: rootMessage, root_message_id: rootMessage });
  });

  it('an edit updates the stored copies and routes nothing', async () => {
    const [{ n: before }] = await database.query<{ n: number }>('select count(*)::int as n from public.messages');
    const turns = await database.query<{ n: number }>('select count(*)::int as n from public.chat_turns where chat_id = $1', [slackChat]);
    const res = await inbound({ externalMessageId: root, body: `<@${BOT_USER}> the login page 500s on Safari`, edit: { editedAt: 1_790_000_050 },
      sender: { externalId: PRIYA, altId: null, name: 'Priya', fromMe: false } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ status: 'edited', messageId: rootMessage });
    expect(res.body.copies).toBeGreaterThanOrEqual(2);
    const bodies = await database.query<{ body: string; edited_at: Date | null }>(
      `select body, edited_at from public.messages where entity_id = $1 or message_batch_id = $2`, [rootMessage, `bridge-in:${slackBridge}:${root}`]);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const b of bodies) {
      expect(b.body).toBe(`<@${BOT_USER}> the login page 500s on Safari`);
      expect(b.edited_at).not.toBeNull();
    }
    expect((await database.query<{ n: number }>('select count(*)::int as n from public.messages'))[0]!.n).toBe(before);
    expect((await database.query<{ n: number }>('select count(*)::int as n from public.chat_turns where chat_id = $1', [slackChat]))).toEqual(turns);
  });

  it('a delete tombstones the copies (shown in the log), scrubs the event log, routes nothing (review finding 6)', async () => {
    const res = await inbound({ externalMessageId: reply, body: '', deleted: true,
      sender: { externalId: PRIYA, altId: null, name: null, fromMe: false } });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.status).toBe('deleted');
    const rows = await database.query<{ body: string; redacted: boolean; deleted: boolean }>(
      `select m.body, m.redacted_at is not null as redacted, e.deleted_at is not null as deleted
         from public.messages m join public.entities e on e.id = m.entity_id where m.entity_id = $1`, [res.body.messageId]);
    expect(rows).toEqual([{ body: '[deleted]', redacted: true, deleted: false }]);
    const [left] = await database.query<{ n: number }>(
      `select ((select count(*) from public.messages where body like '%regression test%')
             + (select count(*) from public.workspace_events where payload::text like '%regression test%'))::int as n`);
    expect(left!.n).toBe(0);
    // The tombstone is in the bridge's log, in its thread.
    const log = await call(`/v2/bridges/${slackBridge}/log?latest=true&limit=50`, browserToken, undefined, 'GET');
    expect(log.status, log.raw).toBe(200);
    expect(log.raw).toContain(res.body.messageId);
    expect(log.raw).not.toContain('regression test');
    // A delete of a message tm8 never stored is a no-op.
    const unknown = await inbound({ externalMessageId: '1790000000.999999', body: '', deleted: true,
      sender: { externalId: PRIYA, altId: null, name: null, fromMe: false } });
    expect(unknown.body).toMatchObject({ status: 'ignored', reason: 'unknown_message' });
  });

  it('deleting a routed message withdraws the chat turn still queued on it', async () => {
    const ext = '1790000000.000500';
    const res = await inbound({ externalMessageId: ext, body: `<@${BOT_USER}> never mind this`, mentions: [BOT_USER],
      sender: { externalId: PRIYA, altId: null, name: 'Priya', fromMe: false, email: SLACK_EMAIL, team: OWN_TEAM } });
    expect(res.body).toMatchObject({ status: 'stored', routed: true });
    const turns = () => database.query<{ state: string }>('select state from public.chat_turns where user_message_id = $1', [res.body.copyId]);
    expect(await turns()).toEqual([{ state: 'queued' }]);
    expect((await inbound({ externalMessageId: ext, body: '', deleted: true,
      sender: { externalId: PRIYA, altId: null, name: null, fromMe: false } })).body.status).toBe('deleted');
    expect(await turns()).toEqual([]);
  });

  it('the answer leaves on the Slack socket with voice and threadTs and no prefix; a 429 waits Retry-After; the retry settles sent', async () => {
    waFrames.length = 0;
    const [turn] = await database.query<{ turn_id: string }>(
      `select t.turn_id from public.chat_turns t join public.messages m on m.entity_id = t.user_message_id
        where t.chat_id = $1 and m.message_batch_id = $2`, [slackChat, `bridge-in:${slackBridge}:${root}`]);
    expect(turn).toBeDefined();
    const answer = randomUUID();
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [answer, spaceId, teammate]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'On it: the CSP header blocks the font CDN.')`,
        [answer, slackChat, teammate]);
      await c.query(`update public.chat_turns set state = 'completed', agent_message_id = $2, completed_at = now() where turn_id = $1`, [turn!.turn_id, answer]);
      // Lane F's thread mode fills thread_ts; here the row gets it in the same transaction.
      await c.query('set constraints all immediate');
      await c.query(`update public.bridge_outbox set thread_ts = $2 where message_id = $1 and kind = 'send'`, [answer, root]);
    });
    const isSend = (f: ServerFrame): f is Extract<ServerFrame, { type: 'send' }> => f.type === 'send' && f.connectionId === slackConnection;
    const send = await until(() => slackFrames.find(isSend));
    expect(send).toMatchObject({ conversationId: CHANNEL, text: 'On it: the CSP header blocks the font CDN.', threadTs: root,
      voice: { username: 'Infra Bot', iconUrl: null } });
    expect(send.text).not.toMatch(/^Infra Bot:/);
    expect(waFrames.filter((f) => f.type === 'send')).toEqual([]);

    const limited = await call('/v2/bridge-runtime/sent', runtimeToken,
      { outboxId: send.outboxId, connectionId: slackConnection, failed: { reason: 'ratelimited', retryable: true, retryAfterSec: 30 } });
    expect(limited.body).toMatchObject({ status: 'failed_retryable' });
    const [ob] = await database.query<{ wait: number; status: string }>(
      `select extract(epoch from next_attempt_at - now())::float as wait, status from public.bridge_outbox where id = $1`, [send.outboxId]);
    expect(ob!.status).toBe('failed_retryable');
    expect(ob!.wait).toBeGreaterThan(25);
    expect(ob!.wait).toBeLessThanOrEqual(31);

    // Retry-After holds the CONNECTION (review finding 5): a later message waits behind it, in order.
    const [conn] = await database.query<{ wait: number }>(
      `select extract(epoch from outbound_not_before - now())::float as wait from public.bridge_connections where id = $1`, [slackConnection]);
    expect(conn!.wait).toBeGreaterThan(25);
    slackFrames.length = 0;
    const later = await call('/v2/messages', browserToken, { anchorIds: [slackBridge], body: 'and one more thing', clientMutationId: randomUUID() });
    expect(later.status, later.raw).toBe(200);
    await new Promise((r) => setTimeout(r, 2500));
    expect(slackFrames.filter(isSend)).toEqual([]);
    const [queued] = await database.query<{ status: string; attempts: number }>(
      `select ob.status, ob.attempts from public.bridge_outbox ob join public.messages m on m.entity_id = ob.message_id
        where ob.connection_id = $1 and m.body = 'and one more thing'`, [slackConnection]);
    expect(queued).toEqual({ status: 'pending', attempts: 0 });

    // The limit lapses: the rate-limited message goes first, then the later one.
    await database.query(`update public.bridge_connections set outbound_not_before = now() where id = $1`, [slackConnection]);
    await database.query(`update public.bridge_outbox set next_attempt_at = now() where id = $1`, [send.outboxId]);
    const retry = await until(() => slackFrames.find(isSend));
    expect(retry.outboxId).toBe(send.outboxId);
    const sent = await call('/v2/bridge-runtime/sent', runtimeToken,
      { outboxId: retry.outboxId, connectionId: slackConnection, externalMessageId: '1790000001.000300', message: null });
    expect(sent.body).toMatchObject({ status: 'sent' });
    const next = await until(() => slackFrames.find((f): f is Extract<ServerFrame, { type: 'send' }> => isSend(f) && f.outboxId !== send.outboxId));
    expect(next.text).toBe('and one more thing');
    expect((await call('/v2/bridge-runtime/sent', runtimeToken,
      { outboxId: next.outboxId, connectionId: slackConnection, externalMessageId: '1790000001.000301', message: null })).body)
      .toMatchObject({ status: 'sent' });
    const origins = await database.query<{ external_message_id: string }>(
      `select external_message_id from public.message_origins where message_id = $1 and direction = 'out'`, [answer]);
    expect(origins).toEqual([{ external_message_id: '1790000001.000300' }]);
  });

  it('a member with an https avatar posts: voice carries it; one bad row fails alone and the queue goes on (lane G)', async () => {
    const AVATAR = 'https://avatars.example/owner.png';
    const poison = randomUUID();
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query(`update public.user_profiles set avatar = $2 where identity_id = $1`, [ownerIdentity, AVATAR]);
      // An older row whose frame cannot be built: 443's voice function, made to raise for this one message.
      await c.query(VOICE_FN.replace(/\bbegin\n/, `begin\n  if p_message = '${poison}'::uuid then raise exception 'poisoned row'; end if;\n`));
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'message',$3)`, [poison, spaceId, ownerMember]);
      await c.query(`insert into public.messages(entity_id, anchor_id, author_id, body) values ($1,$2,$3,'poisoned')`, [poison, slackBridge, ownerMember]);
    });
    slackFrames.length = 0;
    const posted = await call('/v2/messages', browserToken, { anchorIds: [slackBridge], body: 'deploying now', clientMutationId: randomUUID() });
    expect(posted.status, posted.raw).toBe(200);
    const isSend = (f: ServerFrame): f is Extract<ServerFrame, { type: 'send' }> => f.type === 'send' && f.connectionId === slackConnection;
    const send = await until(() => slackFrames.find(isSend));
    expect(send).toMatchObject({ text: 'deploying now', voice: { username: 'Owner', iconUrl: AVATAR } });
    const [bad] = await database.query<{ status: string; last_error: string }>(
      'select status, last_error from public.bridge_outbox where message_id = $1', [poison]);
    expect(bad!.status).toBe('failed_permanent');
    expect(bad!.last_error).toBe('take_failed: P0001: poisoned row');
    await database.transaction(async (c) => { await c.query('set local role tm8_graph_owner'); await c.query(VOICE_FN); });
    expect((await call('/v2/bridge-runtime/sent', runtimeToken,
      { outboxId: send.outboxId, connectionId: slackConnection, externalMessageId: '1790000001.000400', message: null })).body).toMatchObject({ status: 'sent' });
  });

  it('an email-linked (asserted) member is refused admin-tier commands and may use member-tier ones (review finding 2)', async () => {
    const isSend = (f: ServerFrame): f is Extract<ServerFrame, { type: 'send' }> => f.type === 'send' && f.connectionId === slackConnection;
    const ask = async (id: string, text: string): Promise<string> => {
      slackFrames.length = 0;
      const res = await inbound({ externalMessageId: `cmd:${id}`, body: `/${text}`, slashCommand: { command: '/tm8', text },
        sender: { externalId: PRIYA, altId: null, name: 'Priya', fromMe: false, email: SLACK_EMAIL, team: OWN_TEAM } });
      expect(res.body, text).toMatchObject({ status: 'stored', command: true });
      const answer = await until(() => slackFrames.find(isSend), 15_000);
      // A slash command has no thread and no message to quote.
      expect(answer).not.toHaveProperty('threadTs');
      expect(answer).not.toHaveProperty('replyTo');
      await call('/v2/bridge-runtime/sent', runtimeToken,
        { outboxId: answer.outboxId, connectionId: slackConnection, externalMessageId: `1790000002.${id}`, message: null });
      return answer.text ?? '';
    };
    // Priya is the space's OWNER, but her Slack link is an email assertion.
    expect(await ask('T0MUTE', 'mute 1h')).toContain('a space admin with a verified link');
    const status = await ask('T0STATUS', 'status');
    expect(status).not.toContain('link your number first');
    expect(status).not.toContain('space admin');
  });

  it('a renamed channel renames the bridge\'s conversation', async () => {
    const res = await call('/v2/bridge-runtime/conversation-state', runtimeToken,
      { connectionId: slackConnection, conversationId: CHANNEL, canSend: true, reason: null, name: 'eng-help' });
    expect(res.body).toMatchObject({ renamed: 1 });
    const [b] = await database.query<{ title: string }>(`select conversation ->> 'title' as title from public.bridges where entity_id = $1`, [slackBridge]);
    expect(b!.title).toBe('eng-help');
  });
});

describe('the tokens and the email are nowhere (lane A ac1)', () => {
  it('no log line, and no row in any table, holds a token; the Slack email is not stored', async () => {
    const all = logged.join('\n');
    for (const s of SECRETS) expect(all).not.toContain(s);
    const tables = await database.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema in ('public', 'internal')`);
    expect(tables.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const t of tables) {
      const [row] = await database.query<{ n: number }>(
        `select count(*)::int as n from "${t.schema}"."${t.name}" x where x::text like any($1)`,
        [[...SECRETS.map((s) => `%${s}%`), `%${SLACK_EMAIL}%`]]);
      if (row!.n > 0) hits.push(`${t.schema}.${t.name}`);
    }
    expect(hits).toEqual([]);
  });
});
