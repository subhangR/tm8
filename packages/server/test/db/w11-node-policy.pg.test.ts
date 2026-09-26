import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';
import { W2ProjectsAssociationsService } from '../../src/facade/services/w2/projects-associations.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { gatePosture, writeNodePolicy } from '../../src/projects/node-policy.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * Decision 29 (migration 234) — whether one folder may be linked into several
 * spaces is a NODE policy, in `internal.node_policy`, that only the owner role
 * writes (the server at boot, from `gatePosture(config)`). `tm8_app` — the
 * role every request runs as — can neither read nor write it, and no GUC it
 * can set stands in for it. Fail-closed: no row, or any value but 'shared',
 * means one space per folder.
 *
 * Two spaces A and B, both owned by H (not a node admin). Folder F is granted
 * to A. Every refusal is paired with a positive by the SAME caller, so a guard
 * that refused everything would fail this file, not pass it.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ids = {
  identityH: `d29-h-${randomUUID().slice(0, 8)}`,
  identityN: `d29-n-${randomUUID().slice(0, 8)}`,
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  memberHA: randomUUID(),
  memberHB: randomUUID(),
  folderF: randomUUID(),
  folderG: randomUUID(),
};

let database: W1ScratchDatabase;
let db: Db | undefined;

type Posture = Pick<ServerConfig, 'nodeMode' | 'publicOrigin' | 'extraAllowedHostnames' | 'allowedOrigins' | 'preview'>;
const LOOPBACK_SINGLE: Posture = { nodeMode: 'single' };
const MULTI: Posture = { nodeMode: 'multi' };
const OPEN_GATE_SINGLE: Posture = { nodeMode: 'single', publicOrigin: 'https://tm8.example.com' };

async function asApp<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', $2, true)`,
      [ids.identityH, `d29-${randomUUID()}`],
    );
    return fn(client);
  });
}

/** N — a gate admin (node admin, unpinned) with no member row anywhere. */
async function asGateAdmin<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'true', true),
              set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', $2, true)`,
      [ids.identityN, `d29-${randomUUID()}`],
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

const policyRow = (): Promise<string | null> =>
  asOwner((c) => c.query<{ value: string }>(`select value from internal.node_policy where key = 'project_folders'`))
    .then((r) => r.rows[0]?.value ?? null);

const clearPolicy = (): Promise<unknown> =>
  asOwner((c) => c.query(`delete from internal.node_policy`));

const granted = (spaceId: string, folderId: string): Promise<boolean> =>
  asOwner((c) => c.query('select 1 from public.space_projects where space_id = $1 and project_id = $2', [spaceId, folderId]))
    .then((r) => r.rowCount === 1);

const ungrant = (spaceId: string, folderId: string): Promise<unknown> =>
  asOwner((c) => c.query('delete from public.space_projects where space_id = $1 and project_id = $2', [spaceId, folderId]));

/** H links F into B through projects.link's function. */
const linkFIntoB = (tag: string, before?: (c: PoolClient) => Promise<unknown>): Promise<string> =>
  outcome(() => asApp(async (c) => {
    if (before) await before(c);
    await c.query(`select public.link_project_w2($1, $2, null, $3)`, [ids.spaceB, ids.folderF, `d29-${tag}-${randomUUID()}`]);
  }));

