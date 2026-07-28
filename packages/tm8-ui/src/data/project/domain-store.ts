/**
 * Domain store — the ready-made `zustand/vanilla` store wiring
 * seam event stream → reducers → journal → passthrough table (LLD §7,
 * FE-consensus ADOPTED for the domain slice; FE stores keep nav/UI/selection
 * state and call seam commands directly — commands are NOT wrapped here).
 *
 * No react imports anywhere in src/data (LLD §3). No seenEventIds set: the
 * seam guarantees strictly increasing seq per space with no duplicates.
 *
 * Optimistic flow (LLD §7): the caller builds contract input with a fresh
 * clientMutationId → `applyOptimistic` → `seam.commands.x()` → on success
 * apply `CommandResult.patches` (authoritative, via `ingestSummaries`) +
 * `reconcile` · on failure `rollback` + render the CollabError → any event
 * echoing the same clientMutationId also reconciles (first wins; both paths
 * are idempotent no-ops after the first).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  ActivityItem,
  DurableWorkspaceEvent,
  EdgeView,
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
import type { Seam, Unsubscribe } from '../seam.js';
import {
  type DomainState,
  type SpaceSettings,
  ingestDelivery,
  ingestDetail,
  ingestHandoffs,
  ingestMessages,
  ingestNotifications,
  ingestSummaries,
  initialDomainState,
  mergeSummary,
  reduceEvent,
} from './reducers.js';
import { createJournal, type Journal } from './journal.js';

/** The slice of the seam the store consumes — the durable event stream only. */
export type DomainEventSource = Pick<Seam, 'onEvent'>;

export interface DomainActions {
  // hydration ingestion (read results)
  ingestSummaries(list: EntitySummary[]): void;
  ingestDetail(detail: EntityDetail): void;
  ingestMessages(anchorId: EntityId, messages: MessageView[]): void;
  ingestNotifications(items: NotificationItem[]): void;
  ingestMenu(spaceId: SpaceId, menu: MenuConfig | null): void;
  ingestDelivery(messageId: EntityId, records: MessageDeliveryRecord[]): void;
  ingestHandoffs(workSessionId: EntityId, handoffs: HandoffView[]): void;
  /** Event stream entry point (wired to seam.onEvent by createDomainStore). */
  applyEvent(e: DurableWorkspaceEvent): void;
  // optimistic journal
  applyOptimistic(clientMutationId: string, patches: EntitySummary[]): void;
  reconcile(clientMutationId: string): void;
  rollback(clientMutationId: string): void;
  /** Consumer refetched `connections(id)` — clear the invalidation mark. */
  clearConnectionsStale(id: EntityId): void;
  reset(): void;
}

export interface DomainStoreState extends DomainState, DomainActions {
  /** Render marker for in-flight optimistic mutations (captures live in the journal). */
  pendingMutations: Record<string, true>;
}

export interface DomainStoreHandle {
  store: StoreApi<DomainStoreState>;
  /** The underlying journal (exposed for tests and advanced wiring). */
  journal: Journal;
  /** Unsubscribe from the seam event stream. Does not reset state. */
  dispose(): void;
}

/**
 * Create the domain store and (when a seam is given) subscribe it to the
 * durable event stream. Pass no seam to drive `applyEvent` manually.
 */
