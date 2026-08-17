/**
 * Projection reducers — pure per-family folds of `DurableWorkspaceEvent` into
 * the normalized domain state (LLD §7). Framework-free: every function takes
 * immutable records and returns a `Partial<DomainState>` patch usable inside
 * any store's `set()`. Semantics mirror the proven collab-v2 graph-store
 * switch (packages/ui/src/collab-v2/stores/graph.ts).
 *
 * Dedupe/ordering is NOT handled here: the seam guarantees strictly
 * increasing seq per space with no duplicates (seam.ts `onEvent`), so
 * consumers need no seenEventIds set and reducers assume every event is new.
 *
 * Passthrough route (LLD §7 table): `menu.updated` and
 * `space.default_channel.updated` FLOW in Delta 1 v1 and are applied. The
 * delivery/attachments/handoff handlers below are apply-shaped but DORMANT —
 * those events stay off the wire until write-side reshaping is ruled, and
 * correctness never depends on them (source of truth for session/handoff
 * state transitions is entity-backed `entity.upsert`/`edge.upsert`).
 * `project.association.corrected` and `interaction_profile.*` only
 * invalidate. Unknown event types are silently skipped, never thrown on.
 */
import type {
  ActivityItem,
  DurableWorkspaceEvent,
  EdgeGroup,
  EdgeView,
  EntityCounters,
  EntityDetail,
  EntityId,
  EntitySummary,
  HandoffView,
  MenuConfig,
  MessageDeliveryRecord,
  MessageView,
  NotificationItem,
  SpaceId,
} from '@tm8/contract';

export const ACTIVITY_CAP = 300;
export const MESSAGES_CAP = 500;

/** Per-space settings slice fed by `space.default_channel.updated`. */
export interface SpaceSettings {
  defaultChannelId: EntityId | null;
  settingsRevision: number;
}

/**
 * The domain families (LLD §7): normalized caches the reducers fold events
 * into. Data only — actions live in the store that adopts this shape.
 */
export interface DomainState {
  entities: Record<EntityId, EntitySummary>;
  details: Record<EntityId, EntityDetail>;
  edges: Record<string, EdgeView>;
  /** Edge ids that touch an entity (either endpoint), for rail invalidation. */
  edgeIdsByEntity: Record<EntityId, string[]>;
  messagesByAnchor: Record<EntityId, MessageView[]>;
  activityFeed: ActivityItem[];
  notifications: NotificationItem[];
  /** Passthrough, flows in v1: full MenuConfig per space. */
  menuBySpace: Record<SpaceId, MenuConfig>;
  /** Passthrough, flows in v1: space settings slice. */
  settingsBySpace: Record<SpaceId, SpaceSettings>;
  /** Dormant passthrough target; also fed by the on-demand `delivery()` read. */
  deliveryByMessageId: Record<EntityId, MessageDeliveryRecord[]>;
  /** Dormant passthrough target; also fed by the `handoffs()` read. */
  handoffsByWorkSession: Record<EntityId, HandoffView[]>;
  /**
   * `project.association.corrected` marks the artifact here; consumers
   * refetch `connections(entityId)` on demand and clear the flag.
   */
  staleConnections: Record<EntityId, true>;
  /**
   * `interaction_profile.*` invalidation tick (Phase-2 surface, no eager
   * handling — event names blocked on contract-vs-migration drift).
   */
  profileInvalidations: number;
}

export function initialDomainState(): DomainState {
  return {
    entities: {},
    details: {},
    edges: {},
    edgeIdsByEntity: {},
    messagesByAnchor: {},
    activityFeed: [],
    notifications: [],
    menuBySpace: {},
    settingsBySpace: {},
    deliveryByMessageId: {},
    handoffsByWorkSession: {},
    staleConnections: {},
    profileInvalidations: 0,
  };
}

// ---------------------------------------------------------------------------
// Shared merge helpers
// ---------------------------------------------------------------------------

function indexEdge(map: Record<EntityId, string[]>, entityId: EntityId, edgeId: string): string[] {
  const list = map[entityId] ?? [];
  return list.includes(edgeId) ? list : [...list, edgeId];
}

/**
 * Upsert a summary into `entities`, and — because EntityDetail extends
 * EntitySummary — overlay the fresher envelope onto a cached detail while
 * keeping its heavy sections (content/hierarchy/connections).
 */
