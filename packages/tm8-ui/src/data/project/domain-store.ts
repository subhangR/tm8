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
  CollectionQuery,
  Connections,
  DurableWorkspaceEvent,
  EdgeGroup,
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
  ingestEdges,
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
  ingestEdges(list: EdgeView[]): void;
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
    ingestEdges: (list) => set((state) => ingestEdges(state, list)),
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

// --- live membership: does an event-arrived entity belong in a cached list? --

/**
 * THREE ANSWERS, AND THE THIRD ONE IS THE POINT.
 *
 * The event stream delivers whole `EntitySummary` rows, so when a task is
 * created the client HAS it — but a list on screen was produced by a filtered
 * server query, and putting the new row into that list means deciding whether
 * the server would have returned it. Two of the three answers are cheap; the
 * third is the honest one:
 *
 *   'in'      — every clause of the filter is one this module evaluates, and
 *               the row satisfies all of them. Safe to show.
 *   'out'     — some clause is evaluable and the row fails it. Safe to hide,
 *               and this is what makes a task LEAVE the Open list the moment
 *               it is marked done, without a refresh.
 *   'unknown' — the filter contains a clause this module cannot evaluate from
 *               a summary (`readyToPull`, `axes`, `edge`, the actor-scoped
 *               presets). NOT a guess in either direction: the list keeps
 *               exactly what the server gave it, and a new row simply does not
 *               appear there until the next real read. A wrong 'in' would put
 *               a task in a tier it is not in, which is the same class of lie
 *               as inventing the row outright.
 *
 * The clause semantics are MEASURED off the server, not assumed:
 *   · a missing `deleted` clause means 'exclude' — `collections.ts:248` reads
 *     `f.deleted ?? 'exclude'`, so the unfiltered list is not "everything";
 *   · a NULL state axis never matches a status filter (contract §CollectionQuery
 *     on `sessionStatus`), so a doc is 'out' of `workStatus: ['open']` rather
 *     than being waved through.
 *
 * NO KIND LITERAL LIVES HERE. `workStatus` and `status` are STATE FIELD names
 * read structurally off `EntityState`; which kinds carry them is the
 * registry's business and never this function's.
 */
export type Membership = 'in' | 'out' | 'unknown';

/** The filter clauses this module can decide. Everything else ⇒ 'unknown'. */
const DECIDABLE_CLAUSES = new Set(['deleted', 'workStatus', 'sessionStatus']);

export function membershipOf(filter: unknown, summary: EntitySummary): Membership {
  const clauses: Record<string, unknown> =
    filter && typeof filter === 'object' ? (filter as Record<string, unknown>) : {};

  for (const name of Object.keys(clauses)) {
    if (clauses[name] === undefined) continue;
    if (!DECIDABLE_CLAUSES.has(name)) return 'unknown';
  }

  // `deleted` defaults to 'exclude' server-side, so the clause is evaluated
  // whether or not the caller wrote one.
  const deleted = clauses.deleted ?? 'exclude';
  if (deleted === 'exclude' && summary.deletedAt !== null) return 'out';
  if (deleted === 'only' && summary.deletedAt === null) return 'out';

  const state = summary.state as unknown as Record<string, unknown>;
  if (!matchesAxis(clauses.workStatus, state.workStatus)) return 'out';
  if (!matchesAxis(clauses.sessionStatus, state.status)) return 'out';

  return 'in';
}

/** A status clause: absent ⇒ no constraint; present ⇒ the row's axis must
    exist and be listed. A null axis never matches, per the contract. */
function matchesAxis(clause: unknown, value: unknown): boolean {
  if (clause === undefined) return true;
  const wanted = Array.isArray(clause) ? clause : [clause];
  if (wanted.length === 0) return true;
  if (typeof value !== 'string') return false;
  return wanted.includes(value);
}

export interface RowProjection {
  /** The ids the last real read returned for this (kind, filter), in order. */
  ordered: readonly EntityId[];
  /** The store's entity table — the event stream's own projection. */
  entities: Readonly<Record<EntityId, EntitySummary>>;
  kind: string;
  spaceId: SpaceId;
  filter: unknown;
  /**
   * The sort the READ was issued under. Absent ⇒ the server's own default,
   * which is what an unsorted request receives.
   */
  sort?: CollectionQuery['sort'];
}

