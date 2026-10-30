/**
 * Q7/Q8 (D55, D56; migration 410) over a real bootstrap() and a fake runtime
 * on the runtime socket. Two members' numbers (Asha's A, Bina's B) are offered
 * to the space; the Infra bridge rides A. The runtime answers accept's
 * `conversation.list` with each number's groups from `groups` below.
 *
 *   H1 offer: a member who neither owns the number nor admins the space is
 *      refused, and so is the owner's agent; the owner's offer gives Bina an
 *      attention item naming the accept;
 *   H2 accept: only Bina (not Chen, not Bina's agent); B not in the group
 *      refuses not_in_group and nothing moves;
 *   H3 decline and withdraw settle the offer without a move;
 *   H4 accept moves the bridge in one write: same id and log anchor, new
 *      connection and credential, both allowlists bumped and pushed, the
 *      queued loop post re-addressed (and sent on B), the in-flight row left
 *      on A; the loop's next post goes out on B;
 *   H5 the guards still hold outside an accept (395/408's arms);
 *   H6 D56: B logged out raises an fyi to the space admin (not B's owner),
 *      naming the hand-over; linked again clears it. Nothing moved.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE, type AllowlistFrame, type ServerFrame } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { issueBridgeRuntimeSession } from '../../src/identity/pg-auth.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
const spaceId = randomUUID(), teammate = randomUUID(), chat = randomUUID();
const people = {
  asha: { member: randomUUID(), account: randomUUID(), identity: `ho-asha-${randomUUID()}`, role: 'owner', token: '' },
  bina: { member: randomUUID(), account: randomUUID(), identity: `ho-bina-${randomUUID()}`, role: 'member', token: '' },
  chen: { member: randomUUID(), account: randomUUID(), identity: `ho-chen-${randomUUID()}`, role: 'member', token: '' },
  dev: { member: randomUUID(), account: randomUUID(), identity: `ho-dev-${randomUUID()}`, role: 'admin', token: '' },
};
const connA = randomUUID(), connB = randomUUID();
const GROUP = '120363-infra@g.us';
const RUNTIME = 'wa-handover';
const groups: Record<string, string[]> = { [connA]: [GROUP], [connB]: ['120363-other@g.us'] };
let bridge = '';
let runtimeToken = '';
let credB = '';
const sockets: WebSocket[] = [];
const frames: ServerFrame[] = [];
const held: Record<string, number> = {};
let beat: NodeJS.Timeout | undefined;

const claims = (who: keyof typeof people, authKind: 'browser' | 'agent' = 'browser'): DbClaims =>
  ({ identityId: people[who].identity, authKind, requestId: randomUUID() });
const owner = <T>(sql: string, params: unknown[] = []) => database.transaction(async c => {
  await c.query('set local role tm8_graph_owner');
  return (await c.query(sql, params)).rows as T[];
});
async function refusal(p: Promise<unknown>): Promise<{ code?: string; message?: string; detail?: string }> {
  try { await p; } catch (err) { return err as never; }
  throw new Error('expected a refusal');
}

async function call(path: string, who: keyof typeof people | string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const token = who in people ? people[who as keyof typeof people].token : who;
  const response = await fetch(new URL(path, server.url), {
    method: 'POST',
    headers: { [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const runtimePost = (route: string, body: unknown) => call(`/v2/bridge-runtime/${route}`, runtimeToken, body);

async function until<T>(probe: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}
const allowlists = (conn: string) => frames.filter((f): f is AllowlistFrame => f.type === 'allowlist' && f.connectionId === conn);
const heartbeat = () => runtimePost('heartbeat', {
  runtimeId: RUNTIME, at: new Date().toISOString(),
  connections: [connA, connB].map(id => ({ connectionId: id, status: 'linked', dropped: {}, allowlistVersion: held[id] ?? null })),
});

/** A loop that posts in the bridge, and one manual run of it: its outbox row. */
async function loopPost(loopId: string): Promise<{ messageId: string; outboxId: string; connectionId: string; status: string }> {
  const run = await db.rpc<{ claimed: boolean; runId: string }>(claims('asha'), 'loop_run_claim',
    [loopId, new Date().toISOString(), 'manual', [], null, null, null, null, true, randomUUID()]);
  expect(run.claimed).toBe(true);
  const out = await db.rpc<Array<{ result: string; messageId: string }>>(claims('asha'), 'loop_post_targets', [loopId, run.runId]);
  expect(out[0]!.result, JSON.stringify(out)).toBe('posted');
  const [row] = await owner<{ id: string; connection_id: string; status: string }>(
    `select id::text, connection_id::text, status from public.bridge_outbox where message_id = $1 and kind = 'send'`, [out[0]!.messageId]);
  return { messageId: out[0]!.messageId, outboxId: row!.id, connectionId: row!.connection_id, status: row!.status };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridges_handover');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 4 });
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-handover-'));
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    for (const [name, p] of Object.entries(people)) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1,$2)`, [p.identity, name]);
      await c.query(`insert into public.accounts(id, identity_id, username, is_owner, is_node_admin) values ($1,$2,$3,$4,$4)`,
        [p.account, p.identity, `ho-${name}-${p.account.slice(0, 8)}`, name === 'asha']);
    }
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1,'Hand-over',$2)`, [spaceId, people.asha.identity]);
    for (const [name, p] of Object.entries(people)) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'member',$1)`, [p.member, spaceId]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1,$2,$3,$4,$5)`,
        [p.member, spaceId, p.identity, p.role, name]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'team_member',$3)`, [teammate, spaceId, people.asha.member]);
    await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1,$2,'Infra Bot','worker','persona')`,
      [teammate, people.asha.member]);
    await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1,$2,'chat',$3)`, [chat, spaceId, people.asha.member]);
    await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
        chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
      values ($1,$2,'Infra main',$3,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/handover', gen_random_uuid(), $4, $5, $6)`,
      [chat, spaceId, teammate, people.asha.identity, people.asha.member, `ho-${randomUUID()}`]);
    for (const [id, who, label] of [[connA, people.asha, '+91 …1111'], [connB, people.bina, '+91 …2222']] as const) {
      await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status, runtime_id, heartbeat_at)
        values ($1,'whatsapp',$2,$3,'linked',$4, now() + interval '1 hour')`, [id, who.account, label, RUNTIME]);
    }
  });
  await db.tx(claims('asha'), q => q.rpc('offer_bridge_connection', [connA, spaceId, 'public', null, randomUUID()]));
  credB = (await db.tx(claims('bina'), q => q.rpc<{ entity: { id: string } }>('offer_bridge_connection',
    [connB, spaceId, 'public', null, randomUUID()]))).entity.id;
  bridge = (await db.tx(claims('asha'), q => q.rpc<{ entity: { id: string } }>('create_bridge', [spaceId, connA, GROUP,
    JSON.stringify({ kind: 'group', title: 'Infra', memberCount: 4 }), chat, '{}', teammate, null, null, true, null, null, randomUUID()]))).entity.id;
  runtimeToken = (await issueBridgeRuntimeSession(db, { identityId: people.asha.identity, nodeAdmin: true, requestId: 'mint' }, 'whatsapp-runtime')).token;
  for (const p of Object.values(people)) {
    const secret = generateSecret();
    const row = await db.tx(claims('asha'), (q) => q.rpc<{ id: string }>('issue_auth_session', [p.account, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'handover browser']));
    p.token = formatToken(row.id, secret);
  }
  const configured = loadConfig({
    ...process.env, TM8_BIND: '127.0.0.1', TM8_PORT: '4614', TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url, TM8_DATA_DIR: dataDir, TM8_DISABLE_AUTO_OWNER: '1',
  });
  server = await bootstrap({ config: { ...configured, port: 0 } });

  // The fake runtime: records frames, answers conversation.list from `groups`.
  const url = new URL('/v2/ws', server.url);
  url.protocol = 'ws:';
  url.searchParams.set('bridgeRuntime', RUNTIME);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${runtimeToken}` } } as unknown as string[]);
  sockets.push(ws);
  ws.onmessage = (ev) => {
    const f = JSON.parse(String(ev.data)) as ServerFrame;
    frames.push(f);
    if (f.type === 'allowlist') held[f.connectionId] = Math.max(held[f.connectionId] ?? 0, f.version);
    if (f.type === 'conversation.list') {
      void runtimePost('conversations', { requestId: f.requestId, connectionId: f.connectionId,
        items: (groups[f.connectionId] ?? []).map(id => ({ conversationId: id, kind: 'group', name: id, size: 4, canSend: true })) });
    }
  };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket refused')); });
  const hello = await runtimePost('hello', { provider: 'whatsapp', version: 1, runtimeId: RUNTIME, capabilities: {} });
  expect(hello.status, JSON.stringify(hello.body)).toBe(200);
  for (const c of hello.body.connections as { connectionId: string; allowlist: AllowlistFrame }[]) {
    held[c.connectionId] = c.allowlist.version;
  }
  // Keep both numbers linked for the watchdog while the suite runs.
  beat = setInterval(() => { void heartbeat(); }, 20_000);
});

