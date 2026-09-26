import {
  ActionDiscoveryPageSchema,
  ActionDiscoveryResultSchema,
  OPERATIONS,
  SavedViewSchema,
  expandActionRows,
  getOperation,
  type ActionDiscoveryPage,
  type ActionDiscoveryResult,
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
  query: { spaceId: IDS.space, kinds: ['task'], filters: { status: ['open'] } },
  graph_layout: { [IDS.entity]: { x: 12, y: 24 } },
  created_at: new Date('2026-07-26T10:00:00.000Z'),
  updated_at: new Date('2026-07-26T10:00:00.000Z'),
};

class FakeDb implements Db {
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> = async (fn) => {
    if (fn === 'resolve_node_owner') return OWNER as T;
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
      if (fn === 'resolve_node_owner') return OWNER as T;
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

  function taskContextDb(workStatus: string): FakeDb {
    const db = new FakeDb();
    db.queryImpl = async <R>(sql: string) => {
      if (sql.includes('internal.current_member_id')) {
        return [{
          id: IDS.entity,
          space_id: IDS.space,
          kind: 'task',
          version: 3,
          deleted_at: null,
          work_status: workStatus,
          message_author_id: null,
          actor_id: IDS.member,
          is_space_admin: false,
        }] as R[];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    return db;
  }

  /** Registry order is alphabetical, so every global row would lead an unranked list. */
  function registerTaskSurface(db: Db): HandlerRegistry {
    const noOp: OperationHandler = async () => ({ ok: true });
    return register(db, (target) => {
      for (const operation of [
        'artifacts.create',
        'auth.login',
        'auth.logout',
        'spaces.create',
        'spaces.get',
        'spaces.members.list',
        'identity.get',
        'attentionRequests.list',
        'edges.create',
        'entities.get',
        'entities.context',
        'entities.patch',
        'entities.delete',
        'entities.commands.complete',
        'entities.commands.linkCommit',
        'entities.commands.linkPr',
        'entities.commands.work',
        'messages.post',
        'tracking.refresh',
      ] as const) {
        target.register(operation, noOp);
      }
    });
  }

  async function discover(registry: HandlerRegistry, query: string) {
    return ActionDiscoveryResultSchema.parse(await handler(registry, 'actions.list')(
      request('actions.list', { query }),
    ));
  }

  it('W6 review D1: never advertises delete/move/patch on a space_link; the same row as a doc does', async () => {
    const listFor = async (kind: string) => {
      const db = new FakeDb();
      db.queryImpl = async <R>(sql: string) => {
        if (sql.includes('internal.current_member_id')) {
          return [{
            id: IDS.entity, space_id: IDS.space, kind, version: 1, deleted_at: null,
            work_status: null, actor_id: IDS.member, is_space_admin: true,
          }] as R[];
        }
        throw new Error(`unexpected query: ${sql}`);
      };
      const noOp: OperationHandler = async () => ({ ok: true });
      const registry = register(db, (target) => {
        for (const op of ['entities.get', 'entities.patch', 'entities.move', 'entities.delete'] as const) target.register(op, noOp);
      });
      const parsed = ActionDiscoveryResultSchema.parse(await handler(registry, 'actions.list')(
        request('actions.list', { query: `contextEntityId=${IDS.entity}` }),
      ));
      return parsed.actions.map((action) => action.operation);
    };
    const link = await listFor('space_link');
    expect(link).toContain('entities.get');
    for (const op of ['entities.delete', 'entities.move', 'entities.patch']) expect(link).not.toContain(op);
    expect(await listFor('doc')).toEqual(expect.arrayContaining(['entities.get', 'entities.delete', 'entities.move', 'entities.patch']));
  });

  it('lists a working task\'s own operations first, most relevant first, and withholds global ones', async () => {
    const registry = registerTaskSurface(taskContextDb('working'));
    const result = await discover(registry, `contextEntityId=${IDS.entity}`);
    const operations = result.actions.map((action) => action.operation);

    expect(operations.slice(0, 8)).toEqual([
      'entities.commands.complete',
      'messages.post',
      'entities.commands.linkPr',
      'entities.commands.linkCommit',
      'entities.patch',
      'edges.create',
      'tracking.refresh',
      'entities.context',
    ]);
    // Global and Space-level operations answer the same on every entity; the
    // contextual list does not carry them.
    for (const global of [
      'auth.login', 'auth.logout', 'spaces.create', 'identity.get', 'artifacts.create',
      'savedViews.create', 'spaces.get', 'spaces.members.list', 'savedViews.list',
    ]) {
      expect(operations).not.toContain(global);
    }
    // Body-anchored parameter-free operations stay: they are about this entity.
    expect(operations).toContain('attentionRequests.list');
    // Deleting is the least likely next step and ranks last among what it names.
    expect(operations.indexOf('entities.delete')).toBeGreaterThan(operations.indexOf('entities.get'));
  });

  it('orders a not-yet-started task around starting work', async () => {
    const registry = registerTaskSurface(taskContextDb('open'));
    const operations = (await discover(registry, `contextEntityId=${IDS.entity}`))
      .actions.map((action) => action.operation);
    expect(operations[0]).toBe('entities.commands.work');
    expect(operations.indexOf('messages.post')).toBeLessThan(operations.indexOf('entities.commands.complete'));
  });

  it('keeps the complete authorized inventory behind scope=all, contextual rows first, under one epoch', async () => {
    const registry = registerTaskSurface(taskContextDb('working'));
    const contextual = await discover(registry, `contextEntityId=${IDS.entity}`);
    const all = await discover(registry, `contextEntityId=${IDS.entity}&scope=all`);
    const contextualOps = contextual.actions.map((action) => action.operation);
    const allOps = all.actions.map((action) => action.operation);

    expect(allOps.slice(0, contextualOps.length)).toEqual(contextualOps);
    const rest = allOps.slice(contextualOps.length);
    // Space-level before global, each group in registry order.
    expect(rest).toEqual([
      'savedViews.list',
      'spaces.get',
      'spaces.members.list',
      'artifacts.create',
      'auth.login',
      'auth.logout',
      'identity.get',
      'savedViews.create',
      'spaces.create',
    ]);
    // Filtering is presentation, not authorization: the epoch digests the
    // whole inventory, so both views of the same state agree on it.
    expect(all.capabilityEpoch).toBe(contextual.capabilityEpoch);
    expect(all.actions.every((action) => action.capabilityEpoch === contextual.capabilityEpoch)).toBe(true);
    expect([...allOps].sort()).toEqual([...new Set(allOps)].sort());

    const explicit = await discover(registry, `contextEntityId=${IDS.entity}&scope=contextual`);
    expect(explicit.actions.map((action) => action.operation)).toEqual(contextualOps);
  });

  it('refuses an unknown discovery scope', async () => {
    const registry = registerTaskSurface(taskContextDb('working'));
    await expect(handler(registry, 'actions.list')(
      request('actions.list', { query: `contextEntityId=${IDS.entity}&scope=everything` }),
    )).rejects.toMatchObject({ code: 'invalid_input' });
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

/**
 * `tm8.actions.v2`: the factored rows, paging, and the size gate.
 *
 * The fixture is the PRODUCTION composition's shape: every non-reserved
 * catalog operation is implemented, so the contextual list and the full
 * inventory are as long as a real node's.
 */
describe('actions.list schema=v2 — factored rows, paging, size gate', () => {
  const SAVED_VIEWS_AND_SELF = new Set<string>([
    'savedViews.list', 'savedViews.create', 'savedViews.update', 'savedViews.delete', 'actions.list',
  ]);

  function fullCatalog(workStatus = 'working'): { registry: HandlerRegistry; setVersion(v: number): void } {
    let version = 4;
    const db = new FakeDb();
    db.queryImpl = async <R>(sql: string) => {
      if (sql.includes('internal.current_member_id')) {
        return [{
          id: IDS.entity,
          space_id: IDS.space,
          kind: 'task',
          version,
          deleted_at: null,
          work_status: workStatus,
          message_author_id: null,
          actor_id: IDS.member,
          is_space_admin: true,
        }] as R[];
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    const noOp: OperationHandler = async () => ({ ok: true });
    const registry = register(db, (target) => {
      for (const op of OPERATIONS) {
        if (op.status === 'reserved' || SAVED_VIEWS_AND_SELF.has(op.name)) continue;
        target.register(op.name, noOp);
      }
    });
    return { registry, setVersion: (v) => { version = v; } };
  }

  async function list(registry: HandlerRegistry, query: string): Promise<unknown> {
    return handler(registry, 'actions.list')(request('actions.list', { query }));
  }

  async function page(registry: HandlerRegistry, query: string): Promise<ActionDiscoveryPage> {
    return ActionDiscoveryPageSchema.parse(await list(registry, query));
  }

  async function v1(registry: HandlerRegistry, query: string): Promise<ActionDiscoveryResult> {
    return ActionDiscoveryResultSchema.parse(await list(registry, query));
  }

  /** Every page of a listing, following nextCursor to the end. */
  async function walk(registry: HandlerRegistry, query: string): Promise<ActionDiscoveryPage[]> {
    const pages: ActionDiscoveryPage[] = [];
    let cursor: string | null = null;
    do {
      const next = await page(
        registry,
        `${query}&schema=v2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      pages.push(next);
      cursor = next.nextCursor;
    } while (cursor !== null && pages.length < 50);
    return pages;
  }

  /**
   * The v1 object exactly as it was constructed BEFORE v2 existed — written
   * out here independently, so the reversibility check is against the old
   * wire, not against the derivation helpers it is testing.
   */
  function legacyAction(
    result: Pick<ActionDiscoveryResult, 'targetEntityId' | 'targetVersion' | 'capabilityEpoch'>,
    action: { operation: OperationName; kind: string; authzTarget: string; exposure: string },
  ): Record<string, unknown> {
    return {
      id: `action:${action.operation}:${result.targetEntityId ?? 'global'}`,
      label: action.operation.replaceAll('.', ' '),
      kind: action.kind,
      operation: action.operation,
      ...(result.targetEntityId
        ? { targetEntityId: result.targetEntityId, targetVersion: result.targetVersion }
        : {}),
      capabilityEpoch: result.capabilityEpoch,
      authzTarget: action.authzTarget,
      exposure: action.exposure,
      helpRef: `tm8://help/operation/${action.operation}`,
    };
  }

  for (const [name, query] of [
    ['contextual', `contextEntityId=${IDS.entity}`],
    ['scope=all', `contextEntityId=${IDS.entity}&scope=all`],
    ['global', ''],
  ] as const) {
    it(`reconstructs every v1 action object exactly from v2 pages (${name})`, async () => {
      const { registry } = fullCatalog();
      const legacy = await v1(registry, query);
      const pages = await walk(registry, query);
      const rows = pages.flatMap((p) => p.rows);

      expect(rows.length).toBe(legacy.actions.length);
      expect(pages.every((p) => p.total === legacy.actions.length)).toBe(true);
      // Byte-identical, key order included: v2 loses nothing v1 said.
      const rebuilt = expandActionRows({ ...pages[0]!, rows });
      expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(legacy));
      // ...and v1 itself is still what the old construction produced.
      for (const action of legacy.actions) {
        expect(JSON.stringify(action)).toBe(JSON.stringify(legacyAction(legacy, action)));
      }
      if (name === 'global') expect(pages[0]!.target).toBeUndefined();
      else expect(pages[0]!.target).toEqual({ id: IDS.entity, kind: 'task', version: 4 });
    });
  }

  it('keeps the size gate: the default contextual page on a working task is at most 1.5 KB minified', async () => {
    const { registry } = fullCatalog('working');
    const legacy = await v1(registry, `contextEntityId=${IDS.entity}`);
    const first = await page(registry, `contextEntityId=${IDS.entity}&schema=v2`);
    const bytes = Buffer.byteLength(JSON.stringify(first), 'utf8');

    expect(first.rows.length).toBe(Math.min(20, legacy.actions.length));
    expect(first.rows[0]?.[0]).toBe('entities.commands.complete');
    expect(bytes).toBeLessThanOrEqual(1500);
    // The v1 answer to the same question, for scale (not a gate).
    expect(Buffer.byteLength(JSON.stringify(legacy), 'utf8')).toBeGreaterThan(bytes * 4);
  });

  it('bounds every page of the full inventory, at the default and the maximum limit', async () => {
    const { registry } = fullCatalog();
    for (const limit of [20, 100]) {
      const pages: ActionDiscoveryPage[] = [];
      let cursor: string | null = null;
      do {
        const next = await page(registry, `contextEntityId=${IDS.entity}&scope=all&schema=v2&limit=${limit}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        pages.push(next);
        cursor = next.nextCursor;
      } while (cursor !== null && pages.length < 50);
      for (const p of pages) {
        expect(p.rows.length).toBeLessThanOrEqual(limit);
        // ~60 B per row plus a ~350 B header: a page can never grow unboundedly.
        expect(Buffer.byteLength(JSON.stringify(p), 'utf8')).toBeLessThanOrEqual(400 + limit * 80);
      }
      expect(pages.at(-1)!.nextCursor).toBeNull();
      expect(new Set(pages.flatMap((p) => p.rows.map(([op]) => op))).size)
        .toBe(pages.flatMap((p) => p.rows).length);
    }
  });

  it('binds a cursor to its listing: a changed epoch, another scope or a forged cursor is invalid_cursor', async () => {
    const { registry, setVersion } = fullCatalog();
    const first = await page(registry, `contextEntityId=${IDS.entity}&scope=all&schema=v2`);
    const cursor = encodeURIComponent(first.nextCursor!);

    // The contextual listing is a different ranked list; its cursor is not this one's.
    await expect(list(registry, `contextEntityId=${IDS.entity}&schema=v2&cursor=${cursor}`))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(list(registry, `contextEntityId=${IDS.entity}&scope=all&schema=v2&cursor=abc`))
      .rejects.toMatchObject({ code: 'invalid_cursor' });

    // Same listing, same epoch: accepted and continues right after page one.
    const second = await page(registry, `contextEntityId=${IDS.entity}&scope=all&schema=v2&cursor=${cursor}`);
    expect(second.rows[0]).not.toEqual(first.rows.at(-1));
    expect(second.capabilityEpoch).toBe(first.capabilityEpoch);

    // The target moved: the ranked list the cursor pointed into is gone.
    setVersion(5);
    await expect(list(registry, `contextEntityId=${IDS.entity}&scope=all&schema=v2&cursor=${cursor}`))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('keeps v1 the unpaged default and refuses paging it cannot express', async () => {
    const { registry } = fullCatalog();
    const legacy = await v1(registry, `contextEntityId=${IDS.entity}&scope=all`);
    expect(legacy.actions.length).toBeGreaterThan(20);
    expect(await list(registry, `contextEntityId=${IDS.entity}&schema=v1`)).toEqual(
      await list(registry, `contextEntityId=${IDS.entity}`),
    );
    for (const query of [
      `contextEntityId=${IDS.entity}&limit=5`,
      `contextEntityId=${IDS.entity}&schema=v1&cursor=abc`,
      `contextEntityId=${IDS.entity}&schema=v3`,
      `contextEntityId=${IDS.entity}&schema=v2&limit=0`,
      `contextEntityId=${IDS.entity}&schema=v2&limit=101`,
      `contextEntityId=${IDS.entity}&schema=v2&limit=ten`,
    ]) {
      await expect(list(registry, query)).rejects.toMatchObject({ code: 'invalid_input' });
    }
  });
});
