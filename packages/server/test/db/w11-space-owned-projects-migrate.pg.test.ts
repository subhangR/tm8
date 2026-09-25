/**
 * W11 (plan 01a0d9eb §3, migrations 230 + 231) — a node that ALREADY has a
 * folder linked into two spaces still migrates, and every chat, work session
 * and worktree that existed before keeps opening the right folder.
 *
 * The chain is applied up to 229, an old-shaped node is seeded at that level
 * (folder F linked into A AND B, the shape 7 folders have on the perf copy),
 * then 230 and 231 are applied on top. Nothing here runs against anything but
 * this scratch database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db } from '../../src/db/types.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const ordinal = (file: string): number => Number(file.slice(0, 3));
const BEFORE = migrationFiles().filter((f) => ordinal(f) < 230);
const W11_MODEL = migrationFiles().filter((f) => f === '230_space_owned_projects.sql');
const W11_BACKFILL = migrationFiles().filter((f) => f === '231_space_owned_projects_backfill.sql');
const AFTER = migrationFiles().filter((f) => ordinal(f) > 231);

let database: W1ScratchDatabase;
let db: Db;

const ids = {
  identityH: `w11-h-${randomUUID()}`,
  accountH: randomUUID(),
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  spaceC: randomUUID(),
  memberHA: randomUUID(),
  memberHB: randomUUID(),
  memberHC: randomUUID(),
  personaA: randomUUID(),
  personaB: randomUUID(),
  /** Linked into A AND B before 230 — the double-linked shape. */
  folderF: randomUUID(),
  /** Linked into A only. */
  folderG: randomUUID(),
  chatA: randomUUID(),
  chatB: randomUUID(),
  wsA: randomUUID(),
  wsB: randomUUID(),
  wtA: randomUUID(),
  wtB: randomUUID(),
};

interface Stamp { id: string; updated_at: string }
let stampsBefore: Stamp[] = [];

