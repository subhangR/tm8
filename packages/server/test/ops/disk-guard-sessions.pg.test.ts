import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDb, type Db } from '../../src/db/index.js';
import { dbSessionLookup } from '../../src/ops/disk-guard-config.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

// The disk guard's session lookup against the real schema and RLS: an ended
// session is `ended` from its status change, a live one is `live`, and a
// session the owner's claims cannot see is `unknown`, never `ended`.

let database: W1ScratchDatabase;
let db: Db;
const owner = 'disk-guard-owner';
const ids = { space: randomUUID(), member: randomUUID(), ended: randomUUID(), live: randomUUID(), sharedPath: randomUUID() };

beforeAll(async () => {
  database = await createW1ScratchDatabase('disk-guard-sessions');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner')`, [owner]);
    await client.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Disk', $2)`, [ids.space, owner]);
    await client.query(`insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'member', $1)`, [ids.member, ids.space]);
    await client.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name)
      values ($1, $2, $3, 'owner', 'Owner')`, [ids.member, ids.space, owner]);
    await client.query(`insert into public.entities(id, space_id, kind, created_by)
      values ($1, $3, 'work_session', $4), ($2, $3, 'work_session', $4), ($5, $3, 'work_session', $4)`,
    [ids.ended, ids.live, ids.space, ids.member, ids.sharedPath]);
    await client.query(`insert into public.work_sessions(entity_id, title, status, status_changed_at, workdir_mode, workdir_path)
      values ($1, 'ended', 'exited', now() - interval '2 days', 'worktree', '/data/worktrees/p/a'),
             ($2, 'live', 'running', now(), 'worktree', '/data/worktrees/p/b'),
             ($3, 'old', 'failed', now() - interval '9 days', 'worktree', '/data/worktrees/p/b')`,
    [ids.ended, ids.live, ids.sharedPath]);
  });
}, 120_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

it('reads ended, live and unseen sessions under the owner claims', async () => {
  const lookup = await dbSessionLookup(db, async () => ({ identityId: owner }))();
  expect(lookup.error).toBeUndefined();
  const ended = lookup.find({ id: ids.ended });
  expect(ended.state).toBe('ended');
  expect(Date.now() - ended.endedAt!).toBeGreaterThan(47 * 3600_000);
  expect(lookup.find({ id: ids.live })).toEqual({ state: 'live', endedAt: null });
  expect(lookup.find({ workdirPath: '/data/worktrees/p/a' }).state).toBe('ended');
  // Two sessions on one workdir: the live one wins over an older ended one.
  expect(lookup.find({ workdirPath: '/data/worktrees/p/b' }).state).toBe('live');
  expect(lookup.find({ id: randomUUID() })).toEqual({ state: 'unknown', endedAt: null });

  const stranger = await dbSessionLookup(db, async () => ({ identityId: 'not-a-member' }))();
  expect(stranger.find({ id: ids.ended }).state).toBe('unknown');
});
