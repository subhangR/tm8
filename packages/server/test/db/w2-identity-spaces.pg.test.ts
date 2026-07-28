import type { PoolClient, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, type W1ScratchDatabase } from './w1-pg.js';

const MIGRATIONS_001_016 = [
  '001_core_graph.sql',
  '002_identity.sql',
  '003_read_model.sql',
  '004_ledgers.sql',
  '005_custom_kinds.sql',
  '006_execution_side.sql',
  '007_rpc_catalog.sql',
  '008_rls_policies.sql',
  '009_claim_accessor_grants.sql',
  '010_fix_mark_read_ambiguity.sql',
  '011_entity_content_missing_kinds.sql',
  '012_ledger_reserve_cmid.sql',
  '013_next_event_seq_warning.sql',
  '014_assert_version_locks.sql',
  '015_w1_foundations.sql',
  '016_w2_identity_spaces.sql',
] as const;

const OWNER_IDENTITY = 'w2-g01-owner';
const MEMBER_IDENTITY = 'w2-g01-member';
const OUTSIDER_IDENTITY = 'w2-g01-outsider';

interface SpaceFixture {
  spaceId: string;
  memberId: string;
  defaultChannelId: string;
}

interface AxisResult {
  axis: {
    id: string;
    space_id: string;
    name: string;
    axis_values: string[];
    kind: string;
    position: number;
  };
}

