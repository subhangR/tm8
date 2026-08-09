import { getOperation, type OperationName } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import {
  registerW2EntitiesCommandsTrackingHandlers,
} from '../../src/facade/handlers/w2/entities-commands-tracking.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

class FakeDb implements Db {
  readonly calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> = async (fn, args) => {
    this.calls.push({ fn, args });
    return { patches: [] } as T;
  };

  tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: <R>(sql: string, params: readonly unknown[] = []) => this.queryImpl<R>(sql, params),
      rpc: <T>(name: string, args: readonly unknown[] = []) => this.rpcImpl<T>(name, args),
    });
  }

  query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.queryImpl<R>(sql, params);
  }

  rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.rpcImpl<T>(fn, args);
  }

  async end(): Promise<void> {}
}

const OWNER = {
  identityId: 'w2-g02-owner',
  accountId: '00000000-0000-7000-8000-000000000299',
  username: 'w2-g02-owner',
  isNodeAdmin: false,
  isOwner: true,
};

function deps(db: Db = new FakeDb()): FacadeDeps {
  return {
    db,
    config: {} as FacadeDeps['config'],
    owner: async () => OWNER,
  };
}

function request(
  opName: OperationName,
  options: { params?: Record<string, string>; query?: string; body?: unknown } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: new URLSearchParams(options.query),
    body: options.body,
    requestId: `req-${opName}`,
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function registered(db: Db): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2EntitiesCommandsTrackingHandlers(registry, deps(db));
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

describe('W2.G02 universal entities, commands, and tracking', () => {
  it('registers the universal entity and attention operations through one seam', () => {
    const registry = new HandlerRegistry();
    registerW2EntitiesCommandsTrackingHandlers(registry, deps());

    expect(registry.implemented()).toEqual([
      'attentionRequests.create',
      'attentionRequests.list',
      'attentionRequests.resolveEntity',
      'attentionRequests.update',
      'entities.activity',
      'entities.children',
      'entities.commands.complete',
      'entities.commands.gate',
      'entities.commands.linkCommit',
      'entities.commands.linkPr',
      'entities.commands.pull',
      'entities.commands.work',
      'entities.connections',
      'entities.create',
      'entities.delete',
      'entities.get',
      'entities.hierarchy',
      'entities.move',
      'entities.patch',
      'entities.points.add',
      'entities.react',
      'entities.restore',
      'entities.versions',
      'tracking.refresh',
    ]);
  });

  it('returns frozen create/accepted statuses and dispatches concrete enumerable RPCs', async () => {
    const db = new FakeDb();
    db.rpcImpl = async <T>(fn: string, args: readonly unknown[]): Promise<T> => {
      db.calls.push({ fn, args });
      if (fn === 'queue_tracking_refresh') {
        return { accepted: true, status: 'queued', requestIds: ['00000000-0000-7000-8000-000000000201'] } as T;
      }
      return { patches: [] } as T;
    };
    const registry = registered(db);
    const created = await handler(registry, 'entities.create')(request('entities.create', { body: {
      clientMutationId: 'g02-create',
      spaceId: '00000000-0000-7000-8000-000000000202',
      kind: 'spell',
      title: 'Typed spell',
      content: { description: 'real', rule: { allow: true } },
    } }));
    expect(created).toMatchObject({ kind: 'json', status: 201 });
    expect(db.calls[0]).toEqual({
      fn: 'create_spell_entity',
      args: [
        '00000000-0000-7000-8000-000000000202', 'Typed spell', null, 'real',
        JSON.stringify({ allow: true }), null, null, 'g02-create',
      ],
    });

    const accepted = await handler(registry, 'tracking.refresh')(request('tracking.refresh', { body: {
      clientMutationId: 'g02-refresh',
      entityIds: ['00000000-0000-7000-8000-000000000203'],
    } }));
    expect(accepted).toMatchObject({
      kind: 'json', status: 202,
      data: { accepted: true, status: 'queued' },
    });
    expect(db.calls[1]).toEqual({
      fn: 'queue_tracking_refresh',
      args: [['00000000-0000-7000-8000-000000000203'], null, 'g02-refresh'],
    });
  });

  it('normalizes provider URLs into frozen link RPC signatures and refuses malformed URLs before SQL', async () => {
    const db = new FakeDb();
    const registry = registered(db);
    const task = '00000000-0000-7000-8000-000000000204';
    const project = '00000000-0000-7000-8000-000000000205';
    await handler(registry, 'entities.commands.linkPr')(request('entities.commands.linkPr', {
      params: { id: task },
      body: { clientMutationId: 'g02-pr', url: 'https://github.com/acme/tm8/pull/77', projectId: project },
    }));
    await handler(registry, 'entities.commands.linkCommit')(request('entities.commands.linkCommit', {
      params: { id: task },
      body: { clientMutationId: 'g02-commit', url: 'https://git.example/acme/tm8/commit/aBcDeF123' },
    }));
    expect(db.calls).toEqual([
      { fn: 'link_pull_request', args: [task, 'https://github.com/acme/tm8/pull/77', 'github', 'acme/tm8', 77,
        project, null, 'g02-pr'] },
      { fn: 'link_commit', args: [task, 'https://git.example/acme/tm8/commit/aBcDeF123', 'git.example',
        'acme/tm8', 'aBcDeF123', null, null, 'g02-commit'] },
    ]);
    await expect(handler(registry, 'entities.commands.linkPr')(request('entities.commands.linkPr', {
      params: { id: task }, body: { clientMutationId: 'bad', url: 'https://github.com/acme/tm8/issues/7' },
    }))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.calls).toHaveLength(2);
  });

  it('refuses restricted generic create and patch before selecting a mutation RPC', async () => {
    const db = new FakeDb();
    const registry = registered(db);
    await expect(handler(registry, 'entities.create')(request('entities.create', { body: {
      clientMutationId: 'restricted-create', spaceId: '00000000-0000-7000-8000-000000000202',
      kind: 'interaction_profile', title: 'owned elsewhere',
    } }))).rejects.toMatchObject({ code: 'forbidden' });

    db.queryImpl = async <R>(sql: string): Promise<R[]> => {
      if (sql.includes('select kind from public.entities')) return [{ kind: 'project' }] as R[];
      return [];
    };
    await expect(handler(registry, 'entities.patch')(request('entities.patch', {
      params: { id: '00000000-0000-7000-8000-000000000205' },
      body: { clientMutationId: 'restricted-patch', expectedVersion: 1, title: 'forged' },
    }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(db.calls).toEqual([]);
  });
});