export function mergeSummary(
  state: Pick<DomainState, 'entities' | 'details'>,
  summary: EntitySummary,
): Pick<DomainState, 'entities'> & Partial<Pick<DomainState, 'details'>> {
  const out: Pick<DomainState, 'entities'> & Partial<Pick<DomainState, 'details'>> = {
    entities: { ...state.entities, [summary.id]: summary },
  };
  const detail = state.details[summary.id];
  if (detail) {
    out.details = { ...state.details, [summary.id]: { ...detail, ...summary } };
  }
  return out;
}

/**
 * Reactions are edges, and `entities.get` deliberately keeps them OUT of
 * `connections` (server `handlers/entities.ts:95,145`). They still arrive as
 * `edge.upsert`, so folding them into a cached detail would make a live star
 * appear as a LINKED row that no fresh read ever shows. Mirrored here, once.
 */
const REACTION_EDGE_TYPES: ReadonlySet<string> = new Set(['likes', 'dislikes', 'stars']);

/**
 * The label the Server would have sent for a group this client is creating.
 *
 * The Server curates display names for some types (`Relates to`, `Working on`)
 * and falls through to the raw type for the rest, suffixed `(incoming)` on the
 * inbound side (`handlers/entities.ts:115`). That map is Server-local and the
 * `edge.upsert` payload carries no label, so a group born from a live event
 * reuses the label the Server already sent for the SAME TYPE on this entity,
 * and otherwise reproduces the fall-through.
 *
 * ⚠ Residual, stated rather than hidden: the first-ever edge of a CURATED type
 * on an entity renders as its raw type name until the next full detail read.
 * Closing that needs the label map in the contract, which is a wider change
 * than this defect justifies.
 */
function edgeGroupLabel(existing: readonly EdgeGroup[], type: string, direction: 'outgoing' | 'incoming'): string {
  const seen = existing.find((g) => g.type === type);
  if (seen) return seen.label;
  return direction === 'outgoing' ? type : `${type} (incoming)`;
}

/**
 * Fold one edge into a cached detail's `connections`.
 *
 * WHY THIS EXISTS. `ConnectionsTab` renders `detail.connections`, which only a
 * detail READ ever writes. `edge.upsert` used to land in `edges` /
 * `edgeIdsByEntity` and nowhere else, so an edge created while a panel was open
 * was invisible until a reload — measured on a work session whose three
 * `created_in` docs were on the wire and absent from the tab. Keeping the
 * cached detail coherent with newer events is what `mergeSummary` already does
 * for the envelope; this is the same rule for the connection sections.
 */
function mergeEdgeIntoDetail(detail: EntityDetail, edge: EdgeView): EntityDetail {
  if (REACTION_EDGE_TYPES.has(edge.type)) return detail;
  // The Server's own split: an edge is outgoing when this entity is its
  // source, and incoming only when it is the target and NOT also the source
  // (`handlers/entities.ts:204-205`), so a self-edge is never counted twice.
  const direction: 'outgoing' | 'incoming' = edge.source.id === detail.id ? 'outgoing' : 'incoming';
  const groups = direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  const target = groups.find((g) => g.type === edge.type);
  const next = target
    ? groups.map((g) =>
        g === target
          ? { ...g, edges: [edge, ...g.edges.filter((e) => e.id !== edge.id)] }
          : g)
    : [
        ...groups,
        {
          type: edge.type,
          direction,
          label: edgeGroupLabel([...detail.connections.outgoing, ...detail.connections.incoming], edge.type, direction),
          edges: [edge],
        },
      ];
  return withConnections(detail, direction, next);
}

/** `edge.deleted`: drop the edge from a cached detail, and the group with it if it empties. */
function removeEdgeFromDetail(detail: EntityDetail, edgeId: string): EntityDetail {
  let changed = detail;
  for (const direction of ['outgoing', 'incoming'] as const) {
    const groups = direction === 'outgoing' ? changed.connections.outgoing : changed.connections.incoming;
    if (!groups.some((g) => g.edges.some((e) => e.id === edgeId))) continue;
    const next = groups
      .map((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }))
      .filter((g) => g.edges.length > 0);
    changed = withConnections(changed, direction, next);
  }
  return changed;
}

