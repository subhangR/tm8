import { describe, expect, it } from 'vitest';

import {
  CollabError,
  decodeCursor,
  LeaderboardRowSchema,
  PointEventViewSchema,
  SpaceSettingsViewSchema,
  TaskAxisSchema,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE_ID = '00000000-0000-7000-8000-000000000001';
const MEMBER_ID = '00000000-0000-7000-8000-000000000002';
const CHANNEL_ID = '00000000-0000-7000-8000-000000000003';
const AXIS_ID = '00000000-0000-7000-8000-000000000004';

const G01_OPERATIONS = [
  'identity.get',
  // Identity v2 Stage 0 (2026-08-01): the caller's own display-profile writer.
  'identity.profile.update',
  // Landed by a separate lane (migration 063) without this list moving; the
  // group registered 20 while the list froze 19. Reconciled 2026-08-01.
  'spaces.counts',
  'spaces.list',
  'spaces.create',
  'spaces.get',
  'spaces.update',
  'spaces.navigation',
  'spaces.home',
  'spaces.settings',
  'spaces.members.list',
  'spaces.members.updateRole',
  'spaces.invites.list',
  'spaces.invites.create',
  'spaces.invites.revoke',
  'spaces.invites.redeem',
  'spaces.taskAxes.list',
  'spaces.taskAxes.create',
  'spaces.taskAxes.update',
  'spaces.taskAxes.delete',
  // W4/132: the per-type status vocabularies, curated beside the axes they
  // key on and registered by the same module.
  'spaces.taskWorkflows.list',
  'spaces.taskWorkflows.upsert',
  'spaces.taskWorkflows.delete',
  // 148: the real workflow tables, registered by the same module for the
  // same reason — they supersede the taskWorkflows three above, which stay
  // read-only until phase 6.
  'spaces.workflows.list',
  'spaces.workflows.upsert',
  'spaces.workflows.delete',
  'spaces.leaderboard',
  'spaces.awards',
] as const;

type QueryHandler = (sql: string, params: readonly unknown[]) => Promise<unknown[]>;
type RpcHandler = (fn: string, args: readonly unknown[]) => Promise<unknown>;

class FakeDb implements Db {
  readonly queryCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];

  constructor(
    private readonly onQuery: QueryHandler = async () => [],
    private readonly onRpc: RpcHandler = async () => ({}),
  ) {}

  private readonly querier: Querier = {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
      this.queryCalls.push({ sql, params });
      return (await this.onQuery(sql, params)) as R[];
    },
    rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
      this.rpcCalls.push({ fn, args });
      return (await this.onRpc(fn, args)) as T;
    },
  };

  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier);
  }

  async query<R>(
    _claims: DbClaims,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    return this.querier.query<R>(sql, params);
  }

  async rpc<T>(
    _claims: DbClaims,
    fn: string,
    args: readonly unknown[] = [],
  ): Promise<T> {
    return this.querier.rpc<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024,
      databaseUrl: undefined,
    },
    owner: async () => ({
      identityId: 'identity-owner',
      accountId: '00000000-0000-7000-8000-000000000099',
      username: 'owner',
      isNodeAdmin: true,
      isOwner: true,
    }),
  };
}

function context(
  opName: (typeof G01_OPERATIONS)[number],
  options: {
    params?: Record<string, string>;
    body?: unknown;
    query?: Record<string, string>;
    identity?: RequestContext['identity'];
  } = {},
): RequestContext {
  return {
    op: { name: opName, method: 'GET', path: '/test', kind: 'read', status: 'v1' },
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: 'req-g01',
    identity: options.identity ?? { kind: 'auto-owner', identityId: 'identity-owner' },
    headers: {},
    method: 'GET',
    path: '/test',
  } as RequestContext;
}

function registryFor(db: Db): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2IdentitySpacesHandlers(registry, deps(db));
  return registry;
}

