import { describe, expect, it, vi } from 'vitest';

import {
  CollabError,
  MenuConfigSchema,
  SpaceSettingsViewSchema,
  type MenuConfig,
  type MenuConfigPayload,
  type OperationName,
  type SpaceSettingsView,
} from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2MenuDefaultChannelHandlers } from '../../src/facade/handlers/w2/menu-default-channel.js';
import type { MenuUpdatedEventEffect } from '../../src/facade/services/w2/menu-default-channel.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE_ID = '00000000-0000-7000-8000-000000000001';
const MEMBER_ID = '00000000-0000-7000-8000-000000000002';
const CHANNEL_ID = '00000000-0000-7000-8000-000000000003';
const AXIS_ID = '00000000-0000-7000-8000-000000000004';
const PROFILE_ID = '00000000-0000-7000-8000-000000000005';

const DEFAULT_GROUPS: MenuConfigPayload['groups'] = [
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
];

const DEFAULT_MENU: MenuConfig = {
  schemaVersion: 1,
  revision: 1,
  groups: DEFAULT_GROUPS,
};

const REORDERED_MENU: MenuConfig = {
  ...DEFAULT_MENU,
  revision: 2,
  groups: [...DEFAULT_GROUPS].reverse(),
};

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

function context(opName: OperationName, body?: unknown): RequestContext {
  return {
    op: { name: opName, method: 'GET', path: '/test', kind: 'read', status: 'v1' },
    opName,
    params: { spaceId: SPACE_ID },
    query: new URLSearchParams(),
    body,
    requestId: 'req-g14',
    identity: { kind: 'auto-owner', identityId: 'identity-owner' },
    headers: {},
    method: 'GET',
    path: '/test',
  } as RequestContext;
}

function registryFor(
  db: Db,
  publishMenuUpdated?: (spaceId: string, effect: MenuUpdatedEventEffect) => void | Promise<void>,
): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2MenuDefaultChannelHandlers(registry, deps(db), { publishMenuUpdated });
  return registry;
}

/**
 * Dossier A03 freezes `spaces.defaultChannel.set` as
 * `SetDefaultChannelInput -> SpaceSettingsView`, and PostgreSQL honours that by
 * returning `internal.w2_space_settings_view(p_space_id)` from inside the same
 * command transaction (029_w2_menu_default_channel.sql). This is that exact
 * eight-key projection, so the mock speaks the frozen contract rather than the
 * superseded narrow acknowledgement.
 */
const FROZEN_SETTINGS_VIEW: SpaceSettingsView = {
  space: {
    id: SPACE_ID,
    name: 'G14 Space',
    description: 'Menu test',
    memberCount: 1,
    unreadTotal: 0,
    githubRepo: null,
    createdAt: '2026-07-26T00:00:00.000Z',
  },
  members: [{
    actor: {
      id: MEMBER_ID,
      kind: 'member',
      displayName: 'Owner',
      avatar: null,
      role: 'owner',
      isAgent: false,
    },
    role: 'owner',
    joinedAt: '2026-07-26T00:00:00.000Z',
  }],
  invites: [],
  taskAxes: [{
    id: AXIS_ID,
    spaceId: SPACE_ID,
    name: 'status',
    axisValues: ['todo', 'done'],
    kind: 'default',
    position: 0,
  }],
  menu: DEFAULT_MENU,
  defaultChannelId: CHANNEL_ID,
  defaultInteractionProfileId: PROFILE_ID,
  settingsRevision: 2,
};

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

function defaultChannelDb(rpcResult: unknown): FakeDb {
  return new FakeDb(
    async (sql) => {
      throw new Error(`default-channel must not issue a follow-up read: ${sql}`);
    },
    async (fn, args) => {
      if (fn !== 'set_space_default_channel') throw new Error(`unexpected RPC: ${fn}`);
      expect(args).toEqual([SPACE_ID, CHANNEL_ID, 1, 'cmid-default-1']);
      return rpcResult;
    },
  );
}

async function setDefaultChannel(db: Db): Promise<unknown> {
  return registryFor(db).get('spaces.defaultChannel.set')!(context('spaces.defaultChannel.set', {
    clientMutationId: 'cmid-default-1',
    expectedSettingsRevision: 1,
    channelId: CHANNEL_ID,
  }));
}

