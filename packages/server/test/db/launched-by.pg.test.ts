/**
 * 330 against a real Postgres: a launched session records who launched it as
 * a `launched_by` edge, never as its parent (task 01a14a9e).
 *
 * What this pins:
 *   - execution_spawn writes `launched_by` (session -> chat or session) and
 *     leaves parent_id null, so a chat has no cross-kind children;
 *   - only the server writes the edge, at most one per session, and
 *     `dispatched_by` now names `launched_by` as its replacement;
 *   - the lineage readers read the edge: record_authored_from and
 *     session_anchor_ids (the autoclose guard is pinned in
 *     session-outcome-301.pg.test.ts);
 *   - THE MIGRATION: legacy rows (parent_id = chat or session, and a
 *     dispatched_by row) are counted by a dry run, converted by an apply,
 *     untouched by a second apply, and restored by the revert.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'launched-by-owner';

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

/** As the migration owner: the 330 migration functions are granted to no runtime role. */
const asMigrator = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
  database.transaction(async (c) => (await c.query(sql, params)).rows[0]?.v as T);

async function spawn(title: string, launcher: string | null): Promise<string> {
  return asApp(async (c) => (await c.query<{ v: { entity: { id: string } } }>(
    `select public.execution_spawn(p_space_id => $1, p_team_member_id => $2, p_task_ids => '{}'::uuid[],
       p_workdir_mode => 'scratch', p_title => $3, p_client_mutation_id => $4,
       p_parent_session_id => $5::uuid, p_session_cap => 100) v`,
    [id['space'], id['persona'], title, `launched-${randomUUID()}`, launcher])).rows[0]!.v.entity.id);
}

const parentOf = (entityId: string) => one<string | null>(`select parent_id::text v from public.entities where id = $1`, [entityId]);
const launcherOf = (entityId: string) => one<string | null>(`select internal.launched_by($1)::text v`, [entityId]);

/** Put a session back the way pre-330 spawns left it: parent_id = launcher, no edge. */
async function makeLegacy(session: string, launcher: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`delete from public.edges where src_id = $1 and type = 'launched_by'`, [session]);
    await c.query(`update public.entities set parent_id = $2 where id = $1`, [session, launcher]);
  });
}

