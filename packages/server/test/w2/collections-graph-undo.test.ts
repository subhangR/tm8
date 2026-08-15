import { describe, expect, it } from 'vitest';

import type { CollectionQuery, GraphQuery, OperationName } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { queryCollection } from '../../src/facade/handlers/collections.js';
import {
  queryGraph,
  registerW2CollectionsGraphUndoHandlers,
} from '../../src/facade/handlers/w2/graph-undo.js';
import type { EntityRow } from '../../src/facade/entity-read.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { projectForgeFacts } from '../../src/tracking/pr-projection.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE_ID = '00000000-0000-7000-8000-000000000501';
const MEMBER_ID = '00000000-0000-7000-8000-000000000502';
const ROOT_ID = '00000000-0000-7000-8000-000000000503';
const CHILD_ID = '00000000-0000-7000-8000-000000000504';
const OTHER_ID = '00000000-0000-7000-8000-000000000505';
const EDGE_ID = '00000000-0000-7000-8000-000000000506';
const PR_ID = '00000000-0000-7000-8000-000000000507';

function taskRow(id: string, title: string, parentId: string | null, position: number): EntityRow & { __sort: string; __sort_cursor: string } {
  const timestamp = `2026-07-2${position + 1}T10:00:00.000Z`;
  return {
    id,
    space_id: SPACE_ID,
    kind: 'task',
    parent_id: parentId,
    position,
    visibility: 'space',
    version: 1,
    activity_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: null,
    created_by: MEMBER_ID,
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
    __sort: timestamp,
    // Rendered by Postgres, never via a JS Date — see SortSpec.cursorExpr.
    __sort_cursor: timestamp,
  };
}

class FakeDb implements Db {
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];

  constructor(private readonly querier: Querier) {}

  tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier);
  }

  query<R>(_claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    return this.querier.query<R>(sql, params);
  }

  rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.rpcCalls.push({ fn, args });
    return this.querier.rpc<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: {} as FacadeDeps['config'],
    owner: async () => ({
      identityId: 'g05-owner',
      accountId: '00000000-0000-7000-8000-000000000599',
      username: 'g05-owner',
      isNodeAdmin: false,
      isOwner: true,
    }),
  };
}

function context(opName: OperationName, body: unknown): RequestContext {
  return {
    op: { name: opName, method: 'POST', path: '/test', kind: 'command', status: 'v1' },
    opName,
    params: {},
    query: new URLSearchParams(),
    body,
    requestId: 'req-g05',
    identity: { kind: 'auto-owner', identityId: 'g05-owner' },
    headers: {},
    method: 'POST',
    path: '/test',
  } as RequestContext;
}

function readQuerier(rows: Array<EntityRow & { __sort: string; __sort_cursor: string }>): Querier {
  return {
    query: async <R>(sql: string): Promise<R[]> => {
      if (sql.includes(' as __sort')) return rows as R[];
      return [];
    },
    rpc: async <T>(): Promise<T> => ({}) as T,
  };
}

