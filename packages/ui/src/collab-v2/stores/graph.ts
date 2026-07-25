/**
 * Graph store — the normalized client cache of the entity graph.
 *
 * Holds EntitySummary/EntityDetail/EdgeView records, thread slices, the
 * activity feed and inbox, applies WorkspaceEvent patches, and keeps an
 * optimistic-mutation journal keyed by clientMutationId with reconcile and
 * rollback. No component logic lives here — actions are plain functions,
 * fully testable without DOM.
 */
import { create } from 'zustand';
import type {
  ActivityItem, EdgeView, EntityDetail, EntityId, EntitySummary, MessageView,
  NotificationItem, WorkspaceEvent,
} from '../types/contract';

const ACTIVITY_CAP = 300;
const MESSAGES_CAP = 500;

interface OptimisticEntry {
  /** Summary state before the optimistic patch (undefined = wasn't cached). */
  prev: Record<EntityId, EntitySummary | undefined>;
  at: number;
}

export interface GraphState {
  entities: Record<EntityId, EntitySummary>;
  details: Record<EntityId, EntityDetail>;
  edges: Record<string, EdgeView>;
  /** Edge ids that touch an entity (either endpoint), for rail invalidation. */
  edgeIdsByEntity: Record<EntityId, string[]>;
  messagesByAnchor: Record<EntityId, MessageView[]>;
  activityFeed: ActivityItem[];
  notifications: NotificationItem[];
  optimistic: Record<string, OptimisticEntry>;
  /** Event ids already applied (subscription de-dup, contract §5). */
  seenEventIds: Record<string, true>;

  ingestSummaries: (list: EntitySummary[]) => void;
  ingestDetail: (detail: EntityDetail) => void;
  ingestMessages: (anchorId: EntityId, messages: MessageView[]) => void;
  ingestNotifications: (items: NotificationItem[]) => void;
  applyEvent: (event: WorkspaceEvent) => void;
  applyOptimistic: (clientMutationId: string, patches: EntitySummary[]) => void;
  reconcile: (clientMutationId: string) => void;
  rollback: (clientMutationId: string) => void;
  reset: () => void;
}

function indexEdge(map: Record<EntityId, string[]>, entityId: EntityId, edgeId: string): string[] {
  const list = map[entityId] ?? [];
  return list.includes(edgeId) ? list : [...list, edgeId];
}

