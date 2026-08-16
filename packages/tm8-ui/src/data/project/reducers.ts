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
export const DETAIL_CACHE_CAP = 128;
export const MESSAGE_ANCHOR_CACHE_CAP = 128;
export const EDGE_TOMBSTONE_CAP = 1_024;
export const ENTITY_CACHE_CAP = 20_000;
export const EDGE_CACHE_CAP = 20_000;
export const EDGE_INDEX_CACHE_CAP = EDGE_CACHE_CAP * 2;
export const NOTIFICATION_CAP = 500;

/**
 * `retained` is the set of keys some rendered projection still points at, and
 * it is not optional bookkeeping — without it this cap can evict THE THREAD ON
 * SCREEN. `messagesByAnchor` is keyed by anchor entity id, an open panel's
 * anchor is in the retained set (its detail is cached, which is why it renders
 * at all), and the eviction previously took the oldest key unconditionally. A
 * viewer reading a long-lived channel while 128 other anchors received messages
 * would watch their own thread blank and refetch. `pull` re-arms it, so it
 * self-heals — as a visible flicker, on the one surface the viewer is looking
 * at, which is the worst place to spend a cache miss.
 */
function setBounded<T>(
  source: Record<string, T>,
  key: string,
  value: T,
  cap: number,
  retained: ReadonlySet<string> = new Set(),
): Record<string, T> {
  const next = { ...source };
  // Delete/reinsert makes object order a small, allocation-free LRU index.
  delete next[key];
  next[key] = value;
  let excess = Object.keys(next).length - cap;
  if (excess > 0) {
    for (const stale of Object.keys(next)) {
      if (excess <= 0) break;
      // The key just written is always the newest and never a candidate.
      if (stale === key || retained.has(stale)) continue;
      delete next[stale];
      excess -= 1;
    }
  }
  return next;
}

/**
 * Move a key to the end of a record's insertion order.
 *
 * Object key order IS the LRU index for every bounded family in this file
 * (`setBounded` states the same trick), so a write that leaves an existing key
 * where it was records a recency that never happened: the entity everyone is
 * looking at would age out ahead of one nobody has touched since boot. The
 * delete is therefore not redundant with the assignment — it is the whole
 * recency update. Only safe on a map the caller already cloned.
 */
function touchInto<T>(map: Record<string, T>, key: string, value: T): void {
  delete map[key];
  map[key] = value;
}

/**
 * The four normalized families a cap sweep may need to rewrite, threaded as
 * lazily-cloned drafts. Absent ⇒ "unchanged so far, read it off `state`" —
 * the same copy-on-write discipline `reduceEvents` uses, so a sweep that
 * evicts nothing allocates nothing and returns no patch.
 */
export interface CacheDraft {
  entities?: Record<EntityId, EntitySummary>;
  details?: Record<EntityId, EntityDetail>;
  edges?: Record<string, EdgeView>;
  edgeIdsByEntity?: Record<EntityId, string[]>;
}

/**
 * EVERY WRITE PATH ENFORCES THE CAPS, AND EVICTION LEAVES NO DANGLING REFERENCE.
 *
 * Both halves of that sentence were false before this function existed, and
 * each was its own defect.
 *
 * **The caps only ran on the event path.** `reduceEvents` swept; the four
 * other ways an entity enters this store — `ingestSummaries` (every read and
 * every command's `patches`), `ingestEdges` (`graph.query`), `ingestDetail`
 * (every panel open) and the optimistic `mergeSummary` — swept nothing. So the
 * bound described a client that only ever receives events, and the one that
 * actually leaks is the one someone is BROWSING: reads grew `entities`,
 * `details` and `edges` without limit for as long as a space stayed open, and
 * the event path's sweep could not recover it because `Object.keys().length`
 * had to exceed the cap through EVENTS ALONE to fire at all.
 *
 * **Eviction was not reference-safe.** Dropping `entities[id]` left
 * `details[id]` behind — a detail is an `EntitySummary` plus heavy sections, so
 * the store then held a panel's whole payload for a row `projectRows` skips
 * (it reads `entities`, and an id with no summary is dropped from the list).
 * It also left `edgeIdsByEntity[id]` pointing at edges whose endpoint the store
 * can no longer name, which is exactly the shape `selectConnectionsOf` renders
 * from. Eviction here is therefore TRANSITIVE: an evicted entity takes its
 * detail, its edge index entry and its edges with it, and each of those edges
 * is unindexed from its OTHER endpoint too.
 *
 * `retained` is the set of ids some rendered projection still references —
 * rows on screen, graph nodes, open details, open threads. Those are never
 * evicted, at either cap, which is what makes a sweep invisible to the screen.
 * Nothing here is a heuristic about what LOOKS unused: if the UI still points
 * at it, it stays, and the cap is best-effort against that.
 *
 * Mutates `draft` in place, cloning each family off `state` only when the
 * first eviction actually needs it.
 */