describe('W2.G05 collection, graph, and undo handlers', () => {
  it('registers exactly the G05 operations plus the collection membership writes', () => {
    const db = new FakeDb(readQuerier([]));
    const registry = new HandlerRegistry();
    registerW2CollectionsGraphUndoHandlers(registry, deps(db));
    expect(registry.implemented()).toEqual([
      'collections.addItem',
      'collections.query',
      'collections.removeItem',
      'commands.undo',
      'graph.query',
    ]);
  });

  it('binds a collection cursor to the normalized query fingerprint and operation scope', async () => {
    const firstQuery: CollectionQuery = { spaceId: SPACE_ID, kinds: ['task'], limit: 1 };
    const first = await queryCollection(
      readQuerier([
        taskRow(ROOT_ID, 'Root', null, 2),
        taskRow(CHILD_ID, 'Child', ROOT_ID, 1),
      ]),
      firstQuery,
      'g05-owner',
    );
    expect(first.page.nextCursor).toBeTruthy();

    await expect(queryCollection(
      readQuerier([]),
      { ...firstQuery, kinds: ['doc'], cursor: first.page.nextCursor! },
      'g05-owner',
    )).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(queryCollection(
      readQuerier([]),
      { ...firstQuery, cursor: first.page.nextCursor! },
      'g05-owner',
      'graph.query',
    )).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('returns a bounded dependency projection with only induced readable edges and hierarchy clusters', async () => {
    const entityRows = [
      taskRow(ROOT_ID, 'Root', null, 3),
      taskRow(CHILD_ID, 'Child', ROOT_ID, 2),
      taskRow(OTHER_ID, 'Other', ROOT_ID, 1),
    ];
    let edgeSql = '';
    const q: Querier = {
      query: async <R>(sql: string): Promise<R[]> => {
        if (sql.includes(' as __sort')) return entityRows as R[];
        if (sql.includes('from public.edges g')) {
          edgeSql = sql;
          return [{
            id: EDGE_ID,
            src_id: ROOT_ID,
            dst_id: CHILD_ID,
            type: 'depends_on',
            props: { hard: true },
            created_by: MEMBER_ID,
            created_at: '2026-07-26T10:00:00.000Z',
            updated_at: '2026-07-26T10:00:00.000Z',
          }] as R[];
        }
        return [];
      },
      rpc: async <T>(): Promise<T> => ({}) as T,
    };
    const query: GraphQuery = {
      spaceId: SPACE_ID,
      focusId: ROOT_ID,
      hops: 1,
      mode: 'dependency',
      limit: 3,
    };

    const result = await queryGraph(q, query, 'g05-owner');

    expect(result.nodes.map((node) => node.id)).toEqual([ROOT_ID, CHILD_ID]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      id: EDGE_ID,
      type: 'depends_on',
      source: { id: ROOT_ID },
      target: { id: CHILD_ID },
      hard: true,
    });
    expect(result.clusters).toEqual([{ parentId: ROOT_ID, childIds: [CHILD_ID] }]);
    expect(edgeSql).toContain('src.deleted_at is null');
    expect(edgeSql).toContain('dst.deleted_at is null');
  });

  it('turns filters.activeSince into a bound clock predicate on the ordering column', async () => {
    // THE WINDOW IS A READ, NOT A CLIENT-SIDE SIEVE. `activityAt_desc` + a limit
    // can only ever answer "the newest N"; it cannot answer "what happened
    // today", because the page boundary moves with the space's volume. The
    // canvas's whole scope rests on this predicate existing server-side, so the
    // test asserts three separate things about it: that the column is
    // `activity_at` (the SAME column the default sort orders by, so a windowed
    // read is that ordering with a floor under it rather than a second notion of
    // recency), that the instant arrives as a BOUND PARAMETER rather than
    // interpolated text, and that it survives the graph read, which reaches
    // `queryCollection` through its own candidate call and could silently drop
    // an unrecognised filter on the way.
    const captured: Array<{ sql: string; params: readonly unknown[] }> = [];
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
        captured.push({ sql, params });
        if (sql.includes(' as __sort')) return [taskRow(ROOT_ID, 'Root', null, 1)] as R[];
        return [];
      },
      rpc: async <T>(): Promise<T> => ({}) as T,
    };
    const activeSince = '2026-07-28T10:00:00.000Z';

    await queryGraph(q, { spaceId: SPACE_ID, limit: 5, filters: { activeSince } }, 'g05-owner');

    const entityRead = captured.find((call) => call.sql.includes(' as __sort'));
    expect(entityRead).toBeDefined();
    expect(entityRead!.sql).toMatch(/e\.activity_at >= \$\d+::timestamptz/);
    expect(entityRead!.params).toContain(activeSince);
  });

  it('enriches a pull_request node with the same forge-fact fields as the connections read', async () => {
    // Same stored facts the connections read projects in
    // `projects-associations.ts` `artifactSummary`: the graph lens must serve
    // the SAME field names and values, through the SAME shared mapper — a
    // pull_request node whose state degrades to `fields: {}` is the live-rig
    // defect this test freezes out (chips dark despite a truthful
    // connections read).
    const prRow: EntityRow & { __sort: string; __sort_cursor: string } = {
      ...taskRow(PR_ID, '', null, 1),
      kind: 'pull_request',
      task_title: null,
      task_description: null,
      pr_title: 'Speed up CI',
      pr_repo: 'subhangR/tm8',
      pr_number: 89,
      pr_state: 'open',
      pr_ci_status: 'failing',
      pr_mergeable_state: 'dirty',
      pr_url: 'https://github.com/subhangR/tm8/pull/89',
      pr_fetched_at: '2026-08-09T12:00:00.000Z',
    };

    const result = await queryGraph(
      readQuerier([prRow]),
      { spaceId: SPACE_ID, kinds: ['pull_request'], limit: 5 },
      'g05-owner',
    );

    expect(result.nodes).toHaveLength(1);
    const node = result.nodes[0]!;
    expect(node.title).toBe('Speed up CI');
    expect(node.state).toEqual({
      kind: 'pull_request',
      repository: 'subhangR/tm8',
      number: 89,
      state: 'open',
      url: 'https://github.com/subhangR/tm8/pull/89',
      fetchedAt: '2026-08-09T12:00:00.000Z',
      stale: false,
      // The shared mapper the connections read spreads — asserting THROUGH it
      // binds the two doors to one vocabulary ('failing' / 'conflicted').
      ...projectForgeFacts('failing', 'dirty'),
    });
    expect(node.state).toMatchObject({ ciStatus: 'failing', mergeState: 'conflicted' });
  });

  it('validates and forwards undo token, actor, and mutation identity through one RPC transaction', async () => {
    const rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];
    const querier: Querier = {
      query: async <R>(): Promise<R[]> => [],
      rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
        rpcCalls.push({ fn, args });
        return { patches: [] } as T;
      },
    };
    const db = new FakeDb(querier);
    const registry = new HandlerRegistry();
    registerW2CollectionsGraphUndoHandlers(registry, deps(db));
    const handler = registry.get('commands.undo')!;

    await expect(handler(context('commands.undo', {}))).rejects.toMatchObject({ code: 'invalid_input' });
    expect(rpcCalls).toEqual([]);

    const result = await handler(context('commands.undo', {
      token: 'undo-token-g05',
      actorId: MEMBER_ID,
      clientMutationId: 'g05-undo-once',
    }));
    expect(rpcCalls).toEqual([{
      fn: 'undo_command',
      args: ['undo-token-g05', MEMBER_ID, 'g05-undo-once'],
    }]);
    expect(result).toEqual({ patches: [] });
  });
});
