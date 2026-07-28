import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identityA: string;
  identityB: string;
  spaceId: string;
  otherSpaceId: string;
  memberA: string;
  memberB: string;
  otherMemberA: string;
  taskId: string;
}

interface SavedViewRecord {
  id: string;
  space_id: string;
  owner_member_id: string;
  name: string;
  share_mode: 'private' | 'space';
  query: Record<string, unknown>;
  graph_layout: Record<string, { x: number; y: number }> | null;
  created_at: string;
  updated_at: string;
}

const BASELINE_MIGRATIONS = Array.from({ length: 15 }, (_, index) =>
  `${String(index + 1).padStart(3, '0')}_`,
);

function explicitG09Migrations(): string[] {
  const files = migrationFiles();
  const baseline = BASELINE_MIGRATIONS.map((prefix) => {
    const file = files.find((candidate) => candidate.startsWith(prefix));
    if (!file) throw new Error(`missing baseline migration ${prefix}`);
    return file;
  });
  return [...baseline, '024_w2_saved_views_actions.sql'];
}

async function seed(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const fixture = (await client.query<Fixture>(
      `select 'g09-identity-a'::text as "identityA",
              'g09-identity-b'::text as "identityB",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "otherSpaceId",
              internal.new_id()::text as "memberA",
              internal.new_id()::text as "memberB",
              internal.new_id()::text as "otherMemberA",
              internal.new_id()::text as "taskId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G09 A'), ($2, 'G09 B')`,
      [fixture.identityA, fixture.identityB],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G09 shared', $3), ($2, 'G09 other', $3)`,
      [fixture.spaceId, fixture.otherSpaceId, fixture.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $4, 'member', $1),
              ($2, $4, 'member', $2),
              ($3, $5, 'member', $3),
              ($6, $4, 'task', $1)`,
      [
        fixture.memberA,
        fixture.memberB,
        fixture.otherMemberA,
        fixture.spaceId,
        fixture.otherSpaceId,
        fixture.taskId,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $4, $6, 'owner', 'G09 A'),
              ($2, $4, $7, 'member', 'G09 B'),
              ($3, $5, $6, 'owner', 'G09 A other')`,
      [
        fixture.memberA,
        fixture.memberB,
        fixture.otherMemberA,
        fixture.spaceId,
        fixture.otherSpaceId,
        fixture.identityA,
        fixture.identityB,
      ],
    );
    await client.query(
      `insert into public.tasks(entity_id, title) values ($1, 'Must remain unchanged')`,
      [fixture.taskId],
    );
    return fixture;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identityId: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [identityId]);
    return fn(client);
  });
}

async function createView(
  database: W1ScratchDatabase,
  fixture: Fixture,
  options: { identityId?: string; name: string; shareMode: 'private' | 'space'; mutationId: string },
): Promise<SavedViewRecord> {
  return asApp(database, options.identityId ?? fixture.identityA, async (client) => {
    const result = await client.query<{ result: SavedViewRecord }>(
      `select public.create_saved_view($1, $2, $3, $4::jsonb, $5::jsonb, null, $6) result`,
      [
        fixture.spaceId,
        options.name,
        options.shareMode,
        JSON.stringify({ spaceId: fixture.spaceId, kinds: ['task'], layout: 'graph' }),
        JSON.stringify({ [fixture.taskId]: { x: 10, y: 20 } }),
        options.mutationId,
      ],
    );
    return result.rows[0]!.result;
  });
}

