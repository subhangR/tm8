import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createDeliveryPrincipalPool,
  DELIVERY_ROLE,
  type DeliveryPrincipalPool,
} from './delivery-principal.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

// LOAD-SENSITIVE TIMEOUTS. vitest ships TWO INDEPENDENT defaults — testTimeout
// 5s (a NAMED test failure) and hookTimeout 10s (an UNNAMED file-level abort) —
// and a generous argument on `beforeAll` covers NEITHER. MEASURED on this
// machine: one scratch-database `destroy()` costs ~5.0s at load 20, and the wave
// drives load to ~48, where the same assertions on the same tree take >5x longer.
// Per-hook arguments below still win where present; this raises the floor for
// every `it` in the file. Precedent: test/integration/inbox.test.ts:39.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface SupportedFixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  channelId: string;
  projectId: string;
  workSessionId: string;
}

interface B2Fixture {
  target_id: string;
  message_id: string;
  reply_id: string;
}

async function seedSupportedState(database: W1ScratchDatabase): Promise<SupportedFixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<SupportedFixture>(
      `select 'w1-current-owner'::text as "identityId",
              internal.new_id()::text as "spaceId",
              internal.new_id()::text as "memberId",
              internal.new_id()::text as "teammateId",
              internal.new_id()::text as "channelId",
              internal.new_id()::text as "projectId",
              internal.new_id()::text as "workSessionId"`,
    )).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id, display_name)
                        values ($1, 'W1 Owner')`, [ids.identityId]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Supported baseline', $2)`,
      [ids.spaceId, ids.identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $2, 'member', $1)`,
      [ids.memberId, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'W1 Owner')`,
      [ids.memberId, ids.spaceId, ids.identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $2, 'team_member', $3), ($4, $2, 'channel', $3)`,
      [ids.teammateId, ids.spaceId, ids.memberId, ids.channelId],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name)
       values ($1, $2, 'W1 Teammate')`,
      [ids.teammateId, ids.memberId],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name)
       values ($1, $2, 'general')`,
      [ids.channelId, ids.spaceId],
    );
    await client.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'Supported project', '/tmp/tm8-w1-supported', 'trusted')`,
      [ids.projectId],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by)
       values ($1, $2, $3)`,
      [ids.spaceId, ids.projectId, ids.memberId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $2, 'work_session', $3)`,
      [ids.workSessionId, ids.spaceId, ids.teammateId],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, project_id, status)
       values ($1, 'Supported session', $2, 'running')`,
      [ids.workSessionId, ids.projectId],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'relates_to', $4)`,
      [ids.spaceId, ids.teammateId, ids.workSessionId, ids.memberId],
    );
    return ids;
  });
}

async function seedActiveProfile(
  database: W1ScratchDatabase,
  fixture: SupportedFixture,
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const profileId = (await client.query<{ id: string }>(
      `select internal.new_id()::text id`,
    )).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by)
       values ($1, $2, 'interaction_profile', $3)`,
      [profileId, fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.interaction_profiles(
         entity_id, status, current_draft_version, active_version, active_hash)
       values ($1, 'active', 1, 1, 'w1-valid-profile')`,
      [profileId],
    );
    await client.query(
      `insert into public.interaction_profile_versions(
         profile_id, version, draft_json, validation_status, validated_hash, validation_json)
       values ($1, 1, '{"captureMode":"explicit-only"}', 'valid',
               'w1-valid-profile', '{"valid":true}')`,
      [profileId],
    );
    return profileId;
  });
}

const W1_TABLES = [
  'interaction_profile_versions',
  'interaction_profiles',
  'project_links',
  'project_projection_details',
  'session_handoffs',
  'session_message_deliveries',
  'session_wake_budgets',
  'space_menu_configs',
  'work_session_interaction_pins',
  'work_session_view_preferences',
] as const;

const W1_TABLE_COLUMNS: Record<(typeof W1_TABLES)[number], readonly string[]> = {
  project_links: ['space_id', 'project_id', 'project_entity_id', 'created_at', 'updated_at'],
  project_projection_details: ['entity_id', 'project_id', 'materialized_version', 'created_at', 'updated_at'],
  space_menu_configs: ['space_id', 'schema_version', 'revision', 'payload', 'created_at', 'updated_at'],
  interaction_profiles: [
    'entity_id', 'status', 'current_draft_version', 'active_version', 'active_hash',
    'generated_by_team_member_id', 'retired_at', 'created_at', 'updated_at',
  ],
  interaction_profile_versions: [
    'profile_id', 'version', 'draft_json', 'validation_status', 'validated_hash',
    'validation_json', 'created_at',
  ],
  work_session_interaction_pins: [
    'work_session_id', 'pin_revision', 'profile_id', 'profile_version', 'template_key',
    'template_version', 'resolved_hash', 'resolved_snapshot', 'created_at',
  ],
  work_session_view_preferences: [
    'member_id', 'work_session_id', 'content_surface', 'revision', 'updated_at',
  ],
  session_message_deliveries: [
    'delivery_id', 'message_id', 'source_work_session_id', 'target_work_session_id',
    'pair_low_session_id', 'pair_high_session_id', 'pair_budget_version', 'status',
    'attempt_no', 'failure_reason', 'reserved_at', 'claimed_at', 'settled_at', 'updated_at',
  ],
  session_wake_budgets: [
    'low_work_session_id', 'high_work_session_id', 'consecutive_agent_wakes', 'version',
    'updated_at', 'eligible_for_cleanup_at',
  ],
  session_handoffs: [
    'handoff_id', 'source_entity_id', 'target_work_session_id', 'delivery_status',
    'record_status', 'request_hash', 'source_snapshot', 'envelope_hash', 'source_missing',
    'record_version', 'withdrawn_by', 'withdrawn_at', 'withdraw_reason', 'created_at', 'updated_at',
  ],
};

function w1MigrationFiles(): string[] {
  const files = migrationFiles();
  const tail = files.indexOf('015_w1_foundations.sql');
  expect(tail).toBe(14);
  return files.slice(0, tail + 1);
}

