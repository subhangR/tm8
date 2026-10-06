/**
 * 308 and 309 — P0b's row migrations, run the way production runs them: the
 * chain up to 307 is applied, legacy rows are seeded exactly as the old code
 * wrote them (the CLI's created_in claim, spawn's relates_to duplicate), and
 * only then do 308 and 309 apply. Pinned here:
 *   - every created_in row becomes authored_from (origin=client_claim kept),
 *     created_in refuses new rows, and no story loses an entity;
 *   - the walk follows authored_from, but never from a message;
 *   - the server records authored_from only for a live session's own teammate;
 *   - the session's teammate is participates_in only: spawn stops the
 *     duplicate, 309 deletes old duplicates and rewrites a lone one;
 *   - both batches revert to the exact stored rows.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'canonical-edges-rows-owner';
const ROW_MIGRATIONS = ['308_canonical_edges_rows.sql', '309_session_teammate_participates_only.sql'];

let database: W1ScratchDatabase;
const id: Record<string, string> = {};

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [IDENTITY]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

const one = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  asOwner(async (c) => (await c.query(sql, params)).rows[0]?.v as T);

const edge = (src: string, type: string, dst: string, writer?: string): Promise<void> =>
  asOwner(async (c) => {
    if (writer) await c.query(`select internal.w1_set_writer($1)`, [writer]);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,$4,$5)`,
      [id['space'], src, dst, type, id['member']]);
    if (writer) await c.query(`select internal.w1_set_writer(null)`);
  });

const edgeTypes = async (src: string, dst: string): Promise<string[]> =>
  asOwner(async (c) => (await c.query<{ type: string }>(
    `select type from public.edges where src_id = $1 and dst_id = $2 order by type`, [src, dst])).rows.map((r) => r.type));

const subgraph = async (storyId: string): Promise<string[]> =>
  asOwner(async (c) => (await c.query<{ k: string }>(
    `select entity_id::text || '@' || root_id::text k from internal.story_trail($1)`, [storyId])).rows.map((r) => r.k).sort());

const edgeRows = async (ids: string[]): Promise<unknown[]> =>
  asOwner(async (c) => (await c.query(
    `select id, type, src_id, dst_id, props from public.edges
      where src_id = any($1::uuid[]) or dst_id = any($1::uuid[]) order by id`, [ids])).rows);

const revert = async (batch: string): Promise<number> =>
  database.transaction(async (c) => Number((await c.query(`select internal.revert_edge_migration($1) v`, [batch])).rows[0]?.v));

async function spawn(title: string, taskIds: string[]): Promise<string> {
  return asApp(async (c) => (await c.query<{ v: { entity: { id: string } } }>(
    `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => $3::uuid[],
       p_workdir_mode => 'scratch', p_title => $4, p_client_mutation_id => $5) v`,
    [id['space'], id['persona'], taskIds, title, `rows-${randomUUID()}`])).rows[0]!.v.entity.id);
}

describe('308/309 canonical edge rows', () => {
  let storyBefore: string[];
  let rowsBefore: unknown[];
  let touched: string[];

  beforeAll(async () => {
    database = await createW1ScratchDatabase('canonical_rows');
    const files = migrationFiles();
    database.apply(files.filter((f) => !ROW_MIGRATIONS.includes(f) && f < '308'));

    await asOwner(async (c) => {
      const names = ['space', 'member', 'persona', 'story', 'root', 'made', 'byMember', 'message', 'loneSession'];
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [names.length])).rows[0]!.ids;
      names.forEach((n, i) => { id[n] = ids[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'owner')`, [IDENTITY]);
      await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'rows-owner')`,
        [randomUUID(), IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'rows', $2)`,
        [id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'member', $1, 'space')`, [id['member'], id['space']]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, 'owner', 'Owner')`, [id['member'], id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'team_member', $3, 'space')`, [id['persona'], id['space'], id['member']]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
                     values ($1, $2, 'Rows Agent', 'worker', 'persona')`, [id['persona'], id['member']]);

      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,'task',0,$3)`,
        [id['root'], id['space'], id['member']]);
      await c.query(`insert into public.tasks(entity_id, title) values ($1, 'root')`, [id['root']]);
      // `made` is the persona's own doc (an agent made it); `byMember` is a human's.
      for (const [key, by] of [['made', 'persona'], ['byMember', 'member']] as const) {
        await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,'doc',1,$3)`,
          [id[key], id['space'], id[by]]);
        await c.query(`insert into public.documents(entity_id, title, body, format) values ($1,$2,'x','markdown')`,
          [id[key], key]);
      }
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,'story',2,$3)`,
        [id['story'], id['space'], id['member']]);
      await c.query(`insert into public.stories(entity_id, title) values ($1, 'story')`, [id['story']]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'message', $3, 'space')`, [id['message'], id['space'], id['persona']]);
    });
    await edge(id['story']!, 'contains', id['root']!);

    // Legacy data, as the pre-308 code wrote it.
    id['session'] = await spawn('worker', [id['root']!]);
    expect(await edgeTypes(id['session']!, id['persona']!)).toEqual(['relates_to']); // spawn's duplicate
    await edge(id['made']!, 'created_in', id['session']!); // the CLI's claim
    await edge(id['message']!, 'authored_from', id['session']!, 'message_recorder');
    // A session whose teammate was only ever recorded as relates_to.
    id['loneSession'] = await spawn('lone', []);
    // An ended session (a live one must keep a participant), like the old rows.
    await asApp(async (c) => c.query(`select public.work_session_transition($1,'failed',null,null,null,$2,'crashed',null)`,
      [id['loneSession'], `rows-${randomUUID()}`]));
    await asOwner(async (c) => {
      await c.query(`delete from public.edges where type = 'participates_in' and dst_id = $1`, [id['loneSession']]);
    });

    touched = [id['story']!, id['root']!, id['made']!, id['session']!, id['persona']!, id['message']!, id['loneSession']!];
    storyBefore = await subgraph(id['story']!);
    rowsBefore = await edgeRows(touched);
    expect(storyBefore).toContain(`${id['made']}@${id['root']}`); // reached over created_in

    database.apply(ROW_MIGRATIONS);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('created_in becomes authored_from, keeping origin=client_claim, and refuses new rows', async () => {
    expect(await edgeTypes(id['made']!, id['session']!)).toEqual(['authored_from']);
    expect(await one(`select props->>'origin' v from public.edges where src_id = $1 and type = 'authored_from'`,
      [id['made']])).toBe('client_claim');
    expect(Number(await one(`select count(*) v from public.edges where type = 'created_in'`))).toBe(0);
    await expect(edge(id['byMember']!, 'created_in', id['session']!)).rejects.toThrow(/deprecated; use authored_from/);
  });

  it('no story loses an entity, and the walk never follows a message', async () => {
    expect(await subgraph(id['story']!)).toEqual(storyBefore);
    expect((await subgraph(id['story']!)).some((k) => k.startsWith(`${id['message']}@`))).toBe(false);
    expect(Number(await database.query<{ v: string }>(
      `select count(*) v from internal.edge_migration_story_diff where batch = 'p0b-308' and change = 'removed'`)
      .then((r) => r[0]?.v))).toBe(0);
  });

  it('the server records authored_from for a live session\'s own teammate only', async () => {
    const recorded = await asApp(async (c) => (await c.query(
      `select public.record_authored_from($1, $2) v`, [id['byMember'], id['session']])).rows[0]?.v);
    expect(recorded).toBeNull(); // a human made it
    const doc = await asOwner(async (c) => {
      const d = (await c.query<{ v: string }>(`select internal.new_id() v`)).rows[0]!.v;
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,'doc',3,$3)`,
        [d, id['space'], id['persona']]);
      await c.query(`insert into public.documents(entity_id, title, body, format) values ($1,'new','x','markdown')`, [d]);
      return d;
    });
    const edgeRowId = await asApp(async (c) => (await c.query(
      `select public.record_authored_from($1, $2) v`, [doc, id['session']])).rows[0]?.v);
    expect(edgeRowId).toBeTruthy();
    expect(await one(`select props->>'origin' v from public.edges where id = $1`, [edgeRowId])).toBe('entity_recorder');
    // One per source: a second call answers the same row.
    expect(await asApp(async (c) => (await c.query(
      `select public.record_authored_from($1, $2) v`, [doc, id['session']])).rows[0]?.v)).toBe(edgeRowId);
  });

  it('the session\'s teammate is participates_in only', async () => {
    expect(await edgeTypes(id['session']!, id['persona']!)).toEqual([]);
    expect(await edgeTypes(id['persona']!, id['session']!)).toEqual(['participates_in']);
    expect(await edgeTypes(id['persona']!, id['loneSession']!)).toEqual(['participates_in']); // rewritten, not lost
    const fresh = await spawn('after 309', []);
    expect(await edgeTypes(fresh, id['persona']!)).toEqual([]);
    expect(await edgeTypes(id['persona']!, fresh)).toEqual(['participates_in']);
    // A hand-drawn see-also derives nothing any more.
    await edge(fresh, 'relates_to', id['byMember']!);
    expect(Number(await one(`select count(*) v from public.edges where type = 'participates_in' and dst_id = $1`,
      [fresh]))).toBe(1);
  });

  it('no SQL function reads relates_to as the session\'s teammate', async () => {
    const readers = await asOwner(async (c) => (await c.query<{ f: string }>(
      `select p.proname f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'internal') and p.prosrc ~ '''relates_to'''
          and p.proname in ('execution_spawn', 'execution_resume', 'repoint_session_space_credentials',
                            'issue_work_session_agent_session')`)).rows.map((r) => r.f));
    expect(readers).toEqual([]);
  });

  it('both batches revert to the exact stored rows', async () => {
    expect(await revert('p0b-309')).toBeGreaterThan(0);
    expect(await revert('p0b-308')).toBeGreaterThan(0);
    // Edges written after the migrations (the fresh spawn, the recorded doc)
    // are not the migrations' to undo; every row that existed before is back.
    const beforeIds = new Set((rowsBefore as { id: string }[]).map((r) => r.id));
    const after = (await edgeRows(touched)).filter((r) => beforeIds.has((r as { id: string }).id));
    expect(after).toEqual(rowsBefore);
  });
});