async function seed(): Promise<void> {
  await asOwner(async (c) => {
    await c.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'N')`,
      [ids.identityH, ids.identityN],
    );
    await c.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner)
       values ($1, $1, false, false), ($2, $2, true, false)`,
      [ids.identityH, ids.identityN],
    );
    await c.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'D29 A', $3), ($2, 'D29 B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identityH],
    );
    await c.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space')`,
      [ids.memberHA, ids.memberHB, ids.spaceA, ids.spaceB],
    );
    await c.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'H'), ($2, $4, $5, 'owner', 'H')`,
      [ids.memberHA, ids.memberHB, ids.spaceA, ids.spaceB, ids.identityH],
    );
    await c.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'D29 F', $3, 'trusted'), ($2, 'D29 G', $4, 'trusted')`,
      [ids.folderF, ids.folderG, `/tmp/d29-f-${ids.folderF}`, `/tmp/d29-g-${ids.folderG}`],
    );
    await c.query(
      `insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3), ($1, $4, $3)`,
      [ids.spaceA, ids.folderF, ids.memberHA, ids.folderG],
    );
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('w11_node_policy');
  database.apply(migrationFiles());
  await seed();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe.sequential('decision 29 — internal.node_policy is the owner\'s alone', () => {
  it('a fresh chain has no policy row, and the reader answers false (fail-closed)', async () => {
    expect(await policyRow()).toBeNull();
    const shared = await asApp((c) => c.query<{ s: boolean }>('select internal.project_folders_shared() s'));
    expect(shared.rows[0]!.s).toBe(false);
  });

  it('tm8_app cannot read, insert or update the policy (42501)', async () => {
    expect(await outcome(() => asApp((c) => c.query('select * from internal.node_policy')))).toBe('42501');
    expect(await outcome(() => asApp((c) => c.query(
      `insert into internal.node_policy(key, value) values ('project_folders', 'shared')`,
    )))).toBe('42501');
    await writeNodePolicy(database.url, gatePosture(MULTI));
    expect(await outcome(() => asApp((c) => c.query(
      `update internal.node_policy set value = 'shared' where key = 'project_folders'`,
    )))).toBe('42501');
    expect(await policyRow()).toBe('one_space');
  });

  it('the owner write is what changes it — the boot writer, from gatePosture(config)', async () => {
    expect(await writeNodePolicy(database.url, gatePosture(LOOPBACK_SINGLE))).toBe('shared');
    expect(await policyRow()).toBe('shared');
    expect(await writeNodePolicy(database.url, gatePosture(OPEN_GATE_SINGLE))).toBe('one_space');
    expect(await policyRow()).toBe('one_space');
  });
});

