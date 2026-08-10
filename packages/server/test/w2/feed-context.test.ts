/**
 * W2.G13 — `entities.feed` (dossier A11) and `entities.context` (dossier A12).
 *
 * The load-bearing law under test is dossier M1/M3: a feed is selected by a
 * VERSIONED NAMED SCOPE and never by a raw predicate array. So the majority of
 * these assertions are about what the operation REFUSES — an unknown key, a
 * filter expression, a SQL fragment, an arbitrary scope string — and about the
 * fact that the refusal happens before anything reaches PostgreSQL. A raw
 * predicate escape hatch would be a hidden query seam, the same class of defect
 * as a hidden mutation seam.
 */
import {
  EntityContextViewSchema,
  EntityFeedPageSchema,
  decodeCursor,
  encodeCursor,
  getOperation,
  type EntityContextView,
  type EntityFeedPage,
  type OperationName,
  type PaletteAction,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { EntityRow } from '../../src/facade/entity-read.js';
import { registerW2FeedContextHandlers } from '../../src/facade/handlers/w2/feed-context.js';
import {
  FEED_SCOPE_PREDICATES,
  feedCursorFingerprint,
  resolveFeedScope,
  type W2FeedContextServiceOptions,
} from '../../src/facade/services/w2/feed-context.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const IDS = {
  space: '00000000-0000-7000-8000-000000000d01',
  task: '00000000-0000-7000-8000-000000000d02',
  session: '00000000-0000-7000-8000-000000000d03',
  member: '00000000-0000-7000-8000-000000000d04',
  teammate: '00000000-0000-7000-8000-000000000d05',
  rootMessage: '00000000-0000-7000-8000-000000000d06',
  replyMessage: '00000000-0000-7000-8000-000000000d07',
  activity: '00000000-0000-7000-8000-000000000d08',
  causedActivity: '00000000-0000-7000-8000-000000000d09',
  child: '00000000-0000-7000-8000-000000000d0a',
  parent: '00000000-0000-7000-8000-000000000d0b',
  edge: '00000000-0000-7000-8000-000000000d0c',
  absent: '00000000-0000-7000-8000-000000000dff',
};

const OWNER = {
  identityId: 'w2-g13-owner',
  accountId: '00000000-0000-7000-8000-000000000df0',
  username: 'w2-g13-owner',
  isNodeAdmin: true,
  isOwner: true,
};

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

