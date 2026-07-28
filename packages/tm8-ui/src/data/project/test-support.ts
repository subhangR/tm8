/**
 * Local builders for projection-library unit tests (src/data/project only).
 *
 * Deliberately NOT importing from src/fixtures (FE-owned, mid-flight): these
 * tests exercise reducer/journal/store mechanics and need minimal
 * contract-typed rows, not the shared gate dataset.
 */
import type {
  ActivityItem,
  ActorSummary,
  DurableWorkspaceEvent,
  EdgeView,
  EntityCounters,
  EntityDetail,
  EntitySummary,
  HandoffView,
  MenuConfig,
  MessageDeliveryRecord,
  MessageView,
  NotificationItem,
  WorkspaceEventEnvelope,
} from '@tm8/contract';

export const SPACE = 'space_test';

export const actor: ActorSummary = {
  id: 'member_1',
  kind: 'member',
  displayName: 'Tester',
  isAgent: false,
};

export function counters(over: Partial<EntityCounters> = {}): EntityCounters {
  return { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null, ...over };
}

export function summary(id: string, over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id,
    spaceId: SPACE,
    kind: 'task',
    title: `Task ${id}`,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-28T00:00:00.000Z',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    deletedAt: null,
    createdBy: actor,
    counters: counters(),
    state: {
      kind: 'task',
      workStatus: 'open',
      priority: 'medium',
      axes: {},
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
    ...over,
  };
}

export function detail(id: string, over: Partial<EntityDetail> = {}): EntityDetail {
  return {
    ...summary(id),
    content: { kind: 'task', description: `Body of ${id}`, acceptanceCriteria: [] },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: {
      canEdit: true, canDelete: true, canAddChild: true, canLink: true,
      canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
    },
    ...over,
  };
}

export function edge(id: string, sourceId: string, targetId: string, over: Partial<EdgeView> = {}): EdgeView {
  return {
    id,
    type: 'relates_to',
    source: summary(sourceId),
    target: summary(targetId),
    props: {},
    createdBy: actor,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

export function message(id: string, anchorId: string, createdAt: string, over: Partial<MessageView> = {}): MessageView {
  return {
    ...summary(id, { kind: 'message', title: '', createdAt, activityAt: createdAt, updatedAt: createdAt }),
    state: { kind: 'message', anchorId, rootMessageId: null, author: actor, messageBatchId: null },
    content: { kind: 'message', body: `msg ${id}`, mentions: [], attachments: [] },
    replyCount: 0,
    ...over,
  };
}

export function activity(id: string, over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    verb: 'entity.updated',
    summary: {},
    createdAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

export function notification(id: string, createdAt: string, over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id,
    spaceId: SPACE,
    kind: 'mention',
    recipient: actor,
    readAt: null,
    createdAt,
    ...over,
  };
}

export function menu(revision: number): MenuConfig {
  return { schemaVersion: 1, revision, groups: [{ id: 'g1', label: `rev ${revision}`, items: [] }] };
}

export function deliveryRecord(deliveryId: string, messageId: string, over: Partial<MessageDeliveryRecord> = {}): MessageDeliveryRecord {
  return {
    deliveryId,
    messageId,
    sourceWorkSessionId: null,
    targetWorkSessionId: 'ws_target',
    status: 'pending',
    attemptNo: 1,
    failureReason: null,
    reservedAt: '2026-07-28T00:00:00.000Z',
    claimedAt: null,
    settledAt: null,
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

export function handoff(handoffId: string, targetWorkSessionId: string, over: Partial<HandoffView> = {}): HandoffView {
  return {
    handoffId,
    sourceEntityId: 'task_src',
    targetWorkSessionId,
    deliveryStatus: 'prepared',
    recordStatus: 'pending',
    sourceSnapshot: {
      entityId: 'task_src', kind: 'task', title: 'Handoff source', contentVersion: 1,
      sourceSpaceId: SPACE, body: '', bodyBytes: 0, truncated: false, omittedFields: [],
    },
    envelopeHash: 'hash',
    sourceMissing: false,
    recordVersion: 1,
    withdrawnBy: null,
    withdrawnAt: null,
    withdrawReason: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...over,
  };
}

let seqCounter = 0;

export function envelope(over: Partial<WorkspaceEventEnvelope> = {}): WorkspaceEventEnvelope {
  seqCounter += 1;
  return {
    spaceId: SPACE,
    seq: seqCounter,
    occurredAt: '2026-07-28T00:00:00.000Z',
    schemaVersion: 1,
    ...over,
  };
}

/**
 * The union member whose `type` field ADMITS the literal T. A plain
 * `Extract<..., { type: T }>` collapses to `never` for members declared with
 * a literal-union `type` (e.g. `'entity.upsert'|'entity.deleted'`), so the
 * lookup must distribute and test T against each member's own type union.
 */
type EventOf<T extends DurableWorkspaceEvent['type']> =
  DurableWorkspaceEvent extends infer U
    ? U extends { type: infer K } ? (T extends K ? U : never) : never
    : never;

/** Convenience: a durable event with a fresh envelope. */
export function event<T extends DurableWorkspaceEvent['type']>(
  type: T,
  payload: Omit<EventOf<T>, keyof WorkspaceEventEnvelope | 'type'>,
  env: Partial<WorkspaceEventEnvelope> = {},
): EventOf<T> {
  return { ...envelope(env), type, ...payload } as EventOf<T>;
}
