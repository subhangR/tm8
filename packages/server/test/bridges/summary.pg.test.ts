/**
 * Bridges S (§7.3 S, D73, D74) against a scratch database with every migration
 * applied: a group chat whose bridge log holds 2,000 messages gets a group
 * record within budget that still names the open asks; the fold is stored
 * (migration 410) and moves forward only; members see it on `bridges.get`;
 * who is on what comes live from `authored_from → bridge` tasks.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BridgeDetailView } from '@tm8/contract';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerBridgeHandlers } from '../../src/bridges/handlers.js';
import { canonicalJson, projectHistory } from '../../src/chat/continuity.js';
import { GROUP_CONTEXT_MAX_BYTES, TAIL_MESSAGES, readGroupContext } from '../../src/bridges/summary.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, base: string;
const space = randomUUID(), member = randomUUID(), account = randomUUID(), persona = randomUUID();
const chat = randomUUID(), plainChat = randomUUID(), connection = randomUUID(), task = randomUUID();
const identityId = `bridges-summary-owner-${randomUUID()}`;
const secret = generateSecret(), tokenId = randomUUID(), token = formatToken(tokenId, secret);
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });
const claims: DbClaims = { identityId, authKind: 'cli', sessionSpaceId: space };
const people = ['Asha', 'Ben', 'Chen', 'Dara', 'Eli'];
let bridgeId = '';
let seq = 0;

beforeAll(async () => {
  database = await createW1ScratchDatabase('bridges_summary');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identityId]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identityId]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Summary fixture',$2)", [space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Ben Owner')",
      [member, space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'team_member',0,$3)", [persona, space, member]);
    await c.query("insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Infra','','persona')", [persona, member]);
    for (const [id, title] of [[chat, 'Infra main'], [plainChat, 'Plain']] as const) {
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'chat',0,$3)", [id, space, member]);
      await c.query(`insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
          chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id)
        values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/s', gen_random_uuid(), $5, $6, $7)`,
        [id, space, title, persona, identityId, member, `s-${randomUUID()}`]);
    }
    await c.query(`insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at)
      values ($1,$2,'cli',$3,$4,now()+interval '1 hour')`, [tokenId, account, space, hashToken(secret)]);
    await c.query(`insert into public.bridge_connections(id, provider, owner_account_id, label, status)
      values ($1,'whatsapp',$2,'+91 …9494','linked')`, [connection, account]);
  });
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  registerBridgeHandlers(registry, { db, config, owner });
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
  const created = await call('POST', `/v2/spaces/${space}/bridges`, { clientMutationId: randomUUID(), connectionId: connection,
    targetId: chat, conversation: { externalId: 'infra@g.us', kind: 'group', title: 'Infra' }, teammateId: persona, purpose: 'Infra on-call' });
  bridgeId = created.id;
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const name of people) {
      await c.query(`insert into public.bridge_participants(bridge_id, external_id, display_name, first_seen_at, last_seen_at, message_count)
        values ($1,$2,$3,now(),now(),0)`, [bridgeId, `${name.toLowerCase()}@s.whatsapp.net`, name]);
    }
  });
});
afterAll(async () => {
  await server?.close();
  await db?.end();
  await database?.destroy();
});

async function call(method: string, path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as any;
  expect([200, 201], JSON.stringify(json)).toContain(response.status);
  return json.data;
}

/** Inbound log messages: asks every 40th, every other one answered in its thread, long pastes now and then. */
async function post(count: number): Promise<void> {
  const rows: { id: string; body: string; sender: string; parent: string | null; at: string }[] = [];
  const ids = new Map<number, string>();
  for (let n = 0; n < count; n += 1) {
    const i = seq++;
    const id = randomUUID();
    ids.set(i, id);
    const sender = `${people[i % people.length]!.toLowerCase()}@s.whatsapp.net`;
    const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
    let body = `chatter ${i} about lunch`;
    let parent: string | null = null;
    if (i === 3) body = 'Can someone rotate the staging database password before Friday?';
    else if (i % 40 === 0) body = `question ${i}: who can look at the flaky deploy ${i}?`;
    else if (i % 80 === 1 && ids.has(i - 1)) { body = `on it, deploy ${i - 1} is fixed`; parent = ids.get(i - 1)!; }
    else if (i % 97 === 0) body = `log paste ${'x'.repeat(5000)}`;
    rows.push({ id, body, sender, parent, at });
  }
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const replies of [false, true]) {
      const batch = rows.filter(r => (r.parent !== null) === replies);
      if (!batch.length) continue;
      await c.query(`insert into public.entities(id,space_id,kind,parent_id,position,created_by)
        select id, $1, 'message', parent, null, $2 from unnest($3::uuid[], $4::uuid[]) r(id, parent)`,
        [space, member, batch.map(r => r.id), batch.map(r => r.parent)]);
      await c.query(`insert into public.messages(entity_id,anchor_id,root_message_id,author_id,body,created_at)
        select id, $1, parent, $2, body, at from unnest($3::uuid[], $4::uuid[], $5::text[], $6::timestamptz[]) r(id, parent, body, at)`,
        [bridgeId, member, batch.map(r => r.id), batch.map(r => r.parent), batch.map(r => r.body), batch.map(r => r.at)]);
      await c.query(`insert into public.message_origins(message_id,bridge_id,connection_id,direction,external_message_id,
          external_conversation_id,external_sender_id)
        select id, $1, $2, 'in', id::text, 'infra@g.us', sender from unnest($3::uuid[], $4::text[]) r(id, sender)`,
        [bridgeId, connection, batch.map(r => r.id), batch.map(r => r.sender)]);
    }
  });
}

