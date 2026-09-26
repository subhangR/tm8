import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * Plan W2 x A3 (migration 980) — `projects.create` with `spaceId`.
 *
 * Plan W2 pins the credential-free loopback owner to the space its path names.
 * The browser's "connect a folder" dialog created a project (space-less,
 * unpinned) and then linked it under `/v2/spaces/S` (pinned to S), where the
 * project was invisible, and the link answered P0002. `create_project_in_space`
 * creates it already linked into S, in one transaction, so a later call pinned
 * to S sees it — and the pin itself is untouched.
 *
 * Every refusal is paired with a positive, so a function that refused
 * everything (or allowed everything) fails this file.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  /** Node admin; owner of S, plain member of T. */
  identityN: string;
  /** Owner of S, NOT a node admin. */
  identityO: string;
  spaceS: string;
  spaceT: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

interface Claims { nodeAdmin: boolean; pinnedTo?: string }

async function asApp<T>(
  identityId: string,
  claims: Claims,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', $2, true),
              set_config('tm8.session_space_id', $3, true),
              set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', $4, true)`,
      [identityId, String(claims.nodeAdmin), claims.pinnedTo ?? '', `a3-${randomUUID()}`],
    );
    return fn(client);
  });
}

/** 'ok', or the SQLSTATE the statement raised. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
}

async function createInSpace(
  identityId: string,
  claims: Claims,
  spaceId: string,
  workingDir: string,
  cmid: string | null = null,
): Promise<{ project: { id: string; working_dir: string } }> {
  return asApp(identityId, claims, async (client) => {
    const rows = await client.query<{ result: { project: { id: string; working_dir: string } } }>(
      `select public.create_project_in_space($1, 'A3 project', $2, null, 'untrusted', '{}'::jsonb, $3) as result`,
      [spaceId, workingDir, cmid],
    );
    return rows.rows[0]!.result;
  });
}

async function projectRows(workingDir: string): Promise<number> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const rows = await client.query('select 1 from public.projects where working_dir = $1', [workingDir]);
    return rows.rowCount ?? 0;
  });
}

async function linkedSpaces(projectId: string): Promise<string[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const rows = await client.query<{ space_id: string }>(
      'select space_id from public.space_projects where project_id = $1', [projectId]);
    return rows.rows.map((row) => row.space_id);
  });
}

/**
 * Whether a caller pinned to `spaceId` lists `projectId`, through the read a
 * pinned `GET /v2/spaces/:spaceId/projects` makes (`folder_id` is the project).
 */
