import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SpaceSettingsViewSchema, type SpaceSettingsView } from '@tm8/contract';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * Dossier A03 freezes `spaces.defaultChannel.set` as
 * `SetDefaultChannelInput -> SpaceSettingsView`, and 029:310
 * `internal.w2_space_settings_view` — "Build the exact A03 response while the
 * command still owns the Space lock" — returns exactly these eight keys from
 * inside the command transaction. Every acknowledgement below is therefore
 * asserted against the frozen contract itself, not against a field subset.
 */
const FROZEN_SETTINGS_KEYS = [
  'defaultChannelId',
  'defaultInteractionProfileId',
  'invites',
  'members',
  'menu',
  'settingsRevision',
  'space',
  'taskAxes',
];

function frozenSettingsView(raw: unknown, spaceId: string): SpaceSettingsView {
  expect(Object.keys(raw as object).sort()).toEqual(FROZEN_SETTINGS_KEYS);
  const view = SpaceSettingsViewSchema.parse(raw);
  expect(view.space.id).toBe(spaceId);
  return view;
}

const BASELINE_001_016 = Array.from(
  { length: 16 },
  (_, index) => `${String(index + 1).padStart(3, '0')}_`,
);

function explicitMigrations(): string[] {
  const files = migrationFiles();
  return [
    ...BASELINE_001_016.map((prefix) => {
      const file = files.find((candidate) => candidate.startsWith(prefix));
      if (!file) throw new Error(`missing baseline migration ${prefix}`);
      return file;
    }),
    '029_w2_menu_default_channel.sql',
  ];
}

function explicitFrozenTrancheMigrations(): string[] {
  const files = migrationFiles();
  const through018 = Array.from(
    { length: 18 },
    (_, index) => `${String(index + 1).padStart(3, '0')}_`,
  ).map((prefix) => {
    const file = files.find((candidate) => candidate.startsWith(prefix));
    if (!file) throw new Error(`missing frozen-tranche migration ${prefix}`);
    return file;
  });
  return [
    ...through018,
    '020_w2_collections_graph_undo.sql',
    '021_w2_projects.sql',
    '022_w2_files.sql',
    '023_w2_inbox.sql',
    '024_w2_saved_views_actions.sql',
    '029_w2_menu_default_channel.sql',
  ];
}