function baseRow(id: string, kind: string): EntityRow {
  return {
    id,
    space_id: IDS.space,
    kind,
    parent_id: null,
    position: 1,
    visibility: 'space',
    version: 3,
    activity_at: '2026-07-26T10:00:00.000Z',
    created_at: '2026-07-26T09:00:00.000Z',
    updated_at: '2026-07-26T10:00:00.000Z',
    deleted_at: null,
    created_by: IDS.member,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    task_title: null,
    task_description: null,
    task_axes: null,
    work_status: null,
    priority: null,
    acceptance_criteria: null,
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

function taskRow(id: string, title = 'G13 anchor task'): EntityRow {
  return {
    ...baseRow(id, 'task'),
    task_title: title,
    task_description: 'anchor',
    task_axes: {},
    work_status: 'open',
    priority: 'medium',
    acceptance_criteria: [],
  };
}

function sessionRow(id: string): EntityRow {
  return {
    ...baseRow(id, 'work_session'),
    ws_title: 'G13 session',
    ws_status: 'running',
    ws_share_mode: 'space',
    ws_started_at: '2026-07-26T09:00:00.000Z',
  };
}

function messageRow(
  id: string,
  options: { anchorId: string; root?: string | null; body?: string; batch?: string | null } = {
    anchorId: IDS.task,
  },
): EntityRow {
  return {
    ...baseRow(id, 'message'),
    anchor_id: options.anchorId,
    root_message_id: options.root ?? null,
    author_id: IDS.teammate,
    message_body: options.body ?? 'a durable message',
    message_batch_id: options.batch === undefined ? 'batch-g13-1' : options.batch,
    message_mentions: [],
    message_attachments: [],
  };
}

function actorRow(id: string, kind: 'member' | 'team_member', name: string): Record<string, unknown> {
  return {
    id,
    kind,
    space_id: IDS.space,
    member_display_name: kind === 'member' ? name : null,
    member_role: kind === 'member' ? 'owner' : null,
    team_member_name: kind === 'team_member' ? name : null,
    team_member_avatar: null,
    team_member_owner_id: kind === 'team_member' ? IDS.member : null,
    profile_display_name: kind === 'member' ? name : null,
    profile_avatar: null,
  };
}

const ACTOR_ROWS = [
  actorRow(IDS.member, 'member', 'G13 Owner'),
  actorRow(IDS.teammate, 'team_member', 'G13 Agent'),
];

interface PageRow {
  item_kind: 'message' | 'activity';
  item_id: string;
  created_at: string;
  via: string[];
}

interface ActivityRow {
  id: string;
  entity_id: string | null;
  actor_id: string | null;
  verb: string;
  summary: Record<string, unknown>;
  ref_id: string | null;
  created_at: string;
  work_session_id: string | null;
}

function activityRow(id: string, overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id,
    entity_id: IDS.task,
    actor_id: IDS.member,
    verb: 'work.changed',
    summary: { to: 'working' },
    ref_id: null,
    created_at: '2026-07-26T09:30:00.000Z',
    work_session_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake database — routes on the SQL markers the service emits
// ---------------------------------------------------------------------------

class FakeDb implements Db {
  readonly claims: DbClaims[] = [];
  readonly sql: string[] = [];
  readonly params: unknown[][] = [];
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];

  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    this.claims.push(claims);
    return fn({
      query: <R>(sql: string, params: readonly unknown[] = []) => {
        this.sql.push(sql);
        this.params.push([...params]);
        return this.queryImpl<R>(sql, params);
      },
      rpc: <R>(name: string, args: readonly unknown[] = []) => {
        this.rpcCalls.push({ fn: name, args });
        return Promise.resolve({} as R);
      },
    });
  }

  query<R>(claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    this.claims.push(claims);
    this.sql.push(sql);
    this.params.push([...params]);
    return this.queryImpl<R>(sql, params);
  }

  rpc<T>(claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.claims.push(claims);
    this.rpcCalls.push({ fn, args });
    return Promise.resolve({} as T);
  }

  async end(): Promise<void> {}
}

interface Stub {
  anchor?: Array<{ id: string; kind: string; space_id: string }>;
  page?: PageRow[];
  locate?: Array<{ item_id: string; created_at: string; in_scope: boolean }>;
  activity?: ActivityRow[];
  deliveries?: Array<Record<string, unknown>>;
  sessionTargets?: Array<{
    source_message_id: string;
    target_message_id: string;
    target_work_session_id: string;
  }>;
  provenance?: Array<{ src_id: string; dst_id: string }>;
  entities?: EntityRow[];
  root?: EntityRow[];
  parents?: EntityRow[];
  children?: EntityRow[];
  edges?: Array<Record<string, unknown>>;
  messages?: Array<{ entity_id: string }>;
  eventSeq?: number;
}

function router(stub: Stub): <R>(sql: string, params: readonly unknown[]) => Promise<R[]> {
  return async <R>(sql: string): Promise<R[]> => {
    const marker = /\/\* (entities\.[a-z]+:[a-z]+) \*\//.exec(sql)?.[1];
    switch (marker) {
      case 'entities.feed:anchor':
        return (stub.anchor ?? []) as R[];
      case 'entities.feed:page':
        return (stub.page ?? []) as R[];
      case 'entities.feed:locate':
        return (stub.locate ?? []) as R[];
      case 'entities.feed:activity':
        return (stub.activity ?? []) as R[];
      case 'entities.feed:deliveries':
        return (stub.deliveries ?? []) as R[];
      case 'entities.feed:sessiontargets':
        return (stub.sessionTargets ?? []) as R[];
      case 'entities.feed:provenance':
        return (stub.provenance ?? []) as R[];
      case 'entities.context:root':
        return (stub.root ?? []) as R[];
      case 'entities.context:parents':
        return (stub.parents ?? []) as R[];
      case 'entities.context:children':
        return (stub.children ?? []) as R[];
      case 'entities.context:edges':
        return (stub.edges ?? []) as R[];
      case 'entities.context:messages':
        return (stub.messages ?? []) as R[];
      case 'entities.context:activity':
        return (stub.activity ?? []) as R[];
      case 'entities.context:seq':
        return [{ seq: String(stub.eventSeq ?? 0) }] as R[];
      default:
        break;
    }
    if (sql.includes('left join public.user_profiles up')) return ACTOR_ROWS as R[];
    if (sql.includes('root_message_id = any(')) return [] as R[];
    if (sql.includes("and e.kind = 'message'")) {
      return (stub.entities ?? []).filter((row) => row.kind === 'message') as R[];
    }
    if (sql.includes('t.title as task_title')) return (stub.entities ?? []) as R[];
    return [] as R[];
  };
}

function request(
  opName: OperationName,
  options: { params?: Record<string, string>; query?: string } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? { id: IDS.task },
    query: new URLSearchParams(options.query ?? ''),
    body: undefined,
    requestId: `request-${opName}`,
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

const PALETTE: PaletteAction[] = [
  {
    id: 'action:entities.get:g13',
    label: 'entities get',
    kind: 'navigate',
    operation: 'entities.get',
    targetEntityId: IDS.task,
    targetVersion: 3,
    capabilityEpoch: 'cap:g13',
    authzTarget: 'entity',
    exposure: 'public',
    helpRef: 'tm8://help/operation/entities.get',
  },
];

function registryFor(db: Db, options: W2FeedContextServiceOptions = {}): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2FeedContextHandlers(
    registry,
    { db, config: {} as never, owner: async () => OWNER },
    { actions: async () => PALETTE, ...options },
  );
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing handler: ${name}`);
  return value;
}

function feedOn(stub: Stub, options: W2FeedContextServiceOptions = {}): {
  db: FakeDb;
  run: (query?: string, params?: Record<string, string>) => Promise<EntityFeedPage>;
} {
  const db = new FakeDb();
  db.queryImpl = router(stub);
  const registry = registryFor(db, options);
  return {
    db,
    run: async (query = '', params?: Record<string, string>) =>
      (await handler(registry, 'entities.feed')(
        request('entities.feed', { query, ...(params ? { params } : {}) }),
      )) as EntityFeedPage,
  };
}

function contextOn(stub: Stub, options: W2FeedContextServiceOptions = {}): {
  db: FakeDb;
  run: (query?: string) => Promise<EntityContextView>;
} {
  const db = new FakeDb();
  db.queryImpl = router(stub);
  const registry = registryFor(db, options);
  return {
    db,
    run: async (query = '') =>
      (await handler(registry, 'entities.context')(
        request('entities.context', { query }),
      )) as EntityContextView,
  };
}

const TASK_ANCHOR = [{ id: IDS.task, kind: 'task', space_id: IDS.space }];
const SESSION_ANCHOR = [{ id: IDS.session, kind: 'work_session', space_id: IDS.space }];

// ---------------------------------------------------------------------------

describe('W2.G13 registration seam', () => {
  it('registers exactly the two catalogued G13 read operations', () => {
    expect(registryFor(new FakeDb()).implemented()).toEqual([
      'entities.context',
      'entities.feed',
    ]);
  });
});

describe('W2.G13 versioned named scope (dossier M1/M3)', () => {
  it('freezes the scope→predicate registry as a closed, server-owned map', () => {
    expect(Object.keys(FEED_SCOPE_PREDICATES).sort()).toEqual([
      'channel_threads_v1',
      'direct_v1',
      'session_chat_v1',
      'task_discussion_v1',
      'thread_v1',
    ]);
    expect(FEED_SCOPE_PREDICATES.direct_v1).toEqual(['anchored', 'replies', 'subject']);
    expect(FEED_SCOPE_PREDICATES.session_chat_v1).toEqual([
      'anchored',
      'authored',
      'caused',
      'replies',
    ]);
    // `direct_v1` minus `replies` — a reply stops being drawn as a PEER of the
    // message it answers. It is still stored and still reachable through
    // `messages.list?rootMessageId=`; only the flattening goes away.
    expect(FEED_SCOPE_PREDICATES.channel_threads_v1).toEqual(['anchored', 'subject']);
    // The derivation reading (098). `thread_v1` has NO `anchored`: a reply
    // anchors on the channel, never on its root (019:423), so `anchored` on a
    // message anchor is the documented empty-feed trap.
    expect(FEED_SCOPE_PREDICATES.thread_v1).toEqual([
      'derived_session',
      'derived_task',
      'subject',
      'thread',
    ]);
    // `direct_v1` + `derived_thread`, confined to tasks — never `direct_v1`
    // edited in place.
    expect(FEED_SCOPE_PREDICATES.task_discussion_v1).toEqual([
      'anchored',
      'derived_thread',
      'replies',
      'subject',
    ]);
    // Canonical (deduped AND sorted) so the cursor fingerprint and the SQL
    // assembly can never be fed two different spellings of one predicate set.
    for (const predicates of Object.values(FEED_SCOPE_PREDICATES)) {
      expect([...predicates]).toEqual([...new Set(predicates)].sort());
    }
  });

  it('resolves `default` from the anchor kind and refuses an inapplicable named scope', () => {
    // 098: a task defaults to its Discussion joined to the thread it was
    // derived from; `direct_v1` remains nameable for the pre-derivation read.
    expect(resolveFeedScope(undefined, 'task')).toBe('task_discussion_v1');
    expect(resolveFeedScope('default', 'task')).toBe('task_discussion_v1');
    expect(resolveFeedScope('direct_v1', 'task')).toBe('direct_v1');
    expect(resolveFeedScope(undefined, 'doc')).toBe('direct_v1');
    expect(resolveFeedScope('default', 'work_session')).toBe('session_chat_v1');
    expect(resolveFeedScope('direct_v1', 'work_session')).toBe('direct_v1');
    // 098: a message anchor's `direct_v1` is near-empty by construction
    // (019:423 — a reply anchors on the channel, never on its root), so
    // `default` on a message means the thread.
    expect(resolveFeedScope(undefined, 'message')).toBe('thread_v1');
    expect(resolveFeedScope('default', 'message')).toBe('thread_v1');
    expect(() => resolveFeedScope('thread_v1', 'task')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );
    expect(() => resolveFeedScope('thread_v1', 'channel')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );
    expect(() => resolveFeedScope('task_discussion_v1', 'message')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );
    expect(() => resolveFeedScope('task_discussion_v1', 'channel')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );
    expect(() => resolveFeedScope('session_chat_v1', 'task')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );

    // A channel defaults to roots-only, so a client that asks for nothing in
    // particular gets the threaded reading.
    expect(resolveFeedScope(undefined, 'channel')).toBe('channel_threads_v1');
    expect(resolveFeedScope('default', 'channel')).toBe('channel_threads_v1');
    // Naming a scope explicitly still wins — `default` only decides the
    // fallback, it never overrides a caller who said what they wanted.
    expect(resolveFeedScope('direct_v1', 'channel')).toBe('direct_v1');
    // And the new scope is narrow: it answers for a channel and nothing else.
    expect(() => resolveFeedScope('channel_threads_v1', 'task')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );
    expect(() => resolveFeedScope('channel_threads_v1', 'work_session')).toThrowError(
      /feed_scope_not_applicable|not applicable/,
    );
  });

  it('refuses every raw-predicate escape hatch BEFORE any database work', async () => {
    const rejected = [
      'predicates=subject,anchored',
      'predicates[]=subject',
      'via=authored',
      'filter=author_id%3D1',
      'where=1%3D1',
      'sql=select%201',
      'scope=raw%3Aselect%201',
      'scope=direct',
      'scope=direct_v2',
      'scope=%5B%22subject%22%5D',
      'order=random',
      'limit=0',
      'limit=101',
      'limit=abc',
      'around=message%3Aabc&cursor=xyz',
      'around=comment%3Aabc',
    ];
    for (const query of rejected) {
      const { db, run } = feedOn({ anchor: TASK_ANCHOR });
      await expect(run(query), query).rejects.toMatchObject({ code: 'invalid_input' });
      expect(db.sql, `${query} must not reach PostgreSQL`).toEqual([]);
      expect(db.claims, `${query} must not open a transaction`).toEqual([]);
    }
  });

  it('maps an inapplicable named scope to invalid_input + feed_scope_not_applicable', async () => {
    const { db, run } = feedOn({ anchor: TASK_ANCHOR });
    await expect(run('scope=session_chat_v1')).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'feed_scope_not_applicable' },
    });
    // The anchor kind had to be read to know this, but the feed page must not.
    expect(db.sql.filter((sql) => sql.includes('entities.feed:page'))).toEqual([]);
  });

  it('assembles the page SQL from the resolved scope only — one branch per predicate', async () => {
    const direct = feedOn({ anchor: TASK_ANCHOR });
    await direct.run('scope=direct_v1');
    const directSql = direct.db.sql.find((sql) => sql.includes('entities.feed:page')) ?? '';
    expect(directSql).toContain("'anchored'");
    expect(directSql).toContain("'replies'");
    expect(directSql).toContain("'subject'");
    expect(directSql).not.toContain('authored_from');
    expect(directSql).not.toContain('work_session_id');

    const session = feedOn({ anchor: SESSION_ANCHOR });
    await session.run('scope=session_chat_v1', { id: IDS.session });
    const sessionSql = session.db.sql.find((sql) => sql.includes('entities.feed:page')) ?? '';
    expect(sessionSql).toContain('authored_from');
    expect(sessionSql).toContain('a.work_session_id');
    expect(sessionSql).not.toContain("'subject'");
  });

  it('orders newest-first by default and flips both the sort and the keyset comparator', async () => {
    const newest = feedOn({ anchor: TASK_ANCHOR });
    await newest.run();
    const newestSql = newest.db.sql.find((sql) => sql.includes('entities.feed:page')) ?? '';
    expect(newestSql).toMatch(/order by\s+created_at desc,\s*item_id desc/);

    const oldest = feedOn({ anchor: TASK_ANCHOR });
    await oldest.run('order=oldest');
    const oldestSql = oldest.db.sql.find((sql) => sql.includes('entities.feed:page')) ?? '';
    expect(oldestSql).toMatch(/order by\s+created_at asc,\s*item_id asc/);
  });
});

describe('W2.G13 entities.feed page assembly', () => {
  const stub: Stub = {
    anchor: TASK_ANCHOR,
    page: [
      {
        item_kind: 'message',
        item_id: IDS.rootMessage,
        created_at: '2026-07-26T09:45:00.000Z',
        via: ['anchored'],
      },
      {
        item_kind: 'activity',
        item_id: IDS.activity,
        created_at: '2026-07-26T09:30:00.000Z',
        via: ['subject'],
      },
    ],
    entities: [messageRow(IDS.rootMessage), taskRow(IDS.task)],
    activity: [activityRow(IDS.activity)],
    provenance: [{ src_id: IDS.rootMessage, dst_id: IDS.session }],
    deliveries: [
      {
        delivery_id: 'delivery-1',
        message_id: IDS.rootMessage,
        target_work_session_id: IDS.session,
        status: 'delivered',
        attempt_no: 1,
        failure_reason: null,
        updated_at: '2026-07-26T09:46:00.000Z',
      },
    ],
  };

  it('returns a contract-valid page carrying server-owned provenance on every item', async () => {
    const { run } = feedOn(stub);
    const page = await run();
    expect(EntityFeedPageSchema.parse(page)).toBeTruthy();
    // 098: a task's `default` resolves to its derivation-joined Discussion.
    expect(page.resolvedScope).toBe('task_discussion_v1');
    expect(page.predicates).toEqual(['anchored', 'derived_thread', 'replies', 'subject']);

    const message = page.items[0]!;
    expect(message.itemKind).toBe('message');
    expect(message.via).toEqual(['anchored']);
    expect(message.actor?.id).toBe(IDS.teammate);
    expect(message.sourceWorkSessionId).toBe(IDS.session);
    expect(message.logicalOperationId).toBe('batch-g13-1');
    expect(message.anchor?.id).toBe(IDS.task);
    if (message.itemKind !== 'message') throw new Error('expected a message item');
    expect(message.delivery).toHaveLength(1);
    expect(message.delivery[0]).toMatchObject({ deliveryId: 'delivery-1', status: 'delivered' });

    const activity = page.items[1]!;
    if (activity.itemKind !== 'activity') throw new Error('expected an activity item');
    expect(activity.via).toEqual(['subject']);
    expect(activity.activity.verb).toBe('work.changed');
    // `public.activity` stores no logical-operation identity and G13 does not
    // add one — the column would sit under three composed, already-gated
    // readers. `null` is the honest answer, not an invented value.
    expect(activity.logicalOperationId).toBeNull();
    expect(activity.sourceWorkSessionId).toBeNull();
  });

  it('projects channel message siblings as linked sessions and carries their delivery facet', async () => {
    const targetMessage = '00000000-0000-7000-8000-000000000d10';
    const { run } = feedOn({
      anchor: TASK_ANCHOR,
      page: [{
        item_kind: 'message',
        item_id: IDS.rootMessage,
        created_at: '2026-07-26T09:45:00.000Z',
        via: ['anchored'],
      }],
      entities: [messageRow(IDS.rootMessage), taskRow(IDS.task), sessionRow(IDS.session)],
      sessionTargets: [{
        source_message_id: IDS.rootMessage,
        target_message_id: targetMessage,
        target_work_session_id: IDS.session,
      }],
      deliveries: [{
        delivery_id: 'delivery-target-1',
        message_id: targetMessage,
        target_work_session_id: IDS.session,
        status: 'delivered',
        attempt_no: 1,
        failure_reason: null,
        updated_at: '2026-07-26T09:46:00.000Z',
      }],
    });
    const page = await run();
    const item = page.items[0];
    if (item?.itemKind !== 'message') throw new Error('expected message feed item');
    expect(item.linkedWorkSessions).toHaveLength(1);
    expect(item.linkedWorkSessions?.[0]).toMatchObject({ id: IDS.session, title: 'G13 session' });
    expect(item.delivery[0]).toMatchObject({
      deliveryId: 'delivery-target-1',
      targetWorkSessionId: IDS.session,
      targetWorkSession: { id: IDS.session, title: 'G13 session' },
    });
    expect(EntityFeedPageSchema.parse(page)).toBeTruthy();
  });

  it('never lets the request forge recorder-owned provenance', async () => {
    // Every provenance field is refused as an input key by the strict contract
    // schema, so there is no request-side spelling of it at all.
    for (const query of [
      'actorId=' + IDS.member,
      'sourceWorkSessionId=' + IDS.session,
      'logicalOperationId=forged',
      'via=authored',
    ]) {
      const { run } = feedOn(stub);
      await expect(run(query), query).rejects.toMatchObject({ code: 'invalid_input' });
    }
    // And what IS returned comes from the stored rows only.
    const forgedSession = '00000000-0000-7000-8000-0000000009ff';
    const { run } = feedOn({ ...stub, provenance: [] });
    const page = await run();
    expect(page.items[0]!.sourceWorkSessionId).toBeNull();
    expect(JSON.stringify(page)).not.toContain(forgedSession);
  });

  it('reads through claim-bound RLS and never issues a write', async () => {
    const { db, run } = feedOn(stub);
    await run();
    expect(db.rpcCalls).toEqual([]);
    expect(db.claims.at(-1)).toMatchObject({ identityId: OWNER.identityId });
    for (const sql of db.sql) {
      expect(sql).not.toMatch(/\b(insert|update|delete)\s+/i);
    }
  });

  it('answers not_found for an anchor RLS hides rather than an empty page', async () => {
    const { run } = feedOn({ anchor: [] });
    await expect(run()).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('W2.G13 feed cursors', () => {
  const stub: Stub = {
    anchor: TASK_ANCHOR,
    page: [
      {
        item_kind: 'activity',
        item_id: IDS.activity,
        created_at: '2026-07-26T09:30:00.000Z',
        via: ['subject'],
      },
      {
        item_kind: 'activity',
        item_id: IDS.causedActivity,
        created_at: '2026-07-26T09:29:00.000Z',
        via: ['subject'],
      },
    ],
    activity: [
      activityRow(IDS.activity),
      activityRow(IDS.causedActivity, { created_at: '2026-07-26T09:29:00.000Z' }),
    ],
    entities: [taskRow(IDS.task)],
  };

  it('emits a keyset cursor only when a further page exists', async () => {
    const complete = feedOn(stub);
    expect((await complete.run('limit=2')).nextCursor).toBeNull();

    const more = feedOn(stub);
    const page = await more.run('limit=1');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    expect(decodeCursor(page.nextCursor!).k).toHaveLength(3);
  });

  it('accepts a cursor across a REORDERED but identical request (order-equivalence)', async () => {
    const first = feedOn(stub);
    const page = await first.run('scope=direct_v1&order=newest&limit=1');
    const cursor = encodeURIComponent(page.nextCursor!);

    // Same filter, different URL insertion order — must be the same filter.
    const second = feedOn(stub);
    await expect(
      second.run(`limit=1&order=newest&cursor=${cursor}&scope=direct_v1`),
    ).resolves.toBeTruthy();
    const keyset = second.db.params[second.db.sql.findIndex((s) => s.includes('feed:page'))] ?? [];
    expect(keyset).toContain(IDS.activity);
  });

  it('rejects a cursor whose filter or sort fingerprint actually differs', async () => {
    const first = feedOn(stub);
    const cursor = encodeURIComponent((await first.run('limit=1&scope=direct_v1'))!.nextCursor!);

    const flippedOrder = feedOn(stub);
    await expect(
      flippedOrder.run(`limit=1&scope=direct_v1&order=oldest&cursor=${cursor}`),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });

    const flippedScope = feedOn({ ...stub, anchor: SESSION_ANCHOR });
    await expect(
      flippedScope.run(`limit=1&scope=session_chat_v1&cursor=${cursor}`, { id: IDS.session }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });

    const otherAnchor = feedOn({ ...stub, anchor: [{ id: IDS.child, kind: 'task', space_id: IDS.space }] });
    await expect(
      otherAnchor.run(`limit=1&scope=direct_v1&cursor=${cursor}`, { id: IDS.child }),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('rejects a structurally wrong cursor on ARITY, not only on fingerprint', async () => {
    const fingerprint = feedCursorFingerprint({
      entityId: IDS.task,
      scope: 'direct_v1',
      order: 'newest',
      predicates: FEED_SCOPE_PREDICATES.direct_v1,
    });
    // The fingerprint is CORRECT in both of these, so only the arity check can
    // reject them. M7 covers the other half of the same condition.
    for (const keys of [[fingerprint], [fingerprint, '2026-07-26T09:30:00.000Z']]) {
      const { db, run } = feedOn(stub);
      await expect(
        run(`cursor=${encodeURIComponent(encodeCursor(keys))}`),
        `arity ${keys.length}`,
      ).rejects.toMatchObject({ code: 'invalid_cursor' });
      expect(db.sql.some((sql) => sql.includes('entities.feed:page'))).toBe(false);
    }

    // A cursor that is not a cursor at all is the contract's own refusal, and it
    // must not degrade into a silent page-1 restart (DEV-5).
    const { run } = feedOn(stub);
    await expect(run('cursor=not-a-cursor')).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(run('cursor=17')).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('binds the fingerprint to the canonical predicate list, not to the caller spelling', () => {
    const a = feedCursorFingerprint({
      entityId: IDS.task,
      scope: 'direct_v1',
      order: 'newest',
      predicates: FEED_SCOPE_PREDICATES.direct_v1,
    });
    const b = feedCursorFingerprint({
      entityId: IDS.task,
      scope: 'direct_v1',
      order: 'newest',
      predicates: ['subject', 'anchored', 'replies'],
    });
    expect(b).toBe(a);
    const c = feedCursorFingerprint({
      entityId: IDS.task,
      scope: 'direct_v1',
      order: 'oldest',
      predicates: FEED_SCOPE_PREDICATES.direct_v1,
    });
    expect(c).not.toBe(a);
  });
});

describe('W2.G13 feed `around` anchoring', () => {
  const stub: Stub = {
    anchor: TASK_ANCHOR,
    locate: [{ item_id: IDS.rootMessage, created_at: '2026-07-26T09:45:00.000Z', in_scope: true }],
    page: [
      {
        item_kind: 'message',
        item_id: IDS.rootMessage,
        created_at: '2026-07-26T09:45:00.000Z',
        via: ['anchored'],
      },
    ],
    entities: [messageRow(IDS.rootMessage), taskRow(IDS.task)],
  };

  it('centres a page on a visible in-scope item and offers both directions', async () => {
    const { db, run } = feedOn(stub);
    const page = await run(`around=message%3A${IDS.rootMessage}&limit=5`);
    expect(EntityFeedPageSchema.parse(page)).toBeTruthy();
    expect(page.items.map((item) => item.itemId)).toContain(IDS.rootMessage);
    expect(db.sql.some((sql) => sql.includes('entities.feed:locate'))).toBe(true);
    expect(page).toHaveProperty('previousCursor');
  });

  it('refuses a visible item that is outside the resolved scope', async () => {
    const { run } = feedOn({
      ...stub,
      locate: [{ item_id: IDS.rootMessage, created_at: '2026-07-26T09:45:00.000Z', in_scope: false }],
    });
    await expect(run(`around=message%3A${IDS.rootMessage}`)).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'feed_item_not_in_scope' },
    });
  });

  it('answers not_found for an `around` item that is not visible at all', async () => {
    const { run } = feedOn({ ...stub, locate: [] });
    await expect(run(`around=activity%3A${IDS.absent}`)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('answers not_found for a non-uuid `around` id without letting it reach SQL', async () => {
    // The contract regex accepts `message:<anything-without-a-colon>`, so the
    // uuid check is the service's. Without it `$2::uuid` raises 22P02, which is
    // not in the taxonomy and surfaces as 503 — telling the caller the database
    // is unwell when in fact they typed a bad id.
    const { db, run } = feedOn(stub);
    await expect(run('around=message%3Anot-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    expect(db.sql.some((sql) => sql.includes('entities.feed:locate'))).toBe(false);
  });

  it('centres on the item itself when limit=1 leaves no room for a lead window', async () => {
    const { db, run } = feedOn(stub);
    const page = await run(`around=message%3A${IDS.rootMessage}&limit=1`);
    expect(page.items.map((item) => item.itemId)).toEqual([IDS.rootMessage]);
    expect(page.previousCursor).toBeNull();
    // leadCount is 0, so only ONE page window is read, not two.
    expect(db.sql.filter((sql) => sql.includes('entities.feed:page'))).toHaveLength(1);
  });

  it('reads oldest-first `around` through the mirrored comparators', async () => {
    const { db, run } = feedOn(stub);
    await run(`around=message%3A${IDS.rootMessage}&limit=5&order=oldest`);
    const windows = db.sql.filter((sql) => sql.includes('entities.feed:page'));
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatch(/\) < \(/);          // lead reads towards newer…
    expect(windows[0]).toMatch(/order by\s+created_at desc/);
    expect(windows[1]).toMatch(/\) >= \(/);         // …tail from the anchor onward
    expect(windows[1]).toMatch(/order by\s+created_at asc/);
  });

  /**
   * The `activity:` anchor differs from `message:` only in the THIRD bound
   * parameter — which is exactly the shape of argument that let the embed
   * placement branch go unexercised through five gates. So it is exercised.
   */
  it('centres on an `activity:` anchor, not just a `message:` one', async () => {
    const { db, run } = feedOn({
      anchor: TASK_ANCHOR,
      locate: [{ item_id: IDS.activity, created_at: '2026-07-26T09:30:00.000Z', in_scope: true }],
      page: [
        {
          item_kind: 'activity',
          item_id: IDS.activity,
          created_at: '2026-07-26T09:30:00.000Z',
          via: ['subject'],
        },
      ],
      activity: [activityRow(IDS.activity)],
      entities: [taskRow(IDS.task)],
    });
    const page = await run(`around=activity%3A${IDS.activity}&limit=5`);
    expect(EntityFeedPageSchema.parse(page)).toBeTruthy();
    expect(page.items.map((item) => item.itemId)).toEqual([IDS.activity]);
    expect(page.items[0]!.itemKind).toBe('activity');
    // The kind discriminator is BOUND, never interpolated — and it is the
    // `activity` branch of the locate union that ran, not the `message` one.
    const locate = db.sql.findIndex((sql) => sql.includes('entities.feed:locate'));
    expect(db.params[locate]).toEqual([IDS.task, IDS.activity, 'activity']);
  });

  it('emits a NON-NULL previousCursor when a lead window really has more', async () => {
    // Three distinct items and a lead window of 2: the has-more flag is true, so
    // the previousCursor expression actually executes instead of short-circuiting
    // to null the way every other `around` case in this file does.
    const rows: PageRow[] = [IDS.activity, IDS.causedActivity, IDS.child].map((id, index) => ({
      item_kind: 'activity',
      item_id: id,
      created_at: `2026-07-26T09:3${index}:00.000Z`,
      via: ['subject'],
    }));
    const stubWithLead: Stub = {
      anchor: TASK_ANCHOR,
      locate: [{ item_id: IDS.causedActivity, created_at: '2026-07-26T09:31:00.000Z', in_scope: true }],
      page: rows,
      activity: rows.map((row) => activityRow(row.item_id, { created_at: row.created_at })),
      entities: [taskRow(IDS.task)],
    };
    const { run } = feedOn(stubWithLead);
    const page = await run(`around=activity%3A${IDS.causedActivity}&limit=5`);
    expect(EntityFeedPageSchema.parse(page)).toBeTruthy();
    expect(page.previousCursor).toBeTruthy();
    const decoded = decodeCursor(page.previousCursor!);
    expect(decoded.k).toHaveLength(3);
    // It points at the FIRST item on the page — the boundary a caller pages
    // backwards from — and carries this feed's fingerprint, not another's.
    expect(decoded.k[2]).toBe(page.items[0]!.itemId);
    expect(decoded.k[0]).toBe(feedCursorFingerprint({
      entityId: IDS.task,
      // 098: the unscoped request above resolved `default` on a task anchor.
      scope: 'task_discussion_v1',
      order: 'newest',
      predicates: FEED_SCOPE_PREDICATES.task_discussion_v1,
    }));

    // And it round-trips: the same feed accepts it rather than rejecting its own
    // token, which is the failure `handoffs.list` actually shipped.
    await expect(
      feedOn(stubWithLead).run(`scope=task_discussion_v1&cursor=${encodeURIComponent(page.previousCursor!)}`),
    ).resolves.toBeTruthy();
  });
});

describe('W2.G13 feed items RLS or storage cannot render', () => {
  const pageRows: PageRow[] = [
    {
      item_kind: 'message',
      item_id: IDS.rootMessage,
      created_at: '2026-07-26T09:45:00.000Z',
      via: ['anchored'],
    },
    {
      item_kind: 'activity',
      item_id: IDS.activity,
      created_at: '2026-07-26T09:30:00.000Z',
      via: ['subject'],
    },
  ];

  it('drops an item whose row RLS hid rather than rendering a placeholder', async () => {
    // The candidate row survived the scope query but the message body did not
    // survive `messages_select`, which also requires a readable ANCHOR. A
    // placeholder would leak that something is there.
    const { run } = feedOn({
      anchor: TASK_ANCHOR,
      page: pageRows,
      entities: [taskRow(IDS.task)],
      activity: [activityRow(IDS.activity)],
    });
    const page = await run();
    expect(page.items.map((item) => item.itemId)).toEqual([IDS.activity]);
    expect(EntityFeedPageSchema.parse(page)).toBeTruthy();
  });

  it('refuses to render a delivery whose stored status is not in the taxonomy', async () => {
    const { run } = feedOn({
      anchor: TASK_ANCHOR,
      page: [pageRows[0]!],
      entities: [messageRow(IDS.rootMessage), taskRow(IDS.task)],
      deliveries: [{
        delivery_id: 'delivery-x',
        message_id: IDS.rootMessage,
        target_work_session_id: IDS.session,
        status: 'teleported',
        attempt_no: 1,
        failure_reason: null,
        updated_at: '2026-07-26T09:46:00.000Z',
      }],
    });
    await expect(run()).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});

// ---------------------------------------------------------------------------
// entities.context — bounded focus
// ---------------------------------------------------------------------------

function longRow(id: string, size: number): EntityRow {
  return taskRow(id, 'T'.repeat(size));
}

const CONTEXT_STUB: Stub = {
  root: [taskRow(IDS.task)],
  parents: [taskRow(IDS.parent, 'G13 parent')],
  children: [taskRow(IDS.child, 'G13 child')],
  edges: [
    {
      id: IDS.edge,
      src_id: IDS.task,
      dst_id: IDS.child,
      type: 'relates_to',
      props: {},
      created_by: IDS.member,
      created_at: '2026-07-26T09:10:00.000Z',
      updated_at: '2026-07-26T09:10:00.000Z',
      dst_resolved: null,
    },
  ],
  messages: [{ entity_id: IDS.rootMessage }],
  activity: [activityRow(IDS.activity)],
  entities: [
    taskRow(IDS.task),
    taskRow(IDS.child, 'G13 child'),
    taskRow(IDS.parent, 'G13 parent'),
    messageRow(IDS.rootMessage),
  ],
  eventSeq: 4211,
};

describe('W2.G13 entities.context bounded focus', () => {
  it('returns a contract-valid view with server-owned provenance', async () => {
    const { run } = contextOn(CONTEXT_STUB);
    const view = await run();
    expect(EntityContextViewSchema.parse(view)).toBeTruthy();
    expect(view.schemaVersion).toBe('tm8.entity-context.v1');
    expect(view.root.id).toBe(IDS.task);
    expect(view.provenance.operation).toBe('entities.context');
    expect(view.provenance.eventSeq).toBe(4211);
    expect(view.actions).toEqual(PALETTE);
    expect(view.byteSize).toBeGreaterThan(0);
  });

  it('refuses an unknown key or an out-of-range cap before any database work', async () => {
    for (const query of [
      'sections=summary,rubbish',
      'section=summary',
      'bytes=4096',
      'totalBytes=1023',
      'totalBytes=32769',
      'sectionBytes=511',
      'sectionBytes=8193',
      'totalBytes=abc',
    ]) {
      const { db, run } = contextOn(CONTEXT_STUB);
      await expect(run(query), query).rejects.toMatchObject({ code: 'invalid_input' });
      expect(db.sql, query).toEqual([]);
    }
  });

  it('enforces totalBytes as a hard cap, not advice, even with every section requested', async () => {
    const heavy: Stub = {
      ...CONTEXT_STUB,
      children: Array.from({ length: 40 }, (_, index) =>
        longRow(`00000000-0000-7000-8000-0000000010${index.toString(16).padStart(2, '0')}`, 400),
      ),
      entities: [
        taskRow(IDS.task),
        ...Array.from({ length: 40 }, (_, index) =>
          longRow(`00000000-0000-7000-8000-0000000010${index.toString(16).padStart(2, '0')}`, 400),
        ),
      ],
    };
    const { run } = contextOn(heavy);
    const view = await run(
      'sections=summary,hierarchy,connections,messages,activity,actions&totalBytes=2048',
    );
    expect(EntityContextViewSchema.parse(view)).toBeTruthy();
    expect(view.byteSize).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBe(view.byteSize);
    expect(view.truncated).toBe(true);
  });

  it('enforces sectionBytes per section independently of the total', async () => {
    const heavy: Stub = {
      ...CONTEXT_STUB,
      children: Array.from({ length: 12 }, (_, index) =>
        longRow(`00000000-0000-7000-8000-0000000011${index.toString(16).padStart(2, '0')}`, 300),
      ),
      entities: [
        taskRow(IDS.task),
        ...Array.from({ length: 12 }, (_, index) =>
          longRow(`00000000-0000-7000-8000-0000000011${index.toString(16).padStart(2, '0')}`, 300),
        ),
      ],
    };
    const { run } = contextOn(heavy);
    const view = await run('sections=hierarchy&totalBytes=32768&sectionBytes=512');
    expect(Buffer.byteLength(JSON.stringify(view.children), 'utf8')).toBeLessThanOrEqual(512);
    expect(view.truncated).toBe(true);
  });

  it('truncates deterministically — the same request twice is byte-identical', async () => {
    const heavy: Stub = {
      ...CONTEXT_STUB,
      children: Array.from({ length: 20 }, (_, index) =>
        longRow(`00000000-0000-7000-8000-0000000012${index.toString(16).padStart(2, '0')}`, 200),
      ),
      entities: [
        taskRow(IDS.task),
        ...Array.from({ length: 20 }, (_, index) =>
          longRow(`00000000-0000-7000-8000-0000000012${index.toString(16).padStart(2, '0')}`, 200),
        ),
      ],
    };
    const first = await contextOn(heavy).run('totalBytes=2048&sectionBytes=1024');
    const second = await contextOn(heavy).run('totalBytes=2048&sectionBytes=1024');
    // `provenance.fetchedAt` is a wall clock, deliberately: determinism is a
    // claim about TRUNCATION, not about time standing still.
    const stable = (view: EntityContextView): string =>
      JSON.stringify({ ...view, provenance: { ...view.provenance, fetchedAt: '' } });
    expect(stable(first)).toBe(stable(second));
    expect(first.byteSize).toBe(second.byteSize);
  });

  it('honours a section subset and leaves unrequested sections empty', async () => {
    const { db, run } = contextOn(CONTEXT_STUB);
    const view = await run('sections=summary,messages');
    expect(view.parents).toEqual([]);
    expect(view.children).toEqual([]);
    expect(view.edges).toEqual([]);
    expect(view.actions).toEqual([]);
    expect(view.messages).toHaveLength(1);
    expect(view.content).toBeDefined();
    // A section nobody asked for must not even be queried.
    expect(db.sql.some((sql) => sql.includes('entities.context:edges'))).toBe(false);
    expect(db.sql.some((sql) => sql.includes('entities.context:children'))).toBe(false);
  });

  it('reads through claim-bound RLS and issues no write', async () => {
    const { db, run } = contextOn(CONTEXT_STUB);
    await run();
    expect(db.rpcCalls).toEqual([]);
    for (const sql of db.sql) expect(sql).not.toMatch(/\b(insert|update|delete)\s+/i);
  });

  it('answers not_found for a root RLS hides', async () => {
    const { run } = contextOn({ ...CONTEXT_STUB, root: [] });
    await expect(run()).rejects.toMatchObject({ code: 'not_found' });
  });

  /**
   * The excerpt RESOLVER dispatches on the root's kind, and the byte-cap and
   * code-point work all live downstream of it. Every other context test in this
   * file uses a task root, so two of its three branches were unexercised.
   */
  it('resolves the excerpt source from a MESSAGE root, not just a task', async () => {
    const root = messageRow(IDS.rootMessage, { anchorId: IDS.task, body: 'the durable body' });
    const { run } = contextOn({ ...CONTEXT_STUB, root: [root] });
    const view = await run('sections=summary');
    expect(EntityContextViewSchema.parse(view)).toBeTruthy();
    expect(view.content).toEqual({
      excerpt: 'the durable body',
      source: 'message',
      truncated: false,
    });
    expect(view.root.kind).toBe('message');

    // A redacted message keeps its envelope and loses its body — the excerpt
    // must follow the redaction rather than read around it.
    const redacted = { ...root, message_redacted_at: '2026-07-26T10:00:00.000Z' };
    const hidden = await contextOn({ ...CONTEXT_STUB, root: [redacted] }).run('sections=summary');
    expect(hidden.content).toEqual({ excerpt: '', source: 'message', truncated: false });
  });

  it('resolves the excerpt source from a FILE root', async () => {
    const root: EntityRow = {
      ...baseRow(IDS.child, 'file'),
      file_name: 'transcript.md',
      file_mime: 'text/markdown',
      file_size: 4096,
    };
    const { run } = contextOn({ ...CONTEXT_STUB, root: [root] });
    const view = await run('sections=summary');
    expect(EntityContextViewSchema.parse(view)).toBeTruthy();
    expect(view.content).toEqual({
      excerpt: 'transcript.md',
      source: 'file',
      truncated: false,
    });
    expect(view.root.kind).toBe('file');
  });

  it('caps the content excerpt in BYTES and never leaves a split code point', async () => {
    // 3 bytes per `※`, so a byte cap that is not a multiple of 3 lands
    // mid-sequence — the case a naive `slice(0, n)` turns into U+FFFD.
    const wide = { ...taskRow(IDS.task), task_description: '※'.repeat(600) };
    const { run } = contextOn({ ...CONTEXT_STUB, root: [wide] });
    const view = await run('sections=summary&sectionBytes=1000&totalBytes=32768');
    expect(view.content).toBeDefined();
    const excerpt = view.content!.excerpt;
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeGreaterThan(900);
    expect(view.content!.truncated).toBe(true);
    expect(view.truncated).toBe(true);
    expect(excerpt).not.toContain('�');
    expect(excerpt).toBe('※'.repeat(excerpt.length));

    // Under the cap, the excerpt is whole and says so.
    const narrow = await contextOn(CONTEXT_STUB).run('sections=summary');
    expect(narrow.content).toEqual({ excerpt: 'anchor', source: 'entity', truncated: false });
  });

  it('omits `content` entirely when the summary section was not asked for', async () => {
    const { run } = contextOn(CONTEXT_STUB);
    const view = await run('sections=hierarchy');
    expect(view.content).toBeUndefined();
    // `root` stays: the DTO makes it mandatory, so `summary` governs `content`.
    expect(view.root.id).toBe(IDS.task);
    expect(EntityContextViewSchema.parse(view)).toBeTruthy();
  });

  /**
   * ⚠ DECLARED GAP, batched by the wave coordinator for one dossier amendment.
   * `EntityContextQuery.sections` offers `'activity'` but the frozen
   * `EntityContextView` (schemas.ts:1365-1386, `.strict()`) has NO activity
   * array. G13 invents no field: the section contributes a `cursors.activity`
   * continuation token and nothing else, which needs no schema change because
   * `cursors` is an open `z.record(CursorSchema.nullable())`.
   */
  it('lands the `activity` section in cursors only — the declared contract GAP', async () => {
    const { run } = contextOn(CONTEXT_STUB);
    const withActivity = await run('sections=activity');
    expect(withActivity.cursors['activity']).toBeTypeOf('string');
    expect(decodeCursor(withActivity.cursors['activity']!).k).toHaveLength(3);
    expect(Object.keys(withActivity)).not.toContain('activity');

    const without = await run('sections=summary');
    expect(without.cursors['activity']).toBeUndefined();

    // No stored activity → an honest null, not a token that points nowhere.
    const empty = await contextOn({ ...CONTEXT_STUB, activity: [] }).run('sections=activity');
    expect(empty.cursors['activity']).toBeNull();
  });

  it('never emits an `edges` cursor it does not own the fingerprint for', async () => {
    const { run } = contextOn(CONTEXT_STUB);
    const view = await run();
    // `entities.connections` owns that cursor identity; a token G13 minted
    // would be one the continuing operation rejects. `truncated` is the signal.
    expect(view.cursors['edges']).toBeUndefined();
    expect(Object.keys(view.cursors).sort()).toEqual(['activity', 'children', 'messages']);
  });
});