describe('W2.G01 identity and Spaces handler seam', () => {
  it('registers the complete frozen 22-operation group and nothing else', () => {
    const registry = registryFor(new FakeDb());
    expect(registry.implemented()).toEqual([...G01_OPERATIONS].sort());
  });

  it('opens navigation as the authenticated bearer who created the space, not the node owner', async () => {
    const bearerIdentity = 'identity-bhargav';
    const db = new FakeDb(
      async (sql, params) => {
        if (sql.includes('from public.members where space_id')) {
          return params[1] === bearerIdentity ? [{ entity_id: MEMBER_ID }] : [];
        }
        return [];
      },
      async (fn) => fn === 'unread_counts' ? [] : {},
    );
    const handler = registryFor(db).get('spaces.navigation')!;

    const navigation = await handler(context('spaces.navigation', {
      params: { spaceId: SPACE_ID },
      identity: {
        kind: 'bearer',
        identityId: bearerIdentity,
        token: 'tm8s_bhargav.secret',
        nodeAdmin: true,
      },
    }));

    expect(db.queryCalls[0]?.params).toEqual([SPACE_ID, bearerIdentity]);
    expect(navigation).toMatchObject({
      spaceId: SPACE_ID,
      viewer: { id: MEMBER_ID },
    });
  });

  /**
   * The same guarantee as the test above, for the six reads that check
   * membership HERE rather than in `handlers/spaces.ts` — and the one that
   * shipped without it.
   *
   * All six passed `owner.identityId` to the check, so each asked "is the NODE
   * OWNER a member of this Space?" on behalf of whoever called. On a node whose
   * owner belongs to every Space that is invisible; on the first Space somebody
   * ELSE creates it refuses all six for every real member — `spaces.settings`
   * included, which is a boot read, so the Space cannot be opened at all. The
   * refusal reaching the browser is `forbidden: not a member of this space`,
   * addressed to the member who owns it.
   *
   * The fake answers the membership query for the CALLER only, which is what a
   * Space the node owner does not belong to looks like from inside the handler.
   */
  it('checks membership against the caller on every gated G01 read, not the node owner', async () => {
    const bearerIdentity = 'identity-tarkesh';
    const gatedReads = [
      ['spaces.settings', { spaceId: SPACE_ID }],
      ['spaces.members.list', { spaceId: SPACE_ID }],
      ['spaces.invites.list', { spaceId: SPACE_ID }],
      ['spaces.taskAxes.list', { spaceId: SPACE_ID }],
      ['spaces.leaderboard', { spaceId: SPACE_ID }],
      ['spaces.awards', { spaceId: SPACE_ID }],
    ] as const;

    for (const [opName, params] of gatedReads) {
      const db = new FakeDb(async (sql, queryParams) => {
        if (sql.includes('from public.members membership')) {
          // The node owner is not in this Space. Nobody else's identity is
          // either — only the caller's.
          return queryParams[1] === bearerIdentity
            ? [{ entity_id: MEMBER_ID, role: 'owner' }]
            : [];
        }
        if (sql.includes('from public.spaces s')) {
          return [{
            id: SPACE_ID,
            name: 'Tharak',
            description: '',
            github_repo: null,
            created_at: '2026-08-09T17:33:50.899Z',
            member_count: '1',
            unread_total: '0',
            default_channel_id: CHANNEL_ID,
            default_interaction_profile_id: null,
            settings_revision: 1,
          }];
        }
        if (sql.includes('from public.space_menu_configs')) {
          return [{
            schema_version: 1,
            revision: 1,
            payload: {
              schemaVersion: 1,
              groups: [{ id: 'main', label: 'Main', items: [{ type: 'view', ref: 'settings' }] }],
            },
          }];
        }
        return [];
      });

      await expect(
        registryFor(db).get(opName)!(context(opName, {
          params,
          identity: {
            kind: 'bearer',
            identityId: bearerIdentity,
            token: 'tm8s_tarkesh.secret',
            nodeAdmin: false,
          },
        })),
      ).resolves.toBeDefined();

      expect(db.queryCalls[0]?.sql).toContain('from public.members membership');
      expect(db.queryCalls[0]?.params).toEqual([SPACE_ID, bearerIdentity]);
    }
  });

  /**
   * The same defect read from the other side. `spaces.invites.list` wants an
   * ADMIN, and asking for the node owner's role meant a plain member of a Space
   * the node owner administers cleared an admin-only gate. The role that
   * matters is the caller's.
   */
  it('refuses an admin-only G01 read on the caller’s own role, not the node owner’s', async () => {
    const bearerIdentity = 'identity-tarkesh';
    const db = new FakeDb(async (sql, params) => {
      if (sql.includes('from public.members membership')) {
        // The caller is a plain member; the node owner administers the Space.
        return params[1] === bearerIdentity
          ? [{ entity_id: MEMBER_ID, role: 'member' }]
          : [{ entity_id: MEMBER_ID, role: 'admin' }];
      }
      return [];
    });

    await expect(
      registryFor(db).get('spaces.invites.list')!(context('spaces.invites.list', {
        params: { spaceId: SPACE_ID },
        identity: {
          kind: 'bearer',
          identityId: bearerIdentity,
          token: 'tm8s_tarkesh.secret',
          nodeAdmin: false,
        },
      })),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'space administrator role required' });
  });

  it('requires clientMutationId before every G01 command reaches an RPC', async () => {
    const db = new FakeDb();
    const registry = registryFor(db);
    const commandCases = [
      ['spaces.create', {}, { name: 'No mutation id' }],
      ['spaces.update', { spaceId: SPACE_ID }, { name: 'No mutation id' }],
      ['spaces.invites.create', { spaceId: SPACE_ID }, { maxUses: 1 }],
      ['spaces.invites.revoke', { spaceId: SPACE_ID, inviteId: MEMBER_ID }, {}],
      ['spaces.invites.redeem', {}, { code: 'invite-code' }],
      ['spaces.taskAxes.create', { spaceId: SPACE_ID }, {
        name: 'platform', axisValues: ['web'], kind: 'manual', position: 1,
      }],
      ['spaces.taskAxes.update', { spaceId: SPACE_ID, axisId: AXIS_ID }, {
        name: 'platform', axisValues: ['web'], kind: 'manual', position: 1,
      }],
      ['spaces.taskAxes.delete', { spaceId: SPACE_ID, axisId: AXIS_ID }, {}],
      ['identity.profile.update', {}, { displayName: 'No mutation id' }],
    ] as const;

    for (const [opName, params, body] of commandCases) {
      const handler = registry.get(opName);
      expect(handler, opName).toBeDefined();
      await expect(handler!(context(opName, { params, body }))).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    expect(db.rpcCalls).toEqual([]);
  });

  it('writes the caller\'s own profile through update_identity_profile, absent fields as null', async () => {
    const db = new FakeDb(
      async () => [],
      async (fn, args) => {
        expect(fn).toBe('update_identity_profile');
        // Positional: display_name, avatar, email, global_id, cmid. Only the
        // provided fields carry values; the DTO has no way to name another
        // identity — the subject is always the bound claim.
        expect(args).toEqual([
          'Subhang',
          null,
          null,
          'example-issuer:12345',
          'cmid-profile-set',
        ]);
        return {
          identityId: 'identity-owner',
          displayName: 'Subhang',
          avatar: null,
          email: null,
          globalId: 'example-issuer:12345',
        };
      },
    );
    const handler = registryFor(db).get('identity.profile.update')!;

    const result = await handler(context('identity.profile.update', {
      body: {
        clientMutationId: 'cmid-profile-set',
        displayName: 'Subhang',
        globalId: 'example-issuer:12345',
      },
    }));

    expect(result).toEqual({
      identityId: 'identity-owner',
      displayName: 'Subhang',
      avatar: null,
      email: null,
      globalId: 'example-issuer:12345',
    });
    expect(db.rpcCalls).toHaveLength(1);
  });

  it('updates Space metadata through one typed RPC and preserves an explicit null repo', async () => {
    const db = new FakeDb(
      async () => [],
      async (fn, args) => {
        expect(fn).toBe('w2_update_space');
        expect(args).toEqual([
          SPACE_ID,
          { name: 'Renamed', githubRepo: null },
          'cmid-space-update',
        ]);
        return {
          space: {
            id: SPACE_ID,
            name: 'Renamed',
            description: 'Description',
            github_repo: null,
            created_at: '2026-07-26T10:00:00.000Z',
            member_count: '1',
            unread_total: '0',
          },
        };
      },
    );
    const handler = registryFor(db).get('spaces.update')!;

    const result = await handler(context('spaces.update', {
      params: { spaceId: SPACE_ID },
      body: {
        clientMutationId: 'cmid-space-update',
        name: 'Renamed',
        githubRepo: null,
      },
    }));

    expect(result).toEqual({
      id: SPACE_ID,
      name: 'Renamed',
      description: 'Description',
      memberCount: 1,
      unreadTotal: 0,
      githubRepo: null,
      createdAt: '2026-07-26T10:00:00.000Z',
    });
  });

  it('returns the strict amended settings projection from one RLS snapshot', async () => {
    const db = new FakeDb(async (sql) => {
      if (sql.includes('from public.members membership')) {
        return [{ entity_id: MEMBER_ID, role: 'owner' }];
      }
      if (sql.includes('from public.spaces s')) {
        return [{
          id: SPACE_ID,
          name: 'G01',
          description: 'Identity and Spaces',
          github_repo: null,
          created_at: '2026-07-26T10:00:00.000Z',
          member_count: '1',
          unread_total: '0',
          default_channel_id: CHANNEL_ID,
          default_interaction_profile_id: null,
          settings_revision: 3,
        }];
      }
      if (sql.includes('from public.members member_row')) {
        return [{ entity_id: MEMBER_ID, role: 'owner', joined_at: '2026-07-26T10:00:00.000Z' }];
      }
      if (sql.includes('from public.entities e') && sql.includes('left join public.members mem')) {
        return [{
          id: MEMBER_ID,
          kind: 'member',
          space_id: SPACE_ID,
          member_display_name: 'Owner',
          member_role: 'owner',
          team_member_name: null,
          team_member_avatar: null,
          team_member_owner_id: null,
          profile_display_name: 'Owner',
          profile_avatar: null,
        }];
      }
      if (sql.includes('from public.space_invites')) return [];
      if (sql.includes('from public.task_axes')) {
        return [{
          id: AXIS_ID,
          space_id: SPACE_ID,
          name: 'type',
          axis_values: ['default', 'code'],
          kind: 'default',
          position: 0,
        }];
      }
      if (sql.includes('from public.task_workflows')) {
        // W4/132: the settings snapshot carries the workflows beside the axes
        // they key on.
        return [{
          id: AXIS_ID,
          space_id: SPACE_ID,
          type_value: 'code',
          statuses: ['open', 'working', 'done'],
        }];
      }
      if (sql.includes('from public.space_menu_configs')) {
        return [{
          schema_version: 1,
          revision: 2,
          payload: {
            schemaVersion: 1,
            groups: [{ id: 'main', label: 'Main', items: [{ type: 'view', ref: 'settings' }] }],
          },
        }];
      }
      throw new Error(`unexpected settings query: ${sql}`);
    });
    const handler = registryFor(db).get('spaces.settings')!;

    const result = await handler(context('spaces.settings', { params: { spaceId: SPACE_ID } }));
    expect(SpaceSettingsViewSchema.parse(result)).toMatchObject({
      space: { id: SPACE_ID, name: 'G01' },
      defaultChannelId: CHANNEL_ID,
      defaultInteractionProfileId: null,
      settingsRevision: 3,
      menu: { revision: 2, schemaVersion: 1 },
      taskAxes: [{ id: AXIS_ID, axisValues: ['default', 'code'] }],
    });
  });

  it('returns task-axis mutations as the frozen TaskAxis DTO and binds the route Space', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('w2_update_task_axis');
      expect(args).toEqual([
        SPACE_ID,
        AXIS_ID,
        'platform',
        ['web', 'cli'],
        'manual',
        2,
        'cmid-axis-update',
      ]);
      return {
        axis: {
          id: AXIS_ID,
          space_id: SPACE_ID,
          name: 'platform',
          axis_values: ['web', 'cli'],
          kind: 'manual',
          position: 2,
        },
      };
    });
    const handler = registryFor(db).get('spaces.taskAxes.update')!;

    const result = await handler(context('spaces.taskAxes.update', {
      params: { spaceId: SPACE_ID, axisId: AXIS_ID },
      body: {
        clientMutationId: 'cmid-axis-update',
        name: 'platform',
        axisValues: ['web', 'cli'],
        kind: 'manual',
        position: 2,
      },
    }));

    expect(TaskAxisSchema.parse(result)).toEqual({
      id: AXIS_ID,
      spaceId: SPACE_ID,
      name: 'platform',
      axisValues: ['web', 'cli'],
      kind: 'manual',
      position: 2,
    });
  });

  it('creates task axes through the route-bound G01 RPC', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('w2_create_task_axis');
      expect(args).toEqual([
        SPACE_ID,
        'platform',
        ['web'],
        'manual',
        1,
        null,
        'cmid-axis-create',
      ]);
      return {
        axis: {
          id: AXIS_ID,
          space_id: SPACE_ID,
          name: 'platform',
          axis_values: ['web'],
          kind: 'manual',
          position: 1,
        },
      };
    });
    const handler = registryFor(db).get('spaces.taskAxes.create')!;

    const result = await handler(context('spaces.taskAxes.create', {
      params: { spaceId: SPACE_ID },
      body: {
        clientMutationId: 'cmid-axis-create',
        name: 'platform',
        axisValues: ['web'],
        kind: 'manual',
        position: 1,
      },
    }));

    expect(result).toMatchObject({
      kind: 'json',
      status: 201,
      data: { id: AXIS_ID, spaceId: SPACE_ID, name: 'platform' },
    });
  });

  it('rejects unknown keys on catalogued invite commands before the database', async () => {
    const db = new FakeDb();
    const handler = registryFor(db).get('spaces.invites.create')!;

    await expect(handler(context('spaces.invites.create', {
      params: { spaceId: SPACE_ID },
      body: {
        clientMutationId: 'cmid-invite',
        maxUses: 1,
        hiddenPrivilege: true,
      },
    }))).rejects.toEqual(expect.objectContaining<Partial<CollabError>>({ code: 'invalid_input' }));
    expect(db.rpcCalls).toEqual([]);
  });

  it('rejects a malformed acting actor before any G01 mutation RPC', async () => {
    const db = new FakeDb();
    const handler = registryFor(db).get('spaces.update')!;

    await expect(handler(context('spaces.update', {
      params: { spaceId: SPACE_ID },
      body: {
        actorId: 'not-a-uuid',
        clientMutationId: 'cmid-invalid-actor',
        name: 'must not write',
      },
    }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('normalizes bounded invite creation and returns the frozen settings invite projection', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('create_invite');
      expect(args).toEqual([
        SPACE_ID,
        2,
        '2026-07-27T10:00:00.000Z',
        null,
        'cmid-invite-create',
        // 114: the role an invite confers, LAST in the positional list. A body
        // that omits it means `member` — the value every pre-114 invite already
        // had — and the default is applied by the handler, not by SQL, so a
        // wrong word is a 400 naming the vocabulary rather than a 22023.
        'member',
      ]);
      return {
        invite: {
          id: MEMBER_ID,
          code: 'inv_12345678',
          role: 'member',
          max_uses: 2,
          use_count: 0,
          expires_at: '2026-07-27T10:00:00.000Z',
          revoked_at: null,
        },
      };
    });
    const handler = registryFor(db).get('spaces.invites.create')!;

    const result = await handler(context('spaces.invites.create', {
      params: { spaceId: SPACE_ID },
      body: {
        clientMutationId: 'cmid-invite-create',
        maxUses: 2,
        expiresAt: '2026-07-27T10:00:00.000Z',
      },
    }));

    expect(result).toEqual({
      kind: 'json',
      status: 201,
      data: {
        id: MEMBER_ID,
        code: 'inv_12345678',
        role: 'member',
        maxUses: 2,
        uses: 0,
        expiresAt: '2026-07-27T10:00:00.000Z',
        revoked: false,
      },
    });
  });

  it('keyset-pages leaderboard scores with stable ranks and actor DTOs', async () => {
    const secondActorId = '00000000-0000-7000-8000-000000000005';
    const db = new FakeDb(async (sql) => {
      if (sql.includes('from public.members membership')) {
        return [{ entity_id: MEMBER_ID, role: 'owner' }];
      }
      if (sql.includes('with scores as')) {
        return [
          { actor_id: MEMBER_ID, score: '8', rank: '1' },
          { actor_id: secondActorId, score: '5', rank: '2' },
        ];
      }
      if (sql.includes('left join public.user_profiles up')) {
        return [{
          id: MEMBER_ID,
          kind: 'member',
          space_id: SPACE_ID,
          member_display_name: 'Owner',
          member_role: 'owner',
          team_member_name: null,
          team_member_avatar: null,
          team_member_owner_id: null,
          profile_display_name: 'Owner',
          profile_avatar: null,
        }];
      }
      throw new Error(`unexpected leaderboard query: ${sql}`);
    });
    const handler = registryFor(db).get('spaces.leaderboard')!;

    const result = await handler(context('spaces.leaderboard', {
      params: { spaceId: SPACE_ID },
      query: { limit: '1' },
    })) as { items: unknown[]; nextCursor: string | null };

    expect(result.items).toHaveLength(1);
    expect(LeaderboardRowSchema.parse(result.items[0])).toMatchObject({ score: 8, rank: 1 });
    expect(decodeCursor(result.nextCursor!).k).toEqual([8, MEMBER_ID]);
  });

  it('keyset-pages award history and keeps unreadable entity references nullable', async () => {
    const secondAwardId = '00000000-0000-7000-8000-000000000006';
    const db = new FakeDb(async (sql) => {
      if (sql.includes('from public.members membership')) {
        return [{ entity_id: MEMBER_ID, role: 'owner' }];
      }
      if (sql.includes('from public.point_events point_row')) {
        return [
          {
            id: AXIS_ID,
            recipient_id: MEMBER_ID,
            actor_id: MEMBER_ID,
            amount: 5,
            reason: 'award',
            ref_id: CHANNEL_ID,
            created_at: '2026-07-26T12:00:00.000Z',
            // The keyset value now comes from to_char, not from created_at —
            // the cursor must never round-trip through a JS Date.
            cursor_created_at: '2026-07-26T12:00:00.000000Z',
          },
          {
            id: secondAwardId,
            recipient_id: MEMBER_ID,
            actor_id: MEMBER_ID,
            amount: 1,
            reason: 'award',
            ref_id: null,
            created_at: '2026-07-26T11:00:00.000Z',
            cursor_created_at: '2026-07-26T11:00:00.000000Z',
          },
        ];
      }
      if (sql.includes('select e.id, e.kind, e.space_id') && sql.includes('profile_display_name')) {
        return [{
          id: MEMBER_ID,
          kind: 'member',
          space_id: SPACE_ID,
          member_display_name: 'Owner',
          member_role: 'owner',
          team_member_name: null,
          team_member_avatar: null,
          team_member_owner_id: null,
          profile_display_name: 'Owner',
          profile_avatar: null,
        }];
      }
      if (sql.includes('t.title as task_title')) return [];
      throw new Error(`unexpected awards query: ${sql}`);
    });
    const handler = registryFor(db).get('spaces.awards')!;

    const result = await handler(context('spaces.awards', {
      params: { spaceId: SPACE_ID },
      query: { limit: '1' },
    })) as { items: unknown[]; nextCursor: string | null };

    expect(result.items).toHaveLength(1);
    expect(PointEventViewSchema.parse(result.items[0])).toMatchObject({
      id: AXIS_ID,
      amount: 5,
      reason: 'award',
      onEntity: null,
      ref: null,
    });
    // Six fractional digits, taken from the row's `cursor_created_at` (to_char)
    // rather than from `created_at` via a JS Date. `spaces.awards` is a DESC
    // keyset, where a millisecond-truncated cursor does not loop — it SILENTLY
    // SKIPS every award sharing the lost millisecond. The old expectation here
    // was the truncated value, so this assertion moving IS the fix.
    expect(decodeCursor(result.nextCursor!).k).toEqual([
      '2026-07-26T12:00:00.000000Z',
      AXIS_ID,
    ]);
  });
});