describe('W2.G14 menu/default-channel registration seam', () => {
  it('registers exactly the three frozen operations', () => {
    const registry = registryFor(new FakeDb());

    expect(registry.implemented()).toEqual([
      'spaces.defaultChannel.set',
      'spaces.menu.get',
      'spaces.menu.update',
    ]);
  });

  it('reads a contract-valid menu through the member-authorized read RPC', async () => {
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('get_space_menu');
      expect(args).toEqual([SPACE_ID]);
      return DEFAULT_MENU;
    });
    const handler = registryFor(db).get('spaces.menu.get')!;

    const menu = await handler(context('spaces.menu.get'));

    expect(MenuConfigSchema.parse(menu)).toEqual(DEFAULT_MENU);
  });

  it('writes the revision-free payload and returns the full first-attempt publication effect', async () => {
    const effect: MenuUpdatedEventEffect = {
      type: 'menu.updated',
      menu: REORDERED_MENU,
      clientMutationId: 'cmid-menu-1',
    };
    const db = new FakeDb(async () => [], async (fn, args) => {
      expect(fn).toBe('update_space_menu');
      expect(args).toEqual([
        SPACE_ID,
        { schemaVersion: 1, groups: [...DEFAULT_GROUPS].reverse() },
        1,
        'cmid-menu-1',
      ]);
      return { menu: REORDERED_MENU, eventEffect: effect };
    });
    const publishMenuUpdated = vi.fn();
    const handler = registryFor(db, publishMenuUpdated).get('spaces.menu.update')!;

    const menu = await handler(context('spaces.menu.update', {
      clientMutationId: 'cmid-menu-1',
      expectedRevision: 1,
      payload: { schemaVersion: 1, groups: [...DEFAULT_GROUPS].reverse() },
    }));

    expect(menu).toEqual(REORDERED_MENU);
    expect(publishMenuUpdated).toHaveBeenCalledOnce();
    expect(publishMenuUpdated).toHaveBeenCalledWith(SPACE_ID, effect);
  });

  it('does not republish when the ledger replay omits the first-attempt effect', async () => {
    const db = new FakeDb(async () => [], async () => ({ menu: REORDERED_MENU }));
    const publishMenuUpdated = vi.fn();
    const handler = registryFor(db, publishMenuUpdated).get('spaces.menu.update')!;

    await handler(context('spaces.menu.update', {
      clientMutationId: 'cmid-menu-replay',
      expectedRevision: 1,
      payload: { schemaVersion: 1, groups: [...DEFAULT_GROUPS].reverse() },
    }));

    expect(publishMenuUpdated).not.toHaveBeenCalled();
  });

  it.each([
    ['menu_revision_conflict', { currentMenu: DEFAULT_MENU }],
    ['menu_upgrade_required', {}],
  ] as const)('maps %s away from the entity version-conflict taxonomy', async (reason, detail) => {
    const db = new FakeDb(async () => [], async () => {
      throw new CollabError('version_conflict', 'menu write refused', {
        details: { sqlstate: '40001', reason, ...detail },
      });
    });
    const handler = registryFor(db).get('spaces.menu.update')!;

    await expect(handler(context('spaces.menu.update', {
      clientMutationId: 'cmid-menu-error',
      expectedRevision: 1,
      payload: { schemaVersion: 1, groups: DEFAULT_GROUPS },
    }))).rejects.toMatchObject({
      code: 'conflict',
      details: { reason, ...detail },
    });
  });

  it('uses the frozen strict input schemas before a command reaches PostgreSQL', async () => {
    const db = new FakeDb();
    const registry = registryFor(db);

    await expect(registry.get('spaces.menu.update')!(context('spaces.menu.update', {
      clientMutationId: 'cmid-invalid-menu',
      expectedRevision: 1,
      payload: {
        schemaVersion: 1,
        groups: [{
          id: 'settings',
          label: 'Settings',
          items: [
            { type: 'view', ref: 'settings' },
            { type: 'view', ref: 'settings' },
          ],
        }],
      },
    }))).rejects.toMatchObject({ code: 'invalid_input' });

    await expect(registry.get('spaces.defaultChannel.set')!(context('spaces.defaultChannel.set', {
      clientMutationId: 'cmid-invalid-default',
      expectedSettingsRevision: 1,
      channelId: null,
      surprise: true,
    }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('sets a live channel and returns the full frozen settings projection from the same transaction', async () => {
    const db = defaultChannelDb(FROZEN_SETTINGS_VIEW);

    const settings = await setDefaultChannel(db);

    expect(SpaceSettingsViewSchema.parse(settings)).toEqual(FROZEN_SETTINGS_VIEW);
    expect(Object.keys(settings as object).sort()).toEqual(FROZEN_SETTINGS_KEYS);
    expect(settings).toMatchObject({
      menu: DEFAULT_MENU,
      defaultChannelId: CHANNEL_ID,
      defaultInteractionProfileId: PROFILE_ID,
      settingsRevision: 2,
    });
    // The projection is the command's own result: A03 forbids a second read.
    expect(db.queryCalls).toEqual([]);
    expect(db.rpcCalls.map((call) => call.fn)).toEqual(['set_space_default_channel']);
  });

  // The guard on the A03 return shape must be exercised on purpose, not as a
  // side effect of a stale mock. Each case is a shape PostgreSQL must never
  // send; the probe above confirms the frozen eight-key view is NOT refused.
  it.each([
    ['the superseded narrow two-key acknowledgement', {
      defaultChannelId: CHANNEL_ID,
      settingsRevision: 2,
    }],
    ['a projection missing the frozen menu', (() => {
      const { menu: _menu, ...rest } = FROZEN_SETTINGS_VIEW;
      return rest;
    })()],
    ['a projection carrying an unfrozen extra key', { ...FROZEN_SETTINGS_VIEW, surprise: true }],
    ['a projection whose settingsRevision is not a positive integer', {
      ...FROZEN_SETTINGS_VIEW,
      settingsRevision: 0,
    }],
    ['a projection whose menu violates the MenuConfig law', {
      ...FROZEN_SETTINGS_VIEW,
      menu: { schemaVersion: 1, revision: 1, groups: [] },
    }],
    ['a non-object acknowledgement', 'ok'],
    ['a null acknowledgement', null],
  ] as const)('refuses %s as upstream_unavailable', async (_label, rpcResult) => {
    const db = defaultChannelDb(rpcResult);

    await expect(setDefaultChannel(db)).rejects.toMatchObject({
      code: 'upstream_unavailable',
      message: 'default-channel result violates the frozen SpaceSettingsView contract',
    });
  });
});
