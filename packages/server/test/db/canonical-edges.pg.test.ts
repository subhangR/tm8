/**
 * 303 against a real Postgres: canonical edges (P0b, task 01a10c66; Design
 * Rules 01a10c5d §2.3; inventory doc 01a111b8-74a1).
 *
 * What this pins:
 *   - the registry says what every type means; `follows_up` joins two tasks or
 *     two sessions, acyclic; `produces` reaches files and drawings; a
 *     deprecated type (`dispatched_by`) refuses new rows and names what
 *     replaces it;
 *   - the story walk follows ONE list (internal.story_followed_edge_types),
 *     and STORY_FOLLOWED_EDGE_TYPES in the contract mirrors it exactly;
 *   - spawn writes `participates_in` itself, and the agent token is issued to
 *     the participating teammate with no relates_to row at all;
 *   - a deleted story walks and counts nothing, and keeps its roots so a
 *     restore is lossless;
 *   - THE MIGRATION CONTRACT (owner, doc 01a10c5d message 8): moving a legacy
 *     edge to its canonical type through internal.migrate_edge leaves every
 *     story's subgraph exactly as it was, except a difference named in
 *     advance, and every batch replays backwards to the original rows.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { STORY_FOLLOWED_EDGE_TYPES } from '@tm8/contract';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'canonical-edges-owner';

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

/** Insert an edge as the graph owner; the registry triggers still run. */
const edge = (src: string, type: string, dst: string): Promise<void> =>
  asOwner(async (c) => {
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,$4,$5)`,
      [id['space'], src, dst, type, id['member']]);
  });

const edgeId = (src: string, type: string, dst: string): Promise<string | undefined> =>
  one(`select id::text v from public.edges where src_id=$1 and type=$2 and dst_id=$3`, [src, type, dst]);

/** A story's subgraph as a sorted set of `entity@root`: what membership means. */
const subgraph = async (storyId: string): Promise<string[]> =>
  asOwner(async (c) => (await c.query<{ k: string }>(
    `select entity_id::text || '@' || root_id::text k from internal.story_trail($1)`, [storyId])).rows.map((r) => r.k).sort());

/** Every edge touching these entities, exactly as stored. */
const edgeRows = async (ids: string[]): Promise<unknown[]> =>
  asOwner(async (c) => (await c.query(
    `select id, type, src_id, dst_id, props from public.edges
      where src_id = any($1::uuid[]) or dst_id = any($1::uuid[]) order by id`, [ids])).rows);

/** As the migration owner: migrate_edge and revert_edge_migration are granted to no runtime role. */
const asMigrator = async <T>(sql: string, params: unknown[]): Promise<T> =>
  database.transaction(async (c) => (await c.query(sql, params)).rows[0]?.v as T);
const migrate = (batch: string, rule: string, edgeRowId: string, type: string | null, src: string | null, dst: string | null) =>
  asMigrator<string>(`select internal.migrate_edge($1,$2,$3,$4,$5,$6) v`, [batch, rule, edgeRowId, type, src, dst]);
const revert = (batch: string) => asMigrator<number>(`select internal.revert_edge_migration($1) v`, [batch]);

async function spawn(title: string, taskIds: string[]): Promise<string> {
  return asApp(async (c) => (await c.query<{ v: { entity: { id: string } } }>(
    `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => $3::uuid[],
       p_workdir_mode => 'scratch', p_title => $4, p_client_mutation_id => $5) v`,
    [id['space'], id['persona'], taskIds, title, `canon-${randomUUID()}`])).rows[0]!.v.entity.id);
}

describe('303 canonical edges', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('canonical_edges');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const names = ['space', 'member', 'persona', 'story', 'root', 'output', 'input', 'spec', 'origin', 'followUp',
        'deadStory', 'deadRoot', 'mergeTask', 'mergeDoc'];
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [names.length])).rows[0]!.ids;
      names.forEach((n, i) => { id[n] = ids[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'owner')`, [IDENTITY]);
      await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'canon-owner')`,
        [randomUUID(), IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'canon', $2)`,
        [id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'member', $1, 'space')`, [id['member'], id['space']]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, 'owner', 'Owner')`, [id['member'], id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'team_member', $3, 'space')`, [id['persona'], id['space'], id['member']]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
                     values ($1, $2, 'Canon Agent', 'worker', 'persona')`, [id['persona'], id['member']]);

      let pos = 0;
      const entity = async (key: string, kind: string) => {
        await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,$3,$4,$5)`,
          [id[key], id['space'], kind, pos++, id['member']]);
      };
      for (const key of ['root', 'origin', 'followUp', 'deadRoot', 'mergeTask']) {
        await entity(key, 'task');
        await c.query(`insert into public.tasks(entity_id, title) values ($1, $2)`, [id[key], key]);
      }
      for (const key of ['output', 'input', 'spec', 'mergeDoc']) {
        await entity(key, 'doc');
        await c.query(`insert into public.documents(entity_id, title, body, format) values ($1,$2,'x','markdown')`,
          [id[key], key]);
      }
      for (const key of ['story', 'deadStory']) {
        await entity(key, 'story');
        await c.query(`insert into public.stories(entity_id, title) values ($1, $2)`, [id[key], key]);
      }
    });
    await edge(id['story']!, 'contains', id['root']!);
    await edge(id['deadStory']!, 'contains', id['deadRoot']!);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('every registered edge type has a plain one-line meaning', async () => {
    const missing = await asOwner(async (c) => (await c.query(
      `select type from public.edge_types
        where description is null or description in ('', 'placeholder') or description like '%' || chr(10) || '%'`)).rows);
    expect(missing).toEqual([]);
  });

  it('produces reaches every deliverable kind of Design Rules §2.3', async () => {
    const kinds = await one<string[]>(`select dst_kinds v from public.edge_types where type = 'produces'`);
    expect(kinds).toEqual(expect.arrayContaining(['doc', 'artifact', 'file', 'drawing']));
  });

  it('follows_up joins two tasks, refuses a cycle and refuses mixed kinds', async () => {
    await edge(id['followUp']!, 'follows_up', id['origin']!);
    expect(await edgeId(id['followUp']!, 'follows_up', id['origin']!)).toBeTruthy();
    await expect(edge(id['origin']!, 'follows_up', id['followUp']!)).rejects.toThrow(/cycle/i);
    const session = await spawn('follows_up kinds', [id['origin']!]);
    await expect(edge(id['followUp']!, 'follows_up', session)).rejects.toThrow(/never one of each/);
  });

  it('a deprecated type refuses new rows and names its replacement', async () => {
    expect(await one(`select replaced_by v from public.edge_types where type = 'dispatched_by'`)).toBe('parentId');
    const a = await spawn('dispatcher', [id['origin']!]);
    const b = await spawn('dispatched', [id['origin']!]);
    await expect(edge(b, 'dispatched_by', a)).rejects.toThrow(/deprecated; use parentId/);
  });

  it('the story walk follows one list, and the contract mirror agrees with it', async () => {
    const sqlList = await one<string[]>(`select internal.story_followed_edge_types() v`);
    const tsList = STORY_FOLLOWED_EDGE_TYPES.filter((t) => t !== 'parent');
    expect([...tsList].sort()).toEqual([...sqlList].sort());
    expect(sqlList).not.toContain('dispatched_by');
    expect(sqlList).not.toContain('relates_to');
  });

  it('spawn writes participates_in itself, and the agent token needs no relates_to', async () => {
    const session = await spawn('participant', [id['origin']!]);
    expect(await one(`select props->>'origin' v from public.edges
                       where type = 'participates_in' and src_id = $1 and dst_id = $2`, [id['persona'], session])).toBe('spawn');
    // 309: spawn no longer writes the legacy relates_to duplicate.
    expect(Number(await one(`select count(*) v from public.edges where type = 'relates_to' and src_id = $1`, [session]))).toBe(0);
    const issued = await asApp(async (c) => (await c.query(
      `select public.issue_work_session_agent_session($1, $2, $3, now() + interval '1 hour') v`,
      [session, id['persona'], 'a'.repeat(64)])).rows[0]?.v);
    expect(issued).toBeTruthy();
  });

  it('a deleted story walks and counts nothing, and a restore brings its roots back', async () => {
    const before = await subgraph(id['deadStory']!);
    expect(before).toContain(`${id['deadRoot']}@${id['deadRoot']}`);
    const setDeleted = (deleted: boolean) => asOwner(async (c) => {
      await c.query(`update public.entities set deleted_at = ${deleted ? 'now()' : 'null'} where id = $1`, [id['deadStory']]);
    });
    await setDeleted(true);
    expect(await subgraph(id['deadStory']!)).toEqual([]);
    expect(Number(await one(`select count(*) v from internal.story_work($1)`, [id['deadStory']]))).toBe(0);
    expect(Number(await one(`select count(*) v from public.edges where src_id = $1 and type = 'contains'`,
      [id['deadStory']]))).toBe(1);
    await setDeleted(false);
    expect(await subgraph(id['deadStory']!)).toEqual(before);
  });

  it('moving legacy edges to canonical types keeps the story subgraph, and reverts exactly', async () => {
    // The root task has: an output doc filed the legacy way (doc attached_to
    // task), an input doc (stays attached_to), a session working on it
    // (participates_in plus the legacy relates_to duplicate), and a spec doc
    // linked by relates_to task -> doc that really is the task's deliverable.
    await edge(id['output']!, 'attached_to', id['root']!);
    await edge(id['input']!, 'attached_to', id['root']!);
    await edge(id['root']!, 'relates_to', id['spec']!);
    const session = await spawn('worker', [id['root']!]);
    // The legacy duplicate a pre-309 spawn wrote, as it sits in old data.
    await edge(session, 'relates_to', id['persona']!);
    const touched = [id['story']!, id['root']!, id['output']!, id['input']!, id['spec']!, session, id['persona']!];
    const rowsBefore = await edgeRows(touched);
    const before = await subgraph(id['story']!);
    expect(before).toEqual(expect.arrayContaining([`${id['output']}@${id['root']}`, `${session}@${id['root']}`]));

    // Batch 1: moves that must not change membership.
    const b1 = `test-${randomUUID()}`;
    expect(await migrate(b1, 'R1 output', (await edgeId(id['output']!, 'attached_to', id['root']!))!,
      'produces', id['root']!, id['output']!)).toBe('rewritten');
    expect(await migrate(b1, 'duplicate of participates_in', (await edgeId(session, 'relates_to', id['persona']!))!,
      null, null, null)).toBe('deleted');
    expect(await subgraph(id['story']!)).toEqual(before);
    expect(await edgeId(id['root']!, 'produces', id['output']!)).toBeTruthy();
    expect(await edgeId(id['input']!, 'attached_to', id['root']!)).toBeTruthy();

    // Batch 2: relates_to was never walked, so making the spec a deliverable
    // ADDS exactly that doc, the one difference the owner accepts in advance.
    const b2 = `test-${randomUUID()}`;
    await migrate(b2, 'R1 output', (await edgeId(id['root']!, 'relates_to', id['spec']!))!, 'produces', id['root']!, id['spec']!);
    const after = await subgraph(id['story']!);
    expect(after.filter((k) => !before.includes(k))).toEqual([`${id['spec']}@${id['root']}`]);
    expect(before.filter((k) => !after.includes(k))).toEqual([]);

    // Every move is logged, and a batch replays backwards to the original rows.
    expect(Number(await asMigrator(`select count(*) v from internal.edge_migration_log where batch = $1`, [b1]))).toBe(2);
    expect(await revert(b2)).toBe(1);
    expect(await revert(b1)).toBe(2);
    expect(await edgeRows(touched)).toEqual(rowsBefore);
    expect(await subgraph(id['story']!)).toEqual(before);
  });

  it('migrate_edge merges into an existing canonical row instead of duplicating it', async () => {
    await edge(id['mergeDoc']!, 'attached_to', id['mergeTask']!);
    await edge(id['mergeTask']!, 'produces', id['mergeDoc']!);
    const b = `test-${randomUUID()}`;
    expect(await migrate(b, 'R1 output', (await edgeId(id['mergeDoc']!, 'attached_to', id['mergeTask']!))!,
      'produces', id['mergeTask']!, id['mergeDoc']!)).toBe('merged');
    expect(await edgeId(id['mergeDoc']!, 'attached_to', id['mergeTask']!)).toBeUndefined();
    expect(await revert(b)).toBe(1);
    expect(await edgeId(id['mergeDoc']!, 'attached_to', id['mergeTask']!)).toBeTruthy();
  });
});