describe.sequential('W2.G09 saved-view PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g09');
    database.apply(explicitG09Migrations());
    fixture = await seed(database);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('adds only the three saved-view RPCs with explicit application execution grants', async () => {
    const rows = await database.query<{
      proname: string;
      app_exec: boolean;
      public_exec: boolean;
    }>(
      `select p.proname,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('create_saved_view','update_saved_view','delete_saved_view')
        order by p.proname`,
    );
    expect(rows.map((row) => row.proname)).toEqual([
      'create_saved_view',
      'delete_saved_view',
      'update_saved_view',
    ]);
    expect(rows.every((row) => row.app_exec && !row.public_exec)).toBe(true);
  });

  it('persists query/layout without touching selected entities and denies direct handler-role DML', async () => {
    const before = await database.query<{ version: number; updated_at: string }>(
      `select version, updated_at::text from public.entities where id = $1`,
      [fixture.taskId],
    );
    const created = await createView(database, fixture, {
      name: 'Persisted graph lens',
      shareMode: 'private',
      mutationId: 'g09-persist-create',
    });

    expect(created).toMatchObject({
      space_id: fixture.spaceId,
      owner_member_id: fixture.memberA,
      name: 'Persisted graph lens',
      share_mode: 'private',
      query: { spaceId: fixture.spaceId, kinds: ['task'], layout: 'graph' },
      graph_layout: { [fixture.taskId]: { x: 10, y: 20 } },
    });
    const after = await database.query<{ version: number; updated_at: string }>(
      `select version, updated_at::text from public.entities where id = $1`,
      [fixture.taskId],
    );
    expect(after).toEqual(before);

    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `update public.saved_views set name = 'raw write' where id = $1`,
      [created.id],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces private/space visibility through membership RLS and never through share visibility alone', async () => {
    const privateView = await createView(database, fixture, {
      name: 'A private',
      shareMode: 'private',
      mutationId: 'g09-private-create',
    });
    const sharedView = await createView(database, fixture, {
      name: 'A shared',
      shareMode: 'space',
      mutationId: 'g09-shared-create',
    });

    const visibleToA = await asApp(database, fixture.identityA, async (client) => (
      await client.query<{ id: string }>(
        `select id::text from public.saved_views where id in ($1, $2) order by id`,
        [privateView.id, sharedView.id],
      )
    ).rows.map((row) => row.id));
    expect(visibleToA).toEqual([privateView.id, sharedView.id].sort());

    const visibleToB = await asApp(database, fixture.identityB, async (client) => (
      await client.query<{ id: string }>(
        `select id::text from public.saved_views where id in ($1, $2) order by id`,
        [privateView.id, sharedView.id],
      )
    ).rows.map((row) => row.id));
    expect(visibleToB).toEqual([sharedView.id]);

    const visibleToOutsider = await asApp(database, 'g09-outsider', async (client) => (
      await client.query<{ id: string }>(
        `select id::text from public.saved_views where id in ($1, $2)`,
        [privateView.id, sharedView.id],
      )
    ).rows.map((row) => row.id));
    expect(visibleToOutsider).toEqual([]);

    await expect(asApp(database, fixture.identityB, (client) => client.query(
      `select public.update_saved_view($1, 'stolen', 'space', $2::jsonb, null, null, $3)`,
      [
        sharedView.id,
        JSON.stringify({ spaceId: fixture.spaceId }),
        'g09-shared-stolen-update',
      ],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.identityB, (client) => client.query(
      `select public.delete_saved_view($1, null, $2)`,
      [sharedView.id, 'g09-shared-stolen-delete'],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('serializes concurrent create replays and records one command-ledger result', async () => {
    const mutationId = `g09-concurrent-${randomUUID()}`;
    const run = () => createView(database, fixture, {
      name: 'Concurrent one',
      shareMode: 'private',
      mutationId,
    });
    const [first, second] = await Promise.all([run(), run()]);
    expect(second).toEqual(first);

    const rows = await database.query<{ views: number; ledgers: number }>(
      `select count(*) filter (where sv.name = 'Concurrent one')::integer views,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = $1 and operation = 'savedViews.create') ledgers
         from public.saved_views sv`,
      [mutationId],
    );
    expect(rows[0]).toEqual({ views: 1, ledgers: 1 });
  });

  it('updates under an owner row lock, refuses a cross-Space query, and replays exactly', async () => {
    const created = await createView(database, fixture, {
      name: 'Update me',
      shareMode: 'private',
      mutationId: 'g09-update-create',
    });
    const update = () => asApp(database, fixture.identityA, async (client) => (
      await client.query<{ result: SavedViewRecord }>(
        `select public.update_saved_view($1, 'Updated once', 'space', $2::jsonb, null, null, $3) result`,
        [created.id, JSON.stringify({ spaceId: fixture.spaceId, kinds: ['doc'] }), 'g09-update-once'],
      )
    ).rows[0]!.result);
    const first = await update();
    const replay = await update();
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ name: 'Updated once', share_mode: 'space', graph_layout: null });

    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `select public.update_saved_view($1, 'Move spaces', 'space', $2::jsonb, null, null, $3)`,
      [created.id, JSON.stringify({ spaceId: fixture.otherSpaceId }), 'g09-update-cross-space'],
    ))).rejects.toMatchObject({ code: '22023' });
  });

  it('deletes idempotently and replays the frozen SavedView output after the row is gone', async () => {
    const created = await createView(database, fixture, {
      name: 'Delete me',
      shareMode: 'private',
      mutationId: 'g09-delete-create',
    });
    const remove = () => asApp(database, fixture.identityA, async (client) => (
      await client.query<{ result: SavedViewRecord }>(
        `select public.delete_saved_view($1, null, $2) result`,
        [created.id, 'g09-delete-once'],
      )
    ).rows[0]!.result);
    const first = await remove();
    const replay = await remove();
    expect(replay).toEqual(first);
    expect(first.id).toBe(created.id);

    const rows = await database.query<{ count: number }>(
      `select count(*)::integer count from public.saved_views where id = $1`,
      [created.id],
    );
    expect(rows[0]!.count).toBe(0);
  });

  it('rejects non-object query/layout payloads at the RPC boundary', async () => {
    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `select public.create_saved_view($1, 'Bad query', 'private', '[]'::jsonb, null, null, $2)`,
      [fixture.spaceId, 'g09-bad-query'],
    ))).rejects.toMatchObject({ code: '22023' });
    await expect(asApp(database, fixture.identityA, (client) => client.query(
      `select public.create_saved_view($1, 'Bad layout', 'private', '{}'::jsonb, '[]'::jsonb, null, $2)`,
      [fixture.spaceId, 'g09-bad-layout'],
    ))).rejects.toMatchObject({ code: '22023' });
  });
});