afterAll(async () => {
  if (beat) clearInterval(beat);
  for (const ws of sockets) ws.close();
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
});

const offer = (who: keyof typeof people) =>
  call(`/v2/bridges/${bridge}/handover`, who, { clientMutationId: randomUUID(), toConnectionId: connB });
const settle = (verb: 'accept' | 'decline' | 'withdraw', id: string, who: keyof typeof people) =>
  call(`/v2/bridge-handovers/${id}/${verb}`, who, { clientMutationId: randomUUID() });
const handoverRow = async (id: string) =>
  (await owner<{ status: string; settled_by: string | null }>('select status, settled_by::text from public.bridge_handovers where id = $1', [id]))[0]!;
const bridgeRow = async () => (await owner<{ connection_id: string; credential_id: string }>(
  'select connection_id::text, credential_id::text from public.bridges where entity_id = $1', [bridge]))[0]!;
const attention = (key: string) => owner<{ status: string; assignee_id: string | null; reason: string; entity_id: string }>(
  'select status, assignee_id::text, reason, entity_id::text from public.attention_requests where signal_key = $1', [key]);

describe('H1. offer', () => {
  it('refuses a member who neither owns the number nor admins the space, and the owner\'s agent', async () => {
    const chen = await offer('chen');
    expect(chen.status, JSON.stringify(chen.body)).toBe(403);
    const agent = await refusal(db.tx(claims('asha', 'agent'), q => q.rpc('offer_bridge_handover', [bridge, connB, randomUUID()])));
    expect(agent.code).toBe('42501');
    expect(await owner('select 1 from public.bridge_handovers')).toHaveLength(0);
  });

  it('the owner\'s offer gives the receiver an attention item naming the accept', async () => {
    const r = await offer('asha');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const h = r.body.data.handover;
    expect(h).toMatchObject({ bridgeId: bridge, fromConnectionId: connA, toConnectionId: connB, status: 'offered', offeredBy: people.asha.member });
    const [item] = await attention(`bridge.handover:${h.id}`);
    expect(item).toMatchObject({ status: 'open', assignee_id: people.bina.member, entity_id: bridge });
    expect(item!.reason).toContain(`tm8 bridge handover accept ${h.id}`);
    // One open offer per bridge.
    const again = await offer('dev');
    expect(again.status).toBe(409);
    expect(again.body.error.details.reason).toBe('handover_pending');
    expect((await settle('withdraw', h.id, 'dev')).status).toBe(200);
  });
});

