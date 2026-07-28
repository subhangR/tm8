import {
  EdgeViewSchema,
  getOperation,
  type CommandResult,
  type OperationName,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import {
  registerW2EdgesPlacementsHandlers,
} from '../../src/facade/handlers/w2/edges-placements.js';
import {
  queryEdges,
} from '../../src/facade/services/w2/edges-placements.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { EntityRow } from '../../src/facade/entity-read.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const IDS = {
  space: '00000000-0000-7000-8000-000000000301',
  member: '00000000-0000-7000-8000-000000000302',
  source: '00000000-0000-7000-8000-000000000303',
  target: '00000000-0000-7000-8000-000000000304',
  edgeA: '00000000-0000-7000-8000-000000000305',
  edgeB: '00000000-0000-7000-8000-000000000306',
};

const OWNER = {
  identityId: 'g03-owner',
  accountId: '00000000-0000-7000-8000-000000000399',
  username: 'g03-owner',
  isNodeAdmin: false,
  isOwner: true,
};

function taskRow(id: string, title: string): EntityRow {
  return {
    id,
    space_id: IDS.space,
    kind: 'task',
    parent_id: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activity_at: '2026-07-26T10:00:00.000Z',
    created_at: '2026-07-26T10:00:00.000Z',
    updated_at: '2026-07-26T10:00:00.000Z',
    deleted_at: null,
    created_by: IDS.member,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    task_title: title,
    task_description: '',
    task_axes: {},
    work_status: 'open',
    priority: 'medium',
    acceptance_criteria: [],
    points_estimate: null,
    due_date: null,
    doc_title: null,
    doc_body: null,
    doc_format: null,
    channel_name: null,
    channel_topic: null,
    member_display_name: null,
    member_role: null,
    team_member_name: null,
    team_member_model: null,
    team_member_agent_tool: null,
    team_member_owner_id: null,
    team_member_identity: null,
    team_member_avatar: null,
    team_member_capabilities: null,
    team_member_command_permissions: null,
    team_member_memories: null,
    collection_name: null,
    collection_description: null,
    collection_type: null,
    ws_title: null,
    ws_status: null,
    ws_agent_tool: null,
    ws_model: null,
    ws_share_mode: null,
    ws_started_at: null,
    ws_exited_at: null,
    ws_node_id: null,
    ws_project_id: null,
    ws_transcript_doc_id: null,
    anchor_id: null,
    root_message_id: null,
    author_id: null,
    message_batch_id: null,
    message_body: null,
    message_mentions: null,
    message_attachments: null,
    message_edited_at: null,
    message_redacted_at: null,
    file_name: null,
    file_mime: null,
    file_size: null,
  };
}

const ACTOR_ROW = {
  id: IDS.member,
  kind: 'member',
  space_id: IDS.space,
  member_display_name: 'G03 Owner',
  member_role: 'owner',
  team_member_name: null,
  team_member_avatar: null,
  team_member_owner_id: null,
  profile_display_name: 'G03 Owner',
  profile_avatar: null,
};

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

function deps(db: Db): FacadeDeps {
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
  registerW2EdgesPlacementsHandlers(registry, deps(db));
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

describe('W2.G03 edges, edge types, and placements handlers', () => {
  it('registers exactly the six frozen G03 operations', () => {
    expect(registered(new FakeDb()).implemented()).toEqual([
      'edgeTypes.list',
      'edges.create',
      'edges.delete',
      'edges.list',
      'edges.patch',
      'placements.apply',
    ]);
  });

  it('lists only live-endpoint RLS rows with direction-aware, fingerprinted keyset paging', async () => {
    let edgeSql = '';
    let edgeParams: readonly unknown[] = [];
    const rows = [
      {
        id: IDS.edgeA,
        src_id: IDS.target,
        dst_id: IDS.source,
        type: 'depends_on',
        props: { hard: true },
        created_by: IDS.member,
        created_at: '2026-07-26T11:00:00.000Z',
        updated_at: '2026-07-26T11:00:00.000Z',
        resolved: false,
      },
      {
        id: IDS.edgeB,
        src_id: IDS.target,
        dst_id: IDS.source,
        type: 'depends_on',
        props: { hard: true },
        created_by: IDS.member,
        created_at: '2026-07-26T10:00:00.000Z',
        updated_at: '2026-07-26T10:00:00.000Z',
        resolved: false,
      },
    ];
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
        if (sql.includes('from public.edges g') && sql.includes('src.deleted_at is null')) {
          edgeSql = sql;
          edgeParams = params;
          return rows as R[];
        }
        if (sql.includes('select') && sql.includes('where e.id = any')) {
          return [taskRow(IDS.source, 'Source'), taskRow(IDS.target, 'Target')] as R[];
        }
        if (sql.includes('left join public.members mem') && sql.includes('user_profiles')) {
          return [ACTOR_ROW] as R[];
        }
        return [];
      },
      rpc: async <T>(): Promise<T> => ({}) as T,
    };

    const first = await queryEdges(
      q,
      new URLSearchParams(
        `source=${IDS.source}&destination=${IDS.target}&type=depends_on&direction=incoming&limit=1`,
      ),
      OWNER.identityId,
    );
    expect(first.items).toHaveLength(1);
    expect(EdgeViewSchema.safeParse(first.items[0]).success).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    expect(edgeSql).toContain('src.deleted_at is null');
    expect(edgeSql).toContain('dst.deleted_at is null');
    // incoming reverses the relative source/destination anchor into actual dst/src.
    expect(edgeParams.slice(0, 3)).toEqual([IDS.source, IDS.target, 'depends_on']);

    await expect(queryEdges(
      q,
      new URLSearchParams(
        `source=${IDS.source}&destination=${IDS.target}&type=relates_to&direction=incoming&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      ),
      OWNER.identityId,
    )).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('exposes registry endpoint kinds and property schemas without inventing a contract wrapper', async () => {
    const db = new FakeDb();
    db.queryImpl = async <R>(sql: string) => {
      if (!sql.includes('from public.edge_types')) throw new Error(`unexpected query: ${sql}`);
      return [{
        type: 'depends_on',
        src_kinds: ['*'],
        dst_kinds: ['*'],
        description: 'Dependency',
        props_schema: { type: 'object', properties: { hard: { type: 'boolean' } } },
        acyclic: true,
      }] as R[];
    };
    const result = await handler(registered(db), 'edgeTypes.list')(request('edgeTypes.list'));
    expect(result).toEqual([{
      type: 'depends_on',
      sourceKinds: ['*'],
      destinationKinds: ['*'],
      direction: 'directed',
      description: 'Dependency',
      propsSchema: { type: 'object', properties: { hard: { type: 'boolean' } } },
      acyclic: true,
    }]);
  });

  it('rejects client-owned origin and routes every edge mutation through the shipped RPC signatures', async () => {
    const db = new FakeDb();
    const registry = registered(db);
    await expect(handler(registry, 'edges.create')(request('edges.create', {
      body: { srcId: IDS.source, dstId: IDS.target, type: 'relates_to', props: { origin: 'user' } },
    }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(db.calls).toEqual([]);

    const created = await handler(registry, 'edges.create')(request('edges.create', {
      body: {
        srcId: IDS.source,
        dstId: IDS.target,
        type: 'relates_to',
        props: { note: 'safe' },
        actorId: IDS.member,
        clientMutationId: 'g03-create',
      },
    }));
    expect(created).toMatchObject({ kind: 'json', status: 201 });
    expect(db.calls.at(-1)).toEqual({
      fn: 'write_edge',
      args: [IDS.source, IDS.target, 'relates_to', JSON.stringify({ note: 'safe' }), IDS.member, 'g03-create'],
    });

    await handler(registry, 'edges.patch')(request('edges.patch', {
      params: { edgeId: IDS.edgeA },
      body: { props: { hard: false }, clientMutationId: 'g03-patch' },
    }));
    expect(db.calls.at(-1)).toEqual({
      fn: 'update_edge',
      args: [IDS.edgeA, JSON.stringify({ hard: false }), null, 'g03-patch'],
    });

    await handler(registry, 'edges.delete')(request('edges.delete', {
      params: { edgeId: IDS.edgeA },
      body: { clientMutationId: 'g03-delete' },
    }));
    expect(db.calls.at(-1)).toEqual({
      fn: 'delete_edge',
      args: [IDS.edgeA, null, 'g03-delete'],
    });
  });

  it('forwards placement intent unchanged to the single atomic RPC and returns CommandResult', async () => {
    const db = new FakeDb();
    db.rpcImpl = async <T>(fn: string, args: readonly unknown[]) => {
      db.calls.push({ fn, args });
      return { patches: [], undo: { token: 'undo_g03placement', label: 'Embed', expiresAt: '2026-07-26T12:05:00.000Z' } } as T;
    };
    const result = await handler(registered(db), 'placements.apply')(request('placements.apply', {
      body: {
        sourceId: IDS.source,
        targetId: IDS.target,
        intent: 'embed',
        embedMessage: 'Look',
        actorId: IDS.member,
        clientMutationId: 'g03-place',
      },
    })) as CommandResult;
    expect(result.undo?.token).toBe('undo_g03placement');
    expect(db.calls).toEqual([{
      fn: 'place_entity',
      args: [IDS.source, IDS.target, 'embed', 'Look', null, IDS.member, 'g03-place'],
    }]);
  });

  it('projects the dependency hard flag on placement CommandResult edges', async () => {
    const db = new FakeDb();
    db.queryImpl = async <R>(sql: string) => {
      if (sql.includes('where e.id = any')) {
        return [taskRow(IDS.source, 'Source'), taskRow(IDS.target, 'Target')] as R[];
      }
      if (sql.includes('left join public.members mem') && sql.includes('user_profiles')) {
        return [ACTOR_ROW] as R[];
      }
      return [];
    };
    db.rpcImpl = async <T>(fn: string, args: readonly unknown[]) => {
      db.calls.push({ fn, args });
      return {
        edge: {
          id: IDS.edgeA,
          src_id: IDS.target,
          dst_id: IDS.source,
          type: 'depends_on',
          props: { hard: true },
          created_by: IDS.member,
          created_at: '2026-07-26T12:00:00.000Z',
          updated_at: '2026-07-26T12:00:00.000Z',
        },
        patches: [{ id: IDS.source }, { id: IDS.target }],
      } as T;
    };
    const result = await handler(registered(db), 'placements.apply')(request('placements.apply', {
      body: {
        sourceId: IDS.source,
        targetId: IDS.target,
        intent: 'depend',
        clientMutationId: 'g03-place-depend',
      },
    })) as CommandResult;
    expect(result.edge).toMatchObject({
      type: 'depends_on',
      source: { id: IDS.target },
      target: { id: IDS.source },
      props: { hard: true },
      hard: true,
    });
  });
});