function mergeSummary(
  state: Pick<GraphState, 'entities' | 'details'>,
  summary: EntitySummary,
): Partial<Pick<GraphState, 'entities' | 'details'>> {
  const out: Partial<Pick<GraphState, 'entities' | 'details'>> = {
    entities: { ...state.entities, [summary.id]: summary },
  };
  const detail = state.details[summary.id];
  if (detail) {
    // EntityDetail extends EntitySummary — overlay the fresher envelope while
    // keeping the heavy sections (content/hierarchy/connections) cached.
    out.details = { ...state.details, [summary.id]: { ...detail, ...summary } };
  }
  return out;
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  entities: {},
  details: {},
  edges: {},
  edgeIdsByEntity: {},
  messagesByAnchor: {},
  activityFeed: [],
  notifications: [],
  optimistic: {},
  seenEventIds: {},

  ingestSummaries: (list) => set((state) => {
    let entities = state.entities;
    let details = state.details;
    for (const s of list) {
      const merged = mergeSummary({ entities, details }, s);
      entities = merged.entities ?? entities;
      details = merged.details ?? details;
    }
    return { entities, details };
  }),

  ingestDetail: (detail) => set((state) => ({
    details: { ...state.details, [detail.id]: detail },
    entities: { ...state.entities, [detail.id]: detail },
  })),

  ingestMessages: (anchorId, messages) => set((state) => {
    const existing = state.messagesByAnchor[anchorId] ?? [];
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of messages) byId.set(m.id, m);
    const merged = [...byId.values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(-MESSAGES_CAP);
    return { messagesByAnchor: { ...state.messagesByAnchor, [anchorId]: merged } };
  }),

  ingestNotifications: (items) => set((state) => {
    const byId = new Map(state.notifications.map((n) => [n.id, n]));
    for (const n of items) byId.set(n.id, n);
    return {
      notifications: [...byId.values()]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    };
  }),

  applyEvent: (event) => {
    if (get().seenEventIds[event.eventId]) return;
    set((state) => {
      const next: Partial<GraphState> = {
        seenEventIds: { ...state.seenEventIds, [event.eventId]: true as const },
      };
      switch (event.type) {
        case 'entity.upsert':
        case 'entity.deleted': {
          Object.assign(next, mergeSummary(state, event.entity));
          if (event.type === 'entity.deleted') {
            const details = { ...(next.details ?? state.details) };
            delete details[event.entity.id];
            next.details = details;
          }
          if (event.clientMutationId && state.optimistic[event.clientMutationId]) {
            const optimistic = { ...state.optimistic };
            delete optimistic[event.clientMutationId];
            next.optimistic = optimistic;
          }
          break;
        }
        case 'edge.upsert': {
          const edge = event.edge;
          next.edges = { ...state.edges, [edge.id]: edge };
          let index = state.edgeIdsByEntity;
          index = { ...index, [edge.source.id]: indexEdge(index, edge.source.id, edge.id) };
          index = { ...index, [edge.target.id]: indexEdge(index, edge.target.id, edge.id) };
          next.edgeIdsByEntity = index;
          break;
        }
        case 'edge.deleted': {
          const edge = event.edge;
          const edges = { ...state.edges };
          delete edges[edge.id];
          next.edges = edges;
          const index = { ...state.edgeIdsByEntity };
          for (const endpoint of [edge.source.id, edge.target.id]) {
            if (index[endpoint]) index[endpoint] = index[endpoint].filter((id) => id !== edge.id);
          }
          next.edgeIdsByEntity = index;
          break;
        }
        case 'message.created':
        case 'message.updated':
        case 'message.deleted': {
          const list = state.messagesByAnchor[event.anchorId] ?? [];
          const byId = new Map(list.map((m) => [m.id, m]));
          byId.set(event.message.id, event.message); // deleted → tombstone view stays
          next.messagesByAnchor = {
            ...state.messagesByAnchor,
            [event.anchorId]: [...byId.values()]
              .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
              .slice(-MESSAGES_CAP),
          };
          break;
        }
        case 'counter.changed': {
          const summary = state.entities[event.entityId];
          if (summary) {
            Object.assign(next, mergeSummary(state, { ...summary, counters: event.counters }));
          }
          break;
        }
        case 'activity.created': {
          next.activityFeed = [event.activity, ...state.activityFeed].slice(0, ACTIVITY_CAP);
          break;
        }
        case 'notification.created':
        case 'notification.read': {
          const byId = new Map(state.notifications.map((n) => [n.id, n]));
          byId.set(event.notification.id, event.notification);
          next.notifications = [...byId.values()]
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
          break;
        }
        case 'presence.changed':
        case 'typing.changed':
          break; // presence store owns these
      }
      return next;
    });
  },

  applyOptimistic: (clientMutationId, patches) => set((state) => {
    const prev: Record<EntityId, EntitySummary | undefined> = {};
    let entities = state.entities;
    let details = state.details;
    for (const patch of patches) {
      prev[patch.id] = state.entities[patch.id];
      const merged = mergeSummary({ entities, details }, patch);
      entities = merged.entities ?? entities;
      details = merged.details ?? details;
    }
    return {
      entities, details,
      optimistic: { ...state.optimistic, [clientMutationId]: { prev, at: Date.now() } },
    };
  }),

  reconcile: (clientMutationId) => set((state) => {
    if (!state.optimistic[clientMutationId]) return {};
    const optimistic = { ...state.optimistic };
    delete optimistic[clientMutationId];
    return { optimistic };
  }),

  rollback: (clientMutationId) => set((state) => {
    const entry = state.optimistic[clientMutationId];
    if (!entry) return {};
    let entities = { ...state.entities };
    let details = state.details;
    for (const [id, prev] of Object.entries(entry.prev)) {
      if (prev === undefined) {
        delete entities[id];
        const d = { ...details };
        delete d[id];
        details = d;
      } else {
        const merged = mergeSummary({ entities, details }, prev);
        entities = (merged.entities ?? entities) as Record<EntityId, EntitySummary>;
        details = merged.details ?? details;
      }
    }
    const optimistic = { ...state.optimistic };
    delete optimistic[clientMutationId];
    return { entities, details, optimistic };
  }),

  reset: () => set({
    entities: {}, details: {}, edges: {}, edgeIdsByEntity: {},
    messagesByAnchor: {}, activityFeed: [], notifications: [],
    optimistic: {}, seenEventIds: {},
  }),
}));

// --- narrow selector helpers (use with useGraphStore(selectX(id))) ------------
export const selectEntity = (id: EntityId) => (s: GraphState): EntitySummary | undefined => s.entities[id];
export const selectDetail = (id: EntityId) => (s: GraphState): EntityDetail | undefined => s.details[id];
export const selectMessages = (anchorId: EntityId) => (s: GraphState): MessageView[] | undefined => s.messagesByAnchor[anchorId];
export const selectEdgesOf = (id: EntityId) => (s: GraphState): EdgeView[] =>
  (s.edgeIdsByEntity[id] ?? []).map((eid) => s.edges[eid]).filter((e): e is EdgeView => e != null);
export const selectUnreadNotificationCount = (s: GraphState): number =>
  s.notifications.filter((n) => n.readAt == null).length;
