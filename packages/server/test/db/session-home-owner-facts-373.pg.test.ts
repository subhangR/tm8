/**
 * 373 against a real Postgres: `public.session_home_owner_facts`, the read the
 * session artifact reclaim asks before it removes a space-key home whose id
 * 372 did not answer for.
 *
 * That directory is keyed by a work session OR a chat, so the property that
 * matters is the one that keeps a chat's transcripts: an entity of any kind is
 * reported, deleted or not, to a node admin who is NOT a member of its space
 * (an RLS-scoped read would hide it and the reclaim would take it for an
 * orphan). Also pinned: only a node admin may call it, an unknown id is simply
 * absent, and a call is bounded.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface OwnerFact {
  id: string;
  kind: string;
  deleted: boolean;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

const OWNER = 'owner-facts-373-owner';
const ADMIN_ELSEWHERE = 'owner-facts-373-node-admin';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

let database: W1ScratchDatabase;
let spaceId: string;
let chatId: string;
let deletedChatId: string;
let memberId: string;

async function seed(db: W1ScratchDatabase): Promise<void> {
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<{ space: string; member: string; chat: string; gone: string }>(
        `select internal.new_id()::text space, internal.new_id()::text member,
                internal.new_id()::text chat, internal.new_id()::text gone`,
      )
    ).rows[0]!;
    spaceId = ids.space;
    memberId = ids.member;
    chatId = ids.chat;
    deletedChatId = ids.gone;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Owner')`, [OWNER]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Owner facts',$2)`, [
      spaceId,
      OWNER,
    ]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$4,'member',null,0,$1),($2,$4,'chat',null,1,$1),($3,$4,'chat',null,2,$1)`,
      [memberId, chatId, deletedChatId, spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Owner')`,
      [memberId, spaceId, OWNER],
    );
    await client.query(`update public.entities set deleted_at = now() where id = $1`, [deletedChatId]);
  });
}

async function asApp<T>(fn: (q: Q) => Promise<T>, identityId: string, nodeAdmin: boolean): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin',$2,true),set_config('tm8.request_id','req-373',true),
              set_config('tm8.work_session_id','',true)`,
      [identityId, nodeAdmin ? 'true' : 'false'],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function owners(ids: string[], identityId = ADMIN_ELSEWHERE, nodeAdmin = true): Promise<OwnerFact[]> {
  const rows = await asApp(
    (q) => q(`select public.session_home_owner_facts($1::uuid[]) result`, [ids]),
    identityId,
    nodeAdmin,
  );
  return rows[0]!.result as OwnerFact[];
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('owner-facts-373');
  database.apply(migrationFiles());
  await seed(database);
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('373 — session_home_owner_facts', () => {
  it('reports a chat, deleted or not, to a node admin outside its space, where RLS would hide it', async () => {
    const visible = await asApp(
      (q) => q(`select id from public.entities where id = $1`, [chatId]),
      ADMIN_ELSEWHERE,
      true,
    );
    expect(visible).toEqual([]);

    const rows = new Map((await owners([chatId, deletedChatId, UNKNOWN])).map((row) => [row.id, row]));
    expect(rows.size).toBe(2);
    expect(rows.has(UNKNOWN)).toBe(false);
    expect(rows.get(chatId)).toEqual({ id: chatId, kind: 'chat', deleted: false });
    expect(rows.get(deletedChatId)).toEqual({ id: deletedChatId, kind: 'chat', deleted: true });
  });

  it('refuses anyone who is not a node admin, the space owner included', async () => {
    await expect(owners([chatId], OWNER, false)).rejects.toMatchObject({ code: '42501' });
  });

  it('bounds a call at 1000 ids and answers an empty list with an empty array', async () => {
    const many = Array.from({ length: 1001 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await expect(owners(many)).rejects.toMatchObject({ code: '22023' });
    expect(await owners([])).toEqual([]);
  });
});
