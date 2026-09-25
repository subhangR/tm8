/**
 * `spaces.chatDefaults.get` / `.set` against a REAL PostgreSQL (entity-chat
 * design 01a0da4e §3.4, migration 229).
 *
 * The handlers are registered as the facade registers them and run as
 * `tm8_app` under the caller's claims. What must hold:
 *   · an empty space reads `{}` at revision 0;
 *   · set is a PATCH over kinds: a named kind is replaced, `null` clears it,
 *     unnamed kinds survive; a write that changes nothing keeps the revision;
 *   · the gate is `interactionProfile.setDefault`'s: a plain member may READ
 *     but not WRITE; a non-member may do neither;
 *   · validation: never `message`/`chat`, a teammate must be a live teammate
 *     of THIS space, no unknown fields.
 */
import { randomUUID } from 'node:crypto';

import type { ChatDefaultsView } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerChatDefaultsHandlers } from '../../src/chat/defaults.js';
import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'chatdef-owner';
const MEMBER = 'chatdef-member';
const STRANGER = 'chatdef-stranger';

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};
type Client = import('pg').PoolClient;

const newId = async (c: Client): Promise<string> => (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function member(c: Client, space: string, identity: string, role: 'owner' | 'member'): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [id, space]);
  await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`, [id, space, identity, role]);
  return id;
}
async function space(c: Client, name: string, identity: string): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, name, identity]);
  ids[`member:${id}`] = await member(c, id, identity, 'owner');
  return id;
}
async function teammate(c: Client, spaceId: string, name: string): Promise<string> {
  const id = await newId(c);
  await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'team_member', 0, $3)`, [id, spaceId, ids[`member:${spaceId}`]]);
  await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity) values ($1, $2, $3, '', 'persona')`, [id, ids[`member:${spaceId}`], name]);
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_chat_defaults');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Member'), ($3, 'Stranger')`, [OWNER, MEMBER, STRANGER]);
    ids.space = await space(c, 'Chat defaults', OWNER);
    await member(c, ids.space, MEMBER, 'member');
    ids.elsewhere = await space(c, 'Elsewhere', STRANGER);
    ids.draco = await teammate(c, ids.space, 'Draco');
    ids.foreign = await teammate(c, ids.elsewhere, 'Foreign');
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

function registry(identity: string): HandlerRegistry {
  const r = new HandlerRegistry();
  registerChatDefaultsHandlers(r, { db, config: {}, owner: async () => ({ identityId: identity, isNodeAdmin: false }) } as unknown as FacadeDeps);
  return r;
}
function ctx(body: unknown, spaceId: string): RequestContext {
  return {
    params: { spaceId }, query: new URLSearchParams(), body, requestId: randomUUID(),
    identity: { kind: 'loopback' }, headers: {}, method: 'PUT', path: '/',
  } as unknown as RequestContext;
}
const get = (identity = OWNER, spaceId = ids.space!): Promise<ChatDefaultsView> =>
  registry(identity).get('spaces.chatDefaults.get')!(ctx(undefined, spaceId)) as Promise<ChatDefaultsView>;
const set = (defaults: unknown, identity = OWNER, spaceId = ids.space!): Promise<ChatDefaultsView> =>
  registry(identity).get('spaces.chatDefaults.set')!(ctx({ defaults }, spaceId)) as Promise<ChatDefaultsView>;

describe('spaces.chatDefaults — space-wide per-kind defaults', () => {
  it('an untouched space reads an empty map at revision 0', async () => {
    expect(await get()).toEqual({ spaceId: ids.space, defaults: {}, revision: 0 });
  });

  it('set stores teammate + model per kind, and every member reads the same map', async () => {
    const written = await set({ task: { teammateId: ids.draco, model: 'claude-opus-5-5' }, 'c:bug': { model: 'gpt-5' } });
    expect(written.defaults).toEqual({ task: { teammateId: ids.draco, model: 'claude-opus-5-5' }, 'c:bug': { model: 'gpt-5' } });
    expect(written.revision).toBe(1);
    expect(await get(MEMBER)).toEqual(written);
  });

  it('is a PATCH over kinds: named kinds replaced or cleared, others untouched', async () => {
    const before = await get();
    const after = await set({ doc: { teammateId: ids.draco }, 'c:bug': null });
    expect(after.defaults).toEqual({ task: before.defaults.task, doc: { teammateId: ids.draco } });
    expect(after.revision).toBe(before.revision + 1);
    // An entry with neither field clears too.
    expect((await set({ doc: {} })).defaults).toEqual({ task: before.defaults.task });
  });

  it('a write that changes nothing keeps the revision', async () => {
    const before = await get();
    const again = await set({ task: before.defaults.task });
    expect(again).toEqual(before);
  });

  it('gate: a plain member may read but not write; a non-member may do neither', async () => {
    await expect(set({ task: null }, MEMBER)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(get(STRANGER)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(set({ task: null }, STRANGER)).rejects.toMatchObject({ code: 'forbidden' });
    // The owner's map is intact after the refusals.
    expect((await get()).defaults.task).toEqual({ teammateId: ids.draco, model: 'claude-opus-5-5' });
  });

  it('refuses message/chat kinds, unknown fields, and a teammate from another space', async () => {
    await expect(set({ chat: { model: 'x' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(set({ message: null })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(set({ task: { model: 'x', mode: 'ask' } })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(set({ task: { teammateId: ids.foreign } })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('the SQL door validates on its own, whatever the handler lets through', async () => {
    await expect(db.rpc(
      { identityId: OWNER, nodeAdmin: false, requestId: randomUUID() },
      'set_space_chat_defaults', [ids.space, JSON.stringify({ chat: { model: 'x' } }), null],
    )).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(db.rpc(
      { identityId: OWNER, nodeAdmin: false, requestId: randomUUID() },
      'set_space_chat_defaults', [ids.space, JSON.stringify({ task: { model: 'x', extra: 1 } }), null],
    )).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