describe('330 launched_by', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('launched_by');
    database.apply(migrationFiles());

    await asOwner(async (c) => {
      const names = ['space', 'member', 'persona', 'chat'];
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [names.length])).rows[0]!.ids;
      names.forEach((n, i) => { id[n] = ids[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'owner')`, [IDENTITY]);
      await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'launched-owner')`,
        [randomUUID(), IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'launched', $2)`,
        [id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'member', $1, 'space')`, [id['member'], id['space']]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, 'owner', 'Owner')`, [id['member'], id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'team_member', $3, 'space')`, [id['persona'], id['space'], id['member']]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
                     values ($1, $2, 'Launch Agent', 'worker', 'persona')`, [id['persona'], id['member']]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'chat', $3, 'space')`, [id['chat'], id['space'], id['member']]);
      await c.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id, model, provider, agent_tool, chat_mode, workdir_mode, cwd,
           native_session_id, configured_by_identity_id, configured_by_member_id, client_mutation_id
         ) values ($1,$2,'launcher',$3,'claude-opus-5','anthropic','claude-code','ask','scratch',$4,
                   gen_random_uuid(),$5,$6,$7)`,
        [id['chat'], id['space'], id['persona'], `/tmp/tm8-chat-${id['chat']}`, IDENTITY, id['member'], randomUUID()]);
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('registers launched_by and retires dispatched_by in its favour', async () => {
    const row = await one<{ src: string[]; dst: string[]; acyclic: boolean; description: string }>(
      `select jsonb_build_object('src', src_kinds, 'dst', dst_kinds, 'acyclic', acyclic, 'description', description) v
         from public.edge_types where type = 'launched_by'`);
    expect(row).toEqual({
      src: ['work_session'],
      dst: ['chat', 'work_session'],
      acyclic: true,
      description: 'Launched by: that chat or session started this session.',
    });
    expect(await one(`select replaced_by v from public.edge_types where type = 'dispatched_by'`)).toBe('launched_by');
  });

  it('a chat-launched session gets launched_by -> chat and no parent', async () => {
    const session = await spawn('from chat', id['chat']!);
    expect(await launcherOf(session)).toBe(id['chat']);
    expect(await parentOf(session)).toBeNull();
    // The chat has no children at all: nothing cross-kind hangs under it.
    expect(await one<number>(`select count(*)::int v from public.entities where parent_id = $1`, [id['chat']])).toBe(0);
  });

  it('a session-launched session gets launched_by -> session and no parent', async () => {
    const coordinator = await spawn('coordinator', null);
    expect(await launcherOf(coordinator)).toBeNull();
    const worker = await spawn('worker', coordinator);
    expect(await launcherOf(worker)).toBe(coordinator);
    expect(await parentOf(worker)).toBeNull();
    // The worker's anchors carry its launcher, as they carried its parent.
    expect(await one<string[]>(`select internal.session_anchor_ids($1)::text[] v`, [worker])).toContain(coordinator);
  });

  it('only the server writes launched_by, once per session', async () => {
    const a = await spawn('a', null);
    const b = await spawn('b', null);
    await expect(asOwner(async (c) => {
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'launched_by',$4)`,
        [id['space'], b, a, id['member']]);
    })).rejects.toThrow(/recorded by the server/);
    const worker = await spawn('once', a);
    await expect(asOwner(async (c) => {
      await c.query(`select internal.w1_set_writer('spawn')`);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'launched_by',$4)`,
        [id['space'], worker, b, id['member']]);
    })).rejects.toThrow(/edges_one_launched_by|duplicate key/);
  });

  it('authored_from accepts the launcher, and only the launcher', async () => {
    const worker = await spawn('authored', id['chat']!);
    const other = await spawn('other', null);
    expect(await asApp(async (c) => (await c.query(`select public.record_authored_from($1, $2) v`, [worker, other])).rows[0]!.v)).toBeNull();
    expect(await asApp(async (c) => (await c.query(`select public.record_authored_from($1, $2) v`, [worker, id['chat']])).rows[0]!.v)).toBeTruthy();
  });

  it('the migration counts, converts, is idempotent, and reverts', async () => {
    // Nothing legacy yet beyond what earlier spawns wrote (all on the edge).
    const before = await asMigrator<Record<string, number>>(`select internal.migrate_launched_by(false) v`);
    expect(before['sessions']).toBe(0);

    const coordinator = await spawn('legacy coordinator', null);
    const fromChat = await spawn('legacy from chat', id['chat']!);
    const fromSession = await spawn('legacy from session', coordinator);
    const dispatched = await spawn('legacy dispatched', null);
    await makeLegacy(fromChat, id['chat']!);
    await makeLegacy(fromSession, coordinator);
    await asOwner(async (c) => {
      // A pre-303 dispatched_by row; the 303 refusal is bypassed the way a logged migration does.
      await c.query(`select set_config('tm8.edge_migration', 'seed', true)`);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1,$2,$3,'dispatched_by',$4)`,
        [id['space'], dispatched, coordinator, id['member']]);
    });

    const dry = await asMigrator<Record<string, unknown>>(`select internal.migrate_launched_by(false) v`);
    expect(dry).toMatchObject({ applied: false, sessions: 2, launchedByChat: 1, launchedBySession: 1, dispatchedByRows: 1, edgesWritten: 0 });
    expect(await parentOf(fromChat)).toBe(id['chat']);

    const applied = await asMigrator<Record<string, unknown>>(`select internal.migrate_launched_by(true, 'test-330') v`);
    expect(applied).toMatchObject({ applied: true, sessions: 2, edgesWritten: 2, dispatchedByRows: 1 });
    expect(await parentOf(fromChat)).toBeNull();
    expect(await parentOf(fromSession)).toBeNull();
    expect(await launcherOf(fromChat)).toBe(id['chat']);
    expect(await launcherOf(fromSession)).toBe(coordinator);
    expect(await launcherOf(dispatched)).toBe(coordinator);
    expect(await one<number>(`select count(*)::int v from public.edges where type = 'dispatched_by'`)).toBe(0);

    const again = await asMigrator<Record<string, unknown>>(`select internal.migrate_launched_by(true, 'test-330') v`);
    expect(again).toMatchObject({ sessions: 0, edgesWritten: 0, dispatchedByRows: 0 });

    expect(await asMigrator<number>(`select internal.revert_launched_by_migration('test-330') v`)).toBe(2);
    expect(await parentOf(fromChat)).toBe(id['chat']);
    expect(await parentOf(fromSession)).toBe(coordinator);
    expect(await launcherOf(fromChat)).toBeNull();
    expect(await launcherOf(fromSession)).toBeNull();
    expect(await one<number>(`select count(*)::int v from public.edges where type = 'dispatched_by'`)).toBe(1);
    expect(await launcherOf(dispatched)).toBeNull();
  });
});
