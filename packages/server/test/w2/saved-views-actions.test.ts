import {
  ActionDiscoveryResultSchema,
  SavedViewSchema,
  getOperation,
  type OperationName,
  type SavedViewInput,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { registerW2SavedViewsActionsHandlers } from '../../src/facade/handlers/w2/saved-views-actions.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const OWNER = {
  identityId: 'identity-owner',
  accountId: '11111111-1111-4111-8111-111111111111',
  username: 'owner',
  isNodeAdmin: true,
  isOwner: true,
};

const IDS = {
  space: '22222222-2222-4222-8222-222222222222',
  view: '33333333-3333-4333-8333-333333333333',
  member: '44444444-4444-4444-8444-444444444444',
  entity: '55555555-5555-4555-8555-555555555555',
};

const ACTOR_ROW = {
  id: IDS.member,
  kind: 'member',
  space_id: IDS.space,
  member_display_name: 'Owner',
  member_role: 'owner',
  team_member_name: null,
  team_member_avatar: null,
  team_member_owner_id: null,
  profile_display_name: 'Owner Profile',
  profile_avatar: null,
};

const VIEW_ROW = {
  id: IDS.view,
  space_id: IDS.space,
  owner_member_id: IDS.member,
  name: 'Urgent work',
  share_mode: 'private',
  query: { spaceId: IDS.space, kinds: ['task'], filters: { workStatus: ['open'] } },
  graph_layout: { [IDS.entity]: { x: 12, y: 24 } },
  created_at: new Date('2026-07-26T10:00:00.000Z'),
  updated_at: new Date('2026-07-26T10:00:00.000Z'),
};

class FakeDb implements Db {
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> = async (fn) => {
    if (fn === 'resolve_account_credential') return OWNER as T;
    throw new Error(`unexpected rpc: ${fn}`);
  };

  tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: <R>(sql: string, params: readonly unknown[] = []) => this.queryImpl<R>(sql, params),
      rpc: <R>(name: string, args: readonly unknown[] = []) => this.rpcImpl<R>(name, args),
    });
  }

  rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.rpcImpl<T>(fn, args);
  }

  query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.queryImpl<R>(sql, params);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function request(
  opName: OperationName,
  options: {
    params?: Record<string, string>;
    query?: string;
    body?: unknown;
  } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: `request-${opName}`,
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function register(db: Db, before?: (registry: HandlerRegistry) => void): HandlerRegistry {
  const registry = new HandlerRegistry();
  before?.(registry);
  registerW2SavedViewsActionsHandlers(registry, {
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024 * 1024,
      databaseUrl: 'postgres://unused',
    },
  });
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing handler: ${name}`);
  return value;
}

describe('W2.G09 saved views and action discovery', () => {
  it('registers exactly the five G09 semantic operations', () => {
    const registry = register(new FakeDb());
    expect(registry.implemented()).toEqual([
      'actions.list',
      'savedViews.create',
      'savedViews.delete',
      'savedViews.list',
      'savedViews.update',
    ]);
  });

  it('lists only RLS-returned views and projects their frozen SavedView shape', async () => {
    const db = new FakeDb();
    db.queryImpl = async <R>(sql: string) => {
      if (sql.includes('from public.saved_views')) return [VIEW_ROW] as R[];
      if (sql.includes('left join public.members mem')) return [ACTOR_ROW] as R[];
      throw new Error(`unexpected query: ${sql}`);
    };
    const registry = register(db);

    const result = await handler(registry, 'savedViews.list')(
      request('savedViews.list', { params: { spaceId: IDS.space } }),
    );

    expect(result).toEqual([
      {
        id: IDS.view,
        spaceId: IDS.space,
        name: 'Urgent work',
        shareMode: 'private',
        query: VIEW_ROW.query,
        graphLayout: VIEW_ROW.graph_layout,
        createdBy: {
          id: IDS.member,
          kind: 'member',
          displayName: 'Owner',
          avatar: null,
          role: 'owner',
          isAgent: false,
        },
        createdAt: '2026-07-26T10:00:00.000Z',
      },
    ]);
    expect(SavedViewSchema.array().safeParse(result).success).toBe(true);
  });

  it('routes create/update/delete through ledger-backed RPCs and returns no invented DTO', async () => {
    const db = new FakeDb();
    const calls: Array<{ fn: string; args: readonly unknown[] }> = [];
    db.rpcImpl = async <T>(fn: string, args: readonly unknown[]) => {
      if (fn === 'resolve_account_credential') return OWNER as T;
      calls.push({ fn, args });
      return VIEW_ROW as T;
    };
    db.queryImpl = async <R>(sql: string) => {
      if (sql.includes('left join public.members mem')) return [ACTOR_ROW] as R[];
      throw new Error(`unexpected query: ${sql}`);
    };
    const registry = register(db);
    const input: SavedViewInput = {
      clientMutationId: 'saved-view-create-1',
      name: VIEW_ROW.name,
      shareMode: 'private',
      query: VIEW_ROW.query,
      graphLayout: VIEW_ROW.graph_layout,
    };

    const created = await handler(registry, 'savedViews.create')(
      request('savedViews.create', { body: input }),
    );
    expect(created).toMatchObject({ kind: 'json', status: 201 });
    expect(SavedViewSchema.safeParse((created as { data: unknown }).data).success).toBe(true);
    expect(calls.at(-1)).toEqual({
      fn: 'create_saved_view',
      args: [
        IDS.space,
        VIEW_ROW.name,
        'private',
        JSON.stringify(VIEW_ROW.query),
        JSON.stringify(VIEW_ROW.graph_layout),
        null,
        'saved-view-create-1',
      ],
    });

    await handler(registry, 'savedViews.update')(
      request('savedViews.update', {
        params: { viewId: IDS.view },
        body: { ...input, clientMutationId: 'saved-view-update-1', name: 'Renamed' },
      }),
    );
    expect(calls.at(-1)).toEqual({
      fn: 'update_saved_view',
      args: [
        IDS.view,
        'Renamed',
        'private',
        JSON.stringify(VIEW_ROW.query),
        JSON.stringify(VIEW_ROW.graph_layout),
        null,
        'saved-view-update-1',
      ],
    });

    const deleted = await handler(registry, 'savedViews.delete')(
      request('savedViews.delete', {
        params: { viewId: IDS.view },
        body: { clientMutationId: 'saved-view-delete-1' },
      }),
    );
    expect(SavedViewSchema.safeParse(deleted).success).toBe(true);
    expect(calls.at(-1)).toEqual({
      fn: 'delete_saved_view',
      args: [IDS.view, null, 'saved-view-delete-1'],
    });
  });

  it('requires a clientMutationId for every saved-view mutation', async () => {
    const registry = register(new FakeDb());

    await expect(handler(registry, 'savedViews.create')(
      request('savedViews.create', {
        body: { name: 'Missing id', shareMode: 'private', query: { spaceId: IDS.space } },
      }),
    )).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(handler(registry, 'savedViews.delete')(
      request('savedViews.delete', { params: { viewId: IDS.view }, body: {} }),
    )).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('derives contextual actions from capabilities and the registry actually mounted', async () => {
    const db = new FakeDb();
    let version = 7;
    db.queryImpl = async <R>(sql: string) => {
      if (sql.includes('internal.current_member_id')) {
        return [{
          id: IDS.entity,
          space_id: IDS.space,
          kind: 'task',
          version,
          deleted_at: null,
          work_status: 'open',
          actor_id: IDS.member,
          is_space_admin: false,
        }] as R[];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const noOp: OperationHandler = async () => ({ ok: true });
    const registry = register(db, (target) => {
      target.register('entities.get', noOp);
      target.register('entities.patch', noOp);
      target.register('entities.commands.complete', noOp);
      target.register('execution.prompt', noOp);
    });

    const first = await handler(registry, 'actions.list')(
      request('actions.list', { query: `contextEntityId=${IDS.entity}` }),
    );
    const parsed = ActionDiscoveryResultSchema.parse(first);
    const operations = parsed.actions.map((action) => action.operation);

    expect(operations).toContain('entities.get');
    expect(operations).toContain('entities.patch');
    expect(operations).toContain('entities.commands.complete');
    expect(operations).not.toContain('entities.delete');
    expect(operations).not.toContain('execution.prompt');
    expect(operations).not.toContain('search.query');
    expect(parsed.actorId).toBe(IDS.member);
    expect(parsed.targetEntityId).toBe(IDS.entity);
    expect(parsed.targetVersion).toBe(7);
    expect(parsed.actions.every((action) => action.capabilityEpoch === parsed.capabilityEpoch)).toBe(true);
    expect(parsed.actions.find((action) => action.operation === 'entities.patch')).toMatchObject({
      targetEntityId: IDS.entity,
      targetVersion: 7,
      authzTarget: 'entity',
      exposure: 'public',
      helpRef: 'tm8://help/operation/entities.patch',
    });

    version = 8;
    const second = ActionDiscoveryResultSchema.parse(await handler(registry, 'actions.list')(
      request('actions.list', { query: `contextEntityId=${IDS.entity}` }),
    ));
    expect(second.capabilityEpoch).not.toBe(parsed.capabilityEpoch);
  });

  it('reports only invokable operations for the current Server composition without entity context', async () => {
    const registry = register(new FakeDb());
    const result = ActionDiscoveryResultSchema.parse(await handler(registry, 'actions.list')(
      request('actions.list'),
    ));

    expect(result.actions.map((action) => action.operation)).toEqual(['savedViews.create']);
    expect(result.actions[0]).toMatchObject({
      exposure: 'public',
      authzTarget: 'space',
      helpRef: 'tm8://help/operation/savedViews.create',
    });
  });
});