export function createDomainStore(seam?: DomainEventSource): DomainStoreHandle {
  const journal = createJournal();

  const store = createStore<DomainStoreState>()((set, get) => ({
    ...initialDomainState(),
    pendingMutations: {},

    ingestSummaries: (list) => set((state) => ingestSummaries(state, list)),
    ingestDetail: (detail) => set((state) => ingestDetail(state, detail)),
    ingestMessages: (anchorId, messages) => set((state) => ingestMessages(state, anchorId, messages)),
    ingestNotifications: (items) => set((state) => ingestNotifications(state, items)),
    ingestMenu: (spaceId, menu) => set((state) => {
      if (menu === null) {
        // C-4: null means "use the shipped default" — nothing to cache.
        if (!(spaceId in state.menuBySpace)) return {};
        const menuBySpace = { ...state.menuBySpace };
        delete menuBySpace[spaceId];
        return { menuBySpace };
      }
      return { menuBySpace: { ...state.menuBySpace, [spaceId]: menu } };
    }),
    ingestDelivery: (messageId, records) => set((state) => ingestDelivery(state, messageId, records)),
    ingestHandoffs: (workSessionId, handoffs) => set((state) => ingestHandoffs(state, workSessionId, handoffs)),

    applyEvent: (e) => {
      set((state) => reduceEvent(state, e));
      // Any event echoing a journaled clientMutationId reconciles it —
      // idempotent, first-wins with the CommandResult path (LLD §7).
      if (e.clientMutationId) get().reconcile(e.clientMutationId);
    },

    applyOptimistic: (clientMutationId, patches) => {
      const current = get();
      journal.applyOptimistic(clientMutationId, patches, (id) => current.entities[id]);
      set((state) => {
        let entities = state.entities;
        let details = state.details;
        for (const patch of patches) {
          const merged = mergeSummary({ entities, details }, patch);
          entities = merged.entities;
          details = merged.details ?? details;
        }
        return {
          entities,
          details,
          pendingMutations: { ...state.pendingMutations, [clientMutationId]: true },
        };
      });
    },

    reconcile: (clientMutationId) => {
      journal.reconcile(clientMutationId);
      set((state) => {
        if (!state.pendingMutations[clientMutationId]) return {};
        const pendingMutations = { ...state.pendingMutations };
        delete pendingMutations[clientMutationId];
        return { pendingMutations };
      });
    },

    rollback: (clientMutationId) => {
      const instructions = journal.rollback(clientMutationId);
      set((state) => {
        let entities = state.entities;
        let details = state.details;
        for (const inst of instructions) {
          if (inst.kind === 'remove') {
            const e = { ...entities };
            delete e[inst.id];
            entities = e;
            if (details[inst.id]) {
              const d = { ...details };
              delete d[inst.id];
              details = d;
            }
          } else {
            const merged = mergeSummary({ entities, details }, inst.summary);
            entities = merged.entities;
            details = merged.details ?? details;
          }
        }
        const pendingMutations = { ...state.pendingMutations };
        delete pendingMutations[clientMutationId];
        return { entities, details, pendingMutations };
      });
    },

    clearConnectionsStale: (id) => set((state) => {
      if (!state.staleConnections[id]) return {};
      const staleConnections = { ...state.staleConnections };
      delete staleConnections[id];
      return { staleConnections };
    }),

    reset: () => {
      journal.clear();
      set({ ...initialDomainState(), pendingMutations: {} });
    },
  }));

  let unsubscribe: Unsubscribe | null = null;
  if (seam) {
    unsubscribe = seam.onEvent((e) => store.getState().applyEvent(e));
  }

  return {
    store,
    journal,
    dispose: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

// --- narrow selector helpers (mirroring collab-v2 graph.ts) -----------------

export const selectEntity = (id: EntityId) => (s: DomainStoreState): EntitySummary | undefined =>
  s.entities[id];
export const selectDetail = (id: EntityId) => (s: DomainStoreState): EntityDetail | undefined =>
  s.details[id];
export const selectMessages = (anchorId: EntityId) => (s: DomainStoreState): MessageView[] | undefined =>
  s.messagesByAnchor[anchorId];
export const selectEdgesOf = (id: EntityId) => (s: DomainStoreState): EdgeView[] =>
  (s.edgeIdsByEntity[id] ?? []).map((eid) => s.edges[eid]).filter((e): e is EdgeView => e != null);
export const selectActivityFeed = (s: DomainStoreState): ActivityItem[] => s.activityFeed;
export const selectUnreadNotificationCount = (s: DomainStoreState): number =>
  s.notifications.filter((n) => n.readAt == null).length;
/** `undefined` ⇒ no server menu cached — the UI substitutes its shipped default (C-4). */
export const selectMenu = (spaceId: SpaceId) => (s: DomainStoreState): MenuConfig | undefined =>
  s.menuBySpace[spaceId];
export const selectSpaceSettings = (spaceId: SpaceId) => (s: DomainStoreState): SpaceSettings | undefined =>
  s.settingsBySpace[spaceId];
export const selectDeliveryOf = (messageId: EntityId) => (s: DomainStoreState): MessageDeliveryRecord[] =>
  s.deliveryByMessageId[messageId] ?? [];
export const selectHandoffsOf = (workSessionId: EntityId) => (s: DomainStoreState): HandoffView[] =>
  s.handoffsByWorkSession[workSessionId] ?? [];
export const selectIsPending = (clientMutationId: string) => (s: DomainStoreState): boolean =>
  s.pendingMutations[clientMutationId] === true;
export const selectConnectionsStale = (id: EntityId) => (s: DomainStoreState): boolean =>
  s.staleConnections[id] === true;