async function pinnedSees(identityId: string, spaceId: string, projectId: string): Promise<boolean> {
  return asApp(identityId, { nodeAdmin: true, pinnedTo: spaceId }, async (client) => {
    const rows = await client.query(
      'select 1 from public.space_projects_for_caller($1::uuid) where folder_id = $2', [spaceId, projectId]);
    return rows.rowCount === 1;
  });
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      identityN: 'a3-n',
      identityO: 'a3-o',
      spaceS: randomUUID(),
      spaceT: randomUUID(),
    };
    const memberNS = randomUUID();
    const memberNT = randomUUID();
    const memberOS = randomUUID();
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'N'), ($2, 'O')`,
      [ids.identityN, ids.identityO],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner)
       values ($1, 'a3-n', true, false), ($2, 'a3-o', false, false)`,
      [ids.identityN, ids.identityO],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'A3 S', $3), ($2, 'A3 T', $3)`,
      [ids.spaceS, ids.spaceT, ids.identityN],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $4, 'member', $1, 'space'),
              ($2, $5, 'member', $2, 'space'),
              ($3, $4, 'member', $3, 'space')`,
      [memberNS, memberNT, memberOS, ids.spaceS, ids.spaceT],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'N'),
              ($2, $5, $6, 'member', 'N'),
              ($3, $4, $7, 'owner', 'O')`,
      [memberNS, memberNT, memberOS, ids.spaceS, ids.spaceT, ids.identityN, ids.identityO],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('a3_create_project_in_space');
  database.apply(migrationFiles());
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

const unpinned: Claims = { nodeAdmin: true };

describe('980 create_project_in_space', () => {
  it('(a) the unpinned owner creates into S: linked in S, and a call pinned to S sees it', async () => {
    const created = await createInSpace(fixture.identityN, unpinned, fixture.spaceS, '/tmp/a3-born-linked');

    expect(await linkedSpaces(created.project.id)).toEqual([fixture.spaceS]);
    expect(await pinnedSees(fixture.identityN, fixture.spaceS, created.project.id)).toBe(true);
    // The pinned link the browser dialog still sends is now an idempotent no-op.
    expect(await outcome(() => asApp(fixture.identityN, { nodeAdmin: true, pinnedTo: fixture.spaceS },
      (client) => client.query('select public.link_project_w2($1, $2)', [fixture.spaceS, created.project.id]),
    ))).toBe('ok');
  });

  it('(a pair) the space-less create is unchanged: linked nowhere, invisible pinned, same result shape', async () => {
    const plain = await asApp(fixture.identityN, unpinned, async (client) => {
      const rows = await client.query<{ result: Record<string, unknown> & { project: { id: string } } }>(
        `select public.create_project('A3 plain', '/tmp/a3-plain') as result`);
      return rows.rows[0]!.result;
    });
    const born = await createInSpace(fixture.identityN, unpinned, fixture.spaceS, '/tmp/a3-shape');

    expect(await linkedSpaces(plain.project.id)).toEqual([]);
    expect(await pinnedSees(fixture.identityN, fixture.spaceS, plain.project.id)).toBe(false);
    expect(Object.keys(born).sort()).toEqual(Object.keys(plain).sort());
    expect(Object.keys(born.project).sort()).toEqual(Object.keys(plain.project).sort());
  });

  it('(b) a node admin who is NOT an admin of the space is refused 42501, and no project row is left', async () => {
    expect(await outcome(() =>
      createInSpace(fixture.identityN, unpinned, fixture.spaceT, '/tmp/a3-not-space-admin'))).toBe('42501');
    expect(await projectRows('/tmp/a3-not-space-admin')).toBe(0);
    // Pair: the same caller, a space it administers.
    expect(await outcome(() =>
      createInSpace(fixture.identityN, unpinned, fixture.spaceS, '/tmp/a3-space-admin'))).toBe('ok');
  });

  it('(b) a space admin who is NOT a node admin is refused 42501 — create stays node-admin', async () => {
    expect(await outcome(() =>
      createInSpace(fixture.identityO, { nodeAdmin: false }, fixture.spaceS, '/tmp/a3-not-node-admin'))).toBe('42501');
    expect(await projectRows('/tmp/a3-not-node-admin')).toBe(0);
  });

  it('(c) a caller pinned to S is refused, even into S itself; the unpinned owner succeeds', async () => {
    expect(await outcome(() => createInSpace(fixture.identityN,
      { nodeAdmin: true, pinnedTo: fixture.spaceS }, fixture.spaceS, '/tmp/a3-pinned'))).toBe('42501');
    expect(await projectRows('/tmp/a3-pinned')).toBe(0);
    expect(await outcome(() =>
      createInSpace(fixture.identityN, unpinned, fixture.spaceS, '/tmp/a3-pinned'))).toBe('ok');
  });

  it('(i) a link that fails AFTER the insert leaves no orphan project row', async () => {
    // The admin checks run before the insert, so to reach a failure after it,
    // make the link's own insert raise — a scratch-only trigger inside one
    // transaction, rolled back with it.
    const workingDir = '/tmp/a3-atomic';
    const code = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`create function pg_temp.a3_refuse() returns trigger language plpgsql as $$
        begin raise exception 'a3 forced link failure' using errcode = 'P0001'; end $$`);
      await client.query(`create trigger a3_refuse before insert on public.space_projects
        for each row execute function pg_temp.a3_refuse()`);
      await client.query('savepoint a3');
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true), set_config('tm8.node_admin', 'true', true),
                set_config('tm8.session_space_id', '', true), set_config('tm8.auth_kind', 'browser', true)`,
        [fixture.identityN]);
      let raised = 'ok';
      try {
        await client.query(
          `select public.create_project_in_space($1, 'A3 atomic', $2)`, [fixture.spaceS, workingDir]);
      } catch (error) {
        raised = String((error as { code?: unknown }).code);
      }
      await client.query('rollback to savepoint a3');
      const rows = await client.query('select 1 from public.projects where working_dir = $1', [workingDir]);
      expect(rows.rowCount).toBe(0);
      await client.query('drop trigger a3_refuse on public.space_projects');
      return raised;
    });
    expect(code).toBe('P0001');
    // Pair: without the forced failure the same create commits the project.
    expect(await outcome(() => createInSpace(fixture.identityN, unpinned, fixture.spaceS, workingDir))).toBe('ok');
    expect(await projectRows(workingDir)).toBe(1);
  });

  it('replays on the projects.create ledger: the first result, link included, and no second row', async () => {
    const cmid = `a3-replay-${randomUUID()}`;
    const first = await createInSpace(fixture.identityN, unpinned, fixture.spaceS, '/tmp/a3-replay', cmid);
    const again = await createInSpace(fixture.identityN, unpinned, fixture.spaceS, '/tmp/a3-replay', cmid);

    expect(again.project.id).toBe(first.project.id);
    expect(await projectRows('/tmp/a3-replay')).toBe(1);
    expect(await linkedSpaces(first.project.id)).toEqual([fixture.spaceS]);
  });
});
