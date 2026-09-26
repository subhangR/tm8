/**
 * The one-space-per-folder unique index W11 deferred (K13). Its file carries
 * the placeholder ordinal 999 until #874 leaves draft; it is found by name.
 *
 * A node is seeded before 234 with folder F granted to spaces A and B (the
 * shape 7 folders had on prod), then migrated through the rest of the chain. The index file is applied
 * repeatedly as the node policy and the grants change: it builds the index
 * only on a 'one_space' node, refuses there while F is granted twice, and
 * builds it once the second grant is unlinked.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ONE_SPACE_INDEX, oneSpaceIndexMissing } from '../../src/projects/node-policy.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const ordinal = (file: string): number => Number(file.slice(0, 3));
const INDEX_FILE = /^\d{3}_space_projects_one_space_per_folder\.sql$/;
const BEFORE_234 = migrationFiles().filter((f) => ordinal(f) < 234);
const REST = migrationFiles().filter((f) => ordinal(f) >= 234 && !INDEX_FILE.test(f));
const INDEX_MIGRATION = migrationFiles().filter((f) => INDEX_FILE.test(f));
const INDEX = ONE_SPACE_INDEX;

let database: W1ScratchDatabase;

const ids = {
  identity: `w11-idx-${randomUUID()}`,
  account: randomUUID(),
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
  folderF: randomUUID(),
};

async function asOwner(fn: (q: { query: (sql: string, p?: unknown[]) => Promise<unknown> }) => Promise<void>): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await fn(client);
  });
}

async function seedDoubleGrant(): Promise<void> {
  await asOwner(async (q) => {
    await q.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'I')`, [ids.identity]);
    await q.query(
      `insert into public.accounts(id, identity_id, username) values ($1, $2, $3)`,
      [ids.account, ids.identity, `w11-idx-${ids.account.slice(0, 8)}`],
    );
    await q.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'IDX A', $3), ($2, 'IDX B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identity],
    );
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB],
    );
    await q.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'I'), ($2, $4, $5, 'owner', 'I')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB, ids.identity],
    );
    await q.query(
      `insert into public.projects(id, name, working_dir, trust) values ($1, 'IDX F', '/tmp/w11-idx-f', 'trusted')`,
      [ids.folderF],
    );
    // Legal before 234: one folder in two spaces.
    await q.query(
      `insert into public.space_projects(space_id, project_id, linked_by) values ($1, $3, $4), ($2, $3, $5)`,
      [ids.spaceA, ids.spaceB, ids.folderF, ids.memberA, ids.memberB],
    );
  });
}

const setPolicy = (value: string | null): Promise<unknown> =>
  value === null
    ? database.query(`delete from internal.node_policy where key = 'project_folders'`)
    : database.query(
      `insert into internal.node_policy (key, value) values ('project_folders', $1)
       on conflict (key) do update set value = excluded.value`,
      [value],
    );

const indexDef = async (): Promise<string | null> => {
  const rows = await database.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where schemaname = 'public' and indexname = $1`,
    [INDEX],
  );
  return rows[0]?.indexdef ?? null;
};

function applyOutcome(): string {
  try {
    database.apply(INDEX_MIGRATION);
    return 'ok';
  } catch (error) {
    return String((error as Error).message);
  }
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('w11_index');
  database.apply(BEFORE_234);
  await seedDoubleGrant();
  database.apply(REST);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

describe('one space per folder index', () => {
  it('the chain has exactly one index migration', () => {
    expect(INDEX_MIGRATION).toHaveLength(1);
  });

  it('no policy row (a node that has not booted 234): changes nothing', async () => {
    await setPolicy(null);
    expect(applyOutcome()).toBe('ok');
    expect(await indexDef()).toBeNull();
    expect(await oneSpaceIndexMissing(database.url)).toBe(true);
  });

  it("a 'shared' (loopback) node: changes nothing, the double grant stays legal", async () => {
    await setPolicy('shared');
    expect(applyOutcome()).toBe('ok');
    expect(await indexDef()).toBeNull();
  });

  it("a 'one_space' node with a folder still granted twice: refuses, names the folder, builds nothing", async () => {
    await setPolicy('one_space');
    const outcome = applyOutcome();
    expect(outcome).toContain('one-space-per-folder index refused: folders still granted to more than one space');
    expect(outcome).toContain(ids.folderF);
    expect(await indexDef()).toBeNull();
    // What the boot WARNING reads: a one_space node without the index.
    expect(await oneSpaceIndexMissing(database.url)).toBe(true);
  });

  it("after the second grant is unlinked: builds the index 234 recorded", async () => {
    await asOwner((q) => q.query(
      'delete from public.space_projects where space_id = $1 and project_id = $2',
      [ids.spaceB, ids.folderF],
    ));
    expect(applyOutcome()).toBe('ok');
    const def = await indexDef();
    expect(def).toMatch(/CREATE UNIQUE INDEX space_projects_one_space_per_folder ON public\.space_projects USING btree \(project_id\)/);
    const [ddl] = await database.query<{ ddl: string }>('select internal.space_project_unique_index_sql() ddl');
    expect(ddl!.ddl).toContain(INDEX);
    // The paired negative: once built, the boot check is quiet.
    expect(await oneSpaceIndexMissing(database.url)).toBe(false);
  });

  it('re-running is a no-op', async () => {
    const before = await indexDef();
    expect(applyOutcome()).toBe('ok');
    expect(await indexDef()).toBe(before);
  });

  it('a second grant of the folder is refused (23505)', async () => {
    let code = 'ok';
    try {
      await asOwner((q) => q.query(
        'insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)',
        [ids.spaceB, ids.folderF, ids.memberB],
      ));
    } catch (error) {
      code = String((error as { code?: string }).code);
    }
    expect(code).toBe('23505');
  });
});