async function asOwner<T>(fn: (q: { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** SQLSTATE of a raw owner-context statement, or 'ok'. */
async function rawOutcome(sql: string, params: unknown[]): Promise<string> {
  try {
    await asOwner((q) => q.query(sql, params));
    return 'ok';
  } catch (err) {
    return String((err as { code?: string }).code);
  }
}

const linkOf = (spaceId: string, folderId: string): Promise<string> =>
  database.query<{ project_entity_id: string }>(
    'select project_entity_id::text from public.project_links where space_id = $1 and project_id = $2',
    [spaceId, folderId],
  ).then((rows) => rows[0]!.project_entity_id);

async function seedOldShape(): Promise<void> {
  await asOwner(async (q) => {
    await q.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H')`, [ids.identityH]);
    await q.query(
      `insert into public.accounts(id, identity_id, username) values ($1, $2, $3)`,
      [ids.accountH, ids.identityH, `w11-h-${ids.accountH.slice(0, 8)}`],
    );
    await q.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'W11 A', $4), ($2, 'W11 B', $4), ($3, 'W11 C', $4)`,
      [ids.spaceA, ids.spaceB, ids.spaceC, ids.identityH],
    );
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $4, 'member', $1, 'space'), ($2, $5, 'member', $2, 'space'), ($3, $6, 'member', $3, 'space'),
              ($7, $4, 'team_member', $1, 'space'), ($8, $5, 'team_member', $2, 'space')`,
      [ids.memberHA, ids.memberHB, ids.memberHC, ids.spaceA, ids.spaceB, ids.spaceC, ids.personaA, ids.personaB],
    );
    await q.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $7, 'owner', 'H'), ($2, $5, $7, 'owner', 'H'), ($3, $6, $7, 'owner', 'H')`,
      [ids.memberHA, ids.memberHB, ids.memberHC, ids.spaceA, ids.spaceB, ids.spaceC, ids.identityH],
    );
    await q.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'W11 A mate', 'worker', 'persona'), ($3, $4, 'W11 B mate', 'worker', 'persona')`,
      [ids.personaA, ids.memberHA, ids.personaB, ids.memberHB],
    );
    await q.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'W11 F', '/tmp/w11-folder-f', 'trusted'), ($2, 'W11 G', '/tmp/w11-folder-g', 'trusted')`,
      [ids.folderF, ids.folderG],
    );
    // The double link: legal at 229 (the cap was 16 spaces per folder).
    await q.query(
      `insert into public.space_projects(space_id, project_id, linked_by)
       values ($1, $3, $5), ($2, $3, $6), ($1, $4, $5)`,
      [ids.spaceA, ids.spaceB, ids.folderF, ids.folderG, ids.memberHA, ids.memberHB],
    );
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $5, 'chat', $7, 'space'), ($2, $6, 'chat', $8, 'space'),
              ($3, $5, 'work_session', $9, 'space'), ($4, $6, 'work_session', $10, 'space')`,
      [ids.chatA, ids.chatB, ids.wsA, ids.wsB, ids.spaceA, ids.spaceB,
       ids.memberHA, ids.memberHB, ids.personaA, ids.personaB],
    );
    for (const [chat, space, mate, member] of [
      [ids.chatA, ids.spaceA, ids.personaA, ids.memberHA],
      [ids.chatB, ids.spaceB, ids.personaB, ids.memberHB],
    ] as const) {
      await q.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id, model, provider, agent_tool,
           chat_mode, workdir_mode, project_id, cwd, native_session_id,
           configured_by_identity_id, configured_by_member_id, client_mutation_id
         ) values ($1,$2,'W11 chat',$3,'claude-opus-5','anthropic','claude-code',
                   'ask','project',$4,'/tmp/w11-folder-f', gen_random_uuid(), $5, $6, $7)`,
        [chat, space, mate, ids.folderF, ids.identityH, member, `w11-${randomUUID()}`],
      );
    }
    await q.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, project_id, started_at)
       values ($1, 'W11 run A', 'running', 'none', $3, now()), ($2, 'W11 run B', 'running', 'none', $3, now())`,
      [ids.wsA, ids.wsB, ids.folderF],
    );
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'worktree', $5, 'space'), ($2, $4, 'worktree', $6, 'space')`,
      [ids.wtA, ids.wtB, ids.spaceA, ids.spaceB, ids.memberHA, ids.memberHB],
    );
    await q.query(
      `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid)
       values ($1, $3, '/tmp/w11-folder-f/.wt/a', 'w11/a', 'main', repeat('a', 40)),
              ($2, $3, '/tmp/w11-folder-f/.wt/b', 'w11/b', 'main', repeat('b', 40))`,
      [ids.wtA, ids.wtB, ids.folderF],
    );
  });
}

const stamps = (): Promise<Stamp[]> =>
  database.query<Stamp>(
    `select entity_id::text id, updated_at::text from public.chats where entity_id = any($1::uuid[])
     union all select entity_id::text, updated_at::text from public.work_sessions where entity_id = any($1::uuid[])
     union all select entity_id::text, updated_at::text from public.worktrees where entity_id = any($1::uuid[])
     order by 1`,
    [[ids.chatA, ids.chatB, ids.wsA, ids.wsB, ids.wtA, ids.wtB]],
  );

beforeAll(async () => {
  database = await createW1ScratchDatabase('w11_migrate');
  database.apply(BEFORE);
  await seedOldShape();
  stampsBefore = await stamps();
  database.apply(W11_MODEL);
  db = createDb(database.url, { max: 2 });
}, 240_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

describe('230 on a node with a double-linked folder', () => {
  it('the chain has exactly one 230 and one 231', () => {
    expect(W11_MODEL).toHaveLength(1);
    expect(W11_BACKFILL).toHaveLength(1);
  });

  it('migrates, and the existing double link is kept as it was', async () => {
    const rows = await database.query<{ space_id: string }>(
      'select space_id::text from public.space_projects where project_id = $1 order by space_id',
      [ids.folderF],
    );
    expect(rows.map((r) => r.space_id).sort()).toEqual([ids.spaceA, ids.spaceB].sort());
  });

  it('the one-space-per-folder unique index is DEFERRED: building it now fails on this data', async () => {
    const [{ ddl }] = await database.query<{ ddl: string }>(
      'select internal.space_project_unique_index_sql() ddl',
    );
    expect(ddl).toMatch(/unique index .* on public\.space_projects\s*\(project_id\)/i);
    expect(await rawOutcome(ddl, [])).toBe('23505');
  });

  it('a NEW grant of the double-linked folder to a third space is refused (23505)', async () => {
    expect(await rawOutcome(
      'insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)',
      [ids.spaceC, ids.folderF, ids.memberHC],
    )).toBe('23505');
  });

  it('a new grant of a single-linked folder to another space is refused (23505)', async () => {
    expect(await rawOutcome(
      'insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)',
      [ids.spaceC, ids.folderG, ids.memberHC],
    )).toBe('23505');
  });

  it('positive — an ungranted folder is granted to that third space', async () => {
    const fresh = randomUUID();
    await asOwner((q) => q.query(
      `insert into public.projects(id, name, working_dir, trust) values ($1, 'W11 fresh', $2, 'trusted')`,
      [fresh, `/tmp/w11-fresh-${fresh}`],
    ));
    expect(await rawOutcome(
      'insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)',
      [ids.spaceC, fresh, ids.memberHC],
    )).toBe('ok');
  });

  it('before 231, the old rows carry no project entity ref (only new rows are filled)', async () => {
    const rows = await database.query<{ n: number }>(
      `select count(*)::int n from public.chats where entity_id = any($1::uuid[]) and project_entity_id is not null`,
      [[ids.chatA, ids.chatB]],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('a chat created after 230 is filled with its space\'s project entity by the trigger', async () => {
    const chat = randomUUID();
    await asOwner(async (q) => {
      await q.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'chat', $3, 'space')`,
        [chat, ids.spaceB, ids.memberHB],
      );
      await q.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id, model, provider, agent_tool,
           chat_mode, workdir_mode, project_id, cwd, native_session_id,
           configured_by_identity_id, configured_by_member_id, client_mutation_id
         ) values ($1,$2,'W11 new chat',$3,'claude-opus-5','anthropic','claude-code',
                   'ask','project',$4,'/tmp/w11-folder-f', gen_random_uuid(), $5, $6, $7)`,
        [chat, ids.spaceB, ids.personaB, ids.folderF, ids.identityH, ids.memberHB, `w11-${randomUUID()}`],
      );
    });
    const [row] = await database.query<{ project_entity_id: string }>(
      'select project_entity_id::text from public.chats where entity_id = $1', [chat]);
    expect(row!.project_entity_id).toBe(await linkOf(ids.spaceB, ids.folderF));
  });
});

describe('231 backfill on the old-shaped rows (a5)', () => {
  beforeAll(() => {
    database.apply(W11_BACKFILL);
  });

  it('each chat points at ITS space\'s project entity; project_id is untouched', async () => {
    const rows = await database.query<{ id: string; project_id: string; project_entity_id: string }>(
      `select entity_id::text id, project_id::text, project_entity_id::text from public.chats
        where entity_id = any($1::uuid[])`,
      [[ids.chatA, ids.chatB]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.chatA)!.project_entity_id).toBe(await linkOf(ids.spaceA, ids.folderF));
    expect(byId.get(ids.chatB)!.project_entity_id).toBe(await linkOf(ids.spaceB, ids.folderF));
    expect(byId.get(ids.chatA)!.project_entity_id).not.toBe(byId.get(ids.chatB)!.project_entity_id);
    expect(rows.every((r) => r.project_id === ids.folderF)).toBe(true);
  });

  it('each work session points at its entity\'s space\'s project entity', async () => {
    const rows = await database.query<{ id: string; project_id: string; project_entity_id: string }>(
      `select entity_id::text id, project_id::text, project_entity_id::text from public.work_sessions
        where entity_id = any($1::uuid[])`,
      [[ids.wsA, ids.wsB]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.wsA)!.project_entity_id).toBe(await linkOf(ids.spaceA, ids.folderF));
    expect(byId.get(ids.wsB)!.project_entity_id).toBe(await linkOf(ids.spaceB, ids.folderF));
    expect(rows.every((r) => r.project_id === ids.folderF)).toBe(true);
  });

  it('each worktree gets its space and its space\'s project entity', async () => {
    const rows = await database.query<{ id: string; space_id: string; project_entity_id: string }>(
      `select entity_id::text id, space_id::text, project_entity_id::text from public.worktrees
        where entity_id = any($1::uuid[])`,
      [[ids.wtA, ids.wtB]],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(ids.wtA)).toMatchObject({ space_id: ids.spaceA, project_entity_id: await linkOf(ids.spaceA, ids.folderF) });
    expect(byId.get(ids.wtB)).toMatchObject({ space_id: ids.spaceB, project_entity_id: await linkOf(ids.spaceB, ids.folderF) });
  });

  it('no updated_at moved: no chat reorders, no worktree emits a version', async () => {
    expect(await stamps()).toEqual(stampsBefore);
  });

  it('the touch triggers are back on after 231', async () => {
    const rows = await database.query<{ tgname: string; tgenabled: string }>(
      `select tgname, tgenabled from pg_trigger
        where tgname in ('chats_touch_updated_at', 'work_sessions_touch_updated_at',
                         'worktrees_touch_updated_at', 'worktrees_snapshot_version')`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.tgenabled === 'O')).toBe(true);
  });

  it('existing sessions and chats still open the right folder, from either space', async () => {
    for (const space of [ids.spaceA, ids.spaceB]) {
      const rows = await db.tx(
        { identityId: ids.identityH, authKind: 'browser', requestId: `w11-a5-${randomUUID()}` },
        (q) => q.query<{ id: string; working_dir: string; space_id: string }>(
          'select folder_id::text id, working_dir, space_id::text from public.resolve_project_ref($1::uuid, $2::uuid)',
          [ids.folderF, space],
        ),
      );
      expect(rows).toEqual([{ id: ids.folderF, working_dir: '/tmp/w11-folder-f', space_id: space }]);
    }
  });

  it('the backfilled project entity resolves to the same folder', async () => {
    const entityB = await linkOf(ids.spaceB, ids.folderF);
    const rows = await db.tx(
      { identityId: ids.identityH, authKind: 'browser', requestId: `w11-a5-${randomUUID()}` },
      (q) => q.query<{ id: string; space_id: string }>(
        'select folder_id::text id, space_id::text from public.resolve_project_ref($1::uuid)', [entityB]),
    );
    expect(rows).toEqual([{ id: ids.folderF, space_id: ids.spaceB }]);
  });

  it('231 is idempotent: a second application changes nothing', async () => {
    const before = await database.query(
      'select entity_id, project_entity_id from public.chats order by entity_id');
    database.apply(W11_BACKFILL);
    expect(await database.query(
      'select entity_id, project_entity_id from public.chats order by entity_id')).toEqual(before);
  });

  it('the rest of the chain applies on top', () => {
    expect(() => database.apply(AFTER)).not.toThrow();
  });
});