export function enforceCacheBounds(
  state: Pick<DomainState, 'entities' | 'details' | 'edges' | 'edgeIdsByEntity'>,
  draft: CacheDraft,
  retained: ReadonlySet<string> = new Set(),
): void {
  const entityExcess = Object.keys(draft.entities ?? state.entities).length - ENTITY_CACHE_CAP;
  const edgeExcess = Object.keys(draft.edges ?? state.edges).length - EDGE_CACHE_CAP;
  const indexExcess = Object.keys(draft.edgeIdsByEntity ?? state.edgeIdsByEntity).length
    - EDGE_INDEX_CACHE_CAP;
  // The common case by far. Returning before touching `Object.keys` a second
  // time keeps a steady-state event burst allocation-free here: the previous
  // edge trim built and filtered a full key array on every batch and then
  // sliced zero of it.
  if (entityExcess <= 0 && edgeExcess <= 0 && indexExcess <= 0) return;

  /** Drop one edge and unindex it from both endpoints. */
  const dropEdge = (edgeId: string): void => {
    const edges = (draft.edges ??= { ...state.edges });
    const edge = edges[edgeId];
    delete edges[edgeId];
    if (!edge) return;
    const index = (draft.edgeIdsByEntity ??= { ...state.edgeIdsByEntity });
    for (const endpoint of [edge.source.id, edge.target.id]) {
      const list = index[endpoint];
      if (list) index[endpoint] = list.filter((id) => id !== edgeId);
    }
  };

  if (entityExcess > 0) {
    let remaining = entityExcess;
    // Insertion order is the LRU index — see `touchInto`.
    for (const id of Object.keys(draft.entities ?? state.entities)) {
      if (remaining <= 0) break;
      if (retained.has(id)) continue;
      const entities = (draft.entities ??= { ...state.entities });
      delete entities[id];
      remaining -= 1;
      const details = draft.details ?? state.details;
      if (details[id]) delete (draft.details ??= { ...state.details })[id];
      const touching = (draft.edgeIdsByEntity ?? state.edgeIdsByEntity)[id];
      if (touching) {
        // Copy: `dropEdge` rewrites the very list being walked.
        for (const edgeId of [...touching]) dropEdge(edgeId);
        delete (draft.edgeIdsByEntity ??= { ...state.edgeIdsByEntity })[id];
      }
    }
  }

  // Re-measured: the transitive sweep above may already have taken the edge
  // family under its own cap.
  let remainingEdges = Object.keys(draft.edges ?? state.edges).length - EDGE_CACHE_CAP;
  if (remainingEdges > 0) {
    const edges = draft.edges ?? state.edges;
    for (const edgeId of Object.keys(edges)) {
      if (remainingEdges <= 0) break;
      const edge = edges[edgeId];
      if (!edge) continue;
      if (retained.has(edge.source.id) || retained.has(edge.target.id)) continue;
      dropEdge(edgeId);
      remainingEdges -= 1;
    }
  }

  // The index outlives its edges: unindexing leaves an empty array behind, and
  // those are the only entries safe to drop (a non-empty one still names live
  // edges). Retained ids keep theirs so an open Connections tab is never
  // silently emptied.
  let remainingIndex = Object.keys(draft.edgeIdsByEntity ?? state.edgeIdsByEntity).length
    - EDGE_INDEX_CACHE_CAP;
  if (remainingIndex > 0) {
    const index = draft.edgeIdsByEntity ?? state.edgeIdsByEntity;
    for (const entityId of Object.keys(index)) {
      if (remainingIndex <= 0) break;
      if (retained.has(entityId)) continue;
      if (index[entityId]?.length !== 0) continue;
      delete (draft.edgeIdsByEntity ??= { ...state.edgeIdsByEntity })[entityId];
      remainingIndex -= 1;
    }
  }
}

