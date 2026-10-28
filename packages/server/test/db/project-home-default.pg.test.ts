import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { SpaceProject } from '@tm8/contract';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { W2ProjectsAssociationsService } from '../../src/facade/services/w2/projects-associations.js';
import type { RequestContext } from '../../src/http/types.js';
import { gatePosture, writeNodePolicy } from '../../src/projects/node-policy.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * A PROJECT'S WORKING DIRECTORY, THROUGH THE REAL `spaces.projects.create`.
 *
 *  - No `workingDir`: the project gets the home default `~/<name>`, created on
 *    the node, and that folder's `working_dir` is what `start_chat` and spawn
 *    resolve a project chat or session to.
 *  - A typed `~/…` path is the node's home, used as is.
 *  - On a loopback-only node two Spaces can share one folder; on any other
 *    node a folder still belongs to one Space (decision 29).
 *
 * HOME is a scratch directory for the whole file, so nothing is created in
 * the real home of whoever runs it.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ids = {
  identity: `phd-${randomUUID().slice(0, 8)}`,
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
};

let database: W1ScratchDatabase;
let db: Db | undefined;
let home: string;
const savedHome = process.env['HOME'];

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

function service(): W2ProjectsAssociationsService {
  db ??= createDb(database.url);
  return new W2ProjectsAssociationsService({
    db,
    config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url },
    owner: async () => ({
      identityId: ids.identity,
      accountId: '00000000-0000-7000-8000-0000000000ee',
      username: 'h',
      isNodeAdmin: true,
      isOwner: true,
    }),
  });
}

/** `spaces.projects.create` as H, a node admin who owns both spaces. */
function create(spaceId: string, body: Record<string, unknown>): Promise<SpaceProject> {
  const ctx = {
    op: { name: 'spaces.projects.create', method: 'POST', path: '/test', kind: 'write', status: 'v1' },
    opName: 'spaces.projects.create',
    params: { spaceId },
    query: new URLSearchParams(),
    body: { clientMutationId: `phd-${randomUUID()}`, ...body },
    requestId: `req-phd-${randomUUID().slice(0, 8)}`,
    identity: { kind: 'bearer', identityId: ids.identity, token: 'tm8s_phd.unused', nodeAdmin: true, authKind: 'browser' },
    headers: {},
    method: 'POST',
    path: '/test',
  } as unknown as RequestContext;
  return service().createSpaceProject(ctx);
}

const workingDirOf = (folderId: string): Promise<string | null> =>
  asOwner((c) => c.query<{ d: string }>('select working_dir d from public.projects where id = $1', [folderId]))
    .then((r) => r.rows[0]?.d ?? null);

async function seed(): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H')`, [ids.identity]);
    await c.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner) values ($1, $1, true, false)`,
      [ids.identity],
    );
    await c.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'PHD A', $3), ($2, 'PHD B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identity],
    );
    await c.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB],
    );
    await c.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'H'), ($2, $4, $5, 'owner', 'H')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB, ids.identity],
    );
  });
}

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tm8-phd-home-')));
  process.env['HOME'] = home;
  database = await createW1ScratchDatabase('project_home_default');
  database.apply(migrationFiles());
  await seed();
}, 180_000);

afterAll(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
  await db?.end();
  await database?.destroy();
}, 180_000);

describe.sequential('a project with no working directory gets ~/<name>', () => {
  it('creates ~/docs-site for "Docs Site" and registers it as the project folder', async () => {
    await writeNodePolicy(database.url, gatePosture({ nodeMode: 'multi' }));
    const project = await create(ids.spaceA, { name: 'Docs Site' });
    const expected = join(home, 'docs-site');
    expect(existsSync(expected)).toBe(true);
    // What start_chat reads for a `project` chat, and spawn for a project session.
    expect(await workingDirOf(project.folderId)).toBe(expected);
    expect(project.name).toBe('Docs Site');
  });

  it('a typed path is used as is, with ~/ meaning the node home', async () => {
    mkdirSync(join(home, 'repos', 'api'), { recursive: true });
    const project = await create(ids.spaceA, { name: 'API', workingDir: '~/repos/api' });
    expect(await workingDirOf(project.folderId)).toBe(join(home, 'repos', 'api'));
  });

  it('refuses a default that already exists instead of adopting a folder nobody chose', async () => {
    mkdirSync(join(home, 'secrets'));
    await expect(create(ids.spaceA, { name: 'Secrets' })).rejects.toMatchObject({
      code: 'conflict',
      details: expect.objectContaining({ reason: 'default_working_dir_exists' }),
    });
  });

  it('refuses a name that gives no folder name', async () => {
    await expect(create(ids.spaceA, { name: '!!!' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe.sequential('two Spaces and one folder', () => {
  it('a server node (not loopback-only) keeps one Space per folder', async () => {
    await writeNodePolicy(database.url, gatePosture({ nodeMode: 'single', publicOrigin: 'https://tm8.example.com' }));
    await expect(create(ids.spaceB, { name: 'Docs too', workingDir: '~/docs-site' }))
      .rejects.toThrow(/belongs to another space/);
  });

  it('a local (loopback-only) node lets a second Space share the folder', async () => {
    await writeNodePolicy(database.url, gatePosture({ nodeMode: 'single' }));
    const shared = await create(ids.spaceB, { name: 'Docs too', workingDir: '~/docs-site' });
    expect(await workingDirOf(shared.folderId)).toBe(join(home, 'docs-site'));
    const grants = await asOwner((c) => c.query<{ s: string }>(
      'select space_id::text s from public.space_projects where project_id = $1 order by space_id', [shared.folderId],
    ));
    expect(grants.rows.map((row) => row.s).sort()).toEqual([ids.spaceA, ids.spaceB].sort());
  });
});