describe('234 — no function carries PUBLIC EXECUTE', () => {
  it('every function 234 creates or replaces is revoked from PUBLIC (a grant property, not a test outcome)', async () => {
    const names = [
      'fill_project_entity_ref', 'fill_worktree_space', 'guard_space_project_link', 'sync_project_projections',
      'materialize_project_projection', 'grant_folder_row', 'project_entity_for', 'project_folders_shared',
      'require_gate_admin', 'space_project_unique_index_sql', 'create_space_project', 'gate_folders_list',
      'grant_folder', 'register_folder', 'resolve_project_ref', 'space_folders_for_caller', 'space_projects_for_caller',
    ];
    const rows = await asOwner((c) => c.query<{ fn: string; public_execute: boolean }>(
      `select p.oid::regprocedure::text fn,
              p.proacl is null
              or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')
                public_execute
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'internal') and p.proname = any($1::text[])`,
      [names],
    ));
    // Every name resolves (a rename would otherwise shrink this to a vacuous pass).
    expect(new Set(rows.rows.map((r) => r.fn.replace(/^(public|internal)\./, '').replace(/\(.*$/, '')))).toEqual(new Set(names));
    expect(rows.rows.filter((r) => r.public_execute).map((r) => r.fn)).toEqual([]);
  });
});

describe.sequential('decision 29 — a second grant of one folder', () => {
  it('no row: projects.link refuses F into B (23505) — the paired positive is the last case', async () => {
    await clearPolicy();
    expect(await linkFIntoB('norow')).toBe('23505');
    expect(await granted(ids.spaceB, ids.folderF)).toBe(false);
  });

  it('no row: create_space_project refuses F in B with folder_granted_elsewhere', async () => {
    await clearPolicy();
    const refused = await asApp((c) => c.query(
      `select public.create_space_project($1, $2, 'F in B', null)`, [ids.spaceB, ids.folderF],
    )).then(() => null, (error: { code?: string; detail?: string }) => error);
    expect(refused?.code).toBe('23505');
    expect(refused?.detail).toBe('folder_granted_elsewhere');
    // positive — the same caller names A's project on A's own folder G.
    expect(await outcome(() => asApp((c) => c.query(
      `select public.create_space_project($1, $2, 'G in A', null)`, [ids.spaceA, ids.folderG],
    )))).toBe('ok');
  });

  for (const [label, posture] of [['multi', MULTI], ['open-gate single', OPEN_GATE_SINGLE]] as const) {
    it(`a ${label} node: tm8_app cannot make the second grant, even after setting a GUC`, async () => {
      await writeNodePolicy(database.url, gatePosture(posture));
      expect(await linkFIntoB(`${label}-plain`)).toBe('23505');
      expect(await linkFIntoB(`${label}-guc`, (c) => c.query(
        `select set_config('tm8.project_folders', 'shared', true), set_config('tm8.node_policy', 'shared', true)`,
      ))).toBe('23505');
      expect(await granted(ids.spaceB, ids.folderF)).toBe(false);
    });
  }

  it('tm8_app cannot raise the value: on a gatePosture(multi) node its update fails and the link still refuses', async () => {
    await writeNodePolicy(database.url, gatePosture(MULTI));
    const raised = await outcome(() => asApp(async (c) => {
      await c.query(`update internal.node_policy set value = 'shared' where key = 'project_folders'`);
      await c.query(`select public.link_project_w2($1, $2, null, $3)`, [ids.spaceB, ids.folderF, `d29-raise-${randomUUID()}`]);
    }));
    expect(raised).toBe('42501');
    expect(await policyRow()).toBe('one_space');
    expect(await linkFIntoB('after-raise')).toBe('23505');
  });

  it('positive — a gatePosture(loopback single) node: the same caller links F into B', async () => {
    await writeNodePolicy(database.url, gatePosture(LOOPBACK_SINGLE));
    expect(await linkFIntoB('shared')).toBe('ok');
    expect(await granted(ids.spaceB, ids.folderF)).toBe(true);
  });
});

/** F's grant rows, as the owner sees them — what F2's fixes must never change. */
const fRows = (): Promise<string[]> =>
  asOwner((c) => c.query<{ r: string }>(
    `select space_id::text || '/' || project_id::text || '/' || coalesce(linked_by::text, '-') r
       from public.space_projects where project_id = $1 order by space_id`,
    [ids.folderF],
  )).then((r) => r.rows.map((row) => row.r));

describe.sequential('R845-F2 — a folder double-linked before 234, on a one-space node', () => {
  // The last case above left F in A AND B (linked while the node was shared);
  // making the node one-space now is the prod shape: seven such folders exist
  // and 234 must neither break them nor touch them (K13 resolves them).
  it('fixture: F is granted to A and B and the node is one-space', async () => {
    await writeNodePolicy(database.url, gatePosture(MULTI));
    expect(await policyRow()).toBe('one_space');
    expect(await granted(ids.spaceA, ids.folderF)).toBe(true);
    expect(await granted(ids.spaceB, ids.folderF)).toBe(true);
  });

  it('a space admin of A, then of B, names its project on F — neither is refused as granted elsewhere', async () => {
    const before = await fRows();
    expect(before).toHaveLength(2);
    expect(await outcome(() => asApp((c) => c.query(
      `select public.create_space_project($1, $2, 'F in A', null)`, [ids.spaceA, ids.folderF],
    )))).toBe('ok');
    expect(await outcome(() => asApp((c) => c.query(
      `select public.create_space_project($1, $2, 'F in B', null)`, [ids.spaceB, ids.folderF],
    )))).toBe('ok');
    expect(await fRows()).toEqual(before);
  });

  it('a gate admin re-running grant_folder on an existing pair passes the guard; no grant row changes', async () => {
    const before = await fRows();
    expect(await outcome(() => asGateAdmin((c) => c.query(
      `select public.grant_folder($1, $2, null)`, [ids.spaceA, ids.folderF],
    )))).toBe('ok');
    expect(await outcome(() => asGateAdmin((c) => c.query(
      `select public.grant_folder($1, $2, null)`, [ids.spaceB, ids.folderF],
    )))).toBe('ok');
    expect(await fRows()).toEqual(before);
  });

  it('negative, same node — a NEW grant of F into a third space is still refused (23505)', async () => {
    const spaceC = randomUUID();
    await asOwner((c) => c.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'D29 C', $2)`, [spaceC, ids.identityH],
    ));
    const before = await fRows();
    expect(await outcome(() => asGateAdmin((c) => c.query(
      `select public.grant_folder($1, $2, null)`, [spaceC, ids.folderF],
    )))).toBe('23505');
    expect(await fRows()).toEqual(before);
  });
});

describe('R845-F6 — a missing folder id is not an oracle for a space admin', () => {
  it('a space admin gets folder_not_granted (42501), the same as for a folder not granted here', async () => {
    const missing = await asApp((c) => c.query(
      `select public.create_space_project($1, $2, 'nope', null)`, [ids.spaceA, randomUUID()],
    )).then(() => null, (error: { code?: string; detail?: string }) => error);
    expect(missing?.code).toBe('42501');
    expect(missing?.detail).toBe('folder_not_granted');
  });

  it('positive — a gate admin still learns Folder not found (P0002)', async () => {
    expect(await outcome(() => asGateAdmin((c) => c.query(
      `select public.create_space_project($1, $2, 'nope', null)`, [ids.spaceA, randomUUID()],
    )))).toBe('P0002');
  });
});

describe('R845-F1 — correcting a project association through the real handler, as a space admin who is not a node admin', () => {
  function service(): W2ProjectsAssociationsService {
    db ??= createDb(database.url);
    return new W2ProjectsAssociationsService({
      db,
      config: { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: database.url },
      // The loopback owner is someone else; the caller is H's bearer session.
      owner: async () => ({
        identityId: ids.identityN,
        accountId: '00000000-0000-7000-8000-0000000000ff',
        username: 'n',
        isNodeAdmin: true,
        isOwner: true,
      }),
    });
  }

  it('H demotes a promoted commit association in A and gets the edge back, named from the space\'s project', async () => {
    const commitId = randomUUID();
    await asOwner(async (c) => {
      const projection = (await c.query<{ id: string }>(
        `select project_entity_id::text id from public.project_links where space_id = $1 and project_id = $2`,
        [ids.spaceA, ids.folderF],
      )).rows[0]!.id;
      await c.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'commit', $3, 'space')`,
        [commitId, ids.spaceA, ids.memberHA],
      );
      await c.query(
        `insert into public.commits(entity_id, space_id, repo, sha, message) values ($1, $2, 'tm8/f1', 'f1f1f1f', 'F1 commit')`,
        [commitId, ids.spaceA],
      );
      await c.query(`select internal.w1_set_writer('materialized')`);
      await c.query(
        `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
         values ($1, $2, $3, 'in_project', '{"promotedFromOrigin":"user"}'::jsonb, $4)`,
        [ids.spaceA, commitId, projection, ids.memberHA],
      );
      await c.query(`select internal.w1_set_writer(null)`);
    });
    const version = await asOwner((c) => c.query<{ v: number }>('select version v from public.entities where id = $1', [commitId]))
      .then((r) => Number(r.rows[0]!.v));

    const ctx = {
      op: { name: 'projects.associations.correct', method: 'POST', path: '/test', kind: 'write', status: 'v1' },
      opName: 'projects.associations.correct',
      params: { artifactId: commitId },
      query: new URLSearchParams(),
      body: { projectId: ids.folderF, expectedArtifactVersion: version, clientMutationId: `f1-${randomUUID()}` },
      requestId: `req-f1-${randomUUID().slice(0, 8)}`,
      identity: { kind: 'bearer', identityId: ids.identityH, token: 'tm8s_f1.unused', nodeAdmin: false, authKind: 'browser' },
      headers: {},
      method: 'POST',
      path: '/test',
    } as unknown as RequestContext;

    // Before the fix the edge read joined public.projects, which 234 hides from
    // anyone but an unpinned gate admin: the correction committed and the read
    // after it answered not_found.
    const result = await service().correctProjectAssociation(ctx);
    expect(result.outcome).toBe('demoted');
    expect(result.edge).not.toBeNull();
    expect(result.edge!.target.state).toEqual(expect.objectContaining({ kind: 'project', projectId: ids.folderF }));
    // The title is the space's own project name (F2 named it 'F in A'), not the folder's.
    expect(result.edge!.target.title).toBe('F in A');
  });
});