describe('bridge rolling summary (S)', () => {
  it('a chat with no bridge gets no group record', async () => {
    expect(await readGroupContext(db, claims, plainChat, 16_384)).toBeNull();
  });

  it('2,000 messages: the group record stays within budget and still names open asks; the fold is stored', async () => {
    await post(2000);
    const budget = 32_768;
    const groupMax = Math.min(GROUP_CONTEXT_MAX_BYTES, budget / 2);
    const group = await readGroupContext(db, claims, chat, groupMax);
    expect(group).not.toBeNull();
    expect(Buffer.byteLength(canonicalJson(group!.content), 'utf8')).toBeLessThanOrEqual(groupMax);
    const text = canonicalJson(group!.content);
    expect(text).toContain('rotate the staging database password');
    expect(text).toContain('question 1960: who can look at the flaky deploy 1960?');
    expect(text).toContain('chatter 1999 about lunch');
    const projected = projectHistory([], { snapshotId: 's', currentTurnOrdinal: 1, captureHighWater: 0,
      authorityScopeDigest: 'a', maxBytes: budget, groupContext: group });
    expect(Buffer.byteLength(projected.renderedContext, 'utf8')).toBeLessThanOrEqual(budget);

    const [row] = await database.transaction(async c => (await c.query(
      'select covered_messages, through_message_id, state from public.bridge_chat_summaries where bridge_id = $1', [bridgeId])).rows);
    expect(row.covered_messages).toBe(2000 - TAIL_MESSAGES);
    expect(row.state.openAsks.map((a: { excerpt: string }) => a.excerpt)).toContain('Can someone rotate the staging database password before Friday?');
    expect(row.state.participants.map((p: { name: string }) => p.name).sort()).toEqual([...people].sort());
  });

  it('below the threshold nothing folds; past it the fold moves on from its cursor', async () => {
    await post(10);
    await readGroupContext(db, claims, chat, 16_384);
    const covered = async () => (await database.transaction(async c => (await c.query(
      'select covered_messages from public.bridge_chat_summaries where bridge_id = $1', [bridgeId])).rows))[0].covered_messages;
    expect(await covered()).toBe(2000 - TAIL_MESSAGES);
    await post(60);
    await readGroupContext(db, claims, chat, 16_384);
    expect(await covered()).toBe(2070 - TAIL_MESSAGES);
  });

  it('a store from a stale cursor never moves the summary backwards', async () => {
    const stored = await db.tx(claims, q => q.rpc<boolean>('public.store_bridge_chat_summary',
      [bridgeId, null, null, 0, 'tm8-bridge-summary-v1', '{}', 'f'.repeat(64)]));
    expect(stored).toBe(false);
  });

  it('members see the summary and who is on what on bridges.get (D74)', async () => {
    await database.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'task',0,$3)", [task, space, member]);
      await c.query("insert into public.tasks(entity_id,title,work_status) values($1,'Rotate staging password','working')", [task]);
      await c.query("insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'assigned_to',$3)", [space, task, member]);
      await c.query(`select internal.w1_set_writer('message_recorder')`);
      await c.query(`insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
        values($1,$2,$3,'authored_from',jsonb_build_object('bridgeId',$3::text),$4)`, [space, task, bridgeId, member]);
      await c.query(`select internal.w1_set_writer(null)`);
    });
    const view: BridgeDetailView = await call('GET', `/v2/bridges/${bridgeId}`);
    expect(view.summary).not.toBeNull();
    expect(view.summary!.coveredMessages).toBe(2070 - TAIL_MESSAGES);
    expect(view.summary!.unsummarizedMessages).toBe(TAIL_MESSAGES);
    expect(view.summary!.state.openAsks.some(a => a.excerpt.includes('rotate the staging database password'))).toBe(true);
    expect(view.summary!.onWhat).toEqual([{ taskId: task, title: 'Rotate staging password', status: 'working', assignees: ['Ben Owner'] }]);
  });
});