describe.sequential('W1 additive migration foundations', () => {
  let fresh: W1ScratchDatabase;
  let current: W1ScratchDatabase;
  /**
   * The three delivery RPCs are reached over a connection that AUTHENTICATES as
   * `tm8_delivery_worker`. This suite previously reached them by `set local
   * role` from the SUPERUSER pool, which passes `015`'s guard identically to a
   * chain with the role check deleted — see `delivery-principal.ts`.
   */
  let delivery: DeliveryPrincipalPool;
  let supported: SupportedFixture;
  let profileId: string;
  let b2Graph: B2Fixture;
  let b2DeliveryIds: string[];

  beforeAll(async () => {
    fresh = await createW1ScratchDatabase('empty_apply');
    fresh.apply(w1MigrationFiles());

    current = await createW1ScratchDatabase('current_apply');
    const files = w1MigrationFiles();
    current.apply(files.slice(0, -1));
    supported = await seedSupportedState(current);
    current.apply([files.at(-1)!]);
    // Only now: 015:20 issues the worker's CONNECT grant, and 015 is the file
    // just applied. A principal pool built before this line cannot connect.
    delivery = createDeliveryPrincipalPool(current.url);
    profileId = await seedActiveProfile(current, supported);
  }, 120_000);

  // 30s was too close. MEASURED at load ~20: one `destroy()` costs ~5.0s, and
  // this hook does TWO plus a pool end; the wave drives load to ~48. A teardown
  // overrun is a FILE-LEVEL failure with NO failing test name — unmatchable by a
  // subset check and invisible until the machine is busy.
  afterAll(async () => {
    await delivery?.end();
    await fresh?.destroy();
    await current?.destroy();
  }, 120_000);

  /**
   * This suite's premise about its own principal, pinned as a test.
   *
   * Every delivery assertion below is evidence about the production principal
   * ONLY if this holds. Before the rewrite it did not hold and nothing in the
   * suite said so: it reached the RPCs by `set local role` from the superuser
   * pool, which satisfies 015:1347's SECOND limb, and therefore produced the
   * identical observable against a chain with the role check deleted entirely.
   */
  it('reaches the delivery RPCs as an AUTHENTICATED worker, not an assumed role', async () => {
    const seen = await delivery.observe();
    expect(seen.session_user).toBe(DELIVERY_ROLE);
    expect(seen.session_user_is_superuser).toBe(false);
    expect(seen.role_guc).toBe('none');

    // Why session_user and not the two values that look equivalent. Measured
    // here rather than asserted, over the exact shape this suite used to use.
    const impersonated = await current.transaction(async (client) => {
      await client.query(`set local role ${DELIVERY_ROLE}`);
      return (await client.query<{
        session_user: string;
        current_user: string;
        role_guc: string;
        is_superuser_guc: string;
      }>(
        `select session_user::text as session_user,
                current_user::text as current_user,
                coalesce(current_setting('role', true), 'none') as role_guc,
                current_setting('is_superuser') as is_superuser_guc`,
      )).rows[0]!;
    });
    // current_user and the role GUC are FORGED by the impersonation...
    expect(impersonated.current_user).toBe(DELIVERY_ROLE);
    expect(impersonated.role_guc).toBe(DELIVERY_ROLE);
    // ...and so is is_superuser, which is the trap nobody had written down:
    // SET ROLE to a non-superuser drops the flag, so `is_superuser = off` is
    // NOT evidence of a non-superuser connection. Three of the four obvious
    // discriminators read identically in both worlds.
    expect(impersonated.is_superuser_guc).toBe('off');
    // Only session_user survives SET ROLE. It is the whole assertion.
    expect(impersonated.session_user).not.toBe(DELIVERY_ROLE);
  });

  it('applies from empty through the one post-014 migration and creates the exact W1 tables', async () => {
    const files = w1MigrationFiles();
    expect(files.at(-1)).toBe('015_w1_foundations.sql');
    expect(files).toHaveLength(15);

    const rows = await fresh.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public'
          and table_name = any($1::text[])
        order by table_name`,
      [W1_TABLES],
    );
    expect(rows.map((row) => row.table_name)).toEqual([...W1_TABLES]);
  });

  it('creates the frozen W1 columns, registries, indexes, and trigger inventory', async () => {
    const columns = await fresh.query<{ table_name: (typeof W1_TABLES)[number]; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and table_name = any($1::text[])
        order by table_name, ordinal_position`,
      [W1_TABLES],
    );
    for (const table of W1_TABLES) {
      expect(columns.filter((row) => row.table_name === table).map((row) => row.column_name))
        .toEqual(W1_TABLE_COLUMNS[table]);
    }

    const additiveColumns = await fresh.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and (
          (table_name = 'spaces' and column_name in
            ('default_channel_id','settings_revision','default_interaction_profile_id'))
          or (table_name = 'messages' and column_name = 'message_batch_id')
          or (table_name = 'notifications' and column_name = 'recipient_team_member_id')
          or (table_name = 'activity' and column_name = 'work_session_id')
          or (table_name = 'edges' and column_name = 'updated_at'))
        order by table_name, column_name`,
    );
    expect(additiveColumns).toHaveLength(7);

    const registry = await fresh.query<{ type: string }>(
      `select type from public.edge_types
        where type in ('in_project','shared_into','participates_in','authored_from',
                       'defaults_to_profile','selected_profile') order by type`,
    );
    expect(registry.map((row) => row.type)).toEqual([
      'authored_from', 'defaults_to_profile', 'in_project', 'participates_in',
      'selected_profile', 'shared_into',
    ]);

    const requiredIndexes = [
      'activity_work_session_created_idx', 'edges_authored_from_message_idx',
      'edges_participates_pair_idx', 'interaction_profile_versions_validated_hash_idx',
      'messages_batch_idx', 'notifications_member_personal_cursor_idx',
      'notifications_member_personal_unread_idx', 'notifications_teammate_cursor_idx',
      'notifications_teammate_unread_idx', 'spaces_default_interaction_profile_idx',
    ];
    const indexes = await fresh.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public'
        and indexname = any($1::text[]) order by indexname`,
      [requiredIndexes],
    );
    expect(indexes.map((row) => row.indexname)).toEqual([...requiredIndexes].sort());

    const requiredTriggers = [
      'edges_w1_guard', 'entities_message_identity_immutable',
      'interaction_profile_versions_guard', 'messages_batch_identity_immutable',
      'project_links_validate', 'session_handoffs_guard',
      'session_message_deliveries_guard', 'space_projects_w1_lock_guard',
      'spaces_guard_settings', 'work_session_interaction_pins_guard',
      'work_sessions_launch_project_immutable',
    ];
    const triggers = await fresh.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal
        and tgname = any($1::text[]) order by tgname`,
      [requiredTriggers],
    );
    expect(triggers.map((row) => row.tgname)).toEqual([...requiredTriggers].sort());
  });

  it('enables RLS on every W1 table and gives tm8_app SELECT-only table access', async () => {
    const rls = await fresh.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])
        order by c.relname`,
      [W1_TABLES],
    );
    expect(rls).toHaveLength(W1_TABLES.length);
    expect(rls.every((row) => row.relrowsecurity)).toBe(true);

    const directWrites = await fresh.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'tm8_app' and table_schema = 'public'
          and table_name = any($1::text[])
          and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`,
      [W1_TABLES],
    );
    expect(directWrites).toEqual([]);
  });

  it('exposes exactly three database functions to the delivery role and none to PUBLIC or tm8_app', async () => {
    const deliveryFunctions = await fresh.query<{ function_name: string }>(
      `select p.proname function_name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('tm8_delivery_worker', p.oid, 'EXECUTE')
        order by p.proname`,
    );
    expect(deliveryFunctions.map((row) => row.function_name)).toEqual([
      'claim_session_message_delivery',
      'reserve_session_message_delivery',
      'settle_session_message_delivery',
    ]);

    const leakedExecution = await fresh.query<{ proname: string; public_exec: boolean; app_exec: boolean }>(
      `select p.proname,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('reserve_session_message_delivery',
                            'claim_session_message_delivery',
                            'settle_session_message_delivery')
        order by p.proname`,
    );
    expect(leakedExecution.every((row) => !row.public_exec && !row.app_exec)).toBe(true);

    const deliveryTables = await fresh.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'tm8_delivery_worker' and table_schema = 'public'`,
    );
    expect(deliveryTables).toEqual([]);

    const internalMutators = await fresh.query<{
      proname: string;
      public_exec: boolean;
      app_exec: boolean;
      delivery_exec: boolean;
    }>(
      `select p.proname,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('tm8_delivery_worker', p.oid, 'EXECUTE') delivery_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'internal' and p.proname = any($1::text[])
        order by p.proname`,
      [[
        'ensure_core_interaction_pin', 'materialize_project_projection', 'w1_audit',
        'w1_backfill_participant', 'w1_prune_operational_state',
        'w1_refresh_wake_budget_cleanup_eligibility', 'w1_set_writer',
      ]],
    );
    expect(internalMutators).toHaveLength(7);
    expect(internalMutators.every((row) =>
      !row.public_exec && !row.app_exec && !row.delivery_exec)).toBe(true);
  });

  it('applies over supported 001-014 data with conservative, idempotent backfill and audit', async () => {
    const rows = await current.query<{
      default_channel_id: string | null;
      settings_revision: number;
      menu_revision: number;
      links: number;
      pins: number;
      associations: number;
      participants: number;
      unresolved_audits: number;
    }>(
      `select s.default_channel_id, s.settings_revision,
              menu.revision menu_revision,
              (select count(*)::integer from public.project_links
                where space_id = s.id) links,
              (select count(*)::integer from public.work_session_interaction_pins
                where work_session_id = $2) pins,
              (select count(*)::integer from public.edges
                where src_id = $2 and type = 'in_project') associations,
              (select count(*)::integer from public.edges
                where dst_id = $2 and type = 'participates_in') participants,
              (select count(*)::integer from public.workspace_events
                where space_id = s.id and event_type = 'migration.w1.audit'
                  and payload->>'kind' = 'default_channel_unresolved') unresolved_audits
         from public.spaces s join public.space_menu_configs menu on menu.space_id = s.id
        where s.id = $1`,
      [supported.spaceId, supported.workSessionId],
    );
    expect(rows[0]).toMatchObject({
      default_channel_id: null,
      settings_revision: 1,
      menu_revision: 1,
      links: 1,
      pins: 1,
      associations: 1,
      participants: 1,
      unresolved_audits: 1,
    });

    const before = await current.query<{ materialized_version: number; pin_count: number; edge_count: number }>(
      `select min(materialized_version)::integer materialized_version,
              (select count(*)::integer from public.work_session_interaction_pins
                where work_session_id = $2) pin_count,
              (select count(*)::integer from public.edges
                where src_id = $2 and type in ('in_project','participates_in')) edge_count
         from public.project_projection_details d
         join public.entities e on e.id = d.entity_id where e.space_id = $1`,
      [supported.spaceId, supported.workSessionId],
    );
    await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(`select public.repair_w1_foundations($1, 'w1-repair-1')`, [supported.spaceId]);
      await client.query(`select public.repair_w1_foundations($1, 'w1-repair-2')`, [supported.spaceId]);
    });
    const after = await current.query<{ materialized_version: number; pin_count: number; edge_count: number }>(
      `select min(materialized_version)::integer materialized_version,
              (select count(*)::integer from public.work_session_interaction_pins
                where work_session_id = $2) pin_count,
              (select count(*)::integer from public.edges
                where src_id = $2 and type in ('in_project','participates_in')) edge_count
         from public.project_projection_details d
         join public.entities e on e.id = d.entity_id where e.space_id = $1`,
      [supported.spaceId, supported.workSessionId],
    );
    expect(after[0]).toEqual(before[0]);
  });

  it('fails RLS closed without membership and denies tm8_app direct writes', async () => {
    const invisible = await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', 'w1-outsider', true)`);
      return (await client.query<{ count: number }>(
        `select count(*)::integer count from public.project_links`,
      )).rows[0]!.count;
    });
    expect(invisible).toBe(0);

    const visible = await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return (await client.query<{ count: number }>(
        `select count(*)::integer count from public.project_links where space_id = $1`,
        [supported.spaceId],
      )).rows[0]!.count;
    });
    expect(visible).toBe(1);

    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `insert into public.space_menu_configs(space_id, schema_version, revision, payload)
         values ($1, 1, 2, '{}')`,
        [supported.spaceId],
      );
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps Member and Teammate inbox projections separate and owner inspection read-only', async () => {
    const notificationIds = await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ personal_id: string; teammate_id: string }>(
        `with personal as (
           insert into public.notifications(
             space_id, recipient_member_id, target_entity_id, kind, payload)
           values ($1, $2, $3, 'mention', '{}') returning id
         ), teammate as (
           insert into public.notifications(
             space_id, recipient_member_id, recipient_team_member_id,
             target_entity_id, kind, payload)
           values ($1, $2, $4, $3, 'assignment', '{}') returning id
         )
         select personal.id::text personal_id, teammate.id::text teammate_id
           from personal cross join teammate`,
        [supported.spaceId, supported.memberId, supported.channelId, supported.teammateId],
      )).rows[0]!;
    });

    const personalView = await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return (await client.query<{ id: string }>(
        `select id::text from public.notifications
          where id in ($1, $2) order by id`,
        [notificationIds.personal_id, notificationIds.teammate_id],
      )).rows.map((row) => row.id);
    });
    expect(personalView).toEqual([notificationIds.personal_id]);

    const teammateView = await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.acting_as', $2, true)`,
        [supported.identityId, supported.teammateId],
      );
      return (await client.query<{ id: string }>(
        `select id::text from public.notifications
          where id in ($1, $2) order by id`,
        [notificationIds.personal_id, notificationIds.teammate_id],
      )).rows.map((row) => row.id);
    });
    expect(teammateView).toEqual([notificationIds.teammate_id]);

    const inspected = await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return (await client.query<{ id: string; read_at: string | null }>(
        `select id::text, read_at from public.inspect_owned_teammate_inbox($1, 10)
          where id = $2`,
        [supported.teammateId, notificationIds.teammate_id],
      )).rows;
    });
    expect(inspected).toEqual([{ id: notificationIds.teammate_id, read_at: null }]);
    const unchanged = await current.query<{ read_at: string | null }>(
      `select read_at from public.notifications where id = $1`,
      [notificationIds.teammate_id],
    );
    expect(unchanged[0]!.read_at).toBeNull();
  });

  it('serializes A03 and A20 through one Space settings revision', async () => {
    const runA03 = current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return client.query(
        `select public.set_space_default_channel($1, $2, 1, 'w1-a03-race')`,
        [supported.spaceId, supported.channelId],
      );
    });
    const runA20 = current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return client.query(
        `select public.set_space_profile_default($1, $2, 1, false, 'w1-a20-race')`,
        [supported.spaceId, profileId],
      );
    });
    const raced = await Promise.allSettled([runA03, runA20]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const state = await current.query<{
      settings_revision: number;
      default_channel_id: string | null;
      default_interaction_profile_id: string | null;
    }>(
      `select settings_revision, default_channel_id, default_interaction_profile_id
         from public.spaces where id = $1`,
      [supported.spaceId],
    );
    expect(state[0]!.settings_revision).toBe(2);
    expect([state[0]!.default_channel_id, state[0]!.default_interaction_profile_id]
      .filter(Boolean)).toHaveLength(1);
  });

  it('denies application delivery execution and rejects dedicated-role tuple forgery and table reads', async () => {
    const forgedDeliveryId = crypto.randomUUID();
    const differentDeliveryId = crypto.randomUUID();
    const forgedMessageId = crypto.randomUUID();
    const forgedTargetId = crypto.randomUUID();

    // LIMIT OF THIS FIRST ASSERTION, stated because it is not what it looks
    // like: measured on the applied chain, what refuses this is
    // "permission denied for function reserve_session_message_delivery" — the
    // EXECUTE revoke at 015:2201-2204 / 019:1352-1354, NOT
    // internal.require_delivery_principal. It would still pass with the guard
    // deleted outright. It is evidence about the GRANT and nothing else.
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select public.reserve_session_message_delivery($1, $2, $3, 1)`,
        [forgedDeliveryId, forgedMessageId, forgedTargetId],
      );
    })).rejects.toMatchObject({ code: '42501' });

    // Tuple forgery, over the AUTHENTICATED principal: the role limb is
    // satisfied honestly, so the 42501 here really is the guard's tuple check
    // (require_delivery_principal line 13) and not the role check standing in
    // for it.
    await expect(delivery.transaction(async (client) => {
      await client.query(
        `select set_config('tm8.principal_type', 'system_delivery_adapter', true),
                set_config('tm8.delivery_id', $1, true),
                set_config('tm8.delivery_message_id', $2, true),
                set_config('tm8.delivery_target_work_session_id', $3, true),
                set_config('tm8.delivery_expires_at', (now() + interval '5 minutes')::text, true)`,
        [forgedDeliveryId, forgedMessageId, forgedTargetId],
      );
      await client.query(
        `select public.reserve_session_message_delivery($1, $2, $3, 1)`,
        [differentDeliveryId, forgedMessageId, forgedTargetId],
      );
    })).rejects.toMatchObject({ code: '42501' });

    // Table reads, over the AUTHENTICATED principal. LIMIT, stated: this is
    // satisfied by the table revokes at 015:2191, in every world — it is not
    // evidence about require_delivery_principal either. It is here because the
    // worker's relation surface is worth pinning, not because it tests a guard.
    await expect(delivery.transaction(async (client) => {
      await client.query(`select * from public.session_message_deliveries`);
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('preserves the last live participant and refuses the 17th live Project association', async () => {
    const participant = await current.query<{ id: string }>(
      `select id::text from public.edges
        where dst_id = $1 and type = 'participates_in'`,
      [supported.workSessionId],
    );
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.delete_edge($1, null, 'w1-last-participant')`,
        [participant[0]!.id],
      );
    })).rejects.toMatchObject({ code: '23514' });

    const projectionIds = await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const ids: string[] = [];
      for (let index = 0; index < 16; index += 1) {
        const project = (await client.query<{ id: string }>(
          `insert into public.projects(name, working_dir)
           values ($1, $2) returning id::text`,
          [`Cap ${index}`, `/tmp/tm8-w1-cap-${index}`],
        )).rows[0]!;
        await client.query(
          `insert into public.space_projects(space_id, project_id, linked_by)
           values ($1, $2, $3)`,
          [supported.spaceId, project.id, supported.memberId],
        );
        const projection = (await client.query<{ id: string }>(
          `select project_entity_id::text id from public.project_links
            where space_id = $1 and project_id = $2`,
          [supported.spaceId, project.id],
        )).rows[0]!;
        ids.push(projection.id);
      }
      return ids;
    });

    await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      for (const projectionId of projectionIds.slice(0, 15)) {
        await client.query(
          `insert into public.edges(space_id, src_id, dst_id, type, created_by)
           values ($1, $2, $3, 'in_project', $4)`,
          [supported.spaceId, supported.workSessionId, projectionId, supported.memberId],
        );
      }
    });
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'in_project', $4)`,
        [supported.spaceId, supported.workSessionId, projectionIds[15], supported.memberId],
      );
    })).rejects.toMatchObject({ code: '53400' });

    const associationCount = await current.query<{ count: number }>(
      `select count(*)::integer count from public.edges edge
       join public.entities projection on projection.id = edge.dst_id
       where edge.src_id = $1 and edge.type = 'in_project' and projection.deleted_at is null`,
      [supported.workSessionId],
    );
    expect(associationCount[0]!.count).toBe(16);

    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.unlink_project($1, $2, 'w1-live-project-unlink')`,
        [supported.spaceId, supported.projectId],
      );
    })).rejects.toMatchObject({ code: '23514' });
  });

  /**
   * ⚠ THE WAKE CAP IS REMOVED — by migration `083`. This test asserts CHAIN
   * POSITION 015, not current behaviour. DO NOT DELETE IT, and DO NOT CITE IT AS
   * EVIDENCE THAT THE CAP EXISTS.
   *
   * `w1MigrationFiles()` slices the chain at `015_w1_foundations.sql` and pins
   * that position with `expect(tail).toBe(14)`, so every scratch database in
   * this file stops there. At 015 `public.session_wake_budgets`, its trigger,
   * `public.reset_session_wake_budget_for_member_reply`,
   * `internal.w1_refresh_wake_budget_cleanup_eligibility`, the
   * `pair_budget_version` column and `budgetsDeleted` all exist, and every
   * assertion below is a TRUE STATEMENT ABOUT WHAT 015 CREATES. 083 drops them
   * 68 files later, and 015 must keep applying cleanly forever because the chain
   * replays from 001.
   *
   * The rule, so this does not get relitigated: A FULL-CHAIN SUITE ASSERTS
   * PRESENT SYSTEM BEHAVIOUR; A POSITION-PINNED SUITE ASSERTS THAT POSITION.
   * The cap's removal reaches the former — `test/db/w2-execution.pg.test.ts`,
   * which applies `migrationFiles()` whole, lost five cases to it — and does not
   * reach this file at all. Deleting these assertions would make a migration
   * rehearsal lie about the migration it rehearses.
   */
  it('serializes concurrent B2 reservations, caps the fifth wake, and serializes a Member reset', async () => {
    b2Graph = await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const ids = (await client.query<{
        target_id: string;
        message_id: string;
        reply_id: string;
      }>(
        `select internal.new_id()::text target_id,
                internal.new_id()::text message_id,
                internal.new_id()::text reply_id`,
      )).rows[0]!;
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by)
         values ($1, $2, 'work_session', $3)`,
        [ids.target_id, supported.spaceId, supported.teammateId],
      );
      await client.query(
        `insert into public.work_sessions(entity_id, title, workdir_mode, status)
         values ($1, 'B2 target', 'scratch', 'running')`,
        [ids.target_id],
      );
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by)
         values ($1, $2, 'message', $3)`,
        [ids.message_id, supported.spaceId, supported.teammateId],
      );
      await client.query(
        `insert into public.messages(entity_id, anchor_id, author_id, body)
         values ($1, $2, $3, 'wake target')`,
        [ids.message_id, supported.channelId, supported.teammateId],
      );
      await client.query(`select internal.w1_set_writer('message_recorder')`);
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'authored_from', $4)`,
        [supported.spaceId, ids.message_id, supported.workSessionId, supported.teammateId],
      );
      await client.query(`select internal.w1_set_writer(null)`);
      return ids;
    });

    // Five of these are raced concurrently below. The principal pool is capped
    // above five so the serialization measured here is the database's, not the
    // connection pool's.
    const reserve = (deliveryId: string, attemptNo: number) => delivery.transaction(async (client) => {
      await client.query(
        `select set_config('tm8.principal_type', 'system_delivery_adapter', true),
                set_config('tm8.delivery_id', $1, true),
                set_config('tm8.delivery_message_id', $2, true),
                set_config('tm8.delivery_target_work_session_id', $3, true),
                set_config('tm8.delivery_expires_at', (now() + interval '5 minutes')::text, true)`,
        [deliveryId, b2Graph.message_id, b2Graph.target_id],
      );
      return (await client.query<{ delivery: { status: string } }>(
        `select public.reserve_session_message_delivery($1, $2, $3, $4) delivery`,
        [deliveryId, b2Graph.message_id, b2Graph.target_id, attemptNo],
      )).rows[0]!.delivery;
    });

    b2DeliveryIds = Array.from({ length: 5 }, () => crypto.randomUUID());
    const reservations = await Promise.all(
      b2DeliveryIds.map((deliveryId, index) => reserve(deliveryId, index + 1)),
    );
    expect(reservations.filter((row) => row.status === 'pending')).toHaveLength(4);
    expect(reservations.filter((row) => row.status === 'failed_permanent')).toHaveLength(1);
    const budget = await current.query<{ consecutive_agent_wakes: number; version: number }>(
      `select consecutive_agent_wakes, version from public.session_wake_budgets
        where low_work_session_id = least($1::uuid, $2::uuid)
          and high_work_session_id = greatest($1::uuid, $2::uuid)`,
      [supported.workSessionId, b2Graph.target_id],
    );
    expect(budget[0]).toMatchObject({ consecutive_agent_wakes: 4, version: 4 });

    const pendingIndex = reservations.findIndex((row) => row.status === 'pending');
    const pendingDeliveryId = b2DeliveryIds[pendingIndex]!;
    const pendingReservation = (await current.query<{
      pair_budget_version: number;
    }>(
      `select pair_budget_version from public.session_message_deliveries
        where delivery_id = $1`,
      [pendingDeliveryId],
    ))[0]!;
    const claimedAndSettled = await delivery.transaction(async (client) => {
      await client.query(
        `select set_config('tm8.principal_type', 'system_delivery_adapter', true),
                set_config('tm8.delivery_id', $1, true),
                set_config('tm8.delivery_message_id', $2, true),
                set_config('tm8.delivery_target_work_session_id', $3, true),
                set_config('tm8.delivery_pair_budget_version', $4, true),
                set_config('tm8.delivery_expires_at', (now() + interval '5 minutes')::text, true)`,
        [pendingDeliveryId, b2Graph.message_id, b2Graph.target_id,
          String(pendingReservation.pair_budget_version)],
      );
      const claimed = (await client.query<{ delivery: { status: string } }>(
        `select public.claim_session_message_delivery($1, $2, $3, $4) delivery`,
        [pendingDeliveryId, b2Graph.message_id, b2Graph.target_id,
          pendingReservation.pair_budget_version],
      )).rows[0]!.delivery;
      const settled = (await client.query<{ delivery: { status: string } }>(
        `select public.settle_session_message_delivery($1, $2, $3, $4, 'delivered', null) delivery`,
        [pendingDeliveryId, b2Graph.message_id, b2Graph.target_id,
          pendingReservation.pair_budget_version],
      )).rows[0]!.delivery;
      return { claimed: claimed.status, settled: settled.status };
    });
    expect(claimedAndSettled).toEqual({ claimed: 'dispatching', settled: 'delivered' });

    await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id, space_id, kind, parent_id, created_by)
         values ($1, $2, 'message', $3, $4)`,
        [b2Graph.reply_id, supported.spaceId, b2Graph.message_id, supported.memberId],
      );
      await client.query(
        `insert into public.messages(entity_id, anchor_id, root_message_id, author_id, body)
         values ($1, $2, $3, $4, 'human reset')`,
        [b2Graph.reply_id, supported.channelId, b2Graph.message_id, supported.memberId],
      );
    });

    const sixthDeliveryId = crypto.randomUUID();
    const reset = current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return client.query(
        `select public.reset_session_wake_budget_for_member_reply($1, 'w1-b2-reset')`,
        [b2Graph.reply_id],
      );
    });
    const sixth = reserve(sixthDeliveryId, 6);
    await Promise.all([reset, sixth]);
    const racedState = await current.query<{ consecutive_agent_wakes: number; status: string }>(
      `select b.consecutive_agent_wakes, d.status
         from public.session_wake_budgets b
         join public.session_message_deliveries d on d.delivery_id = $3
        where b.low_work_session_id = least($1::uuid, $2::uuid)
          and b.high_work_session_id = greatest($1::uuid, $2::uuid)`,
      [supported.workSessionId, b2Graph.target_id, sixthDeliveryId],
    );
    if (racedState[0]!.status === 'pending') {
      expect(racedState[0]!.consecutive_agent_wakes).toBe(1);
    } else {
      expect(racedState[0]).toMatchObject({
        consecutive_agent_wakes: 0,
        status: 'failed_permanent',
      });
    }
  });

  it('serializes association create versus Project unlink to one consistent outcome', async () => {
    const raceFixture = await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const project = (await client.query<{ id: string }>(
        `insert into public.projects(name, working_dir)
         values ('Race project', '/tmp/tm8-w1-race-project') returning id::text`,
      )).rows[0]!;
      await client.query(
        `insert into public.space_projects(space_id, project_id, linked_by)
         values ($1, $2, $3)`,
        [supported.spaceId, project.id, supported.memberId],
      );
      const projection = (await client.query<{ id: string }>(
        `select project_entity_id::text id from public.project_links
          where space_id = $1 and project_id = $2`,
        [supported.spaceId, project.id],
      )).rows[0]!;
      return { projectId: project.id, projectionId: projection.id };
    });

    const associate = current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'in_project', $4)`,
        [supported.spaceId, b2Graph.target_id, raceFixture.projectionId, supported.memberId],
      );
    });
    const unlink = current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return client.query(
        `delete from public.space_projects where space_id = $1 and project_id = $2`,
        [supported.spaceId, raceFixture.projectId],
      );
    });
    const raced = await Promise.allSettled([associate, unlink]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const consistent = (await current.query<{ links: number; edges: number }>(
      `select
         (select count(*)::integer from public.space_projects
           where space_id = $1 and project_id = $2) links,
         (select count(*)::integer from public.edges
           where src_id = $3 and dst_id = $4 and type = 'in_project') edges`,
      [supported.spaceId, raceFixture.projectId, b2Graph.target_id, raceFixture.projectionId],
    ))[0]!;
    expect(consistent.links).toBe(consistent.edges);
  });

  it('enforces launch, message, recorder-owned edge, profile version, pin, and referenced-default guards', async () => {
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.work_sessions set project_id = null where entity_id = $1`, [supported.workSessionId]);
    })).rejects.toMatchObject({ code: '23514' });
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.messages set anchor_id = $1 where entity_id = $2`, [supported.workSessionId, b2Graph.message_id]);
    })).rejects.toMatchObject({ code: '23514' });

    const authoredEdge = (await current.query<{ id: string }>(
      `select id::text from public.edges where src_id = $1 and type = 'authored_from'`,
      [b2Graph.message_id],
    ))[0]!;
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(`select public.delete_edge($1, null, 'w1-owned-edge')`, [authoredEdge.id]);
    })).rejects.toMatchObject({ code: '42501' });

    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.interaction_profile_versions set draft_json = '{"changed":true}'
          where profile_id = $1 and version = 1`,
        [profileId],
      );
    })).rejects.toMatchObject({ code: '23514' });
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.work_session_interaction_pins set resolved_hash = 'forged'
          where work_session_id = $1 and pin_revision = 1`,
        [supported.workSessionId],
      );
    })).rejects.toMatchObject({ code: '23514' });

    const settings = (await current.query<{ revision: number; profile_id: string | null }>(
      `select settings_revision revision, default_interaction_profile_id::text profile_id
         from public.spaces where id = $1`,
      [supported.spaceId],
    ))[0]!;
    if (settings.profile_id === null) {
      await current.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
        await client.query(
          `select public.set_space_profile_default($1, $2, $3, false, 'w1-profile-guard')`,
          [supported.spaceId, profileId, settings.revision],
        );
      });
    }
    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.interaction_profiles
            set status = 'retired', retired_at = now()
          where entity_id = $1`,
        [profileId],
      );
      throw Object.assign(new Error('referenced profile retirement was not guarded'), { code: 'NO_GUARD' });
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces the complete A20 principal, target, revision, replay, no-op, and NULL laws', async () => {
    const secondSpace = await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return (await client.query<{
        result: { space: { id: string }; memberId: string };
      }>(
        `select public.create_space('A20 wrong Space', '', 'private', null, 'w1-a20-second-space') result`,
      )).rows[0]!.result;
    });
    const variants = await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const ids = (await client.query<{
        generated: string;
        retired: string;
        inactive: string;
        hidden: string;
        deleted: string;
        wrong_space: string;
      }>(
        `select internal.new_id()::text generated, internal.new_id()::text retired,
                internal.new_id()::text inactive, internal.new_id()::text hidden,
                internal.new_id()::text deleted, internal.new_id()::text wrong_space`,
      )).rows[0]!;
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by, visibility, deleted_at) values
          ($1, $7, 'interaction_profile', $8, 'space', null),
          ($2, $7, 'interaction_profile', $8, 'space', null),
          ($3, $7, 'interaction_profile', $8, 'space', null),
          ($4, $7, 'interaction_profile', $8, 'restricted', null),
          ($5, $7, 'interaction_profile', $8, 'space', now()),
          ($6, $9, 'interaction_profile', $10, 'space', null)`,
        [ids.generated, ids.retired, ids.inactive, ids.hidden, ids.deleted, ids.wrong_space,
          supported.spaceId, supported.memberId, secondSpace.space.id, secondSpace.memberId],
      );
      await client.query(
        `insert into public.interaction_profiles(
           entity_id, status, current_draft_version, active_version, active_hash,
           generated_by_team_member_id, retired_at) values
          ($1, 'active', 1, 1, 'generated-valid', $7, null),
          ($2, 'retired', 1, null, null, null, now()),
          ($3, 'draft', 1, null, null, null, null),
          ($4, 'active', 1, 1, 'hidden-valid', null, null),
          ($5, 'active', 1, 1, 'deleted-valid', null, null),
          ($6, 'active', 1, 1, 'wrong-valid', null, null)`,
        [ids.generated, ids.retired, ids.inactive, ids.hidden, ids.deleted, ids.wrong_space,
          supported.teammateId],
      );
      for (const [id, hash] of [
        [ids.generated, 'generated-valid'], [ids.hidden, 'hidden-valid'],
        [ids.deleted, 'deleted-valid'], [ids.wrong_space, 'wrong-valid'],
      ]) {
        await client.query(
          `insert into public.interaction_profile_versions(
             profile_id, version, draft_json, validation_status, validated_hash, validation_json)
           values ($1, 1, '{}', 'valid', $2, '{"valid":true}')`,
          [id, hash],
        );
      }
      return ids;
    });

    const before = (await current.query<{
      settings_revision: number;
      default_interaction_profile_id: string;
      event_count: number;
    }>(
      `select settings_revision, default_interaction_profile_id::text,
              (select count(*)::integer from public.workspace_events
                where space_id = s.id and event_type = 'interaction_profile.default_updated') event_count
         from public.spaces s where id = $1`,
      [supported.spaceId],
    ))[0]!;
    expect(before.default_interaction_profile_id).toBe(profileId);

    const noOp = async () => current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      return client.query(
        `select public.set_space_profile_default($1, $2, $3, false, 'w1-a20-noop')`,
        [supported.spaceId, profileId, before.settings_revision],
      );
    });
    await noOp();
    await noOp();
    const afterNoOp = (await current.query<{ settings_revision: number; event_count: number }>(
      `select settings_revision,
              (select count(*)::integer from public.workspace_events
                where space_id = s.id and event_type = 'interaction_profile.default_updated') event_count
         from public.spaces s where id = $1`,
      [supported.spaceId],
    ))[0]!;
    expect(afterNoOp).toEqual({
      settings_revision: before.settings_revision,
      event_count: before.event_count,
    });

    const rejectedDefault = async (
      candidate: string,
      confirmation: boolean,
      mutationId: string,
      actingAs: string | null = null,
    ) => current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.acting_as', coalesce($2, ''), true)`,
        [supported.identityId, actingAs],
      );
      return client.query(
        `select public.set_space_profile_default($1, $2, $3, $4, $5)`,
        [supported.spaceId, candidate, before.settings_revision, confirmation, mutationId],
      );
    });
    await expect(rejectedDefault(variants.wrong_space, false, 'w1-a20-wrong-space'))
      .rejects.toMatchObject({ code: 'P0002' });
    await expect(rejectedDefault(variants.hidden, false, 'w1-a20-hidden'))
      .rejects.toMatchObject({ code: 'P0002' });
    await expect(rejectedDefault(variants.deleted, false, 'w1-a20-deleted'))
      .rejects.toMatchObject({ code: 'P0002' });
    await expect(rejectedDefault(variants.retired, false, 'w1-a20-retired'))
      .rejects.toMatchObject({ code: '23514', detail: 'profile_retired' });
    await expect(rejectedDefault(variants.inactive, false, 'w1-a20-inactive'))
      .rejects.toMatchObject({ code: '23514', detail: 'profile_not_validated' });
    await expect(rejectedDefault(variants.generated, false, 'w1-a20-generated-unconfirmed'))
      .rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });
    await expect(rejectedDefault(profileId, false, 'w1-a20-agent-principal', supported.teammateId))
      .rejects.toMatchObject({ code: '42501', detail: 'profile_principal_required' });

    await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.set_space_profile_default($1, $2, $3, true, 'w1-a20-generated-confirmed')`,
        [supported.spaceId, variants.generated, before.settings_revision],
      );
    });
    await expect(rejectedDefault(profileId, false, 'w1-a20-stale-revision'))
      .rejects.toMatchObject({ code: '40001' });

    const generatedState = (await current.query<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`,
      [supported.spaceId],
    ))[0]!;
    await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.set_space_profile_default($1, null, $2, false, 'w1-a20-clear')`,
        [supported.spaceId, generatedState.settings_revision],
      );
      await client.query(
        `select public.set_space_profile_default($1, $2, $3, true, 'w1-a20-restore')`,
        [supported.spaceId, variants.generated, generatedState.settings_revision + 1],
      );
    });
    const finalState = (await current.query<{
      settings_revision: number;
      default_interaction_profile_id: string;
    }>(
      `select settings_revision, default_interaction_profile_id::text
         from public.spaces where id = $1`,
      [supported.spaceId],
    ))[0]!;
    expect(finalState).toEqual({
      settings_revision: generatedState.settings_revision + 2,
      default_interaction_profile_id: variants.generated,
    });
  });

  it('rehearses forward compensation only after drain and keeps immutable pins as history', async () => {
    const currentSettings = (await current.query<{
      settings_revision: number;
      default_interaction_profile_id: string | null;
    }>(
      `select settings_revision, default_interaction_profile_id
         from public.spaces where id = $1`,
      [supported.spaceId],
    ))[0]!;
    if (currentSettings.default_interaction_profile_id === null) {
      await current.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
        await client.query(
          `select public.set_space_profile_default($1, $2, $3, false, 'w1-comp-profile')`,
          [supported.spaceId, profileId, currentSettings.settings_revision],
        );
      });
    }

    await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`select internal.w1_set_writer('profile_pin')`);
      await client.query(
        `insert into public.work_session_interaction_pins(
           work_session_id, pin_revision, profile_id, profile_version,
           template_key, template_version, resolved_hash, resolved_snapshot)
         values ($1, 2, $2, 1, 'custom', 1, 'w1-custom-profile', '{"profile":"custom"}')`,
        [supported.workSessionId, profileId],
      );
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, created_by)
         values ($1, $2, $3, 'selected_profile', $4)`,
        [supported.spaceId, supported.workSessionId, profileId, supported.memberId],
      );
      await client.query(`select internal.w1_set_writer(null)`);
    });

    await expect(current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.compensate_w1_foundations($1, 'w1-comp-before-drain')`,
        [supported.spaceId],
      );
    })).rejects.toMatchObject({ code: '55006' });

    await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.session_message_deliveries
            set status = 'cancelled', settled_at = now()
          where status = 'pending'`,
      );
    });
    await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.work_session_transition($1, 'exited', 0, null, null, 'w1-retention-source')`,
        [supported.workSessionId],
      );
      await client.query(
        `select public.work_session_transition($1, 'exited', 0, null, null, 'w1-retention-target')`,
        [b2Graph.target_id],
      );
    });
    const pruned = await current.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.session_message_deliveries set settled_at = now() - interval '31 days'
          where delivery_id = (
            select delivery_id from public.session_message_deliveries
             where delivery_id = any($1::uuid[]) and status = 'failed_permanent'
             order by delivery_id limit 1)`,
        [b2DeliveryIds],
      );
      await client.query(`select internal.w1_refresh_wake_budget_cleanup_eligibility()`);
      await client.query(
        `update public.session_wake_budgets
            set eligible_for_cleanup_at = now() - interval '8 days'`,
      );
      return (await client.query<{
        result: { deliveriesDeleted: number; budgetsDeleted: number };
      }>(
        `select internal.w1_prune_operational_state(now()) result`,
      )).rows[0]!.result;
    });
    expect(pruned).toEqual({ deliveriesDeleted: 1, budgetsDeleted: 1 });
    const revisionBefore = (await current.query<{ settings_revision: number }>(
      `select settings_revision from public.spaces where id = $1`,
      [supported.spaceId],
    ))[0]!.settings_revision;
    await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.compensate_w1_foundations($1, 'w1-comp-after-drain')`,
        [supported.spaceId],
      );
    });

    const compensated = (await current.query<{
      settings_revision: number;
      default_interaction_profile_id: string | null;
      pin_count: number;
      latest_profile: string | null;
      selected_edges: number;
      live_projections: number;
      audit_count: number;
    }>(
      `select s.settings_revision, s.default_interaction_profile_id,
              (select count(*)::integer from public.work_session_interaction_pins
                where work_session_id = $2) pin_count,
              (select profile_id::text from public.work_session_interaction_pins
                where work_session_id = $2 order by pin_revision desc limit 1) latest_profile,
              (select count(*)::integer from public.edges
                where src_id = $2 and type = 'selected_profile') selected_edges,
              (select count(*)::integer from public.project_links link
                join public.entities e on e.id = link.project_entity_id
                where link.space_id = s.id and e.deleted_at is null) live_projections,
              (select count(*)::integer from public.workspace_events
                where space_id = s.id and event_type = 'migration.w1.audit'
                  and payload->>'kind' = 'forward_compensation_completed') audit_count
         from public.spaces s where s.id = $1`,
      [supported.spaceId, supported.workSessionId],
    ))[0]!;
    expect(compensated).toMatchObject({
      settings_revision: revisionBefore + 1,
      default_interaction_profile_id: null,
      pin_count: 3,
      latest_profile: null,
      selected_edges: 0,
      live_projections: 0,
      audit_count: 1,
    });

    await current.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [supported.identityId]);
      await client.query(
        `select public.compensate_w1_foundations($1, 'w1-comp-repeat')`,
        [supported.spaceId],
      );
    });
    const repeated = (await current.query<{ settings_revision: number; pin_count: number }>(
      `select settings_revision,
              (select count(*)::integer from public.work_session_interaction_pins
                where work_session_id = $2) pin_count
         from public.spaces where id = $1`,
      [supported.spaceId, supported.workSessionId],
    ))[0]!;
    expect(repeated).toEqual({
      settings_revision: compensated.settings_revision,
      pin_count: compensated.pin_count,
    });
  });
});
