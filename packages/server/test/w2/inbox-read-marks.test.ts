import {
  NotificationItemSchema,
  decodeCursor,
  getOperation,
  type OperationName,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { EntityRow } from '../../src/facade/entity-read.js';
import { registerW2InboxReadMarksHandlers } from '../../src/facade/handlers/w2/inbox-read-marks.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const IDS = {
  space: '00000000-0000-7000-8000-000000000801',
  otherSpace: '00000000-0000-7000-8000-000000000802',
  member: '00000000-0000-7000-8000-000000000803',
  otherMember: '00000000-0000-7000-8000-000000000804',
  teammate: '00000000-0000-7000-8000-000000000805',
  otherTeammate: '00000000-0000-7000-8000-000000000806',
  actor: '00000000-0000-7000-8000-000000000807',
  target: '00000000-0000-7000-8000-000000000808',
  restrictedTarget: '00000000-0000-7000-8000-000000000809',
  deletedTarget: '00000000-0000-7000-8000-00000000080a',
  notification: '00000000-0000-7000-8000-00000000080b',
  secondNotification: '00000000-0000-7000-8000-00000000080c',
};

const OWNER = {
  identityId: 'w2-g08-owner',
  accountId: '00000000-0000-7000-8000-0000000008f0',
  username: 'w2-g08-owner',
  isNodeAdmin: true,
  isOwner: true,
};

interface NotificationRow {
  id: string;
  space_id: string;
  recipient_member_id: string;
  recipient_team_member_id: string | null;
  target_entity_id: string | null;
  actor_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  read_at: Date | string | null;
  created_at: Date | string;
}

const PERSONAL_ROW: NotificationRow = {
  id: IDS.notification,
  space_id: IDS.space,
  recipient_member_id: IDS.member,
  recipient_team_member_id: null,
  target_entity_id: IDS.target,
  actor_id: IDS.actor,
  kind: 'message_reply',
  payload: { message: 'A durable reply is ready' },
  read_at: null,
  created_at: '2026-07-26T12:00:00.000Z',
};

const TEAMMATE_ROW: NotificationRow = {
  ...PERSONAL_ROW,
  id: IDS.secondNotification,
  recipient_team_member_id: IDS.teammate,
  kind: 'session_delivery_failed',
  payload: { deliveryStatus: 'unknown' },
  created_at: '2026-07-26T11:00:00.000Z',
};

function actorRow(
  id: string,
  kind: 'member' | 'team_member',
  displayName: string,
): Record<string, unknown> {
  return {
    id,
    kind,
    space_id: IDS.space,
    member_display_name: kind === 'member' ? displayName : null,
    member_role: kind === 'member' ? 'owner' : null,
    team_member_name: kind === 'team_member' ? displayName : null,
    team_member_avatar: null,
    team_member_owner_id: kind === 'team_member' ? IDS.member : null,
    profile_display_name: kind === 'member' ? displayName : null,
    profile_avatar: null,
  };
}