const DEFAULT_GROUPS = [
  {
    id: 'home',
    label: 'Home',
    items: [
      { type: 'view', ref: 'dashboard' },
      { type: 'view', ref: 'feed' },
      { type: 'view', ref: 'inbox' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    items: [{
      type: 'view',
      ref: 'workspace',
      children: [
        { type: 'kind', ref: 'task' },
        { type: 'kind', ref: 'work_session' },
        { type: 'kind', ref: 'doc' },
        { type: 'kind', ref: 'team_member' },
      ],
    }],
  },
  {
    id: 'tracking',
    label: 'Tracking',
    items: [
      { type: 'kind', ref: 'project' },
      { type: 'kind', ref: 'pull_request' },
    ],
  },
  { id: 'collab', label: 'Collab', items: [{ type: 'kind', ref: 'member' }] },
  { id: 'channels', label: 'Channels', items: [{ type: 'view', ref: 'channels' }] },
  { id: 'settings', label: 'Settings', items: [{ type: 'view', ref: 'settings' }] },
] as const;

function payload(groups: readonly unknown[] = DEFAULT_GROUPS): Record<string, unknown> {
  return { schemaVersion: 1, groups };
}

interface Fixture {
  ownerIdentity: string;
  memberIdentity: string;
  outsiderIdentity: string;
  spaceA: string;
  spaceB: string;
  corruptSpace: string;
  futureSpace: string;
  missingSpace: string;
  ownerA: string;
  ownerB: string;
  corruptOwner: string;
  futureOwner: string;
  missingOwner: string;
  memberA: string;
  agentA: string;
  channelA1: string;
  channelA2: string;
  channelB: string;
  taskA: string;
}

async function seedBefore029(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Fixture>(
      `select 'g14-owner'::text "ownerIdentity",
              'g14-member'::text "memberIdentity",
              'g14-outsider'::text "outsiderIdentity",
              internal.new_id()::text "spaceA",
              internal.new_id()::text "spaceB",
              internal.new_id()::text "corruptSpace",
              internal.new_id()::text "futureSpace",
              internal.new_id()::text "missingSpace",
              internal.new_id()::text "ownerA",
              internal.new_id()::text "ownerB",
              internal.new_id()::text "corruptOwner",
              internal.new_id()::text "futureOwner",
              internal.new_id()::text "missingOwner",
              internal.new_id()::text "memberA",
              internal.new_id()::text "agentA",
              internal.new_id()::text "channelA1",
              internal.new_id()::text "channelA2",
              internal.new_id()::text "channelB",
              internal.new_id()::text "taskA"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G14 Owner'), ($2, 'G14 Member'), ($3, 'G14 Outsider')`,
      [ids.ownerIdentity, ids.memberIdentity, ids.outsiderIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'g14-owner', 'G14 Owner', true, true),
              ($2, 'g14-member', 'G14 Member', false, false),
              ($3, 'g14-outsider', 'G14 Outsider', false, false)`,
      [ids.ownerIdentity, ids.memberIdentity, ids.outsiderIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G14 A', $6), ($2, 'G14 B', $6), ($3, 'G14 corrupt', $6),
              ($4, 'G14 future', $6), ($5, 'G14 missing', $6)`,
      [ids.spaceA, ids.spaceB, ids.corruptSpace, ids.futureSpace, ids.missingSpace, ids.ownerIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values
         ($1, $6, 'member', 0, $1), ($2, $7, 'member', 0, $2),
         ($3, $8, 'member', 0, $3), ($4, $9, 'member', 0, $4),
         ($5, $10, 'member', 0, $5), ($11, $6, 'member', 1, $11),
         ($12, $6, 'team_member', 2, $1),
         ($13, $6, 'channel', 0, $1), ($14, $6, 'channel', 1, $1),
         ($15, $7, 'channel', 0, $2), ($16, $6, 'task', 3, $1)`,
      [
        ids.ownerA, ids.ownerB, ids.corruptOwner, ids.futureOwner, ids.missingOwner,
        ids.spaceA, ids.spaceB, ids.corruptSpace, ids.futureSpace, ids.missingSpace,
        ids.memberA, ids.agentA, ids.channelA1, ids.channelA2, ids.channelB, ids.taskA,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values
         ($1, $6, $11, 'owner', 'G14 Owner A'),
         ($2, $7, $11, 'owner', 'G14 Owner B'),
         ($3, $8, $11, 'owner', 'G14 Owner corrupt'),
         ($4, $9, $11, 'owner', 'G14 Owner future'),
         ($5, $10, $11, 'owner', 'G14 Owner missing'),
         ($12, $6, $13, 'member', 'G14 Member')`,
      [
        ids.ownerA, ids.ownerB, ids.corruptOwner, ids.futureOwner, ids.missingOwner,
        ids.spaceA, ids.spaceB, ids.corruptSpace, ids.futureSpace, ids.missingSpace,
        ids.ownerIdentity, ids.memberA, ids.memberIdentity,
      ],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role)
       values ($1, $2, 'G14 Agent', 'helper')`,
      [ids.agentA, ids.ownerA],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1, $4, 'alpha', ''), ($2, $4, 'beta', ''), ($3, $5, 'other', '')`,
      [ids.channelA1, ids.channelA2, ids.channelB, ids.spaceA, ids.spaceB],
    );
    await client.query(
      `insert into public.tasks(entity_id, title) values ($1, 'Not a channel')`,
      [ids.taskA],
    );
    await client.query(`select internal.w1_set_writer('space_settings')`);
    await client.query(
      `update public.spaces set default_channel_id = $2 where id = $1`,
      [ids.spaceA, ids.channelA1],
    );
    await client.query(`select internal.w1_set_writer(null)`);

    await client.query(
      `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
       values
         ($1, 1, 3, internal.w1_default_menu_payload()),
         ($2, 1, 7, '{"groups":[{"id":"broken","label":"Broken","items":[{"type":"view","ref":"unknown"},{"type":"view","ref":"settings"}]}]}'::jsonb),
         ($3, 2, 9, '{"opaqueFuture":{"must":"survive"},"groups":[]}'::jsonb)`,
      [ids.spaceA, ids.corruptSpace, ids.futureSpace],
    );
    return ids;
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identity: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
  actorId: string | null = null,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', $2, true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'req-g14-pg', true)`,
      [identity, actorId ?? ''],
    );
    return fn(client);
  });
}

