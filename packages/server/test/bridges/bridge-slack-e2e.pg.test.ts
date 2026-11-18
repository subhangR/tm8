/**
 * Slack bridge END TO END (design doc 01a1ed5f-40af, lane G): the build's
 * "done means" proof, run by CI's test-server job.
 *
 *   REAL tm8-server (bootstrap() on a scratch database, every migration)
 *     <-> REAL integrations/slack-bridge runtime, in-process (HttpWsLink +
 *         Runtime + SlackApi, wired as src/runtime-main.ts wires them)
 *     <-> lane C's FAKE SLACK (integrations/slack-bridge/test/fake-slack.ts):
 *         the Web API at the URL runtime-main takes from TM8_SLACK_API_URL,
 *         and Socket Mode over a real `ws` server.
 *
 * Only the agent launch is faked, the way 425/444's suites fake it: the
 * execution runtime's spawnService.spawn/resume write the work session row
 * (as a child of the requested parent) instead of starting a PTY. Everything
 * else (begin, the connect frame, auth.test, the sealed tokens, state.account,
 * offer, bridges.create, the allowlist, Socket Mode, inbound, the email
 * auto-link, thread mode, the keeper, delivery, the outbox, the hub, voice,
 * progress reactions, edits, deletes, the /tm8 executor and 429 handling)
 * is the shipped code.
 *
 * `ws`: the runtime and the fake import the bare specifier 'ws'. It is a
 * devDependency of packages/server, so CI's root `bun install` provides it,
 * but bun places it under packages/server/node_modules, which node resolution
 * from integrations/slack-bridge/src cannot reach. The vi.mock below re-resolves
 * the specifier from this package: the runtime gets the real `ws`, unchanged.
 */
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import { createW2BlobStore } from '../../src/files/w2-blob-store.js';
import type { Db } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { deliveryPrincipalUrl } from '../db/delivery-principal.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

import { HttpWsLink } from '../../../../integrations/slack-bridge/src/runtime/link.js';
import { Runtime } from '../../../../integrations/slack-bridge/src/runtime/runtime.js';
import { Egress } from '../../../../integrations/slack-bridge/src/runtime/egress.js';
import { SlackApi } from '../../../../integrations/slack-bridge/src/runtime/slack-api.js';
import { FakeSlack, type PostedMessage } from '../../../../integrations/slack-bridge/test/fake-slack.js';

vi.mock('ws', () => vi.importActual('ws'));

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const RUNTIME_ID = 'slack-e2e';
const CHANNEL = 'C0ENGSUPPORT';
const PRIYA = 'U0PRIYA01';
const OWNER_EMAIL = 'priya@acme.example';
const AVATAR = 'https://avatars.acme.example/priya.png';

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
let slack: FakeSlack;
let runtime: Runtime;
let link: HttpWsLink;
let stateDir = '';
let dataDir = '';
let runtimeToken = '';
let browserToken = '';
const spaceId = randomUUID(), ownerMember = randomUUID(), teammate = randomUUID(), target = randomUUID();
const ownerIdentity = `slack-e2e-${randomUUID()}`, ownerAccount = randomUUID();
const logged: string[] = [];
const runtimeLog: string[] = [];

/** The faked agent launch: what the real server asked for, and the sessions it got. */
const spawns: { parentSessionId: string | null; title: string | null; teamMemberId: string; origins: unknown }[] = [];
const spawned = new Map<string, string>();

const human = () => ({ identityId: ownerIdentity, authKind: 'browser' as const, requestId: randomUUID() });
const owner = <T>(sql: string, params: unknown[] = []) => database.transaction(async (c) => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});