describe('H2. accept: the receiving number\'s owner, and only with the group on that number', () => {
  it('refuses Chen and Bina\'s agent; B not in the group refuses not_in_group and nothing moves', async () => {
    const h = (await offer('dev')).body.data.handover;
    const chen = await settle('accept', h.id, 'chen');
    expect(chen.status).toBe(403);
    const agent = await refusal(db.tx(claims('bina', 'agent'), q => q.rpc('accept_bridge_handover', [h.id, [GROUP], randomUUID()])));
    expect(agent.code).toBe('42501');
    const notIn = await settle('accept', h.id, 'bina');
    expect(notIn.status, JSON.stringify(notIn.body)).toBe(409);
    expect(notIn.body.error.details.reason).toBe('not_in_group');
    expect(frames.some(f => f.type === 'conversation.list' && f.connectionId === connB)).toBe(true);
    expect((await handoverRow(h.id)).status).toBe('offered');
    expect((await bridgeRow()).connection_id).toBe(connA);
    expect((await settle('withdraw', h.id, 'asha')).status).toBe(200);
  });
});

describe('H3. decline and withdraw', () => {
  it('decline is the receiver\'s; it settles the offer and clears the item; withdraw likewise', async () => {
    const d = (await offer('asha')).body.data.handover;
    expect((await settle('decline', d.id, 'asha')).status).toBe(403);
    const declined = await settle('decline', d.id, 'bina');
    expect(declined.status).toBe(200);
    expect(declined.body.data.handover.status).toBe('declined');
    expect((await attention(`bridge.handover:${d.id}`))[0]!.status).toBe('cleared');
    expect((await settle('accept', d.id, 'bina')).body.error.details.reason).toBe('handover_not_open');

    const w = (await offer('asha')).body.data.handover;
    expect((await settle('withdraw', w.id, 'chen')).status).toBe(403);
    const withdrawn = await settle('withdraw', w.id, 'asha');
    expect(withdrawn.body.data.handover.status).toBe('withdrawn');
    expect((await attention(`bridge.handover:${w.id}`))[0]!.status).toBe('cleared');
    expect((await bridgeRow()).connection_id).toBe(connA);
  });
});