async function asApplication<T>(
  database: W1ScratchDatabase,
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'w2-g01-pg', true)`,
      [identityId],
    );
    return fn(client);
  });
}

async function appValue<T>(
  database: W1ScratchDatabase,
  identityId: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  return asApplication(database, identityId, async (client) => {
    const result = await client.query<{ value: T }>(sql, [...params]);
    return result.rows[0]!.value;
  });
}

async function appRows<R extends QueryResultRow>(
  database: W1ScratchDatabase,
  identityId: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  return asApplication(database, identityId, async (client) => {
    const result = await client.query<R>(sql, [...params]);
    return result.rows;
  });
}

async function seedAccounts(database: W1ScratchDatabase): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    for (const [identityId, username, displayName, isOwner] of [
      [OWNER_IDENTITY, 'w2-g01-owner', 'G01 Owner', true],
      [MEMBER_IDENTITY, 'w2-g01-member', 'G01 Member', false],
      [OUTSIDER_IDENTITY, 'w2-g01-outsider', 'G01 Outsider', false],
    ] as const) {
      await client.query(
        `insert into public.user_profiles(identity_id, display_name)
         values ($1, $2)`,
        [identityId, displayName],
      );
      await client.query(
        `insert into public.accounts(identity_id, username, display_name, is_owner, is_node_admin)
         values ($1, $2, $3, $4, $4)`,
        [identityId, username, displayName, isOwner],
      );
    }
  });
}

async function createSpace(
  database: W1ScratchDatabase,
  name: string,
  mutationId: string,
): Promise<SpaceFixture> {
  const result = await appValue<{
    space: { id: string };
    memberId: string;
    defaultChannelId: string;
  }>(
    database,
    OWNER_IDENTITY,
    `select public.create_space($1, '', 'private', 'https://example.test/repo', $2) value`,
    [name, mutationId],
  );
  return {
    spaceId: result.space.id,
    memberId: result.memberId,
    defaultChannelId: result.defaultChannelId,
  };
}

describe.sequential('W2.G01 identity and Spaces PostgreSQL behavior', () => {
  let database: W1ScratchDatabase;
  let primary: SpaceFixture;
  let other: SpaceFixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g01');
    database.apply(MIGRATIONS_001_016);
    await seedAccounts(database);
    primary = await createSpace(database, 'G01 primary', 'g01-space-primary');
    other = await createSpace(database, 'G01 other', 'g01-space-other');
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('keeps tm8_app read-only and grants only the enumerable G01 command RPCs', async () => {
    const privileges = await database.query<{
      update_space: boolean;
      create_axis: boolean;
      update_axis: boolean;
      delete_axis: boolean;
      revoke_invite: boolean;
      direct_insert: boolean;
      direct_update: boolean;
      direct_delete: boolean;
    }>(`
      select
        has_function_privilege('tm8_app', 'public.w2_update_space(uuid,jsonb,text)', 'EXECUTE') update_space,
        has_function_privilege('tm8_app', 'public.w2_create_task_axis(uuid,text,text[],text,integer,uuid,text)', 'EXECUTE') create_axis,
        has_function_privilege('tm8_app', 'public.w2_update_task_axis(uuid,uuid,text,text[],text,integer,text)', 'EXECUTE') update_axis,
        has_function_privilege('tm8_app', 'public.w2_delete_task_axis(uuid,uuid,text)', 'EXECUTE') delete_axis,
        has_function_privilege('tm8_app', 'public.w2_revoke_invite(uuid,uuid,text)', 'EXECUTE') revoke_invite,
        has_table_privilege('tm8_app', 'public.spaces', 'INSERT') direct_insert,
        has_table_privilege('tm8_app', 'public.task_axes', 'UPDATE') direct_update,
        has_table_privilege('tm8_app', 'public.space_invites', 'DELETE') direct_delete
    `);
    expect(privileges[0]).toEqual({
      update_space: true,
      create_axis: true,
      update_axis: true,
      delete_axis: true,
      revoke_invite: true,
      direct_insert: false,
      direct_update: false,
      direct_delete: false,
    });

    await expect(asApplication(database, OWNER_IDENTITY, (client) => client.query(
      `update public.spaces set name = 'raw write' where id = $1`,
      [primary.spaceId],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('resolves the one identity path and applies Space RLS to member-only reads', async () => {
    const identity = await appValue<{
      identityId: string;
      username: string;
      memberships: Array<{ spaceId: string }>;
    }>(database, OWNER_IDENTITY, `select public.current_identity() value`);
    expect(identity).toMatchObject({ identityId: OWNER_IDENTITY, username: 'w2-g01-owner' });
    expect(identity.memberships.map((membership) => membership.spaceId)).toEqual(
      expect.arrayContaining([primary.spaceId, other.spaceId]),
    );

    const ownerAxes = await appRows<{ space_id: string }>(
      database,
      OWNER_IDENTITY,
      `select space_id from public.task_axes where space_id = $1`,
      [primary.spaceId],
    );
    const outsiderAxes = await appRows<{ space_id: string }>(
      database,
      OUTSIDER_IDENTITY,
      `select space_id from public.task_axes where space_id = $1`,
      [primary.spaceId],
    );
    expect(ownerAxes).toHaveLength(1);
    expect(outsiderAxes).toEqual([]);
  });

  it('serializes concurrent retries by clientMutationId and applies one axis side effect', async () => {
    const call = () => appValue<AxisResult>(
      database,
      OWNER_IDENTITY,
      `select public.create_task_axis($1, 'platform', array['web','cli'], 'manual', 1, $2) value`,
      [primary.spaceId, 'g01-axis-concurrent'],
    );
    const [first, second] = await Promise.all([call(), call()]);
    expect(second).toEqual(first);

    const count = await database.query<{ count: number }>(
      `select count(*)::integer count from public.task_axes
        where space_id = $1 and name = 'platform'`,
      [primary.spaceId],
    );
    expect(count[0]!.count).toBe(1);

    const ledger = await database.query<{ count: number }>(
      `select count(*)::integer count from public.command_ledger
        where client_mutation_id = 'g01-axis-concurrent'`,
    );
    expect(ledger[0]!.count).toBe(1);
  });

  it('updates nullable Space metadata without changing the shared settings revision', async () => {
    const first = await appValue<{ space: { github_repo: string | null; name: string } }>(
      database,
      OWNER_IDENTITY,
      `select public.w2_update_space($1, $2::jsonb, $3) value`,
      [primary.spaceId, JSON.stringify({ name: 'G01 renamed', githubRepo: null }), 'g01-space-update'],
    );
    const replay = await appValue<typeof first>(
      database,
      OWNER_IDENTITY,
      `select public.w2_update_space($1, $2::jsonb, $3) value`,
      [primary.spaceId, JSON.stringify({ name: 'ignored replay' }), 'g01-space-update'],
    );
    expect(first.space).toMatchObject({ name: 'G01 renamed', github_repo: null });
    expect(replay).toEqual(first);

    const settings = await appRows<{
      name: string;
      github_repo: string | null;
      settings_revision: number;
      default_channel_id: string;
      default_interaction_profile_id: string | null;
    }>(
      database,
      OWNER_IDENTITY,
      `select name, github_repo, settings_revision, default_channel_id,
              default_interaction_profile_id
         from public.spaces where id = $1`,
      [primary.spaceId],
    );
    expect(settings[0]).toEqual({
      name: 'G01 renamed',
      github_repo: null,
      settings_revision: 1,
      default_channel_id: primary.defaultChannelId,
      default_interaction_profile_id: null,
    });

    await expect(database.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(
        `select set_config('tm8.identity_id', $1, true),
                set_config('tm8.actor_id', '00000000-0000-7000-8000-0000000000fd', true)`,
        [OWNER_IDENTITY],
      );
      await client.query(
        `select public.w2_update_space($1, '{"name":"spoofed"}'::jsonb, $2)`,
        [primary.spaceId, 'g01-space-spoofed-actor'],
      );
    })).rejects.toMatchObject({ code: '42501' });

    const afterSpoof = await database.query<{ name: string }>(
      `select name from public.spaces where id = $1`,
      [primary.spaceId],
    );
    expect(afterSpoof[0]!.name).toBe('G01 renamed');
  });

  it('enforces invite admin roles, route Space binding, bounds, revocation, and redemption', async () => {
    const created = await appValue<{ invite: { id: string; code: string; max_uses: number } }>(
      database,
      OWNER_IDENTITY,
      `select public.create_invite($1, 1, now() + interval '1 hour', null, $2) value`,
      [primary.spaceId, 'g01-invite-create'],
    );
    expect(created.invite.max_uses).toBe(1);

    await expect(appValue(
      database,
      OWNER_IDENTITY,
      `select public.w2_revoke_invite($1, $2, $3) value`,
      [other.spaceId, created.invite.id, 'g01-invite-wrong-space'],
    )).rejects.toMatchObject({ code: 'P0002' });

    const redeemed = await appValue<{ spaceId: string; memberId: string; joined: boolean }>(
      database,
      MEMBER_IDENTITY,
      `select public.redeem_invite($1, $2) value`,
      [created.invite.code, 'g01-invite-redeem'],
    );
    expect(redeemed).toMatchObject({ spaceId: primary.spaceId, joined: true });

    await expect(appValue(
      database,
      OUTSIDER_IDENTITY,
      `select public.redeem_invite($1, $2) value`,
      [created.invite.code, 'g01-invite-exhausted'],
    )).rejects.toMatchObject({ code: '53400' });

    await expect(appValue(
      database,
      MEMBER_IDENTITY,
      `select public.create_invite($1, 1, null, null, $2) value`,
      [primary.spaceId, 'g01-member-invite'],
    )).rejects.toMatchObject({ code: '42501' });

    for (const inviteId of [
      created.invite.id,
      '00000000-0000-7000-8000-0000000000ff',
    ]) {
      await expect(appValue(
        database,
        MEMBER_IDENTITY,
        `select public.w2_revoke_invite($1, $2, $3) value`,
        [primary.spaceId, inviteId, `g01-member-revoke-${inviteId}`],
      )).rejects.toMatchObject({ code: '42501' });
    }

    const memberInviteRows = await appRows<{ id: string }>(
      database,
      MEMBER_IDENTITY,
      `select id from public.space_invites where space_id = $1`,
      [primary.spaceId],
    );
    expect(memberInviteRows).toEqual([]);

    const revocable = await appValue<{ invite: { id: string } }>(
      database,
      OWNER_IDENTITY,
      `select public.create_invite($1, 2, null, null, $2) value`,
      [primary.spaceId, 'g01-invite-revocable'],
    );
    const revoked = await appValue<{ invite: { id: string; revoked_at: string | null } }>(
      database,
      OWNER_IDENTITY,
      `select public.w2_revoke_invite($1, $2, $3) value`,
      [primary.spaceId, revocable.invite.id, 'g01-invite-revoke'],
    );
    expect(revoked.invite).toMatchObject({ id: revocable.invite.id });
    expect(revoked.invite.revoked_at).not.toBeNull();
  });

  it('binds task-axis update/delete to the route Space and protects the default axis', async () => {
    const created = await appValue<AxisResult>(
      database,
      OWNER_IDENTITY,
      `select public.create_task_axis($1, 'release', array['alpha'], 'manual', 2, $2) value`,
      [primary.spaceId, 'g01-axis-release'],
    );
    const updated = await appValue<AxisResult>(
      database,
      OWNER_IDENTITY,
      `select public.w2_update_task_axis($1, $2, 'release-stage', array['alpha','ga'],
              'manual', 3, $3) value`,
      [primary.spaceId, created.axis.id, 'g01-axis-update'],
    );
    expect(updated.axis).toMatchObject({
      space_id: primary.spaceId,
      name: 'release-stage',
      axis_values: ['alpha', 'ga'],
      kind: 'manual',
      position: 3,
    });

    for (const axisId of [
      created.axis.id,
      '00000000-0000-7000-8000-0000000000fe',
    ]) {
      await expect(appValue(
        database,
        MEMBER_IDENTITY,
        `select public.w2_delete_task_axis($1, $2, $3) value`,
        [primary.spaceId, axisId, `g01-member-axis-delete-${axisId}`],
      )).rejects.toMatchObject({ code: '42501' });
    }

    await expect(appValue(
      database,
      OWNER_IDENTITY,
      `select public.w2_delete_task_axis($1, $2, $3) value`,
      [other.spaceId, created.axis.id, 'g01-axis-wrong-space'],
    )).rejects.toMatchObject({ code: 'P0002' });

    const defaultAxis = await database.query<{ id: string }>(
      `select id from public.task_axes where space_id = $1 and kind = 'default'`,
      [primary.spaceId],
    );
    await expect(appValue(
      database,
      OWNER_IDENTITY,
      `select public.w2_delete_task_axis($1, $2, $3) value`,
      [primary.spaceId, defaultAxis[0]!.id, 'g01-axis-default-delete'],
    )).rejects.toMatchObject({ code: '23514' });

    await appValue(
      database,
      OWNER_IDENTITY,
      `select public.w2_delete_task_axis($1, $2, $3) value`,
      [primary.spaceId, created.axis.id, 'g01-axis-delete'],
    );
    const deleted = await database.query<{ count: number }>(
      `select count(*)::integer count from public.task_axes where id = $1`,
      [created.axis.id],
    );
    expect(deleted[0]!.count).toBe(0);
  });

  it('does not leak unread counts from a restricted canonical anchor', async () => {
    const hidden = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const ids = (await client.query<{ anchor_id: string; message_id: string }>(
        `select internal.new_id() anchor_id, internal.new_id() message_id`,
      )).rows[0]!;
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by, visibility)
         values ($1, $3, 'channel', null, $4, 'restricted'),
                ($2, $3, 'message', null, $4, 'space')`,
        [ids.anchor_id, ids.message_id, primary.spaceId, primary.memberId],
      );
      await client.query(
        `insert into public.channels(entity_id, space_id, name, topic)
         values ($1, $2, 'hidden', 'restricted anchor')`,
        [ids.anchor_id, primary.spaceId],
      );
      await client.query(
        `insert into public.messages(entity_id, anchor_id, author_id, body)
         values ($1, $2, $3, 'must not affect unread totals')`,
        [ids.message_id, ids.anchor_id, primary.memberId],
      );
      return ids;
    });

    const counts = await appRows<{ anchor_id: string; unread: number }>(
      database,
      MEMBER_IDENTITY,
      `select anchor_id, unread from public.unread_counts($1)`,
      [primary.spaceId],
    );
    expect(counts.map((row) => row.anchor_id)).not.toContain(hidden.anchor_id);
  });

  it('exposes point-ledger rows only inside the Space RLS boundary', async () => {
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.point_events(space_id, entity_id, actor_id, amount, reason, ref_id,
                                         client_event_id)
         values ($1, $2, $2, 5, 'award', $3, 'g01-award')`,
        [primary.spaceId, primary.memberId, primary.defaultChannelId],
      );
    });

    const memberAwards = await appRows<{ amount: number }>(
      database,
      MEMBER_IDENTITY,
      `select amount from public.point_events where space_id = $1 and reason = 'award'`,
      [primary.spaceId],
    );
    const outsiderAwards = await appRows<{ amount: number }>(
      database,
      OUTSIDER_IDENTITY,
      `select amount from public.point_events where space_id = $1 and reason = 'award'`,
      [primary.spaceId],
    );
    expect(memberAwards).toEqual([{ amount: 5 }]);
    expect(outsiderAwards).toEqual([]);
  });
});
