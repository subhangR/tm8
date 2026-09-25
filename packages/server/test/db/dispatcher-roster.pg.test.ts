/**
 * I8 (integrated design 01a0d348 §8 I8, headers T6): a dispatcher's roster,
 * read by `loadDispatcherRoster` against a REAL PostgreSQL as `tm8_app` under
 * the caller's claims.
 *
 *   · RLS decides: another space's teammate, a restricted one and a deleted
 *     one are in neither the rows nor the total;
 *   · the dispatcher is never on its own roster;
 *   · the order is stable (name, case-folded, then id), and `total` counts
 *     every readable teammate past the LIMIT, so the rest can be declared;
 *   · mode and model are the teammate's own columns.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { DbClaims, Db } from '../../src/db/types.js';
import { loadDispatcherRoster } from '../../src/launch/roster.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWNER = 'roster-owner';
const STRANGER = 'roster-stranger';

let database: W1ScratchDatabase;
let db: Db;
const ids: Record<string, string> = {};

type Client = import('pg').PoolClient;

async function newId(client: Client): Promise<string> {
  return (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
}

async function space(client: Client, key: string, identity: string): Promise<string> {
  const id = await newId(client);
  await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`, [id, key, identity]);
  const member = await newId(client);
  await client.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, id]);
  await client.query(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, 'owner', $3)`,
    [member, id, identity],
  );
  ids[`member:${id}`] = member;
  return id;
}

async function teammate(
  client: Client, spaceId: string, name: string,
  opts: { mode?: string; model?: string; visibility?: string } = {},
): Promise<string> {
  const id = await newId(client);
  await client.query(
    `insert into public.entities(id, space_id, kind, position, created_by, visibility) values ($1, $2, 'team_member', 0, $3, $4)`,
    [id, spaceId, ids[`member:${spaceId}`], opts.visibility ?? 'space'],
  );
  await client.query(
    `insert into public.team_members(entity_id, owner_member_id, name, role, identity, mode, model) values ($1, $2, $3, 'role', 'persona', $4, $5)`,
    [id, ids[`member:${spaceId}`], name, opts.mode ?? null, opts.model ?? null],
  );
  return id;
}

const claims = (identityId = OWNER): DbClaims => ({ identityId, nodeAdmin: false, requestId: 'dispatcher-roster' });

beforeAll(async () => {
  database = await createW1ScratchDatabase('dispatcher_roster');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger')`, [OWNER, STRANGER]);
    await c.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'roster-owner', 'Owner', false, true), ($2, 'roster-stranger', 'Stranger', false, false)`,
      [OWNER, STRANGER],
    );
    const s = ids.space = await space(c, 'Roster', OWNER);
    const other = await space(c, 'Elsewhere', STRANGER);
    ids.dispatcher = await teammate(c, s, 'Dispatcher', { mode: 'dispatcher' });
    ids.zed = await teammate(c, s, 'zed', { mode: 'worker', model: 'claude-opus-5' });
    ids.alice = await teammate(c, s, 'Alice', { model: 'gpt-5' });
    ids.bob = await teammate(c, s, 'bob');
    ids.hidden = await teammate(c, s, 'Hidden', { visibility: 'restricted' });
    ids.deleted = await teammate(c, s, 'Deleted');
    await c.query(`update public.entities set deleted_at = now() where id = $1`, [ids.deleted]);
    ids.foreign = await teammate(c, other, 'Foreign');
  });
}, 300_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('loadDispatcherRoster', () => {
  it('reads the readable teammates in stable order, without the dispatcher, with their mode and model', async () => {
    const roster = await db.tx(claims(), (q) => loadDispatcherRoster(q, { spaceId: ids.space!, excludeTeamMemberId: ids.dispatcher!, limit: 64 }));
    expect(roster).toEqual({
      members: [
        { entityId: ids.alice, name: 'Alice', mode: null, model: 'gpt-5' },
        { entityId: ids.bob, name: 'bob', mode: null, model: null },
        { entityId: ids.zed, name: 'zed', mode: 'worker', model: 'claude-opus-5' },
      ],
      total: 3,
    });
  });

  it('counts every readable teammate past the limit, so the rest can be declared', async () => {
    const roster = await db.tx(claims(), (q) => loadDispatcherRoster(q, { spaceId: ids.space!, excludeTeamMemberId: ids.dispatcher!, limit: 2 }));
    expect(roster.members.map((m) => m.name)).toEqual(['Alice', 'bob']);
    expect(roster.total).toBe(3);
  });

  it('reads nothing a stranger cannot see', async () => {
    const roster = await db.tx(claims(STRANGER), (q) => loadDispatcherRoster(q, { spaceId: ids.space!, excludeTeamMemberId: ids.dispatcher!, limit: 64 }));
    expect(roster).toEqual({ members: [], total: 0 });
  });
});