describe('H4. accept moves the bridge in one write', () => {
  it('keeps the bridge, swaps both allowlists, re-addresses the queued post and leaves the in-flight one', async () => {
    const loopId = await db.tx(claims('asha'), async q => {
      const r = await q.rpc<{ entity: { id: string } }>('create_loop', [
        spaceId, 'Daily infra', null, 'every 1d', teammate, null, '', '{}',
        true, new Date(Date.now() + 86_400_000).toISOString(), null, null, randomUUID(),
        'post', null, '{}', 'UTC', 'skip', null, 0, 300, null,
      ]);
      await q.rpc('set_loop_bridge_fields', [r.entity.id, JSON.stringify([{ bridgeId: bridge, text: 'standup in 5' }]), null, null]);
      return r.entity.id;
    });
    // Hold dispatch while the rows are set up: the runtime's socket stays open,
    // so the hub would otherwise take them at once.
    await owner(`update public.bridge_connections set status = 'connecting' where id = $1`, [connA]);
    const inFlight = await loopPost(loopId);
    const queued = await loopPost(loopId);
    expect(queued.connectionId).toBe(connA);
    await owner(`update public.bridge_outbox set status = 'dispatching', dispatched_at = now(), attempts = 1 where id = $1`, [inFlight.outboxId]);
    await owner(`update public.bridge_connections set status = 'linked' where id = $1`, [connA]);

    const [before] = await owner<{ version: number; anchor: string }>(
      'select e.version, internal.bridge_log_anchor(b) as anchor from public.entities e join public.bridges b on b.entity_id = e.id where e.id = $1', [bridge]);
    const versions = async () => Object.fromEntries((await owner<{ id: string; v: string }>(
      'select id::text, allowlist_version::text as v from public.bridge_connections where id = any($1)', [[connA, connB]])).map(r => [r.id, Number(r.v)]));
    const v0 = await versions();
    const pushedA = held[connA] ?? 0, pushedB = held[connB] ?? 0;

    groups[connB] = [GROUP, '120363-other@g.us'];
    const h = (await offer('asha')).body.data.handover;
    const accepted = await settle('accept', h.id, 'bina');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.data.handover).toMatchObject({ status: 'accepted', settledBy: people.bina.member });
    expect(accepted.body.data.bridge).toMatchObject({ id: bridge, connectionId: connB, connectionCredentialId: credB });
    expect(accepted.body.data.readdressed).toBe(1);

    // Same bridge: id, log anchor; one new version; D20's one bridge per group.
    const [after] = await owner<{ version: number; anchor: string }>(
      'select e.version, internal.bridge_log_anchor(b) as anchor from public.entities e join public.bridges b on b.entity_id = e.id where e.id = $1', [bridge]);
    expect(after!.anchor).toBe(before!.anchor);
    expect(Number(after!.version)).toBeGreaterThan(Number(before!.version));
    expect(await owner('select 1 from public.bridges where external_conversation_id = $1', [GROUP])).toHaveLength(1);
    expect(await bridgeRow()).toEqual({ connection_id: connB, credential_id: credB });
    expect((await attention(`bridge.handover:${h.id}`))[0]!.status).toBe('cleared');

    // Both allowlists bumped in the write, then pushed: A without the group, B with it.
    const v1 = await versions();
    expect(v1[connA]).toBeGreaterThan(v0[connA]!);
    expect(v1[connB]).toBeGreaterThan(v0[connB]!);
    const a = await until(() => allowlists(connA).find(f => f.version > pushedA && !f.conversationIds.includes(GROUP)));
    const b = await until(() => allowlists(connB).find(f => f.version > pushedB && f.conversationIds.includes(GROUP)));
    expect(a.conversationIds).toEqual([]);
    expect(b.conversationIds).toEqual([GROUP]);

    // The queued post went out on B; the in-flight one stayed on A and settles there.
    const send = await until(() => frames.find(f => f.type === 'send' && f.outboxId === queued.outboxId));
    expect(send).toMatchObject({ connectionId: connB, conversationId: GROUP });
    const [rows] = await owner<{ q: string; f: string }>(
      `select (select connection_id::text from public.bridge_outbox where id = $1) q, (select connection_id::text from public.bridge_outbox where id = $2) f`,
      [queued.outboxId, inFlight.outboxId]);
    expect(rows).toEqual({ q: connB, f: connA });
    const settled = await runtimePost('sent', { outboxId: inFlight.outboxId, connectionId: connA, externalMessageId: 'WAID-A-1', message: {} });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.status).toBe('sent');

    // A loop still targeting the bridge posts via the new number.
    const next = await loopPost(loopId);
    expect(next.connectionId).toBe(connB);
    const nextSend = await until(() => frames.find(f => f.type === 'send' && f.outboxId === next.outboxId));
    expect(nextSend).toMatchObject({ connectionId: connB });

    // A's runtime forwarding the group now is refused (off its allowlist); B's lands on the same bridge.
    const offA = await runtimePost('inbound', { connectionId: connA, conversationId: GROUP, externalMessageId: 'WA-IN-A',
      sender: { externalId: '919800000001@s.whatsapp.net', altId: null, name: 'Ravi', fromMe: false },
      body: 'hello', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_001 });
    expect(offA.body.status).toBe('refused');
    const onB = await runtimePost('inbound', { connectionId: connB, conversationId: GROUP, externalMessageId: 'WA-IN-B',
      sender: { externalId: '919800000001@s.whatsapp.net', altId: null, name: 'Ravi', fromMe: false },
      body: 'hello', kind: 'text', media: [], replyTo: null, mentions: [], ts: 1_790_000_002 });
    expect(onB.status, JSON.stringify(onB.body)).toBe(200);
    expect(onB.body.status).not.toBe('refused');
  });
});

