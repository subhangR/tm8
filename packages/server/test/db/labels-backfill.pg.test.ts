/**
 * 410's BACKFILL, against a database that held spaces before 410 ran.
 *
 * `labels.pg.test.ts` seeds its spaces after every migration, so it only ever
 * exercises the owner-arrival trigger. Here the chain stops below 410, spaces
 * are written, then 410 applies: a space with an owner gets `bug` created by
 * that owner; a space with no owner gets it from its earliest member. Also
 * pinned: a non-member reads no `labels` rows and cannot label an entity.
 *
 * Adapted from the B0b reviewer's probe (pass 1).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

let database: W1ScratchDatabase;
let owned: { spaceId: string; memberId: string };
let ownerless: { spaceId: string; memberId: string };

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asApp<T>(identityId: string, fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-397-backfill',true)`,
      [identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seedSpace(identityId: string, name: string, role: 'owner' | 'member'): Promise<{ spaceId: string; memberId: string }> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<{ spaceId: string; memberId: string }>(
      `select internal.new_id()::text "spaceId", internal.new_id()::text "memberId"`)).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,$2) on conflict do nothing`,
      [identityId, name]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,$2,$3)`, [ids.spaceId, name, identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values($1,$2,'member',null,0,$1)`,
      [ids.memberId, ids.spaceId]);
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,$4,$5)`,
      [ids.memberId, ids.spaceId, identityId, role, name]);
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('labels-397-backfill');
  const files = migrationFiles();
  database.apply(files.filter((f) => f < '410'));
  owned = await seedSpace('backfill-owner', 'Pre-397', 'owner');
  ownerless = await seedSpace('backfill-member', 'Ownerless', 'member');
  database.apply(files.filter((f) => f >= '410'));
});

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('410 backfill', () => {
  it('gives every pre-existing space bug, created by its owner or else its earliest member', async () => {
    const rows = await database.query<{ space_id: string; created_by: string; colour: string }>(
      `select l.space_id::text, e.created_by::text, l.colour
         from public.labels l join public.entities e on e.id = l.entity_id where l.name = 'bug'`);
    expect(rows.find((r) => r.space_id === owned.spaceId)).toMatchObject({ created_by: owned.memberId, colour: '#d73a4a' });
    expect(rows.find((r) => r.space_id === ownerless.spaceId)).toMatchObject({ created_by: ownerless.memberId });
  });

  it('a non-member reads no labels and cannot label an entity', async () => {
    const story = await asApp('backfill-owner', async (q) =>
      ((await q(`select public.create_story_entity($1,'x',null,'',null,null,'backfill-story') r`, [owned.spaceId]))[0]!.r as
        { entity: { id: string; version: number } }).entity);
    const bug = (await database.query<{ id: string }>(
      `select entity_id::text id from public.labels where space_id = $1`, [owned.spaceId]))[0]!.id;
    expect(await asApp('backfill-member', (q) => q(`select entity_id from public.labels where space_id = $1`, [owned.spaceId])))
      .toEqual([]);
    await expect(asApp('backfill-member', (q) => q(`select public.set_entity_labels($1,$2,null,array[$3::uuid],'{}','backfill-x')`,
      [story.id, story.version, bug]))).rejects.toMatchObject({ code: '42501' });
  });
});
