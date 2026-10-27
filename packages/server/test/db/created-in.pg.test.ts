/**
 * 327 — "created here": a chat records what it makes, and `filters.createdIn`
 * lists the roots a chat or session made. Pinned here:
 *   - sessions spawned under a chat before 327 are backfilled from their parent;
 *   - `record_authored_from` accepts a chat origin for the chat teammate's own
 *     entities (never a human's, never a message), and a session only when the
 *     origin is its spawn parent;
 *   - `createdIn` returns roots only (a child of something made here is left
 *     to its parent's subtree), never messages, and reaches a session's own
 *     sub-sessions through its parent;
 *   - the rollup (task 01a14a91): what a session spawned under the origin made,
 *     at any depth, is made there too.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CollectionQuery } from '@tm8/contract';
import type { Querier } from '../../src/db/types.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const IDENTITY = 'created-in-owner';
const MIGRATION = '327_authored_from_chat.sql';

let database: W1ScratchDatabase;
const id: Record<string, string> = {};

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function asApp<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true), set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true), set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', 'req-created-in', true)`,
      [IDENTITY],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async <R>(fnName: string, args: readonly unknown[] = []): Promise<R> => {
        if (!/^[a-z_][a-z0-9_]*$/.test(fnName)) throw new Error(`unsafe test RPC ${fnName}`);
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        return (await client.query(`select public.${fnName}(${placeholders}) result`, [...args])).rows[0]?.result as R;
      },
    };
    return fn(q);
  });
}

const record = (entity: string, origin: string): Promise<string | null> =>
  asApp((q) => q.rpc<string | null>('record_authored_from', [id[entity], id[origin]]));

const originOf = async (entity: string): Promise<string | null> =>
  asOwner(async (c) => (await c.query<{ v: string }>(
    `select dst_id::text v from public.edges where src_id = $1 and type = 'authored_from'`, [id[entity]])).rows[0]?.v ?? null);

async function createdIn(origin: string): Promise<string[]> {
  const query: CollectionQuery = { spaceId: id['space']! as CollectionQuery['spaceId'], filters: { createdIn: id[origin]! as never }, limit: 50 };
  const result = await asApp((q) => queryCollection(q, query, IDENTITY));
  const names = new Map(Object.entries(id).map(([name, value]) => [value, name]));
  return result.page.items.map((item) => names.get(item.id) ?? item.id).sort();
}

describe('327 created here', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('created_in');
    const files = migrationFiles();
    database.apply(files.filter((f) => f < MIGRATION));

    await asOwner(async (c) => {
      const names = ['space', 'member', 'persona', 'chat', 'otherChat', 'oldSession', 'session', 'subSession',
        'task', 'childTask', 'humanTask', 'message'];
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, $1)) ids`, [names.length])).rows[0]!.ids;
      names.forEach((n, i) => { id[n] = ids[i]!; });

      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'owner')`, [IDENTITY]);
      await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'created-in-owner')`,
        [randomUUID(), IDENTITY]);
      await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'created in', $2)`,
        [id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'member', $1, 'space')`, [id['member'], id['space']]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
                     values ($1, $2, $3, 'owner', 'Owner')`, [id['member'], id['space'], IDENTITY]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'team_member', $3, 'space')`, [id['persona'], id['space'], id['member']]);
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity)
                     values ($1, $2, 'Chat Agent', 'worker', 'persona')`, [id['persona'], id['member']]);
      for (const chat of ['chat', 'otherChat']) {
        await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                       values ($1, $2, 'chat', $3, 'space')`, [id[chat], id['space'], id['member']]);
        await c.query(
          `insert into public.chats(entity_id, space_id, title, teammate_id, model, provider, agent_tool,
             chat_mode, workdir_mode, cwd, native_session_id, configured_by_identity_id, configured_by_member_id,
             client_mutation_id)
           values ($1,$2,$3,$4,'claude-opus-5','anthropic','claude-code','ask','scratch','/tmp/created-in',
                   gen_random_uuid(),$5,$6,$7)`,
          [id[chat], id['space'], chat, id['persona'], IDENTITY, id['member'], `created-in-${randomUUID()}`]);
      }

      // Sessions: one spawned under the chat before 327, one after, and one
      // spawned by that session.
      for (const [session, parent] of [['oldSession', 'chat'], ['session', 'chat'], ['subSession', 'session']] as const) {
        await c.query(`insert into public.entities(id, space_id, kind, parent_id, created_by, visibility)
                       values ($1, $2, 'work_session', $3, $4, 'space')`,
          [id[session], id['space'], id[parent], id['member']]);
        await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
                       values ($1, $2, 'running', 'none', now())`, [id[session], session]);
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
                       values ($1, $2, $3, 'participates_in', $2)`, [id['space'], id['persona'], id[session]]);
      }

      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,'task',0,$3)`,
        [id['task'], id['space'], id['persona']]);
      await c.query(`insert into public.tasks(entity_id, title) values ($1, 'made in the chat')`, [id['task']]);
      await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                     values ($1,$2,'task',$3,1,$4)`, [id['childTask'], id['space'], id['task'], id['persona']]);
      await c.query(`insert into public.tasks(entity_id, title) values ($1, 'a subtask')`, [id['childTask']]);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1,$2,'task',2,$3)`,
        [id['humanTask'], id['space'], id['member']]);
      await c.query(`insert into public.tasks(entity_id, title) values ($1, 'a human made it')`, [id['humanTask']]);
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'message', $3, 'space')`, [id['message'], id['space'], id['persona']]);
      // Every chat post carries authored_from(message -> chat).
      await c.query(`select internal.w1_set_writer('message_recorder')`);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
                     values ($1, $2, $3, 'authored_from', $4)`, [id['space'], id['message'], id['chat'], id['persona']]);
      await c.query(`select internal.w1_set_writer(null)`);
    });

    database.apply(files.filter((f) => f >= MIGRATION));
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('backfills sessions spawned under a chat or a session from their parent', async () => {
    expect(await originOf('oldSession')).toBe(id['chat']);
    expect(await originOf('session')).toBe(id['chat']);
    expect(await originOf('subSession')).toBe(id['session']);
    expect(await asOwner(async (c) => (await c.query<{ v: string }>(
      `select props->>'origin' v from public.edges where src_id = $1 and type = 'authored_from'`, [id['oldSession']])).rows[0]?.v))
      .toBe('entity_recorder');
  });

  it('records a chat as the origin of its teammate\'s entities, and nothing else', async () => {
    expect(await record('humanTask', 'chat')).toBeNull(); // a human made it
    expect(await record('message', 'otherChat')).toBeNull(); // messages have their own recorder
    const edgeRowId = await record('task', 'chat');
    expect(edgeRowId).toBeTruthy();
    expect(await originOf('task')).toBe(id['chat']);
    expect(await record('task', 'chat')).toBe(edgeRowId); // one per source
    expect(await record('childTask', 'chat')).toBeTruthy();
    // A session's origin must be its spawn parent.
    expect(await asOwner(async (c) => {
      await c.query(`select internal.w1_set_writer('forward_compensation')`);
      await c.query(`delete from public.edges where src_id = $1 and type = 'authored_from'`, [id['subSession']]);
    })).toBeUndefined();
    expect(await record('subSession', 'chat')).toBeNull();
    expect(await record('subSession', 'session')).toBeTruthy();
  });

  it('createdIn lists the roots made here, never children or messages', async () => {
    expect(await createdIn('chat')).toEqual(['oldSession', 'session', 'task']);
    expect(await createdIn('session')).toEqual(['subSession']);
    expect(await createdIn('otherChat')).toEqual([]);
  });

  it('createdIn reaches a pre-327 spawn through its parent alone', async () => {
    await asOwner(async (c) => {
      await c.query(`select internal.w1_set_writer('forward_compensation')`);
      await c.query(`delete from public.edges where src_id = $1 and type = 'authored_from'`, [id['oldSession']]);
    });
    expect(await createdIn('chat')).toEqual(['oldSession', 'session', 'task']);
  });

  it('createdIn rolls up what the sessions spawned under it made', async () => {
    await asOwner(async (c) => {
      const ids = (await c.query<{ ids: string[] }>(
        `select array(select internal.new_id() from generate_series(1, 3)) ids`)).rows[0]!.ids;
      ['workerTask', 'workerChild', 'subWorkerTask'].forEach((n, i) => { id[n] = ids[i]!; });
      for (const [name, parent, position] of [['workerTask', null, 3], ['workerChild', 'workerTask', 4], ['subWorkerTask', null, 5]] as const) {
        await c.query(`insert into public.entities(id, space_id, kind, parent_id, position, created_by)
                       values ($1,$2,'task',$3,$4,$5)`, [id[name], id['space'], parent ? id[parent] : null, position, id['persona']]);
        await c.query(`insert into public.tasks(entity_id, title) values ($1, $2)`, [id[name], name]);
      }
    });
    expect(await record('workerTask', 'session')).toBeTruthy();
    expect(await record('workerChild', 'session')).toBeTruthy();
    expect(await record('subWorkerTask', 'subSession')).toBeTruthy();
    // A child's outputs are roots of the chat, but never their own children.
    expect(await createdIn('chat')).toEqual(['oldSession', 'session', 'subWorkerTask', 'task', 'workerTask']);
    expect(await createdIn('session')).toEqual(['subSession', 'subWorkerTask', 'workerTask']);
    expect(await createdIn('subSession')).toEqual(['subWorkerTask']);
    expect(await createdIn('otherChat')).toEqual([]);
  });
});