function taskRow(id: string, deletedAt: string | null = null): EntityRow {
  return {
    id,
    space_id: IDS.space,
    kind: 'task',
    parent_id: null,
    position: 1,
    visibility: 'space',
    version: 2,
    activity_at: '2026-07-26T10:00:00.000Z',
    created_at: '2026-07-26T09:00:00.000Z',
    updated_at: '2026-07-26T10:00:00.000Z',
    deleted_at: deletedAt,
    created_by: IDS.member,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    task_title: 'Readable task',
    task_description: 'Notification target',
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

class FakeDb implements Db {
  readonly claims: DbClaims[] = [];
  readonly rpcCalls: Array<{ fn: string; args: readonly unknown[] }> = [];
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async () => [];
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> = async () => ({}) as T;

  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    this.claims.push(claims);
    return fn({
      query: <R>(sql: string, params: readonly unknown[] = []) => this.queryImpl<R>(sql, params),
      rpc: <R>(name: string, args: readonly unknown[] = []) => {
        this.rpcCalls.push({ fn: name, args });
        return this.rpcImpl<R>(name, args);
      },
    });
  }

  query<R>(claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    this.claims.push(claims);
    return this.queryImpl<R>(sql, params);
  }

  rpc<T>(claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.claims.push(claims);
    this.rpcCalls.push({ fn, args });
    return this.rpcImpl<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function request(
  opName: OperationName,
  options: {
    params?: Record<string, string>;
    query?: URLSearchParams;
    body?: unknown;
    actorId?: string;
  } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: options.query ?? new URLSearchParams(),
    body: options.body,
    requestId: `request-${opName}`,
    identity: {
      kind: 'auto-owner',
      identityId: OWNER.identityId,
      ...(options.actorId ? { actorId: options.actorId } : {}),
    },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function listQuery(input: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    query.set(key, key === 'recipient' ? JSON.stringify(value) : String(value));
  }
  return query;
}

function registryFor(db: Db): HandlerRegistry {
  const registry = new HandlerRegistry();
  registerW2InboxReadMarksHandlers(registry, {
    db,
    config: {} as never,
    owner: async () => OWNER,
  });
  return registry;
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing handler: ${name}`);
  return value;
}

function hydratedQuery(
  notifications: NotificationRow[],
  targets: EntityRow[] = [taskRow(IDS.target)],
): <R>(sql: string, params: readonly unknown[]) => Promise<R[]> {
  return async <R>(sql: string): Promise<R[]> => {
    if (sql.includes('inbox_recipient_authorized')) return [{ authorized: true }] as R[];
    if (sql.includes('from public.inspect_owned_teammate_inbox')) return notifications as R[];
    if (sql.includes('from public.notifications notification_row')) return notifications as R[];
    if (sql.includes('left join public.user_profiles up')) {
      return [
        actorRow(IDS.member, 'member', 'Owner'),
        actorRow(IDS.teammate, 'team_member', 'Scout'),
        actorRow(IDS.actor, 'member', 'Reviewer'),
      ] as R[];
    }
    if (sql.includes('t.title as task_title')) return targets as R[];
    return [];
  };
}

describe('W2.G08 inbox and read-mark handlers', () => {
  it('exports one registration seam for exactly the three frozen operations', () => {
    const registry = registryFor(new FakeDb());
    expect(registry.implemented()).toEqual([
      'inbox.list',
      'inbox.markRead',
      'readMarks.upsert',
    ]);
  });

  it('lists the authenticated Member inbox, maps the frozen item, and fingerprints the complete page', async () => {
    const db = new FakeDb();
    db.queryImpl = hydratedQuery([PERSONAL_ROW, { ...PERSONAL_ROW, id: IDS.secondNotification }]);
    const registry = registryFor(db);
    const result = await handler(registry, 'inbox.list')(
      request('inbox.list', { query: listQuery({ limit: 1 }) }),
    ) as { items: unknown[]; nextCursor: string | null };

    expect(result.items).toHaveLength(1);
    expect(NotificationItemSchema.parse(result.items[0])).toMatchObject({
      id: IDS.notification,
      kind: 'message_reply',
      message: 'A durable reply is ready',
      recipient: { id: IDS.member, kind: 'member' },
      actor: { id: IDS.actor },
      target: { id: IDS.target, title: 'Readable task' },
      readAt: null,
    });
    expect(result.nextCursor).toBeTruthy();
    expect(decodeCursor(result.nextCursor!).k).toHaveLength(3);

    await expect(handler(registry, 'inbox.list')(
      request('inbox.list', {
        query: listQuery({ limit: 1, unread: true, cursor: result.nextCursor! }),
      }),
    )).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  it('uses acting-as RLS for a Teammate but the named read-only RPC for owner inspection', async () => {
    const actingDb = new FakeDb();
    actingDb.queryImpl = hydratedQuery([TEAMMATE_ROW]);
    const actingRegistry = registryFor(actingDb);
    const recipient = { type: 'team_member', teamMemberId: IDS.teammate };
    const actingResult = await handler(actingRegistry, 'inbox.list')(
      request('inbox.list', {
        actorId: IDS.teammate,
        query: listQuery({ recipient }),
      }),
    ) as { items: Array<{ recipient: { id: string } }> };
    expect(actingResult.items[0]!.recipient.id).toBe(IDS.teammate);
    expect(actingDb.claims.at(-1)?.actorId).toBe(IDS.teammate);

    const inspectingDb = new FakeDb();
    const sql: string[] = [];
    inspectingDb.queryImpl = async <R>(statement: string, params: readonly unknown[]) => {
      sql.push(statement);
      return hydratedQuery([TEAMMATE_ROW])<R>(statement, params);
    };
    const inspectingRegistry = registryFor(inspectingDb);
    await handler(inspectingRegistry, 'inbox.list')(
      request('inbox.list', { query: listQuery({ recipient }) }),
    );
    expect(sql.some((statement) => statement.includes('inspect_owned_teammate_inbox'))).toBe(true);
    expect(inspectingDb.claims.at(-1)?.actorId).toBeUndefined();
    expect(inspectingDb.rpcCalls).toEqual([]);
  });

  it('does not leak restricted targets and uses a tombstone for a deleted readable target', async () => {
    const db = new FakeDb();
    db.queryImpl = hydratedQuery([
      { ...PERSONAL_ROW, target_entity_id: IDS.restrictedTarget },
      { ...PERSONAL_ROW, id: IDS.secondNotification, target_entity_id: IDS.deletedTarget },
    ], [taskRow(IDS.deletedTarget, '2026-07-26T11:30:00.000Z')]);
    const registry = registryFor(db);
    const result = await handler(registry, 'inbox.list')(
      request('inbox.list'),
    ) as { items: Array<{ target?: { id: string; title: string } | null }> };

    expect(result.items[0]!.target).toBeNull();
    expect(result.items[1]!.target).toMatchObject({ id: IDS.deletedTarget, title: 'Deleted' });
  });

  it('authorizes the selected recipient before marking and never turns owner inspection into a write', async () => {
    const db = new FakeDb();
    db.queryImpl = hydratedQuery([]);
    db.rpcImpl = async <T>(fn: string) => {
      if (fn !== 'mark_notification_read') throw new Error(`unexpected rpc: ${fn}`);
      return { ...PERSONAL_ROW, read_at: '2026-07-26T12:05:00.000Z' } as T;
    };
    const registry = registryFor(db);
    const marked = await handler(registry, 'inbox.markRead')(
      request('inbox.markRead', {
        params: { notificationId: IDS.notification },
        body: {
          clientMutationId: 'g08-member-mark-once',
          recipient: { type: 'member', memberId: IDS.member },
        },
      }),
    );
    expect(NotificationItemSchema.parse(marked)).toMatchObject({
      id: IDS.notification,
      readAt: '2026-07-26T12:05:00.000Z',
    });
    expect(db.rpcCalls.at(-1)).toEqual({
      fn: 'mark_notification_read',
      args: [IDS.notification, 'member', IDS.member, 'g08-member-mark-once'],
    });

    const before = db.rpcCalls.length;
    await expect(handler(registry, 'inbox.markRead')(
      request('inbox.markRead', {
        params: { notificationId: IDS.secondNotification },
        body: {
          clientMutationId: 'g08-owner-must-not-mark-teammate',
          recipient: { type: 'team_member', teamMemberId: IDS.teammate },
        },
      }),
    )).rejects.toMatchObject({ code: 'not_found' });
    expect(db.rpcCalls).toHaveLength(before);
  });

  it('marks an acting-as Teammate independently and rejects unrelated or fabricated recipients uniformly', async () => {
    const db = new FakeDb();
    db.queryImpl = hydratedQuery([]);
    db.rpcImpl = async <T>() => ({
      ...TEAMMATE_ROW,
      read_at: '2026-07-26T12:06:00.000Z',
    }) as T;
    const registry = registryFor(db);
    await handler(registry, 'inbox.markRead')(
      request('inbox.markRead', {
        actorId: IDS.teammate,
        params: { notificationId: IDS.secondNotification },
        body: {
          clientMutationId: 'g08-teammate-mark-once',
          recipient: { type: 'team_member', teamMemberId: IDS.teammate },
        },
      }),
    );
    expect(db.claims.at(-1)?.actorId).toBe(IDS.teammate);
    expect(db.rpcCalls.at(-1)?.args).toEqual([
      IDS.secondNotification,
      'team_member',
      IDS.teammate,
      'g08-teammate-mark-once',
    ]);

    for (const teamMemberId of [IDS.otherTeammate, '00000000-0000-7000-8000-0000000008ff']) {
      await expect(handler(registry, 'inbox.markRead')(
        request('inbox.markRead', {
          actorId: IDS.teammate,
          params: { notificationId: IDS.notification },
          body: {
            clientMutationId: `g08-refuse-${teamMemberId}`,
            recipient: { type: 'team_member', teamMemberId },
          },
        }),
      )).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('keeps readMarks.upsert path-addressed, Member-only, and RPC-backed', async () => {
    const db = new FakeDb();
    db.rpcImpl = async <T>(fn: string) => {
      if (fn !== 'mark_read') throw new Error(`unexpected rpc: ${fn}`);
      return {
        anchorId: IDS.target,
        lastReadAt: '2026-07-26T12:07:00.000Z',
        patches: [],
      } as T;
    };
    const registry = registryFor(db);

    await expect(handler(registry, 'readMarks.upsert')(
      request('readMarks.upsert', { params: { anchorId: IDS.target }, body: {} }),
    )).rejects.toMatchObject({ code: 'invalid_input' });
    expect(db.rpcCalls).toEqual([]);

    const result = await handler(registry, 'readMarks.upsert')(
      request('readMarks.upsert', {
        params: { anchorId: IDS.target },
        body: { clientMutationId: 'g08-anchor-read-once' },
      }),
    );
    expect(result).toEqual({
      anchorId: IDS.target,
      lastReadAt: '2026-07-26T12:07:00.000Z',
      patches: [],
    });
    expect(db.rpcCalls.at(-1)).toEqual({
      fn: 'mark_read',
      args: [IDS.target, 'g08-anchor-read-once'],
    });
  });
});