/**
 * Replace one direction's groups and re-derive the blocked count from them, so
 * the badge cannot drift from the rows it summarizes. Same rule as the Server
 * (`handlers/entities.ts:207-213`): OUTGOING `depends_on`, hard unless props
 * say otherwise, counted only while unresolved.
 */
function withConnections(
  detail: EntityDetail,
  direction: 'outgoing' | 'incoming',
  groups: EdgeGroup[],
): EntityDetail {
  const connections = {
    ...detail.connections,
    ...(direction === 'outgoing' ? { outgoing: groups } : { incoming: groups }),
  };
  connections.unresolvedHardDependencyCount = connections.outgoing
    .filter((g) => g.type === 'depends_on')
    .flatMap((g) => g.edges)
    .filter((e) => e.hard !== false && e.resolved === false).length;
  return { ...detail, connections };
}

/** Apply one detail-level connection change to whichever endpoints are cached. */
function mapCachedDetails(
  details: Record<EntityId, EntityDetail>,
  endpointIds: readonly string[],
  change: (detail: EntityDetail) => EntityDetail,
): Record<EntityId, EntityDetail> | undefined {
  let next: Record<EntityId, EntityDetail> | undefined;
  for (const id of new Set(endpointIds)) {
    const detail = details[id as EntityId];
    if (!detail) continue;
    const updated = change(detail);
    if (updated === detail) continue;
    next = { ...(next ?? details), [id as EntityId]: updated };
  }
  return next;
}

function upsertMessageList(list: MessageView[], message: MessageView): MessageView[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  byId.set(message.id, message); // deleted → tombstone view stays in the list
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-MESSAGES_CAP);
}

// ---------------------------------------------------------------------------
// Per-family reducers (each returns a Partial<DomainState> patch)
// ---------------------------------------------------------------------------

/** `entity.upsert` / `entity.deleted`: deleted keeps the summary (tombstone), drops the cached detail. */
export function reduceEntityEvent(
  state: DomainState,
  entity: EntitySummary,
  deleted: boolean,
): Partial<DomainState> {
  const next: Partial<DomainState> = mergeSummary(state, entity);
  if (deleted) {
    const details = { ...(next.details ?? state.details) };
    delete details[entity.id];
    next.details = details;
  }
  return next;
}

/** `counter.changed`: fold into the cached summary; no-op if the entity is not cached. */
export function reduceCounterChanged(
  state: DomainState,
  entityId: EntityId,
  counters: EntityCounters,
): Partial<DomainState> {
  const summary = state.entities[entityId];
  if (!summary) return {};
  return mergeSummary(state, { ...summary, counters });
}

/** `edge.upsert`: upsert the edge and index it under both endpoints. */
export function reduceEdgeUpsert(state: DomainState, edge: EdgeView): Partial<DomainState> {
  let index = state.edgeIdsByEntity;
  index = { ...index, [edge.source.id]: indexEdge(index, edge.source.id, edge.id) };
  index = { ...index, [edge.target.id]: indexEdge(index, edge.target.id, edge.id) };
  const details = mapCachedDetails(state.details, [edge.source.id, edge.target.id], (detail) =>
    mergeEdgeIntoDetail(detail, edge),
  );
  return {
    edges: { ...state.edges, [edge.id]: edge },
    edgeIdsByEntity: index,
    ...(details ? { details } : {}),
  };
}

/** `edge.deleted`: drop the edge and unindex it from both endpoints. */
export function reduceEdgeDeleted(state: DomainState, edge: EdgeView): Partial<DomainState> {
  const edges = { ...state.edges };
  delete edges[edge.id];
  const index = { ...state.edgeIdsByEntity };
  for (const endpoint of [edge.source.id, edge.target.id]) {
    if (index[endpoint]) index[endpoint] = index[endpoint].filter((id) => id !== edge.id);
  }
  const details = mapCachedDetails(state.details, [edge.source.id, edge.target.id], (detail) =>
    removeEdgeFromDetail(detail, edge.id),
  );
  return { edges, edgeIdsByEntity: index, ...(details ? { details } : {}) };
}

/** `message.created|updated|deleted`: upsert by anchor, createdAt-sorted, capped; tombstones stay. */
export function reduceMessageEvent(
  state: DomainState,
  anchorId: EntityId,
  message: MessageView,
): Partial<DomainState> {
  const list = state.messagesByAnchor[anchorId] ?? [];
  return {
    messagesByAnchor: { ...state.messagesByAnchor, [anchorId]: upsertMessageList(list, message) },
  };
}