/** The patch shape of a cap sweep: only the families it actually rewrote. */
export function draftPatch(draft: CacheDraft): Partial<DomainState> {
  return {
    ...(draft.entities ? { entities: draft.entities } : {}),
    ...(draft.details ? { details: draft.details } : {}),
    ...(draft.edges ? { edges: draft.edges } : {}),
    ...(draft.edgeIdsByEntity ? { edgeIdsByEntity: draft.edgeIdsByEntity } : {}),
  };
}

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
  /** Recent deletes prevent an older HTTP detail snapshot resurrecting edges. */
  edgeTombstones: Record<string, string>;
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
    edgeTombstones: {},
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

function isAfter(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs > rightMs;
  return left > right;
}

function isAtOrAfter(left: string, right: string): boolean {
  return left === right || isAfter(left, right);
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

function upsertMessageList(list: MessageView[], message: MessageView): MessageView[] {
  const byId = new Map(list.map((m) => [m.id, m]));
  const current = byId.get(message.id);
  if (!current || current.version <= message.version) {
    byId.set(message.id, message); // deleted → tombstone view stays in the list
  }
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
  const current = state.entities[entity.id];
  if (current && current.version > entity.version) return {};
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

/*
 * WHY NEITHER EDGE REDUCER TOUCHES `details[id].connections`, asked and
 * answered while fixing the attachment strip.
 *
 * `EntityDetail.connections` is a READ-TIME SNAPSHOT of the same fact these
 * two functions maintain in `edges`/`edgeIdsByEntity`. Folding events into it
 * as well would give the store TWO live copies of one fact, which have to be
 * kept in agreement forever — and `ingestDetail` overwrites the detail
 * wholesale on every read, so the two would diverge on the very next fetch.
 *
 * The live answer already exists and needs no second copy:
 * `selectConnectionsOf` regroups the normalized family below into a
 * `Connections` on demand, which is how an open Connections tab already sees
 * an edge created after it was opened. A consumer that needs the CURRENT
 * connections reads that selector; one that reads `detail.connections` is
 * asking for the snapshot and gets it. The attachment strip was reading the
 * snapshot by mistake — fixed there (`files/model.ts` `attachedFiles(detail,
 * live)`), not by adding a third copy here.
 */

/** `edge.upsert`: upsert the edge and index it under both endpoints. */
export function reduceEdgeUpsert(state: DomainState, edge: EdgeView): Partial<DomainState> {
  const current = state.edges[edge.id];
  const tombstone = state.edgeTombstones[edge.id];
  if (current && isAfter(current.updatedAt, edge.updatedAt)) return {};
  if (tombstone && isAtOrAfter(tombstone, edge.updatedAt)) return {};
  let index = state.edgeIdsByEntity;
  index = { ...index, [edge.source.id]: indexEdge(index, edge.source.id, edge.id) };
  index = { ...index, [edge.target.id]: indexEdge(index, edge.target.id, edge.id) };
  const edges = { ...state.edges, [edge.id]: edge };
  if (!tombstone) return { edges, edgeIdsByEntity: index };
  const edgeTombstones = { ...state.edgeTombstones };
  delete edgeTombstones[edge.id];
  return { edges, edgeIdsByEntity: index, edgeTombstones };
}

/** `edge.deleted`: drop the edge and unindex it from both endpoints. */
export function reduceEdgeDeleted(state: DomainState, edge: EdgeView): Partial<DomainState> {
  const current = state.edges[edge.id];
  const tombstone = state.edgeTombstones[edge.id];
  if (current && isAfter(current.updatedAt, edge.updatedAt)) return {};
  if (tombstone && isAfter(tombstone, edge.updatedAt)) return {};
  const edges = { ...state.edges };
  delete edges[edge.id];
  const index = { ...state.edgeIdsByEntity };
  for (const endpoint of [edge.source.id, edge.target.id]) {
    if (index[endpoint]) index[endpoint] = index[endpoint].filter((id) => id !== edge.id);
  }
  return {
    edges,
    edgeIdsByEntity: index,
    edgeTombstones: setBounded(
      state.edgeTombstones,
      edge.id,
      edge.updatedAt,
      EDGE_TOMBSTONE_CAP,
    ),
  };
}

/** `message.created|updated|deleted`: upsert by anchor, createdAt-sorted, capped; tombstones stay. */
export function reduceMessageEvent(
  state: DomainState,
  anchorId: EntityId,
  message: MessageView,
  retained: ReadonlySet<string> = new Set(),
): Partial<DomainState> {
  const list = state.messagesByAnchor[anchorId] ?? [];
  return {
    messagesByAnchor: setBounded(
      state.messagesByAnchor,
      anchorId,
      upsertMessageList(list, message),
      MESSAGE_ANCHOR_CACHE_CAP,
      retained,
    ),
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
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, NOTIFICATION_CAP),
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

export function ingestSummaries(
  state: DomainState,
  list: EntitySummary[],
  retained: ReadonlySet<string> = new Set(),
): Partial<DomainState> {
  if (list.length === 0) return {};
  const draft: CacheDraft = {};
  for (const s of list) {
    const current = (draft.entities ?? state.entities)[s.id];
    if (current && current.version > s.version) continue;
    touchInto((draft.entities ??= { ...state.entities }), s.id, s);
    const detail = (draft.details ?? state.details)[s.id];
    if (detail) (draft.details ??= { ...state.details })[s.id] = { ...detail, ...s };
  }
  if (!draft.entities) return {};
  enforceCacheBounds(state, draft, retained);
  return draftPatch(draft);
}

/**
 * Fold edges into a draft without sweeping. The sweep is the CALLER'S, because
 * `ingestDetail` folds its connection snapshot through here on the way to one
 * combined patch and a nested sweep would evict against a half-built draft.
 */
function foldEdges(
  state: DomainState,
  draft: CacheDraft & { edgeTombstones?: Record<string, string> },
  list: readonly EdgeView[],
): void {
  for (const edge of list) {
    const current = (draft.edges ?? state.edges)[edge.id];
    const tombstone = (draft.edgeTombstones ?? state.edgeTombstones)[edge.id];
    if (current && isAfter(current.updatedAt, edge.updatedAt)) continue;
    if (tombstone && isAtOrAfter(tombstone, edge.updatedAt)) continue;
    const edges = (draft.edges ??= { ...state.edges });
    const index = (draft.edgeIdsByEntity ??= { ...state.edgeIdsByEntity });
    touchInto(edges, edge.id, edge);
    index[edge.source.id] = indexEdge(index, edge.source.id, edge.id);
    index[edge.target.id] = indexEdge(index, edge.target.id, edge.id);
    if (tombstone) delete (draft.edgeTombstones ??= { ...state.edgeTombstones })[edge.id];
  }
}

/** `graph.query` hydration uses the same normalized edge family as events. */
export function ingestEdges(
  state: DomainState,
  list: EdgeView[],
  retained: ReadonlySet<string> = new Set(),
): Partial<DomainState> {
  if (list.length === 0) return {};
  const draft: CacheDraft & { edgeTombstones?: Record<string, string> } = {};
  foldEdges(state, draft, list);
  if (!draft.edges) return {};
  enforceCacheBounds(state, draft, retained);
  return {
    ...draftPatch(draft),
    ...(draft.edgeTombstones ? { edgeTombstones: draft.edgeTombstones } : {}),
  };
}

export function ingestDetail(
  state: DomainState,
  detail: EntityDetail,
  retained: ReadonlySet<string> = new Set(),
): Partial<DomainState> {
  const cachedDetail = state.details[detail.id];
  if (cachedDetail && cachedDetail.version > detail.version) return {};
  const currentSummary = state.entities[detail.id];
  // Heavy fields are versioned with the entity. Overlaying a newer summary on
  // stale content would make old content claim the newer version and suppress
  // every future pull, so reject the whole stale snapshot.
  if (currentSummary && currentSummary.version > detail.version) return {};
  // EntityDetail carries the connection snapshot that was authoritative when
  // the read completed. Normalize those edges into the SAME family that live
  // edge.upsert/edge.deleted events update; otherwise a panel can only render
  // the frozen detail snapshot and will miss a relation created after it was
  // opened (or keep one after edge.deleted).
  const connectionEdges = [
    ...(detail.connections?.outgoing ?? []).flatMap((group) => group.edges),
    ...(detail.connections?.incoming ?? []).flatMap((group) => group.edges),
  ];
  const draft: CacheDraft & { edgeTombstones?: Record<string, string> } = {
    details: setBounded(state.details, detail.id, detail, DETAIL_CACHE_CAP),
    entities: { ...state.entities },
  };
  touchInto(draft.entities as Record<EntityId, EntitySummary>, detail.id, detail);
  foldEdges(state, draft, connectionEdges);
  // The id whose detail this IS can never be the sweep's victim: dropping the
  // summary of a panel that is open right now is the one eviction guaranteed
  // to be wrong, and the caller's retained set is built from a render that
  // predates this read.
  enforceCacheBounds(state, draft, new Set([...retained, detail.id]));
  return {
    ...draftPatch(draft),
    ...(draft.edgeTombstones ? { edgeTombstones: draft.edgeTombstones } : {}),
  };
}

export function ingestMessages(
  state: DomainState,
  anchorId: EntityId,
  messages: MessageView[],
  retained: ReadonlySet<string> = new Set(),
): Partial<DomainState> {
  let list = state.messagesByAnchor[anchorId] ?? [];
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of messages) {
    const current = byId.get(m.id);
    if (!current || current.version <= m.version) byId.set(m.id, m);
  }
  list = [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-MESSAGES_CAP);
  return {
    messagesByAnchor: setBounded(
      state.messagesByAnchor,
      anchorId,
      list,
      MESSAGE_ANCHOR_CACHE_CAP,
      retained,
    ),
  };
}

export function ingestNotifications(state: DomainState, items: NotificationItem[]): Partial<DomainState> {
  const byId = new Map(state.notifications.map((n) => [n.id, n]));
  for (const n of items) byId.set(n.id, n);
  return {
    notifications: [...byId.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, NOTIFICATION_CAP),
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

/**
 * Fold an ordered burst with one outer-map clone per changed family.
 *
 * WebSocket frames are deliberately collected at the domain boundary before
 * reaching this reducer. Calling `reduceEvent` in a loop would avoid React
 * notifications but would still copy a 10k-entry entity map 500 times. This
 * mutable draft is private to the fold; callers still receive immutable slice
 * identities and the observable result is equivalent to applying the events
 * sequentially.
 */
export function reduceEvents(
  state: DomainState,
  events: readonly DurableWorkspaceEvent[],
  retainedEntityIds: ReadonlySet<string> = new Set(),
): Partial<DomainState> {
  if (events.length === 0) return {};

  let entities: DomainState['entities'] | undefined;
  let details: DomainState['details'] | undefined;
  let edges: DomainState['edges'] | undefined;
  let edgeTombstones: DomainState['edgeTombstones'] | undefined;
  let edgeIdsByEntity: DomainState['edgeIdsByEntity'] | undefined;
  let messagesByAnchor: DomainState['messagesByAnchor'] | undefined;
  let activityFeed: DomainState['activityFeed'] | undefined;
  let notifications: DomainState['notifications'] | undefined;
  let notificationMap: Map<string, NotificationItem> | undefined;
  let menuBySpace: DomainState['menuBySpace'] | undefined;
  let settingsBySpace: DomainState['settingsBySpace'] | undefined;
  let deliveryByMessageId: DomainState['deliveryByMessageId'] | undefined;
  let handoffsByWorkSession: DomainState['handoffsByWorkSession'] | undefined;
  let staleConnections: DomainState['staleConnections'] | undefined;
  let profileInvalidations: number | undefined;

  for (const e of events) {
    switch (e.type) {
      case 'entity.upsert':
      case 'entity.deleted': {
        const currentEntity = (entities ?? state.entities)[e.entity.id];
        if (currentEntity && currentEntity.version > e.entity.version) break;
        entities ??= { ...state.entities };
        delete entities[e.entity.id];
        entities[e.entity.id] = e.entity;
        const detail = (details ?? state.details)[e.entity.id];
        if (e.type === 'entity.deleted') {
          if (detail) {
            details ??= { ...state.details };
            delete details[e.entity.id];
          }
        } else if (detail) {
          details ??= { ...state.details };
          details[e.entity.id] = { ...detail, ...e.entity };
        }
        break;
      }
      case 'counter.changed': {
        const summary = (entities ?? state.entities)[e.entityId];
        if (!summary) break;
        entities ??= { ...state.entities };
        entities[e.entityId] = { ...summary, counters: e.counters };
        const detail = (details ?? state.details)[e.entityId];
        if (detail) {
          details ??= { ...state.details };
          details[e.entityId] = { ...detail, counters: e.counters };
        }
        break;
      }
      case 'edge.upsert': {
        const current = (edges ?? state.edges)[e.edge.id];
        const tombstone = (edgeTombstones ?? state.edgeTombstones)[e.edge.id];
        if (current && isAfter(current.updatedAt, e.edge.updatedAt)) break;
        if (tombstone && isAtOrAfter(tombstone, e.edge.updatedAt)) break;
        edges ??= { ...state.edges };
        edgeIdsByEntity ??= { ...state.edgeIdsByEntity };
        edges[e.edge.id] = e.edge;
        edgeIdsByEntity[e.edge.source.id] = indexEdge(
          edgeIdsByEntity,
          e.edge.source.id,
          e.edge.id,
        );
        edgeIdsByEntity[e.edge.target.id] = indexEdge(
          edgeIdsByEntity,
          e.edge.target.id,
          e.edge.id,
        );
        if (tombstone) {
          edgeTombstones ??= { ...state.edgeTombstones };
          delete edgeTombstones[e.edge.id];
        }
        break;
      }
      case 'edge.deleted': {
        const current = (edges ?? state.edges)[e.edge.id];
        const tombstone = (edgeTombstones ?? state.edgeTombstones)[e.edge.id];
        if (current && isAfter(current.updatedAt, e.edge.updatedAt)) break;
        if (tombstone && isAfter(tombstone, e.edge.updatedAt)) break;
        edges ??= { ...state.edges };
        edgeIdsByEntity ??= { ...state.edgeIdsByEntity };
        edgeTombstones ??= { ...state.edgeTombstones };
        delete edges[e.edge.id];
        delete edgeTombstones[e.edge.id];
        edgeTombstones[e.edge.id] = e.edge.updatedAt;
        for (const endpoint of [e.edge.source.id, e.edge.target.id]) {
          const list = edgeIdsByEntity[endpoint];
          if (list) edgeIdsByEntity[endpoint] = list.filter((id) => id !== e.edge.id);
        }
        break;
      }
      case 'message.created':
      case 'message.updated':
      case 'message.deleted': {
        messagesByAnchor ??= { ...state.messagesByAnchor };
        const current = messagesByAnchor[e.anchorId] ?? [];
        delete messagesByAnchor[e.anchorId];
        messagesByAnchor[e.anchorId] = upsertMessageList(
          current,
          e.message,
        );
        break;
      }
      case 'message.attachments.updated': {
        messagesByAnchor ??= { ...state.messagesByAnchor };
        const anchorId = e.message.state.anchorId;
        const current = messagesByAnchor[anchorId] ?? [];
        delete messagesByAnchor[anchorId];
        messagesByAnchor[anchorId] = upsertMessageList(
          current,
          e.message,
        );
        break;
      }
      case 'activity.created': {
        activityFeed ??= [...state.activityFeed];
        const at = activityFeed.findIndex((item) => item.id === e.activity.id);
        if (at >= 0) activityFeed[at] = e.activity;
        else activityFeed = [e.activity, ...activityFeed].slice(0, ACTIVITY_CAP);
        break;
      }
      case 'notification.created':
      case 'notification.read': {
        notificationMap ??= new Map(state.notifications.map((item) => [item.id, item]));
        notificationMap.set(e.notification.id, e.notification);
        break;
      }
      case 'menu.updated':
        menuBySpace ??= { ...state.menuBySpace };
        menuBySpace[e.spaceId] = e.menu;
        break;
      case 'space.default_channel.updated':
        settingsBySpace ??= { ...state.settingsBySpace };
        settingsBySpace[e.spaceId] = {
          defaultChannelId: e.channelId,
          settingsRevision: e.settingsRevision,
        };
        break;
      case 'message.delivery_reserved':
      case 'message.delivery_settled': {
        deliveryByMessageId ??= { ...state.deliveryByMessageId };
        const list = deliveryByMessageId[e.delivery.messageId] ?? [];
        const at = list.findIndex((record) => record.deliveryId === e.delivery.deliveryId);
        deliveryByMessageId[e.delivery.messageId] = at >= 0
          ? list.map((record, index) => index === at ? e.delivery : record)
          : [...list, e.delivery];
        break;
      }
      case 'handoff.prepared':
      case 'handoff.delivery_settled':
      case 'handoff.recorded':
      case 'handoff.withdrawn': {
        handoffsByWorkSession ??= { ...state.handoffsByWorkSession };
        const key = e.handoff.targetWorkSessionId;
        const list = handoffsByWorkSession[key] ?? [];
        const at = list.findIndex((handoff) => handoff.handoffId === e.handoff.handoffId);
        handoffsByWorkSession[key] = at >= 0
          ? list.map((handoff, index) => index === at ? e.handoff : handoff)
          : [...list, e.handoff];
        break;
      }
      case 'project.association.corrected':
        staleConnections ??= { ...state.staleConnections };
        staleConnections[e.result.artifactId] = true;
        break;
      default: {
        const type: string = (e as { type: string }).type;
        if (type.startsWith('interaction_profile.')) {
          profileInvalidations = (profileInvalidations ?? state.profileInvalidations) + 1;
        }
      }
    }
  }

  if (notificationMap) {
    notifications = [...notificationMap.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, NOTIFICATION_CAP);
  }

  if (details && Object.keys(details).length > DETAIL_CACHE_CAP) {
    for (const stale of Object.keys(details).slice(0, Object.keys(details).length - DETAIL_CACHE_CAP)) {
      delete details[stale];
    }
  }
  if (messagesByAnchor) {
    // Same rule as `setBounded`: an open thread's anchor is retained and must
    // not be evicted out from under the panel rendering it.
    let excess = Object.keys(messagesByAnchor).length - MESSAGE_ANCHOR_CACHE_CAP;
    for (const stale of Object.keys(messagesByAnchor)) {
      if (excess <= 0) break;
      if (retainedEntityIds.has(stale)) continue;
      delete messagesByAnchor[stale];
      excess -= 1;
    }
  }
  if (edgeTombstones && Object.keys(edgeTombstones).length > EDGE_TOMBSTONE_CAP) {
    for (const stale of Object.keys(edgeTombstones).slice(
      0,
      Object.keys(edgeTombstones).length - EDGE_TOMBSTONE_CAP,
    )) delete edgeTombstones[stale];
  }
  // ONE SWEEP, SHARED WITH THE READ PATHS. This used to be two bespoke trims
  // that between them dropped entities without their details and edges without
  // re-checking whether the entity sweep had already taken the family under
  // cap — see `enforceCacheBounds` for both defects.
  if (entities || edges || edgeIdsByEntity || details) {
    const draft: CacheDraft = {
      ...(entities ? { entities } : {}),
      ...(details ? { details } : {}),
      ...(edges ? { edges } : {}),
      ...(edgeIdsByEntity ? { edgeIdsByEntity } : {}),
    };
    enforceCacheBounds(state, draft, retainedEntityIds);
    entities = draft.entities;
    details = draft.details;
    edges = draft.edges;
    edgeIdsByEntity = draft.edgeIdsByEntity;
  }

  // Construct only the changed families so an unknown-event batch is a true
  // no-op and Zustand does not wake every subscriber for it.
  return {
    ...(entities ? { entities } : {}),
    ...(details ? { details } : {}),
    ...(edges ? { edges } : {}),
    ...(edgeTombstones ? { edgeTombstones } : {}),
    ...(edgeIdsByEntity ? { edgeIdsByEntity } : {}),
    ...(messagesByAnchor ? { messagesByAnchor } : {}),
    ...(activityFeed ? { activityFeed } : {}),
    ...(notifications ? { notifications } : {}),
    ...(menuBySpace ? { menuBySpace } : {}),
    ...(settingsBySpace ? { settingsBySpace } : {}),
    ...(deliveryByMessageId ? { deliveryByMessageId } : {}),
    ...(handoffsByWorkSession ? { handoffsByWorkSession } : {}),
    ...(staleConnections ? { staleConnections } : {}),
    ...(profileInvalidations === undefined ? {} : { profileInvalidations }),
  };
}