function detail(error: unknown): Record<string, unknown> {
  const raw = (error as { detail?: unknown }).detail;
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { detail: raw };
  }
}

async function settingsRevision(database: W1ScratchDatabase, spaceId: string): Promise<number> {
  return (await database.query<{ revision: number }>(
    `select settings_revision revision from public.spaces where id = $1`,
    [spaceId],
  ))[0]!.revision;
}

describe.sequential('W2.G14 menu/default-channel PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g14');
    const migrations = explicitMigrations();
    database.apply(migrations.slice(0, 16));
    fixture = await seedBefore029(database);
    database.apply(migrations.slice(16));
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('applies after exactly 001-016, backfills the one shipped default, and closes ACLs', async () => {
    const backfilled = (await database.query<{
      schema_version: number;
      revision: number;
      payload: { groups: unknown[] };
    }>(
      `select schema_version, revision, payload
         from public.space_menu_configs where space_id = $1`,
      [fixture.missingSpace],
    ))[0]!;
    const shipped = (await database.query<{ payload: { groups: unknown[] } }>(
      `select internal.w1_default_menu_payload() payload`,
    ))[0]!.payload;
    expect(backfilled).toEqual({ schema_version: 1, revision: 1, payload: shipped });

    const functions = await database.query<{
      name: string;
      app_exec: boolean;
      public_exec: boolean;
    }>(
      `select p.proname name,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('get_space_menu','update_space_menu','set_space_default_channel',
                            'set_space_menu_config')
        order by p.proname`,
    );
    expect(functions).toEqual([
      { name: 'get_space_menu', app_exec: true, public_exec: false },
      { name: 'set_space_default_channel', app_exec: true, public_exec: false },
      { name: 'set_space_menu_config', app_exec: false, public_exec: false },
      { name: 'update_space_menu', app_exec: true, public_exec: false },
    ]);

    await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
      `update public.space_menu_configs set revision = revision + 1 where space_id = $1`,
      [fixture.spaceA],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
      `update public.spaces set default_channel_id = null where id = $1`,
      [fixture.spaceA],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('materializes both defaults for newly created Spaces without a channel-name heuristic', async () => {
    const created = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{
        result: { space: { id: string }; defaultChannelId: string };
      }>(
        `select public.create_space('G14 created', '', 'private', null, 'g14-create') result`,
      )
    ).rows[0]!.result);
    const stored = (await database.query<{
      default_channel_id: string;
      schema_version: number;
      revision: number;
      payload: { groups: unknown[] };
    }>(
      `select s.default_channel_id::text, m.schema_version, m.revision, m.payload
         from public.spaces s join public.space_menu_configs m on m.space_id = s.id
        where s.id = $1`,
      [created.space.id],
    ))[0]!;
    expect(stored.default_channel_id).toBe(created.defaultChannelId);
    expect(stored).toMatchObject({ schema_version: 1, revision: 1 });
    expect(stored.payload.groups).toEqual(DEFAULT_GROUPS);
  });

  it('renders valid, corrupt, future and missing storage states without overwriting raw future data', async () => {
    const valid = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ menu: { revision: number; groups: unknown[] } }>(
        `select public.get_space_menu($1) menu`, [fixture.spaceA],
      )
    ).rows[0]!.menu);
    expect(valid).toEqual({ schemaVersion: 1, revision: 3, groups: DEFAULT_GROUPS });

    const corrupt = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ menu: { revision: number; groups: unknown[] } }>(
        `select public.get_space_menu($1) menu`, [fixture.corruptSpace],
      )
    ).rows[0]!.menu);
    expect(corrupt).toEqual({ schemaVersion: 1, revision: 7, groups: DEFAULT_GROUPS });

    const future = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ menu: { revision: number; groups: unknown[] } }>(
        `select public.get_space_menu($1) menu`, [fixture.futureSpace],
      )
    ).rows[0]!.menu);
    expect(future).toEqual({ schemaVersion: 1, revision: 9, groups: DEFAULT_GROUPS });
    const rawFuture = (await database.query<{ schema_version: number; revision: number; payload: unknown }>(
      `select schema_version, revision, payload from public.space_menu_configs where space_id = $1`,
      [fixture.futureSpace],
    ))[0]!;
    expect(rawFuture).toEqual({
      schema_version: 2,
      revision: 9,
      payload: { opaqueFuture: { must: 'survive' }, groups: [] },
    });

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`delete from public.space_menu_configs where space_id = $1`, [fixture.missingSpace]);
    });
    const missing = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ menu: { revision: number; groups: unknown[] } }>(
        `select public.get_space_menu($1) menu`, [fixture.missingSpace],
      )
    ).rows[0]!.menu);
    expect(missing).toEqual({ schemaVersion: 1, revision: 1, groups: DEFAULT_GROUPS });
  });

  it('keeps reads member-authorized and non-leaking for absent versus foreign Spaces', async () => {
    const memberRead = await asApp(database, fixture.memberIdentity, async (client) => (
      await client.query<{ menu: { revision: number } }>(
        `select public.get_space_menu($1) menu`, [fixture.spaceA],
      )
    ).rows[0]!.menu);
    expect(memberRead.revision).toBe(3);

    for (const target of [fixture.spaceA, '00000000-0000-7000-8000-000000000099']) {
      await expect(asApp(database, fixture.outsiderIdentity, (client) => client.query(
        `select public.get_space_menu($1)`, [target],
      ))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('validates the full one-level/global-ref/registry/required-settings menu law on every save', async () => {
    const revision = 3;
    const invalidPayloads = [
      payload([{ id: 'bad', label: 'Bad', items: [{ type: 'view', ref: 'settings' }, { type: 'view', ref: 'settings' }] }]),
      payload([{ id: 'bad', label: 'Bad', items: [{ type: 'kind', ref: 'message' }, { type: 'view', ref: 'settings' }] }]),
      payload([{ id: 'bad', label: 'Bad', items: [{ type: 'view', ref: 'dashboard' }] }]),
      payload([{ id: 'bad', label: 'Bad', items: [{ type: 'view', ref: 'v:not-registered' }, { type: 'view', ref: 'settings' }] }]),
      payload([{ id: 'bad', label: 'Bad', items: [{ type: 'kind', ref: 'task', children: [] }, { type: 'view', ref: 'settings' }] }]),
      payload([{ id: 'bad', label: 'Bad', items: [{
        type: 'view', ref: 'workspace', children: [{ type: 'view', ref: 'dashboard', children: [] }],
      }, { type: 'view', ref: 'settings' }] }]),
    ];
    for (const [index, invalid] of invalidPayloads.entries()) {
      await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.update_space_menu($1, $2::jsonb, $3, $4)`,
        [fixture.spaceA, JSON.stringify(invalid), revision, `g14-invalid-${index}`],
      ))).rejects.toMatchObject({ code: '22023' });
    }

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.menu_view_registry(ref, route_template, menu_eligible, implemented)
         values ('v:future-view', '#/s/{s}/future', true, false)`,
      );
    });
    const futureViewPayload = payload([{ id: 'future', label: 'Future', items: [
      { type: 'view', ref: 'v:future-view' }, { type: 'view', ref: 'settings' },
    ] }]);
    await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
      `select public.update_space_menu($1, $2::jsonb, 3, 'g14-view-not-implemented')`,
      [fixture.spaceA, JSON.stringify(futureViewPayload)],
    ))).rejects.toMatchObject({ code: '22023' });
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.menu_view_registry set implemented = true where ref = 'v:future-view'`);
    });
    const accepted = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: { menu: { revision: number; groups: unknown[] } } }>(
        `select public.update_space_menu($1, $2::jsonb, 3, 'g14-view-implemented') result`,
        [fixture.spaceA, JSON.stringify(futureViewPayload)],
      )
    ).rows[0]!.result.menu);
    expect(accepted).toEqual({ schemaVersion: 1, revision: 4, groups: futureViewPayload.groups });

    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entity_kinds(kind, origin, space_id) values ('c:g14_asset', 'custom', $1)`,
        [fixture.spaceA],
      );
    });
    const customPayload = payload([{ id: 'custom', label: 'Custom', items: [
      { type: 'kind', ref: 'c:g14_asset' }, { type: 'view', ref: 'settings' },
    ] }]);
    const custom = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: { menu: { revision: number } } }>(
        `select public.update_space_menu($1, $2::jsonb, 4, 'g14-custom-kind') result`,
        [fixture.spaceA, JSON.stringify(customPayload)],
      )
    ).rows[0]!.result.menu);
    expect(custom.revision).toBe(5);
  });

  it('returns full first-attempt effects, typed conflicts, replay convergence, repair, and future refusal', async () => {
    const current = (await database.query<{ revision: number }>(
      `select revision from public.space_menu_configs where space_id = $1`, [fixture.spaceA],
    ))[0]!.revision;
    const reorderedGroups = [...DEFAULT_GROUPS].reverse();
    const first = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{
        result: {
          menu: { schemaVersion: number; revision: number; groups: unknown[] };
          eventEffect: { type: string; menu: unknown; clientMutationId: string };
        };
      }>(
        `select public.update_space_menu($1, $2::jsonb, $3, 'g14-converge') result`,
        [fixture.spaceA, JSON.stringify(payload(reorderedGroups)), current],
      )
    ).rows[0]!.result);
    expect(first.eventEffect).toEqual({
      type: 'menu.updated',
      menu: first.menu,
      clientMutationId: 'g14-converge',
    });
    const replay = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: { menu: unknown; eventEffect?: unknown } }>(
        `select public.update_space_menu($1, $2::jsonb, 0, 'g14-converge') result`,
        [fixture.spaceA, JSON.stringify(payload(DEFAULT_GROUPS))],
      )
    ).rows[0]!.result);
    expect(replay.menu).toEqual(first.menu);
    expect(replay.eventEffect).toBeUndefined();
    const durable = await database.query<{ payload: unknown }>(
      `select payload from public.workspace_events
        where client_mutation_id = 'g14-converge' and event_type = 'menu.updated'`,
    );
    expect(durable).toEqual([{ payload: first.eventEffect }]);

    let conflict: unknown;
    try {
      await asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.update_space_menu($1, $2::jsonb, $3, 'g14-stale')`,
        [fixture.spaceA, JSON.stringify(payload(DEFAULT_GROUPS)), current],
      ));
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: '40001' });
    expect(detail(conflict)).toMatchObject({
      reason: 'menu_revision_conflict',
      currentRevision: first.menu.revision,
      currentMenu: first.menu,
    });

    const repaired = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: { menu: { revision: number } } }>(
        `select public.update_space_menu($1, $2::jsonb, 7, 'g14-repair') result`,
        [fixture.corruptSpace, JSON.stringify(payload(DEFAULT_GROUPS))],
      )
    ).rows[0]!.result.menu);
    expect(repaired.revision).toBe(8);

    const missingCreated = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: { menu: { revision: number } } }>(
        `select public.update_space_menu($1, $2::jsonb, 0, 'g14-missing-create') result`,
        [fixture.missingSpace, JSON.stringify(payload(DEFAULT_GROUPS))],
      )
    ).rows[0]!.result.menu);
    expect(missingCreated.revision).toBe(1);

    let upgrade: unknown;
    try {
      await asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.update_space_menu($1, $2::jsonb, 9, 'g14-future-refused')`,
        [fixture.futureSpace, JSON.stringify(payload(DEFAULT_GROUPS))],
      ));
    } catch (error) {
      upgrade = error;
    }
    expect(upgrade).toMatchObject({ code: '40001' });
    expect(detail(upgrade)).toMatchObject({ reason: 'menu_upgrade_required' });
    const rawFuture = (await database.query<{ schema_version: number; revision: number; payload: unknown }>(
      `select schema_version, revision, payload from public.space_menu_configs where space_id = $1`,
      [fixture.futureSpace],
    ))[0]!;
    expect(rawFuture).toEqual({
      schema_version: 2,
      revision: 9,
      payload: { opaqueFuture: { must: 'survive' }, groups: [] },
    });
  });

  it('serializes concurrent menu reorders so exactly one stale writer commits', async () => {
    const revision = (await database.query<{ revision: number }>(
      `select revision from public.space_menu_configs where space_id = $1`, [fixture.spaceA],
    ))[0]!.revision;
    const left = payload(DEFAULT_GROUPS);
    const right = payload([...DEFAULT_GROUPS].reverse());
    const attempts = await Promise.allSettled([
      asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.update_space_menu($1, $2::jsonb, $3, 'g14-race-left')`,
        [fixture.spaceA, JSON.stringify(left), revision],
      )),
      asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.update_space_menu($1, $2::jsonb, $3, 'g14-race-right')`,
        [fixture.spaceA, JSON.stringify(right), revision],
      )),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejection).toMatchObject({ reason: { code: '40001' } });
    const after = (await database.query<{ revision: number }>(
      `select revision from public.space_menu_configs where space_id = $1`, [fixture.spaceA],
    ))[0]!.revision;
    expect(after).toBe(revision + 1);
    const eventCount = (await database.query<{ count: number }>(
      `select count(*)::integer count from public.workspace_events
        where client_mutation_id in ('g14-race-left','g14-race-right') and event_type = 'menu.updated'`,
    ))[0]!.count;
    expect(eventCount).toBe(1);
  });

  it('enforces human owner/admin menu and default-channel commands', async () => {
    const menuRevision = (await database.query<{ revision: number }>(
      `select revision from public.space_menu_configs where space_id = $1`, [fixture.spaceA],
    ))[0]!.revision;
    await expect(asApp(database, fixture.memberIdentity, (client) => client.query(
      `select public.update_space_menu($1, $2::jsonb, $3, 'g14-member-menu')`,
      [fixture.spaceA, JSON.stringify(payload(DEFAULT_GROUPS)), menuRevision],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
      `select public.update_space_menu($1, $2::jsonb, $3, 'g14-agent-menu')`,
      [fixture.spaceA, JSON.stringify(payload(DEFAULT_GROUPS)), menuRevision],
    ), fixture.agentA)).rejects.toMatchObject({ code: '42501' });
    const revision = await settingsRevision(database, fixture.spaceA);
    await expect(asApp(database, fixture.memberIdentity, (client) => client.query(
      `select public.set_space_default_channel($1, null, $2, 'g14-member-default')`,
      [fixture.spaceA, revision],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
      `select public.set_space_default_channel($1, null, $2, 'g14-agent-default')`,
      [fixture.spaceA, revision],
    ), fixture.agentA)).rejects.toMatchObject({ code: '42501' });
  });

  it('validates live same-Space channels, shares settings_revision, and makes no-op/replay eventless', async () => {
    const initialRevision = await settingsRevision(database, fixture.spaceA);
    for (const invalidChannel of [fixture.channelB, fixture.taskA]) {
      await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.set_space_default_channel($1, $2, $3, $4)`,
        [fixture.spaceA, invalidChannel, initialRevision, `g14-invalid-channel-${invalidChannel}`],
      ))).rejects.toMatchObject({ code: 'P0002' });
    }

    const rawFirst = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: unknown }>(
        `select public.set_space_default_channel($1, $2, $3, 'g14-default-change') result`,
        [fixture.spaceA, fixture.channelA2, initialRevision],
      )
    ).rows[0]!.result);
    const first = frozenSettingsView(rawFirst, fixture.spaceA);
    expect(first).toMatchObject({
      defaultChannelId: fixture.channelA2,
      settingsRevision: initialRevision + 1,
    });
    const replay = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: unknown }>(
        `select public.set_space_default_channel($1, null, 1, 'g14-default-change') result`,
        [fixture.spaceA],
      )
    ).rows[0]!.result);
    // The ledger replays the byte-identical frozen snapshot, not a recomputation.
    expect(frozenSettingsView(replay, fixture.spaceA)).toEqual(first);
    expect(replay).toEqual(rawFirst);

    const rawNoOp = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: unknown }>(
        `select public.set_space_default_channel($1, $2, $3, 'g14-default-noop') result`,
        [fixture.spaceA, fixture.channelA2, first.settingsRevision],
      )
    ).rows[0]!.result);
    const noOp = frozenSettingsView(rawNoOp, fixture.spaceA);
    expect(noOp.settingsRevision).toBe(first.settingsRevision);
    // A true no-op: the whole frozen projection is unchanged, not just the revision.
    expect(noOp).toEqual(first);
    const events = await database.query<{ cmid: string; payload: unknown }>(
      `select client_mutation_id cmid, payload from public.workspace_events
        where client_mutation_id in ('g14-default-change','g14-default-noop')
        order by seq`,
    );
    expect(events).toEqual([{
      cmid: 'g14-default-change',
      payload: {
        type: 'space.default_channel.updated',
        channelId: fixture.channelA2,
        settingsRevision: first.settingsRevision,
        clientMutationId: 'g14-default-change',
      },
    }]);

    let conflict: unknown;
    try {
      await asApp(database, fixture.ownerIdentity, (client) => client.query(
        `select public.set_space_default_channel($1, null, $2, 'g14-default-stale')`,
        [fixture.spaceA, initialRevision],
      ));
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: '40001' });
    expect(detail(conflict)).toEqual({ currentRevision: first.settingsRevision });
  });

  it('uses the same Space settings_revision as the profile-default command', async () => {
    const profileId = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by)
         values ($1, $2, 'interaction_profile', $3)`,
        [id, fixture.spaceA, fixture.ownerA],
      );
      await client.query(`insert into public.interaction_profiles(entity_id) values ($1)`, [id]);
      await client.query(
        `insert into public.interaction_profile_versions(
           profile_id, version, draft_json, validation_status, validated_hash, validation_json)
         values ($1, 1, '{}'::jsonb, 'valid', 'g14-valid-hash', '{}'::jsonb)`,
        [id],
      );
      await client.query(
        `update public.interaction_profiles
            set status = 'active', active_version = 1, active_hash = 'g14-valid-hash'
          where entity_id = $1`,
        [id],
      );
      return id;
    });
    const beforeProfile = await settingsRevision(database, fixture.spaceA);
    const profile = await asApp(database, fixture.ownerIdentity, async (client) => (
      await client.query<{ result: { settingsRevision: number } }>(
        `select public.set_space_profile_default($1, $2, $3, false, 'g14-profile-default') result`,
        [fixture.spaceA, profileId, beforeProfile],
      )
    ).rows[0]!.result);
    expect(profile.settingsRevision).toBe(beforeProfile + 1);
    await expect(asApp(database, fixture.ownerIdentity, (client) => client.query(
      `select public.set_space_default_channel($1, null, $2, 'g14-shared-stale')`,
      [fixture.spaceA, beforeProfile],
    ))).rejects.toMatchObject({ code: '40001' });
    const afterDefault = frozenSettingsView(
      await asApp(database, fixture.ownerIdentity, async (client) => (
        await client.query<{ result: unknown }>(
          `select public.set_space_default_channel($1, null, $2, 'g14-shared-current') result`,
          [fixture.spaceA, profile.settingsRevision],
        )
      ).rows[0]!.result),
      fixture.spaceA,
    );
    expect(afterDefault.settingsRevision).toBe(profile.settingsRevision + 1);
    // The shared revision is the Space's, so A03 reports A20's profile default too.
    expect(afterDefault.defaultInteractionProfileId).toBe(profileId);
  });

  it('requires an explicit successor/no-feed before deletion and audits import no-feed without inference', async () => {
    let revision = await settingsRevision(database, fixture.spaceA);
    const selected = frozenSettingsView(
      await asApp(database, fixture.ownerIdentity, async (client) => (
        await client.query<{ result: unknown }>(
          `select public.set_space_default_channel($1, $2, $3, 'g14-successor-select') result`,
          [fixture.spaceA, fixture.channelA1, revision],
        )
      ).rows[0]!.result),
      fixture.spaceA,
    );
    expect(selected.defaultChannelId).toBe(fixture.channelA1);
    revision = selected.settingsRevision;
    await expect(database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [fixture.channelA1]);
    })).rejects.toMatchObject({ code: '23514' });
    // 23503 (foreign_key_violation), NOT 23001 (restrict_violation). The refusal
    // comes from `spaces_default_channel_id_fkey ... on delete restrict`
    // (029:546-548), and PostgreSQL reports a RESTRICT violation through
    // ri_ReportViolation as a plain foreign_key_violation — 23001 is not a code
    // this schema can produce, so the old pin could never go green. The
    // constraint is named as well as the code: that is what makes this assert
    // "the default channel is what protects it", not merely "something failed".
    await expect(database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`delete from public.channels where entity_id = $1`, [fixture.channelA1]);
    })).rejects.toMatchObject({ code: '23503', constraint: 'spaces_default_channel_id_fkey' });

    const noFeed = frozenSettingsView(
      await asApp(database, fixture.ownerIdentity, async (client) => (
        await client.query<{ result: unknown }>(
          `select public.set_space_default_channel($1, null, $2, 'g14-explicit-no-feed') result`,
          [fixture.spaceA, revision],
        )
      ).rows[0]!.result),
      fixture.spaceA,
    );
    expect(noFeed.defaultChannelId).toBeNull();
    expect(noFeed.settingsRevision).toBe(revision + 1);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [fixture.channelA1]);
      await client.query(
        `select internal.w2_import_default_channel($1, null, 'export:missing-channel')`,
        [fixture.spaceA],
      );
    });
    const audit = (await database.query<{ count: number }>(
      `select count(*)::integer count from public.workspace_events
        where space_id = $1 and event_type = 'migration.w1.audit'
          and payload->>'kind' = 'default_channel_import_no_feed'
          and payload #>> '{details,exportedStableRef}' = 'export:missing-channel'
          and payload #>> '{details,feedState}' = 'no-feed'`,
      [fixture.spaceA],
    ))[0]!.count;
    expect(audit).toBe(1);
    const finalSpace = (await database.query<{ default_channel_id: string | null }>(
      `select default_channel_id::text from public.spaces where id = $1`, [fixture.spaceA],
    ))[0]!;
    expect(finalSpace.default_channel_id).toBeNull();
  });

  it('also applies after the frozen 001-018 + 020-024 tranche without depending on active 019', async () => {
    const integrated = await createW1ScratchDatabase('w2_g14_tranche');
    try {
      integrated.apply(explicitFrozenTrancheMigrations());
      const functions = await integrated.query<{ name: string }>(
        `select p.proname name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('get_space_menu','update_space_menu','set_space_default_channel')
          order by p.proname`,
      );
      expect(functions.map((row) => row.name)).toEqual([
        'get_space_menu',
        'set_space_default_channel',
        'update_space_menu',
      ]);
    } finally {
      await integrated.destroy();
    }
  }, 120_000);
});