/** `activity.created`: prepend, cap, dedupe by id (a re-sent item is replaced in place, not reordered). */
export function reduceActivityCreated(state: DomainState, activity: ActivityItem): Partial<DomainState> {
  const at = state.activityFeed.findIndex((a) => a.id === activity.id);
  if (at >= 0) {
    const feed = [...state.activityFeed];
    feed[at] = activity;
    return { activityFeed: feed };
  }
  return { activityFeed: [activity, ...state.activityFeed].slice(0, ACTIVITY_CAP) };
}

/** `notification.created|read`: upsert by id, createdAt-descending. */
export function reduceNotificationEvent(
  state: DomainState,
  notification: NotificationItem,
): Partial<DomainState> {
  const byId = new Map(state.notifications.map((n) => [n.id, n]));
  byId.set(notification.id, notification);
  return {
    notifications: [...byId.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

/** `menu.updated` (passthrough, FLOWS in v1): full MenuConfig replaces the space's menu. */
export function reduceMenuUpdated(state: DomainState, spaceId: SpaceId, menu: MenuConfig): Partial<DomainState> {
  return { menuBySpace: { ...state.menuBySpace, [spaceId]: menu } };
}

/** `space.default_channel.updated` (passthrough, FLOWS in v1). */
export function reduceDefaultChannelUpdated(
  state: DomainState,
  spaceId: SpaceId,
  channelId: EntityId | null,
  settingsRevision: number,
): Partial<DomainState> {
  return {
    settingsBySpace: {
      ...state.settingsBySpace,
      [spaceId]: { defaultChannelId: channelId, settingsRevision },
    },
  };
}

/** `message.delivery_reserved|settled` (DORMANT in v1): upsert the record by deliveryId. */
export function reduceDeliveryEvent(
  state: DomainState,
  record: MessageDeliveryRecord,
): Partial<DomainState> {
  const list = state.deliveryByMessageId[record.messageId] ?? [];
  const at = list.findIndex((r) => r.deliveryId === record.deliveryId);
  const next = at >= 0 ? list.map((r, i) => (i === at ? record : r)) : [...list, record];
  return { deliveryByMessageId: { ...state.deliveryByMessageId, [record.messageId]: next } };
}

/** `handoff.*` (DORMANT in v1): upsert the full HandoffView under its target work session. */
export function reduceHandoffEvent(state: DomainState, handoff: HandoffView): Partial<DomainState> {
  const key = handoff.targetWorkSessionId;
  const list = state.handoffsByWorkSession[key] ?? [];
  const at = list.findIndex((h) => h.handoffId === handoff.handoffId);
  const next = at >= 0 ? list.map((h, i) => (i === at ? handoff : h)) : [...list, handoff];
  return { handoffsByWorkSession: { ...state.handoffsByWorkSession, [key]: next } };
}

/** `project.association.corrected`: invalidate `connections(artifactId)` — refetch on demand. */
export function reduceAssociationCorrected(state: DomainState, artifactId: EntityId): Partial<DomainState> {
  return { staleConnections: { ...state.staleConnections, [artifactId]: true } };
}

/** `interaction_profile.*`: invalidate the profile slice only (no eager handling). */
export function reduceProfileInvalidation(state: DomainState): Partial<DomainState> {
  return { profileInvalidations: state.profileInvalidations + 1 };
}

// ---------------------------------------------------------------------------
// Hydration ingestion (read results → same normalized families)
// ---------------------------------------------------------------------------

export function ingestSummaries(state: DomainState, list: EntitySummary[]): Partial<DomainState> {
  let entities = state.entities;
  let details = state.details;
  for (const s of list) {
    const merged = mergeSummary({ entities, details }, s);
    entities = merged.entities;
    details = merged.details ?? details;
  }
  return { entities, details };
}

/** `graph.query` hydration uses the same normalized edge family as events. */
export function ingestEdges(state: DomainState, list: EdgeView[]): Partial<DomainState> {
  const edges = { ...state.edges };
  let edgeIdsByEntity = state.edgeIdsByEntity;
  for (const edge of list) {
    edges[edge.id] = edge;
    edgeIdsByEntity = {
      ...edgeIdsByEntity,
      [edge.source.id]: indexEdge(edgeIdsByEntity, edge.source.id, edge.id),
      [edge.target.id]: indexEdge(edgeIdsByEntity, edge.target.id, edge.id),
    };
  }
  return { edges, edgeIdsByEntity };
}

export function ingestDetail(state: DomainState, detail: EntityDetail): Partial<DomainState> {
  return {
    details: { ...state.details, [detail.id]: detail },
    entities: { ...state.entities, [detail.id]: detail },
  };
}

export function ingestMessages(
  state: DomainState,
  anchorId: EntityId,
  messages: MessageView[],
): Partial<DomainState> {
  let list = state.messagesByAnchor[anchorId] ?? [];
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of messages) byId.set(m.id, m);
  list = [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-MESSAGES_CAP);
  return { messagesByAnchor: { ...state.messagesByAnchor, [anchorId]: list } };
}

export function ingestNotifications(state: DomainState, items: NotificationItem[]): Partial<DomainState> {
  const byId = new Map(state.notifications.map((n) => [n.id, n]));
  for (const n of items) byId.set(n.id, n);
  return {
    notifications: [...byId.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
  };
}

/** `delivery(messageId)` read result — the v1 correctness path for facets (LLD §8). */
export function ingestDelivery(
  state: DomainState,
  messageId: EntityId,
  records: MessageDeliveryRecord[],
): Partial<DomainState> {
  return { deliveryByMessageId: { ...state.deliveryByMessageId, [messageId]: records } };
}

/** `handoffs(workSessionId)` read result. */
export function ingestHandoffs(
  state: DomainState,
  workSessionId: EntityId,
  handoffs: HandoffView[],
): Partial<DomainState> {
  return { handoffsByWorkSession: { ...state.handoffsByWorkSession, [workSessionId]: handoffs } };
}

// ---------------------------------------------------------------------------
// The dispatcher — one event in, one Partial<DomainState> patch out
// ---------------------------------------------------------------------------

/**
 * Fold one durable event. Unknown/unhandled types return `{}` — the event-row
 * rule: unknown ACTIVITY variants still render, unknown EVENT types are
 * skipped silently (forward compatibility across contract additions).
 */
export function reduceEvent(state: DomainState, e: DurableWorkspaceEvent): Partial<DomainState> {
  switch (e.type) {
    case 'entity.upsert':
      return reduceEntityEvent(state, e.entity, false);
    case 'entity.deleted':
      return reduceEntityEvent(state, e.entity, true);
    case 'edge.upsert':
      return reduceEdgeUpsert(state, e.edge);
    case 'edge.deleted':
      return reduceEdgeDeleted(state, e.edge);
    case 'message.created':
    case 'message.updated':
    case 'message.deleted':
      return reduceMessageEvent(state, e.anchorId, e.message);
    case 'counter.changed':
      return reduceCounterChanged(state, e.entityId, e.counters);
    case 'activity.created':
      return reduceActivityCreated(state, e.activity);
    case 'notification.created':
    case 'notification.read':
      return reduceNotificationEvent(state, e.notification);
    case 'menu.updated':
      return reduceMenuUpdated(state, e.spaceId, e.menu);
    case 'space.default_channel.updated':
      return reduceDefaultChannelUpdated(state, e.spaceId, e.channelId, e.settingsRevision);
    case 'message.delivery_reserved':
    case 'message.delivery_settled':
      return reduceDeliveryEvent(state, e.delivery);
    case 'message.attachments.updated':
      // Full MessageView payload; its anchor lives in the message state.
      return reduceMessageEvent(state, e.message.state.anchorId, e.message);
    case 'handoff.prepared':
    case 'handoff.delivery_settled':
    case 'handoff.recorded':
    case 'handoff.withdrawn':
      return reduceHandoffEvent(state, e.handoff);
    case 'project.association.corrected':
      return reduceAssociationCorrected(state, e.result.artifactId);
    default: {
      // Defensive discrimination (LLD §7): the interaction_profile event NAMES
      // are blocked on contract-vs-migration drift, so match the family by
      // prefix rather than enumerating names that may not survive arbitration.
      const type: string = (e as { type: string }).type;
      if (type.startsWith('interaction_profile.')) return reduceProfileInvalidation(state);
      return {};
    }
  }
}