async function call(path: string, token: string, body?: unknown): Promise<{ status: number; body: any; raw: string }> {
  const get = body === undefined;
  const response = await fetch(new URL(path, server.url), {
    method: get ? 'GET' : 'POST',
    headers: {
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      authorization: `Bearer ${token}`,
      ...(get ? {} : { 'content-type': 'application/json' }),
    },
    ...(get ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  return { status: response.status, body: raw ? JSON.parse(raw) : null, raw };
}

async function until<T>(what: string, probe: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== null && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Pushes an Events API envelope and waits for the runtime's ack. */
async function event(e: Record<string, unknown>): Promise<void> {
  await slack.waitForAck(slack.event(e), 5000);
}

const posted = (pred: (m: PostedMessage) => boolean, what: string) => until(what, () => slack.messages.find(pred));
const inboundCopies = (ts: string) => owner<{ message_id: string; body: string; edited: boolean; redacted: boolean; deleted: boolean }>(
  `select o.message_id::text, m.body, m.edited_at is not null as edited, m.redacted_at is not null as redacted, e.deleted_at is not null as deleted
     from public.message_origins o join public.messages m on m.entity_id = o.message_id join public.entities e on e.id = o.message_id
    where o.direction = 'in' and o.external_message_id = $1`, [ts]);

beforeAll(async () => {
  // Every line anyone writes (server, runtime), for the "never logged" check.
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

  slack = await FakeSlack.start();
  slack.channel({ id: CHANNEL, name: 'eng-support', members: 12 });
  // Her Slack profile email is the tm8 owner's account email: she is auto-linked on her first message.
  slack.user({ id: PRIYA, name: 'Priya', realName: 'Priya Raman', email: OWNER_EMAIL.toUpperCase(), avatar: `${slack.origin}/avatars/priya.png` });

  database = await createW1ScratchDatabase('bridges_slack_e2e');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name, avatar) values ($1,'Priya',$2)`, [ownerIdentity, AVATAR]);
    await c.query(`insert into public.accounts(id, identity_id, username, email, is_owner, is_node_admin) values ($1,$2,'priya',$3,true,true)`,
      [ownerAccount, ownerIdentity, OWNER_EMAIL]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Acme',$2)`, [spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [ownerMember, spaceId]);
    await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,'owner','Priya')`,
      [ownerMember, spaceId, ownerIdentity]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'team_member',$3,'space')`,
      [teammate, spaceId, ownerMember]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Support Bot','worker','persona')`,
      [teammate, ownerMember]);
    // The bridge's target: a running work session (the support desk).
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1,$2,'work_session',$3,'space')`,
      [target, spaceId, teammate]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,'Support desk','running','none',now())`, [target]);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'participates_in',$2)`,
      [spaceId, teammate, target]);
  });

  runtimeToken = (await issueBridgeRuntimeSession(db, { identityId: ownerIdentity, nodeAdmin: true, requestId: 'mint' }, 'slack-e2e')).token;
  const secret = generateSecret();
  const row = await db.tx(human(), (q) => q.rpc<{ id: string }>('issue_auth_session', [ownerAccount, hashToken(secret), 'browser',
    new Date(Date.now() + 3_600_000).toISOString(), null, 'slack-e2e browser']));
  browserToken = formatToken(row.id, secret);

  // main.ts wires message delivery, and with it the bridge keeper that starts thread sessions, only
  // with TM8_DELIVERY_DATABASE_URL (read off process.env): set it around bootstrap, as ws-e2e-harness does.
  const priorDeliveryUrl = process.env['TM8_DELIVERY_DATABASE_URL'];
  process.env['TM8_DELIVERY_DATABASE_URL'] = deliveryPrincipalUrl(database.url);
  try {
    server = await bootstrap({ config: { ...loadConfig({
      ...process.env, TM8_BIND: '127.0.0.1', TM8_PORT: '4613', TM8_NODE_MODE: 'single', TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: dataDir = await mkdtemp(join(tmpdir(), 'tm8-slack-e2e-')), TM8_DISABLE_AUTO_OWNER: '1',
    }), port: 0 } });
  } finally {
    if (priorDeliveryUrl === undefined) delete process.env['TM8_DELIVERY_DATABASE_URL'];
    else process.env['TM8_DELIVERY_DATABASE_URL'] = priorDeliveryUrl;
  }

  // The agent launch, faked (425/444): the session row a real spawn writes, a child of the requested parent.
  const spawnService = server.execution!.spawnService as unknown as Record<string, unknown>;
  vi.spyOn(spawnService as never, 'spawn' as never).mockImplementation((async (_claims: unknown, request: {
    teamMemberId: string; parentSessionId?: string | null; title?: string | null; clientMutationId: string;
  }, facts?: { bridgeOrigins?: unknown }) => {
    const prior = spawned.get(request.clientMutationId);
    if (prior) return { sessionId: prior };
    spawns.push({ parentSessionId: request.parentSessionId ?? null, title: request.title ?? null, teamMemberId: request.teamMemberId, origins: facts?.bridgeOrigins });
    const id = randomUUID();
    await owner(`insert into public.entities(id, space_id, kind, created_by, visibility, parent_id) values ($1,$2,'work_session',$3,'space',$4)`,
      [id, spaceId, request.teamMemberId, request.parentSessionId ?? null]);
    await owner(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1,$2,'running','none',now())`, [id, request.title ?? 'thread']);
    await owner(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'participates_in',$2)`, [spaceId, request.teamMemberId, id]);
    if (facts?.bridgeOrigins) {
      await database.transaction((c) => c.query('select public.record_bridge_provenance($1, $2::jsonb)', [id, JSON.stringify(facts.bridgeOrigins)]));
    }
    spawned.set(request.clientMutationId, id);
    return { sessionId: id };
  }) as never);
  vi.spyOn(spawnService as never, 'resume' as never).mockImplementation((async (_claims: unknown, request: { sessionId: string }) => {
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query("select set_config('tm8.work_session_transition', 'on', true)");
      await c.query(`update public.work_sessions set status = 'running', status_changed_at = now() where entity_id = $1`, [request.sessionId]);
    });
    return { sessionId: request.sessionId };
  }) as never);

  // The REAL runtime, wired as src/runtime-main.ts wires it: TM8_SERVER_URL = server.url,
  // TM8_SLACK_API_URL = the fake's Web API, TM8_SLACK_STATE_DIR = a fresh dir, no proxy.
  stateDir = await mkdtemp(join(tmpdir(), 'slack-e2e-state-'));
  const ref: { runtime?: Runtime } = {};
  link = new HttpWsLink({
    serverUrl: server.url,
    runtimeId: RUNTIME_ID,
    token: () => runtimeToken,
    log: (m) => runtimeLog.push(m),
    onOpen: () => ref.runtime!.hello(),
    onFrame: (f) => ref.runtime!.onFrame(f),
  });
  runtime = new Runtime({ runtimeId: RUNTIME_ID, stateDir, link, log: (m) => runtimeLog.push(m), api: new SlackApi(slack.apiUrl, new Egress({})) });
  ref.runtime = runtime;
  link.start();
});

afterAll(async () => {
  // E2E_DEBUG=<file>: dump the bridge tables, the fake's view and both logs there (for a red run).
  if (process.env.E2E_DEBUG) {
    const { writeFileSync } = await import('node:fs');
    const dump = async (sql: string) => JSON.stringify(await owner(sql).catch((e) => String(e)), null, 1);
    writeFileSync(process.env.E2E_DEBUG, [
      '== pg activity', JSON.stringify(await database.query(`select pid, usename, state, wait_event_type, wait_event,
        extract(epoch from now() - query_start)::int as secs, left(query, 160) as query from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() order by query_start`).catch((e) => String(e)), null, 1),
      '== threads', await dump('select * from public.bridge_threads'),
      '== origins', await dump('select message_id, direction, external_message_id, command_state from public.message_origins'),
      '== deliveries', await dump('select message_id, target_work_session_id, status, failure_reason from public.session_message_deliveries'),
      '== outbox', await dump('select kind, status, reaction, thread_ts, external_reply_to, last_error, payload from public.bridge_outbox'),
      '== spawns', JSON.stringify(spawns), '== slack messages', JSON.stringify(slack.messages.map((m) => ({ ...m, params: undefined }))),
      '== reactions', JSON.stringify(slack.reactions),
      '== runtime log', ...runtimeLog, '== server log', ...logged.filter((l) => /bridges|slack|error|warn/i.test(l)),
    ].join('\n'));
  }
  link?.stop();
  await runtime?.stop().catch(() => undefined);
  runtime?.api.egress.destroy();
  await slack?.close();
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
  vi.restoreAllMocks();
});

describe('Slack end to end: real server + real slack-bridge runtime + fake Slack', () => {
  let connectionId = '';
  let bridgeId = '';
  let root = '';
  let threadSession = '';
  let rootMessage = '';
  let reply = '';
  let handle = '';

  it('1. begin with pasted tokens: the runtime checks them with auth.test and the connection goes linked with its account', async () => {
    const begun = await until('a Slack runtime to take the begin', async () => {
      const r = await call('/v2/me/bridge-connections', browserToken, { clientMutationId: randomUUID(), provider: 'slack',
        credential: { kind: 'slack_tokens', botToken: slack.botToken, appToken: slack.appToken } });
      return r.status === 200 && r.body.data.runtime === 'connecting' ? r : undefined;
    });
    expect(begun.raw).not.toContain(slack.botToken);
    expect(begun.raw).not.toContain(slack.appToken);
    connectionId = begun.body.data.connection.id;
    expect(begun.body.data.connection).toMatchObject({ provider: 'slack', runtimeId: RUNTIME_ID });

    const linked = await until('the connection to go linked', async () => {
      const list = await call('/v2/me/bridge-connections?provider=slack', browserToken);
      const c = list.body.data.items.find((x: { id: string }) => x.id === connectionId);
      return c?.status === 'linked' ? c : undefined;
    });
    expect(linked).toMatchObject({
      label: 'Acme', externalAccountId: 'T0FAKE', detail: null,
      account: expect.objectContaining({ teamId: 'T0FAKE', teamName: 'Acme', botUserId: slack.bot.userId, enterpriseId: 'E0FAKE', isEnterpriseInstall: false }),
    });
    expect(slack.callsOf('auth.test').length).toBeGreaterThan(0);
    // The runtime sealed the tokens under its own state dir (D38); the bytes on disk are not the tokens.
    const dir = join(stateDir, 'bridges', connectionId);
    const files = await readdir(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const bytes = await readFile(join(dir, f), 'utf8');
      expect(bytes).not.toContain(slack.botToken);
      expect(bytes).not.toContain(slack.appToken);
    }
    await slack.waitForSocket(undefined, 10_000);
  });

  it('2. offered to a space, a channel bridge on a session target defaults to threadMode mention; the runtime gets the allowlist', async () => {
    const offered = await call(`/v2/me/bridge-connections/${connectionId}/offer`, browserToken,
      { clientMutationId: randomUUID(), spaceId, visibility: 'public' });
    expect(offered.status, offered.raw).toBe(200);
    const created = await call(`/v2/spaces/${spaceId}/bridges`, browserToken, {
      clientMutationId: randomUUID(), connectionId,
      conversation: { externalId: CHANNEL, kind: 'channel', title: 'eng-support', memberCount: 12 },
      targetId: target, teammateId: teammate,
    });
    expect(created.status, created.raw).toBe(200);
    const view = created.body.data.bridge ?? created.body.data;
    bridgeId = view.id ?? view.entity?.id;
    expect(bridgeId).toBeTruthy();
    const [b] = await owner<{ policy: Record<string, unknown> }>('select policy from public.bridges where entity_id = $1', [bridgeId]);
    expect(b!.policy).toMatchObject({ threadMode: 'mention', trigger: 'mention' });
    // The runtime takes the channel into its allowlist (it drops anything from a channel not on it).
    await until('the allowlist on the runtime', () => runtimeLog.some((l) => l.startsWith(`[allowlist ${connectionId}]`) && / 1 connected /.test(l)));
  });

  it('3. an @mention from an email-linked member starts a thread session, a child of the target', async () => {
    root = slack.ts();
    await event({ type: 'message', channel: CHANNEL, user: PRIYA, text: `<@${slack.bot.userId}> the login page 500s on Safari`, ts: root });
    await until('the mention to be stored', async () => (await inboundCopies(root)).length > 0);
    const links = await owner<{ method: string; identity_id: string }>(
      `select method, identity_id from public.bridge_identity_links where provider = 'slack' and external_id = $1 and revoked_at is null`, [PRIYA]);
    expect(links).toEqual([{ method: 'email', identity_id: ownerIdentity }]);

    const thread = await until('the thread session', async () => (await owner<{ session_id: string | null; root_message_id: string }>(
      `select session_id::text, root_message_id::text from public.bridge_threads where bridge_id = $1 and root_external_id = $2`, [bridgeId, root]))
      .find((t) => t.session_id));
    threadSession = thread.session_id!;
    rootMessage = thread.root_message_id;
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ parentSessionId: target, teamMemberId: teammate, title: 'The login page 500s on Safari' });
    expect((await owner<{ parent_id: string }>('select parent_id::text from public.entities where id = $1', [threadSession]))[0]!.parent_id).toBe(target);
    // Delivered to the thread session, never to the bridge's own target.
    const deliveries = await until('a delivery to the thread session', async () => {
      const rows = await owner<{ target: string }>(
        `select target_work_session_id::text as target from public.session_message_deliveries d
           join public.message_origins o on o.message_id = d.message_id or o.message_id = (select root_message_id from public.messages where entity_id = d.message_id)
          where o.external_message_id = $1 and o.direction = 'in'`, [root]);
      return rows.length ? rows : undefined;
    });
    expect(new Set(deliveries.map((d) => d.target))).toEqual(new Set([threadSession]));
  });

  it('5. a progress reaction lands on the mention in Slack before any reply (427: 📨 once tm8 acts on it)', async () => {
    const r = await until('a progress reaction on the mention', () => slack.reactions.find((x) => x.channel === CHANNEL && x.ts === root), 5000);
    expect(r.name).toBe('incoming_envelope');
    expect(slack.messages).toEqual([]);
  });

  it('4. the thread session replies: chat.postMessage into the thread (thread_ts = root ts) with the session as username and no prefix', async () => {
    const secret = generateSecret();
    const agent = await db.tx(human(), (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      threadSession, teammate, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'slack-e2e thread session']));
    const sessionToken = formatToken(agent.id, secret);
    const answer = await call('/v2/messages', sessionToken, { replyToMessageId: rootMessage, body: 'On it: the CSP header blocks the font CDN.', clientMutationId: randomUUID() });
    expect(answer.status, answer.raw).toBe(200);
    const m = await posted((x) => x.text.includes('the CSP header blocks the font CDN'), 'the answer in Slack');
    expect(m.channel).toBe(CHANNEL);
    expect(m.thread_ts).toBe(root);
    // chat:write.customize: the session's own name (title and handle), not a 'Title (handle):' prefix.
    const [h] = await owner<{ handle: string }>('select handle from public.bridge_handles where entity_id = $1', [threadSession]);
    handle = h!.handle;
    expect(m.username).toBe(`The login page 500s on Safari (${handle})`);
    expect(m.text).toBe('On it: the CSP header blocks the font CDN.');
    // The outbox settled sent with Slack's ts as the external id.
    await until('the outbox row to settle sent', async () => (await owner<{ status: string }>(
      `select status from public.bridge_outbox where external_message_id = $1 and kind = 'send'`, [m.ts]))[0]?.status === 'sent' || undefined);
    // ✅ replaces the earlier progress stage once a reply crossed out.
    await until('the replied reaction', () => slack.reactions.find((x) => x.ts === root && x.name === 'white_check_mark' && !x.removed));
    expect(slack.reactions.filter((x) => x.ts === root && !x.removed).map((x) => x.name)).toEqual(['white_check_mark']);
  });

  it('6 + 9. a thread reply routes to that session (📨 on it); its answer survives a 429 (Retry-After honoured, then retried)', async () => {
    reply = slack.ts();
    await event({ type: 'message', channel: CHANNEL, user: PRIYA, text: 'can you also add a regression test?', ts: reply, thread_ts: root, parent_user_id: PRIYA });
    const copies = await until('the thread reply to be stored', async () => {
      const c = await inboundCopies(reply);
      return c.length ? c : undefined;
    });
    const targets = await until('the thread reply delivered', async () => {
      const rows = await owner<{ target: string }>(
        `select distinct target_work_session_id::text as target from public.session_message_deliveries where message_id = any($1::uuid[])`,
        [copies.map((c) => c.message_id)]);
      return rows.length ? rows : undefined;
    });
    expect(targets.map((t) => t.target)).toEqual([threadSession]);
    expect(spawns).toHaveLength(1);
    await until('📨 on the thread reply', () => slack.reactions.find((x) => x.ts === reply && x.name === 'incoming_envelope'));

    // The session answers the reply; Slack's first answer is a 429 with Retry-After: 1.
    const secret = generateSecret();
    const agent = await db.tx(human(), (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      threadSession, teammate, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'slack-e2e thread session 2']));
    slack.rateLimit('chat.postMessage', 1, 1);
    const logCopy = copies.find((c) => c.message_id)!.message_id;
    const sent = await call('/v2/messages', formatToken(agent.id, secret), { replyToMessageId: logCopy, body: 'Added a Safari regression test.', clientMutationId: randomUUID() });
    expect(sent.status, sent.raw).toBe(200);
    const m = await posted((x) => x.text.includes('Added a Safari regression test'), 'the answer after the 429');
    expect(m.thread_ts).toBe(root);
    const tries = slack.calls.filter((c) => c.method === 'chat.postMessage' && c.params.text?.includes('Added a Safari regression test'));
    expect(tries.length).toBe(2);
    // The 429 came back to the server as failed{retryAfterSec}; the outbox re-sent it, and the row settled sent.
    await until('the retried row to settle sent', async () => (await owner<{ status: string }>(
      `select status from public.bridge_outbox where external_message_id = $1 and kind = 'send'`, [m.ts]))[0]?.status === 'sent' || undefined);
  });

  it('files: a Slack file in the thread reaches the session as an attachment; a tm8 file goes up into the thread', async () => {
    // In: a file_share in the thread. The server asks for the bytes (media.fetch), the runtime downloads url_private
    // with the bot token and hands them over, and the file is attached to the stored message delivered to the session.
    const log = Buffer.from('Safari 18.1: CSP violation font-src\n');
    const shot = slack.file({ name: 'console.log', mimetype: 'text/plain', bytes: log, channels: [CHANNEL] });
    const ts = slack.ts();
    await event({ type: 'message', subtype: 'file_share', channel: CHANNEL, user: PRIYA, text: 'the console output', ts, thread_ts: root, files: [slack.fileRef(shot)] });
    const attached = await until('the Slack file attached in tm8', async () => {
      const rows = await owner<{ message_id: string; attachments: { fileEntityId: string; name: string; mime: string }[] }>(
        `select m.entity_id::text as message_id, m.attachments from public.message_origins o join public.messages m on m.entity_id = o.message_id
          where o.direction = 'in' and o.external_message_id = $1`, [ts]);
      return rows.find((r) => r.attachments?.length);
    });
    expect(attached.attachments).toEqual([expect.objectContaining({ name: 'console.log', mime: 'text/plain' })]);
    const [file] = await owner<{ size_bytes: string }>('select size_bytes::text from public.files where entity_id = $1', [attached.attachments[0]!.fileEntityId]);
    expect(Number(file!.size_bytes)).toBe(log.length);
    expect(slack.fileRequests.some((q) => q.path.includes(shot.id) && q.authorization === `Bearer ${slack.botToken}`)).toBe(true);
    await until('the file message delivered to the thread session', async () => (await owner<{ target: string }>(
      `select distinct d.target_work_session_id::text as target from public.session_message_deliveries d
         join public.message_origins o on o.message_id = d.message_id
        where o.direction = 'in' and o.external_message_id = $1`, [ts]))
      .some((r) => r.target === threadSession) || undefined);

    // Out: the session answers with a tm8 file. It streams through files.getUploadURLExternal (no token on the
    // upload URL) and files.completeUploadExternal into the thread.
    const report = Buffer.from('%PDF-1.7 regression report '.repeat(200));
    const fileId = randomUUID();
    const blobs = createW2BlobStore({ dataDir });
    const storagePath = blobs.storagePath(spaceId, randomUUID());
    const sha256 = createHash('sha256').update(report).digest('hex');
    await blobs.writeUpload({ stream: (async function* () { yield report; })(), storagePath, expectedSpaceId: spaceId,
      expectedSizeBytes: report.length, expectedChecksumSha256: sha256 });
    await owner(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'file',$3)`, [fileId, spaceId, teammate]);
    await owner(`insert into public.files(entity_id, name, mime_type, size_bytes, storage_path, checksum_sha256) values ($1,$2,'application/pdf',$3,$4,$5)`,
      [fileId, 'report.pdf', report.length, storagePath, sha256]);
    const secret = generateSecret();
    const agent = await db.tx(human(), (q) => q.rpc<{ id: string }>('issue_agent_auth_session', [
      threadSession, teammate, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'slack-e2e thread session files']));
    const sent = await call('/v2/messages', formatToken(agent.id, secret),
      { replyToMessageId: attached.message_id, body: 'The regression report', attachmentIds: [fileId], clientMutationId: randomUUID() });
    expect(sent.status, sent.raw).toBe(200);
    const done = await until('files.completeUploadExternal', () => slack.callsOf('files.completeUploadExternal').at(-1));
    const [up] = slack.callsOf('files.getUploadURLExternal');
    expect(up!.params).toMatchObject({ filename: 'report.pdf', length: String(report.length) });
    const uploadedId = JSON.parse(done.params.files!)[0].id as string;
    expect(slack.uploaded(uploadedId)!.equals(report)).toBe(true);
    expect(done.params).toMatchObject({ channel_id: CHANNEL, thread_ts: root });
    expect(slack.fileRequests.filter((q) => q.path.startsWith('/upload/')).every((q) => q.authorization === null)).toBe(true);
  });

  it('7. an edit and a delete in Slack are mirrored into tm8', async () => {
    await event({ type: 'message', subtype: 'message_changed', channel: CHANNEL, hidden: true, ts: slack.ts(),
      message: { type: 'message', user: PRIYA, text: `<@${slack.bot.userId}> the login page 500s on Safari 18`, ts: root, edited: { user: PRIYA, ts: `${Math.floor(Date.now() / 1000)}.000000` } },
      previous_message: { type: 'message', user: PRIYA, text: `<@${slack.bot.userId}> the login page 500s on Safari`, ts: root } });
    const edited = await until('the edit', async () => {
      const c = await inboundCopies(root);
      return c.length && c.every((x) => x.edited && x.body.includes('Safari 18')) ? c : undefined;
    });
    expect(edited.length).toBeGreaterThanOrEqual(1);
    expect(spawns).toHaveLength(1); // an edit starts nothing

    await event({ type: 'message', subtype: 'message_deleted', channel: CHANNEL, hidden: true, ts: slack.ts(), deleted_ts: reply,
      previous_message: { type: 'message', user: PRIYA, text: 'can you also add a regression test?', ts: reply, thread_ts: root } });
    const gone = await until('the delete', async () => {
      const c = await inboundCopies(reply);
      return c.length && c.every((x) => x.redacted && x.deleted) ? c : undefined;
    });
    expect(gone.every((x) => !x.body.includes('regression test'))).toBe(true);
  });

  it('8. /tm8 status <worker> arrives as a slash command and is answered in the channel (not in a thread)', async () => {
    const before = slack.messages.length;
    const ack = await slack.waitForAck(slack.slash({ channel: CHANNEL, user: PRIYA, text: `status ${handle}` }), 5000);
    expect(ack.envelope_id).toBeTruthy();
    const m = await until('the /tm8 status answer', () => slack.messages.slice(before).find((x) => x.channel === CHANNEL && !x.thread_ts));
    expect(m.text).toContain(handle);
    expect(m.text).not.toMatch(/usage:|problem on our side/);
    // The command is not a thread and started no session.
    expect(spawns).toHaveLength(1);
  });

  it('a guest and a Slack Connect user with a member\'s verified email are NOT auto-linked; their @mention starts nothing', async () => {
    slack.user({ id: 'U0GUEST01', name: 'Gus', email: OWNER_EMAIL, guest: 'multi' });
    slack.user({ id: 'U0EXTERN1', name: 'Ext', email: OWNER_EMAIL, external: true });
    for (const user of ['U0GUEST01', 'U0EXTERN1']) {
      const ts = slack.ts();
      await event({ type: 'message', channel: CHANNEL, user, text: `<@${slack.bot.userId}> please deploy main`, ts });
      await until(`${user}'s mention stored`, async () => (await inboundCopies(ts)).length > 0);
      const links = await owner('select 1 from public.bridge_identity_links where provider = $1 and external_id = $2', ['slack', user]);
      expect(links, user).toEqual([]);
      const threads = await owner('select 1 from public.bridge_threads where bridge_id = $1 and root_external_id = $2', [bridgeId, ts]);
      expect(threads, user).toEqual([]);
      const [author] = await owner<{ kind: string }>(
        `select e.kind from public.message_origins o join public.messages m on m.entity_id = o.message_id
           join public.entities e on e.id = m.author_id where o.direction = 'in' and o.external_message_id = $1 limit 1`, [ts]);
      expect(author!.kind, user).not.toBe('member');
    }
    expect(spawns).toHaveLength(1);
  });

  it('4b. a member\'s reply from tm8 goes into the thread with her name and her https avatar as icon_url', async () => {
    const mine = await call('/v2/messages', browserToken, { anchorIds: [bridgeId], parentMessageId: rootMessage, body: 'Thanks, I will check Safari 17 too.', clientMutationId: randomUUID() });
    expect(mine.status, mine.raw).toBe(200);
    const pm = await posted((x) => x.text.includes('Safari 17 too'), 'the member reply in Slack');
    expect(pm).toMatchObject({ channel: CHANNEL, thread_ts: root, username: 'Priya', icon_url: AVATAR, text: 'Thanks, I will check Safari 17 too.' });
  });

  it('no token is in any table, log line or runtime log', async () => {
    const secrets = [slack.botToken, slack.appToken, 'FAKE0bot0token', 'fake0app0token'];
    const all = [...logged, ...runtimeLog].join('\n');
    for (const s of secrets) expect(all).not.toContain(s);
    const tables = await database.query<{ schema: string; name: string }>(
      `select table_schema as schema, table_name as name from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema in ('public', 'internal')`);
    expect(tables.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const t of tables) {
      const [row] = await database.query<{ n: number }>(
        `select count(*)::int as n from "${t.schema}"."${t.name}" x where x::text like any($1)`, [secrets.map((s) => `%${s}%`)]);
      if (row!.n > 0) hits.push(`${t.schema}.${t.name}`);
    }
    expect(hits).toEqual([]);
  });
});
