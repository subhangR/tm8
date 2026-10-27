import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createW1ScratchDatabase, MIGRATIONS_DIR, migrationFiles, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

/**
 * 326 — `register_space_folder`: a space admin's door to a project folder
 * (task 01a13574). Space A: H is its owner (not a node admin), M a plain
 * member, N an admin who is also a node (gate) admin. Folder G is registered
 * on the node and granted nowhere. Every refusal is paired with a positive by
 * a caller who differs in exactly the fact the refusal is about.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ids = {
  identityH: `sap-h-${randomUUID().slice(0, 8)}`,
  identityM: `sap-m-${randomUUID().slice(0, 8)}`,
  identityN: `sap-n-${randomUUID().slice(0, 8)}`,
  spaceA: randomUUID(),
  memberH: randomUUID(),
  memberM: randomUUID(),
  memberN: randomUUID(),
  folderG: randomUUID(),
};
const pathFor = (tag: string) => `/srv/sap-${tag}-${ids.spaceA}`;

let database: W1ScratchDatabase;

async function as<T>(identity: string, nodeAdmin: boolean, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', $3, true),
              set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', $2, true)`,
      [identity, `sap-${randomUUID()}`, String(nodeAdmin)],
    );
    return fn(client);
  });
}

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

function register(
  identity: string,
  nodeAdmin: boolean,
  args: { path: string; name?: string; trust?: string; repoUrl?: string | null; branch?: string | null },
): Promise<Record<string, unknown>> {
  return as(identity, nodeAdmin, async (c) => (await c.query<{ r: Record<string, unknown> }>(
    'select public.register_space_folder($1, $2, $3, $4, $5, $6, null) r',
    [ids.spaceA, args.name ?? 'Added', args.path, args.repoUrl ?? null, args.branch ?? null, args.trust ?? 'untrusted'],
  )).rows[0]!.r);
}

async function sqlstate(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('space_admin_projects');
  database.apply(migrationFiles());
  await asOwner(async (c) => {
    await c.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'M'), ($3, 'N')`,
      [ids.identityH, ids.identityM, ids.identityN],
    );
    await c.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner)
       values ($1, $1, false, false), ($2, $2, false, false), ($3, $3, true, false)`,
      [ids.identityH, ids.identityM, ids.identityN],
    );
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'SAP A', $2)`, [ids.spaceA, ids.identityH]);
    await c.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $4, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space'), ($3, $4, 'member', $3, 'space')`,
      [ids.memberH, ids.memberM, ids.memberN, ids.spaceA],
    );
    await c.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $5, 'owner', 'H'), ($2, $4, $6, 'member', 'M'), ($3, $4, $7, 'admin', 'N')`,
      [ids.memberH, ids.memberM, ids.memberN, ids.spaceA, ids.identityH, ids.identityM, ids.identityN],
    );
    await c.query(
      `insert into public.projects(id, name, working_dir, trust) values ($1, 'Gate G', $2, 'untrusted')`,
      [ids.folderG, pathFor('g')],
    );
  });
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

describe.sequential('326 register_space_folder', () => {
  it('a space admin who is not a node admin registers, grants and names a new folder — untrusted, with remote and branch', async () => {
    const result = await register(ids.identityH, false, {
      path: pathFor('new'), name: 'Hello', repoUrl: 'https://github.com/octo/hello.git', branch: 'main',
    });
    expect(result).toMatchObject({ spaceId: ids.spaceA, created: true });
    const row = await asOwner((c) => c.query(
      `select p.trust, p.repo_url, p.default_branch, d.name
         from public.projects p
         join public.space_projects sp on sp.project_id = p.id and sp.space_id = $2
         join public.project_links l on l.project_id = p.id and l.space_id = $2
         join public.project_projection_details d on d.entity_id = l.project_entity_id
        where p.id = $1`,
      [result.folderId, ids.spaceA],
    ));
    expect(row.rows[0]).toEqual({ trust: 'untrusted', repo_url: 'https://github.com/octo/hello.git', default_branch: 'main', name: 'Hello' });
  });

  it('registering the same path again in the same space reuses the folder', async () => {
    const again = await register(ids.identityH, false, { path: pathFor('new'), name: 'Hello' });
    expect(again).toMatchObject({ created: false });
  });

  it('a plain member is refused; the space owner is not (42501)', async () => {
    expect(await sqlstate(() => register(ids.identityM, false, { path: pathFor('m') }))).toBe('42501');
    expect(await sqlstate(() => register(ids.identityH, false, { path: pathFor('h') }))).toBe('ok');
  });

  it('a space admin cannot take a gate folder not granted to the space; a gate admin who is space admin can', async () => {
    expect(await sqlstate(() => register(ids.identityH, false, { path: pathFor('g') }))).toBe('42501');
    // N without the node-admin claim is just a space admin: same refusal.
    expect(await sqlstate(() => register(ids.identityN, false, { path: pathFor('g') }))).toBe('42501');
    expect(await sqlstate(() => register(ids.identityN, true, { path: pathFor('g') }))).toBe('ok');
  });

  it('only a gate admin may register a folder trusted', async () => {
    expect(await sqlstate(() => register(ids.identityH, false, { path: pathFor('t1'), trust: 'trusted' }))).toBe('42501');
    expect(await sqlstate(() => register(ids.identityN, true, { path: pathFor('t2'), trust: 'trusted' }))).toBe('ok');
  });

  it('refuses a relative path and an empty name (22023)', async () => {
    expect(await sqlstate(() => register(ids.identityH, false, { path: 'relative/dir' }))).toBe('22023');
    expect(await sqlstate(() => register(ids.identityH, false, { path: pathFor('noname'), name: '  ' }))).toBe('22023');
  });

  it('is executable by tm8_app and not by PUBLIC', async () => {
    const grants = await asOwner((c) => c.query<{ app: boolean; pub: boolean }>(
      `select has_function_privilege('tm8_app', 'public.register_space_folder(uuid,text,text,text,text,text,text)', 'execute') app,
              exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                       where p.proname = 'register_space_folder' and a.grantee = 0) pub`,
    ));
    expect(grants.rows[0]).toEqual({ app: true, pub: false });
  });
});

describe.sequential('326: the rollback', () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '326_space_admin_projects.sql'), 'utf8');
  const down = readFileSync(join(REPO_ROOT, 'db', 'rollback', '326_space_admin_projects.down.sql'), 'utf8');
  const run = (script: string): Promise<void> => database.transaction(async (client) => { await client.query(script); });
  const shape = () => asOwner(async (c) => (await c.query<{ fn: boolean; col: boolean }>(
    `select exists (select 1 from pg_proc where proname = 'register_space_folder') fn,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'projects' and column_name = 'default_branch') col`,
  )).rows[0]);

  it('down drops the door and default_branch but keeps what a space admin registered; up restores both', async () => {
    await run(down);
    expect(await shape()).toEqual({ fn: false, col: false });
    const kept = await asOwner((c) => c.query(`select 1 from public.projects where working_dir = $1`, [pathFor('new')]));
    expect(kept.rowCount).toBe(1);
    await run(up);
    expect(await shape()).toEqual({ fn: true, col: true });
    expect(await sqlstate(() => register(ids.identityH, false, { path: pathFor('after-up') }))).toBe('ok');
  });
});