// ---------------------------------------------------------------------------
// Ordering — a mirror of the server's, not an invention
// ---------------------------------------------------------------------------

/** The server's default when a query carries no sort (`collections.ts`). */
const DEFAULT_SORT: NonNullable<CollectionQuery['sort']> = 'activityAt_desc';

/** `coalesce(t.due_date, '9999-12-31')` — the sentinel that sorts nulls last. */
const NO_DUE_DATE = '9999-12-31';

/** `case t.priority when 'urgent' then 0 … else 3 end`, verbatim. */
const PRIORITY_RANK: Readonly<Record<string, number>> = {
  urgent: 0, high: 1, medium: 2,
};

/**
 * The value each sort orders by, and its direction — one entry per member of
 * `CollectionQuery['sort']`, each mirroring that sort's SQL expression in
 * `handlers/collections.ts`. A row's state field is read structurally, exactly
 * as `membershipOf` does: `priority`/`dueDate` are NULL for every non-task row
 * server-side, and `undefined` here lands on the same sentinel.
 */
const ORDERINGS: Record<
  NonNullable<CollectionQuery['sort']>,
  { readonly of: (row: EntitySummary) => string | number; readonly dir: 1 | -1 }
> = {
  activityAt_desc: { of: (r) => r.activityAt, dir: -1 },
  updatedAt_desc: { of: (r) => r.updatedAt, dir: -1 },
  createdAt_desc: { of: (r) => r.createdAt, dir: -1 },
  position: { of: (r) => r.position, dir: 1 },
  dueDate: {
    of: (r) => {
      const due = (r.state as unknown as Record<string, unknown>).dueDate;
      return typeof due === 'string' ? due : NO_DUE_DATE;
    },
    dir: 1,
  },
  priority: {
    of: (r) => {
      const value = (r.state as unknown as Record<string, unknown>).priority;
      return (typeof value === 'string' ? PRIORITY_RANK[value] : undefined) ?? 3;
    },
    dir: 1,
  },
};

/**
 * The comparator the server paged by, including its tiebreak.
 *
 * The tiebreak is `e.id ${dir}` — the SAME direction as the sort, because the
 * keyset comparison is a row comparison `(sortValue, id) < (…)`. Breaking ties
 * ascending under a descending sort would put two rows sharing a timestamp in
 * an order no page boundary agrees with.
 */
export function compareBySort(
  sort: CollectionQuery['sort'],
): (a: EntitySummary, b: EntitySummary) => number {
  const ordering = ORDERINGS[sort ?? DEFAULT_SORT] ?? ORDERINGS[DEFAULT_SORT];
  return (a, b) => {
    const left = ordering.of(a);
    const right = ordering.of(b);
    if (left < right) return -ordering.dir;
    if (left > right) return ordering.dir;
    return a.id < b.id ? -ordering.dir : a.id > b.id ? ordering.dir : 0;
  };
}

/**
 * THE LIVE LIST — a server-ordered read, kept current by the event stream.
 *
 * This is the whole create → event → screen loop in one pure function, and it
 * is pure precisely so the loop can be asserted without a browser, a socket or
 * a React tree.
 *
 * THREE THINGS HAPPEN, and each answers a different way a list goes stale:
 *
 *  1. **Every row is re-read from the store.** `ordered` holds ids, never
 *     summaries, so a row someone else renamed shows the new title on the next
 *     event — the list is a view over the projection, not a snapshot beside it.
 *  2. **Rows the filter now excludes LEAVE.** A task marked done drops out of
 *     Open by itself. Only an evaluable 'out' removes anything: 'unknown'
 *     keeps the server's answer, so a filter this module cannot read can never
 *     silently empty a panel.
 *  3. **Rows the store knows and the read never saw ARRIVE, IN SORT ORDER.**
 *     That is the created task appearing without a refresh. Its position is
 *     the READ'S OWN SORT applied locally (`compareBySort`, a mirror of the
 *     server's `SORTS` table) — not a preference, and no longer the fixed
 *     head-insert that was only correct while `activityAt_desc` was the only
 *     order this app could ask for. Under `dueDate` a new task with no due
 *     date now lands where the server would have put it: last.
 *
 * PAGINATION IS A NARROWER HOLE THAN IT WAS: `ordered` may be several pages,
 * but it is still a PREFIX of the full result. An arrival that belongs after
 * everything loaded is shown at the tail, which is where it belongs among the
 * rows on screen — it is only wrong relative to rows nobody has fetched.
 */