describe('H5. the guards still hold outside an accept', () => {
  it('connection and credential stay fixed on any other write; resume on a withdrawn credential is still refused', async () => {
    const move = await refusal(owner('update public.bridges set connection_id = $2 where entity_id = $1', [bridge, connA]));
    expect(move.message).toMatch(/fixed/);
    const [credA] = await owner<{ id: string }>(
      `select id::text from public.space_credentials where bridge_connection_id = $1 and space_id = $2`, [connA, spaceId]);
    const cred = await refusal(owner('update public.bridges set credential_id = $2 where entity_id = $1', [bridge, credA!.id]));
    expect(cred.message).toMatch(/credential is fixed/);
    // 408's arm: withdraw B's offer pauses the bridge; resume refuses connection_withdrawn.
    const w = await call(`/v2/me/bridge-connections/${connB}/withdraw`, 'bina', { clientMutationId: randomUUID(), spaceId });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    const resume = await refusal(owner('update public.bridges set paused_at = null where entity_id = $1', [bridge]));
    expect(resume.detail ?? '').toContain('connection_withdrawn');
    // Offered again: the same credential comes back and the bridge resumes on B.
    await db.tx(claims('bina'), q => q.rpc('offer_bridge_connection', [connB, spaceId, 'public', null, randomUUID()]));
    await owner('update public.bridges set paused_at = null where entity_id = $1', [bridge]);
    expect(await bridgeRow()).toEqual({ connection_id: connB, credential_id: credB });
  });

  it('#1443\'s owner_not_member arm (carried in 410\'s restatement): the NEW number\'s owner left, resume is refused', async () => {
    await owner('update public.bridges set paused_at = now() where entity_id = $1', [bridge]);
    await owner(`update public.members set status = 'left' where entity_id = $1`, [people.bina.member]);
    const resume = await refusal(owner('update public.bridges set paused_at = null where entity_id = $1', [bridge]));
    expect(resume.detail ?? '').toContain('owner_not_member');
    await owner(`update public.members set status = 'active' where entity_id = $1`, [people.bina.member]);
    await owner('update public.bridges set paused_at = null where entity_id = $1', [bridge]);
  });
});

