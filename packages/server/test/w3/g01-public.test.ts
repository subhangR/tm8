import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

describe.sequential('W3.G01 identity and Spaces through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let memberId = '';
  let defaultChannelId = '';
  let inviteId = '';
  let inviteCode = '';
  let axisId = '';
  let teammateId = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g01');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('resolves loopback identity, creates one Space, and persists its required defaults', async () => {
    const identity = successData<{
      identityId: string;
      username: string;
      isOwner: boolean;
    }>(await harness.request('GET', '/v2/identity'));
    expect(identity).toMatchObject({ username: 'owner', isOwner: true });

    const created = successData<{
      space: { id: string; name: string; memberCount: number };
      memberId: string;
      defaultChannelId: string;
    }>(await harness.request('POST', '/v2/spaces', {
      clientMutationId: 'w3-g01-space-create',
      name: 'W3 G01 public gate',
      description: 'production Server boundary',
      githubRepo: 'https://example.test/tm8-g01',
    }));
    spaceId = created.space.id;
    memberId = created.memberId;
    defaultChannelId = created.defaultChannelId;
    expect(created.space).toMatchObject({ name: 'W3 G01 public gate', memberCount: 1 });

    const rows = await harness.rows<{
      spaces: number;
      members: number;
      channels: number;
      axes: number;
      menus: number;
      settings_revision: number;
      default_channel_id: string;
    }>(
      `select
         (select count(*)::integer from public.spaces where id = $1) spaces,
         (select count(*)::integer from public.members where space_id = $1) members,
         (select count(*)::integer from public.channels where space_id = $1) channels,
         (select count(*)::integer from public.task_axes where space_id = $1) axes,
         (select count(*)::integer from public.space_menu_configs where space_id = $1) menus,
         settings_revision,
         default_channel_id
       from public.spaces where id = $1`,
      [spaceId],
    );
    expect(rows[0]).toEqual({
      spaces: 1,
      members: 1,
      channels: 1,
      axes: 1,
      menus: 1,
      settings_revision: 1,
      default_channel_id: defaultChannelId,
    });
  });

  it('lists, gets, updates, and replays Space metadata without touching settings revision', async () => {
    const listed = successData<Array<{ id: string }>>(await harness.request('GET', '/v2/spaces'));
    expect(listed.map((space) => space.id)).toContain(spaceId);

    const got = successData<{ id: string; name: string }>(
      await harness.request('GET', `/v2/spaces/${spaceId}`),
    );
    expect(got).toMatchObject({ id: spaceId, name: 'W3 G01 public gate' });

    const first = successData<{ id: string; name: string; githubRepo: string | null }>(
      await harness.request('PATCH', `/v2/spaces/${spaceId}`, {
        clientMutationId: 'w3-g01-space-update',
        name: 'W3 G01 renamed',
        githubRepo: null,
      }),
    );
    const replay = successData<typeof first>(
      await harness.request('PATCH', `/v2/spaces/${spaceId}`, {
        clientMutationId: 'w3-g01-space-update',
        name: 'must not replace the stored result',
      }),
    );
    expect(first).toMatchObject({ id: spaceId, name: 'W3 G01 renamed', githubRepo: null });
    expect(replay).toEqual(first);

    const rows = await harness.rows<{
      name: string;
      github_repo: string | null;
      settings_revision: number;
      ledger_rows: number;
    }>(
      `select space_row.name, space_row.github_repo, space_row.settings_revision,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g01-space-update') ledger_rows
         from public.spaces space_row where space_row.id = $1`,
      [spaceId],
    );
    expect(rows[0]).toEqual({
      name: 'W3 G01 renamed',
      github_repo: null,
      settings_revision: 1,
      ledger_rows: 1,
    });
  });

  it('serves navigation, Home, settings, and member projections from the same Space', async () => {
    const navigation = successData<{ spaceId: string; channels: unknown[] }>(
      await harness.request('GET', `/v2/spaces/${spaceId}/navigation`),
    );
    expect(navigation.spaceId).toBe(spaceId);
    expect(JSON.stringify(navigation)).toContain(defaultChannelId);

    const home = successData<Record<string, unknown>>(
      await harness.request('GET', `/v2/spaces/${spaceId}/home`),
    );
    expect(home).toBeTypeOf('object');

    const settings = successData<{
      space: { id: string };
      members: Array<{ actor: { id: string }; role: string }>;
      invites: unknown[];
      taskAxes: Array<{ kind: string }>;
      menu: { schemaVersion: number; revision: number };
      defaultChannelId: string | null;
      defaultInteractionProfileId: string | null;
      settingsRevision: number;
    }>(await harness.request('GET', `/v2/spaces/${spaceId}/settings`));
    expect(settings).toMatchObject({
      space: { id: spaceId },
      defaultChannelId,
      defaultInteractionProfileId: null,
      settingsRevision: 1,
      menu: { schemaVersion: 1, revision: 1 },
    });
    expect(settings.members).toHaveLength(1);
    expect(settings.taskAxes.some((axis) => axis.kind === 'default')).toBe(true);

    const members = successData<Array<{ actor: { id: string }; role: string }>>(
      await harness.request('GET', `/v2/spaces/${spaceId}/members`),
    );
    expect(members).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: expect.objectContaining({ id: memberId }), role: 'owner' }),
    ]));
  });

  it('creates, lists, redeems idempotently for an existing member, and revokes an invite', async () => {
    const invite = successData<{
      id: string;
      code: string;
      maxUses: number;
      uses: number;
      revoked: boolean;
    }>(await harness.request('POST', `/v2/spaces/${spaceId}/invites`, {
      clientMutationId: 'w3-g01-invite-create',
      maxUses: 2,
    }));
    inviteId = invite.id;
    inviteCode = invite.code;
    expect(invite).toMatchObject({ maxUses: 2, uses: 0, revoked: false });

    const invites = successData<Array<{ id: string }>>(
      await harness.request('GET', `/v2/spaces/${spaceId}/invites`),
    );
    expect(invites.map((item) => item.id)).toContain(inviteId);

    const redeemed = successData<{ spaceId: string; memberId: string; joined: boolean }>(
      await harness.request('POST', '/v2/invites/redeem', {
        clientMutationId: 'w3-g01-invite-redeem',
        code: inviteCode,
      }),
    );
    expect(redeemed).toMatchObject({ spaceId, memberId, joined: false });

    const revoked = successData<{ id: string; revoked: boolean }>(
      await harness.request('POST', `/v2/spaces/${spaceId}/invites/${inviteId}/revoke`, {
        clientMutationId: 'w3-g01-invite-revoke',
      }),
    );
    expect(revoked).toMatchObject({ id: inviteId, revoked: true });

    const rows = await harness.rows<{ use_count: number; revoked: boolean; ledger_rows: number }>(
      `select invite_row.use_count,
              invite_row.revoked_at is not null revoked,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id in (
                  'w3-g01-invite-create', 'w3-g01-invite-redeem', 'w3-g01-invite-revoke'
                )) ledger_rows
         from public.space_invites invite_row where invite_row.id = $1`,
      [inviteId],
    );
    expect(rows[0]).toEqual({ use_count: 0, revoked: true, ledger_rows: 3 });
  });

  it('creates, updates, lists, and deletes a manual task axis with one durable effect per mutation', async () => {
    const created = successData<{
      id: string;
      name: string;
      axisValues: string[];
      kind: string;
      position: number;
    }>(await harness.request('POST', `/v2/spaces/${spaceId}/task-axes`, {
      clientMutationId: 'w3-g01-axis-create',
      name: 'platform',
      axisValues: ['web', 'cli'],
      kind: 'manual',
      position: 2,
    }));
    axisId = created.id;
    expect(created).toMatchObject({ name: 'platform', axisValues: ['web', 'cli'], kind: 'manual' });

    const updated = successData<typeof created>(
      await harness.request('PATCH', `/v2/spaces/${spaceId}/task-axes/${axisId}`, {
        clientMutationId: 'w3-g01-axis-update',
        name: 'surface',
        axisValues: ['web', 'cli', 'api'],
        kind: 'manual',
        position: 3,
      }),
    );
    expect(updated).toMatchObject({ id: axisId, name: 'surface', position: 3 });

    const axes = successData<Array<{ id: string; name: string }>>(
      await harness.request('GET', `/v2/spaces/${spaceId}/task-axes`),
    );
    expect(axes.map((axis) => axis.id)).toContain(axisId);

    const deleted = successData<{ axisId: string }>(
      await harness.request('DELETE', `/v2/spaces/${spaceId}/task-axes/${axisId}`, {
        clientMutationId: 'w3-g01-axis-delete',
      }),
    );
    expect(deleted.axisId).toBe(axisId);

    const rows = await harness.rows<{ axes: number; ledger_rows: number }>(
      `select
         (select count(*)::integer from public.task_axes where id = $1) axes,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in (
             'w3-g01-axis-create', 'w3-g01-axis-update', 'w3-g01-axis-delete'
           )) ledger_rows`,
      [axisId],
    );
    expect(rows[0]).toEqual({ axes: 0, ledger_rows: 3 });
  });

  it('returns real keyset leaderboard and award pages', async () => {
    const teammate = successData<{ entity: { id: string } }>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g01-teammate-fixture',
        spaceId,
        kind: 'team_member',
        title: 'G01 teammate',
        content: {
          identity: 'Public gate fixture.',
          model: 'claude-sonnet-5',
          agentTool: 'claude-code',
        },
      }),
    );
    teammateId = teammate.entity.id;

    for (const [targetId, mutationId, amount] of [
      [memberId, 'w3-g01-award-owner', 3],
      [teammateId, 'w3-g01-award-teammate', 5],
    ] as const) {
      successData(await harness.request('POST', `/v2/entities/${targetId}/points`, {
        clientMutationId: mutationId,
        amount,
        reason: 'award',
      }));
    }

    const leaderboardFirst = successData<{
      items: Array<{ actor: { id: string }; score: number }>;
      nextCursor: string | null;
    }>(await harness.request('GET', `/v2/spaces/${spaceId}/leaderboard?limit=1`));
    expect(leaderboardFirst.items).toHaveLength(1);
    expect(leaderboardFirst.nextCursor).toBeTruthy();
    const leaderboardSecond = successData<typeof leaderboardFirst>(
      await harness.request(
        'GET',
        `/v2/spaces/${spaceId}/leaderboard?limit=1&cursor=${encodeURIComponent(leaderboardFirst.nextCursor!)}`,
      ),
    );
    expect(leaderboardSecond.items[0]?.actor.id).not.toBe(leaderboardFirst.items[0]?.actor.id);

    const awardsFirst = successData<{
      items: Array<{ id: string; amount: number }>;
      nextCursor: string | null;
    }>(await harness.request('GET', `/v2/spaces/${spaceId}/awards?limit=1`));
    expect(awardsFirst.items).toHaveLength(1);
    expect(awardsFirst.nextCursor).toBeTruthy();
    const awardsSecond = successData<typeof awardsFirst>(
      await harness.request(
        'GET',
        `/v2/spaces/${spaceId}/awards?limit=1&cursor=${encodeURIComponent(awardsFirst.nextCursor!)}`,
      ),
    );
    expect(awardsSecond.items[0]?.id).not.toBe(awardsFirst.items[0]?.id);
  });

  it('rejects unknown command fields and missing mutation identities before a write', async () => {
    const before = await harness.rows<{ count: number }>(
      `select count(*)::integer count from public.space_invites where space_id = $1`,
      [spaceId],
    );
    const unknown = await harness.request('POST', `/v2/spaces/${spaceId}/invites`, {
      clientMutationId: 'w3-g01-invalid-unknown',
      maxUses: 1,
      unknownField: true,
    });
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe('invalid_input');

    const missingMutation = await harness.request('PATCH', `/v2/spaces/${spaceId}`, {
      name: 'must not land',
    });
    expect(missingMutation.status).toBe(400);
    expect(errorCode(missingMutation)).toBe('invalid_input');

    const after = await harness.rows<{ name: string; count: number }>(
      `select space_row.name,
              (select count(*)::integer from public.space_invites where space_id = $1) count
         from public.spaces space_row where space_row.id = $1`,
      [spaceId],
    );
    expect(after[0]).toEqual({ name: 'W3 G01 renamed', count: before[0]!.count });
  });
});