export function projectRows(input: RowProjection): EntitySummary[] {
  const { ordered, entities, kind, spaceId, filter, sort } = input;

  const seen = new Set<EntityId>(ordered);
  const base: EntitySummary[] = [];
  for (const id of ordered) {
    const row = entities[id];
    // An id with no summary is one the store has never been told about; keep
    // nothing rather than an empty shell. (Every read ingests, so this is the
    // transient window between a read landing and its ingest, not a leak.)
    if (!row) continue;
    if (membershipOf(filter, row) === 'out') continue;
    base.push(row);
  }

  const compare = compareBySort(sort);
  const arrived = Object.values(entities)
    .filter(
      (e) =>
        !seen.has(e.id) &&
        e.kind === kind &&
        e.spaceId === spaceId &&
        membershipOf(filter, e) === 'in',
    )
    .sort(compare);

  if (arrived.length === 0) return base;

  // A merge, not a concat: `base` is already in this order (the server sorted
  // it), so each arrival slots in at its own place rather than displacing the
  // whole page. Stable on ties — `compare`'s id tiebreak decides those.
  const out: EntitySummary[] = [];
  let i = 0;
  for (const row of base) {
    while (i < arrived.length && compare(arrived[i]!, row) <= 0) out.push(arrived[i++]!);
    out.push(row);
  }
  while (i < arrived.length) out.push(arrived[i++]!);
  return out;
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

/** Same presentation vocabulary as the entity-detail read. A live edge event
    has no group label of its own, so a type absent from the old snapshot needs
    this mapping to render identically to a fresh read. */
const LIVE_EDGE_LABELS: Readonly<Record<string, string>> = {
  assigned_to: 'Assigned to',
  attached_to: 'Attached to',
  depends_on: 'Depends on',
  completed_by: 'Completed by',
  tracks: 'Tracks',
  relates_to: 'Relates to',
  contains: 'Contains',
  working_on: 'Working on',
  pulled: 'Pulled by',
  equips: 'Equips',
  member_of: 'Member of',
  copy_of: 'Copy of',
  approved_by: 'Approved by',
  approval_requested_from: 'Approval requested from',
  visible_to: 'Visible to',
};

/**
 * The live connection view for one hydrated entity.
 *
 * `EntityDetail.connections` is a read-time snapshot. Its edges are ingested
 * into the normalized edge family above, and this selector groups that family
 * on every store update, so edge.upsert/edge.deleted events reach an already
 * open Connections tab without another entity read.
 */
export const selectConnectionsOf = (id: EntityId) => (s: DomainStoreState): Connections | undefined => {
  const detail = s.details[id];
  if (!detail) return undefined;

  const snapshotGroups = [
    ...(detail.connections?.outgoing ?? []),
    ...(detail.connections?.incoming ?? []),
  ];
  const labelOf = (type: string, direction: EdgeGroup['direction']): string => {
    const snapshot = snapshotGroups.find((group) => group.type === type && group.direction === direction);
    if (snapshot) return snapshot.label;
    return LIVE_EDGE_LABELS[type] ?? (direction === 'outgoing' ? type : `${type} (incoming)`);
  };

  const grouped = new Map<string, EdgeGroup>();
  for (const edge of selectEdgesOf(id)(s)) {
    const direction: EdgeGroup['direction'] = edge.source.id === id ? 'outgoing' : 'incoming';
    // Match the server: a self-edge is represented once, as outgoing.
    if (direction === 'incoming' && edge.target.id !== id) continue;
    const key = `${direction}:${edge.type}`;
    const existing = grouped.get(key);
    if (existing) existing.edges.push(edge);
    else grouped.set(key, { type: edge.type, direction, label: labelOf(edge.type, direction), edges: [edge] });
  }

  const groups = [...grouped.values()];
  return {
    outgoing: groups.filter((group) => group.direction === 'outgoing'),
    incoming: groups.filter((group) => group.direction === 'incoming'),
    unresolvedHardDependencyCount: selectEdgesOf(id)(s).filter(
      (edge) => edge.source.id === id && edge.type === 'depends_on' && edge.hard !== false && edge.resolved === false,
    ).length,
  };
};
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