describe('H6. D56: degraded tells the admins and names the hand-over; nothing moves by itself', () => {
  it('B logged out: the space admins (not B\'s owner) get an fyi; linked again clears it', async () => {
    await owner(`update public.bridge_connections set status = 'logged_out' where id = $1`, [connB]);
    const key = (member: string) => `bridge.connection_down:${connB}:${member}`;
    for (const admin of [people.asha.member, people.dev.member]) {
      const [item] = await attention(key(admin));
      expect(item).toMatchObject({ status: 'open', assignee_id: admin, entity_id: bridge });
      expect(item!.reason).toContain(`tm8 bridge handover offer ${bridge}`);
      expect(item!.reason).toContain('logged out');
    }
    expect(await attention(key(people.bina.member))).toHaveLength(0);
    expect(await attention(key(people.chen.member))).toHaveLength(0);
    // No failover: the bridge still rides B, and no offer was made.
    expect((await bridgeRow()).connection_id).toBe(connB);
    expect(await owner(`select 1 from public.bridge_handovers where status = 'offered'`)).toHaveLength(0);

    await owner(`update public.bridge_connections set status = 'linked' where id = $1`, [connB]);
    for (const admin of [people.asha.member, people.dev.member]) {
      expect((await attention(key(admin)))[0]!.status).toBe('cleared');
    }
  });

  it('the watchdog\'s silent-runtime path raises the same admin item', async () => {
    await owner(`update public.bridge_connections set heartbeat_at = now() - interval '5 minutes', down_since = null where id = $1`, [connB]);
    const tick = await db.rpc<{ runtimeDown: number }>(
      { identityId: people.asha.identity, nodeAdmin: true, requestId: 'wd', backgroundJob: 'bridges.runtime' }, 'internal.bridge_watchdog_tick', []);
    expect(tick.runtimeDown).toBeGreaterThanOrEqual(1);
    const [item] = await attention(`bridge.connection_down:${connB}:${people.dev.member}`);
    expect(item).toMatchObject({ status: 'open' });
    expect(item!.reason).toContain('offline');
    // D19's own item to the number's owner is unchanged.
    expect((await attention(`bridge.runtime_down:${connB}`))[0]).toMatchObject({ status: 'open' });
  });
});
