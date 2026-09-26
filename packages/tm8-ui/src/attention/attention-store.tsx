/**
 * THE ATTENTION STORE (Attention v2, chapter 5 "UI: one module").
 *
 * One provider per space, mounted once by the host shell. It holds:
 * - the request ROWS for every open root (`useAttentionPending`: open plus
 *   legacy acknowledged, refetched off the event stream);
 * - the freshest BADGE per entity (from upserts and command responses, see
 *   `attention-broadcast.ts`);
 * - the optimistic overlay the commands write: rows hidden by a Resolve or a
 *   Withdraw, roots hidden by a Resolve, rows seen locally;
 * - the titles of the roots in the queue, hydrated once each.
 *
 * Surfaces read it only through `useAttention()` (or `useAttentionOptional()`
 * in hosts whose tests render without the provider). No surface calls the
 * attention API itself; `attention-api-ban.test.ts` enforces that.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AttentionRequest, EntityAttentionSummary, EntityId, SpaceId } from '@tm8/contract';
import { useAttentionPending } from './useAttentionPending';
import {
  buildQueue,
  chipFromBadge,
  chipFromRows,
  countsOf,
  countsOn,
  groupByRoot,
  maxLevelOf,
  requestsOn,
  requestsRaisedBy,
} from './attention-selectors';
import type {
  AttentionChip,
  AttentionCounts,
  AttentionFilter,
  AttentionQueueRow,
  EntityName,
} from './attention-selectors';
import { badgeOf, createAttentionCommands } from './attention-commands';
import type { AttentionCommands, AttentionSeam, AttentionUndo } from './attention-commands';
import { subscribeAttentionBroadcast } from './attention-broadcast';

/** Anything a surface holds for an entity: a summary, a list row, a graph node. */
export interface AttentionEntityRef {
  id: EntityId | string;
  badges?: { attention?: EntityAttentionSummary | null } | null;
}

export interface AttentionApi extends AttentionCommands {
  status: 'loading' | 'ready' | 'error';
  /** The chip for an entity: its own and rolled-up requests. Null when nothing is pending. */
  chipFor(entity: AttentionEntityRef): AttentionChip | null;
  /** The F1 "waiting on you" marker for a session or chat: requests it raised, wherever pinned. */
  raisedChipFor(sessionOrChatId: EntityId | string): AttentionChip | null;
  counts(): AttentionCounts;
  queue(filter: AttentionFilter): readonly AttentionQueueRow[];
  /** Pending requests on `root` (own and rolled up), newest first. */
  requestsFor(root: EntityId | string): readonly AttentionRequest[];
  /** The live Undo offer after a Resolve, or null. */
  undo: AttentionUndo | null;
  /** The last command failure, shown by the toast; cleared by the next command. */
  error: string | null;
  refresh(): void;
}

const AttentionContext = createContext<AttentionApi | null>(null);

export function useAttention(): AttentionApi {
  const api = useContext(AttentionContext);
  if (!api) throw new Error('useAttention() needs an <AttentionProvider> above it');
  return api;
}

/** For hosts whose tests render without the provider: null there, render nothing. */
export function useAttentionOptional(): AttentionApi | null {
  return useContext(AttentionContext);
}

/** Inject a ready-made api: for tests, and for any host that already has one. */
export function AttentionApiProvider({ api, children }: { api: AttentionApi; children?: ReactNode }) {
  return <AttentionContext.Provider value={api}>{children}</AttentionContext.Provider>;
}

export interface AttentionProviderProps {
  seam: AttentionSeam;
  spaceId: SpaceId | string | null | undefined;
  /** The viewer's member id: "mine" is requests assigned to it. */
  viewerId?: string | null;
  /** The notification hook point (Q19): called when the counts change. */
  onCountsChange?(counts: AttentionCounts): void;
  /** Test seams. */
  now?: () => number;
  newId?: () => string;
  delayMs?: number;
  children?: ReactNode;
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

export function AttentionProvider(props: AttentionProviderProps) {
  const { seam, viewerId = null, onCountsChange, children } = props;
  const spaceId = (props.spaceId ?? null) as SpaceId | null;
  const now = props.now ?? Date.now;
  const newId = props.newId ?? uuid;
  const pending = useAttentionPending(seam, spaceId, props.delayMs !== undefined ? { delayMs: props.delayMs } : {});

  const [badges, setBadges] = useState<ReadonlyMap<string, EntityAttentionSummary | null>>(new Map());
  const [hiddenRows, setHiddenRows] = useState<ReadonlySet<string>>(new Set());
  const [hiddenRoots, setHiddenRoots] = useState<ReadonlySet<string>>(new Set());
  const [seenRows, setSeenRows] = useState<ReadonlySet<string>>(new Set());
  const [names, setNames] = useState<ReadonlyMap<EntityId, EntityName>>(new Map());
  const [undo, setUndoState] = useState<AttentionUndo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new space starts clean.
  useEffect(() => {
    setBadges(new Map());
    setHiddenRows(new Set());
    setHiddenRoots(new Set());
    setSeenRows(new Set());
    setNames(new Map());
    setUndoState(null);
    setError(null);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    return subscribeAttentionBroadcast(seam, spaceId, {
      setBadge: (id, badge) => setBadges((current) => new Map(current).set(id, badge)),
      clearBadges: () => setBadges(new Map()),
    });
  }, [seam, spaceId]);

  /** Pending rows with the optimistic overlay applied. */
  const rows = useMemo<readonly AttentionRequest[]>(() => {
    if (pending.state.phase !== 'ready') return [];
    return pending.state.rows
      .filter((row) => !hiddenRows.has(row.id))
      .map((row) => (seenRows.has(row.id) && row.seenByMe !== true ? { ...row, seenByMe: true } : row));
  }, [pending.state, hiddenRows, seenRows]);

  const byRoot = useMemo(() => groupByRoot(rows), [rows]);

  // Hydrate root titles, once per root.
  const asked = useRef<Set<string>>(new Set());
  useEffect(() => {
    asked.current = new Set();
  }, [seam, spaceId]);
  useEffect(() => {
    for (const rootId of byRoot.keys()) {
      if (asked.current.has(rootId)) continue;
      asked.current.add(rootId);
      void seam.entity(rootId).then(
        (detail) => setNames((current) => new Map(current).set(rootId, {
          title: detail.title,
          kind: detail.state.kind,
        })),
        () => { /* An unreadable root shows its id; there is nothing better to say. */ },
      );
    }
  }, [seam, byRoot]);

  // Latest values for the commands, which must not change identity per render.
  const live = useRef({ rows, undo });
  live.current = { rows, undo };

  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setUndo = useCallback((next: AttentionUndo | null) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = null;
    live.current.undo = next;
    setUndoState(next);
    if (next) {
      undoTimer.current = setTimeout(() => {
        undoTimer.current = null;
        live.current.undo = null;
        setUndoState(null);
      }, Math.max(0, next.expiresAt - now()));
    }
  }, [now]);
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, []);

  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showError = useCallback((message: string | null) => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = null;
    setError(message);
    if (message) errorTimer.current = setTimeout(() => setError(null), 8_000);
  }, []);
  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  const refresh = pending.refresh;
  const commands = useMemo(() => createAttentionCommands({
    seam,
    rowsOn: (entityId) => requestsOn(live.current.rows, entityId),
    rowById: (id) => live.current.rows.find((row) => row.id === id),
    hideRows: (ids, rootId) => {
      setHiddenRows((current) => new Set([...current, ...ids]));
      if (rootId) setHiddenRoots((current) => new Set(current).add(rootId));
    },
    showRows: (ids, rootId) => {
      setHiddenRows((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      if (rootId) {
        setHiddenRoots((current) => {
          const next = new Set(current);
          next.delete(rootId);
          return next;
        });
      }
    },
    markSeenLocally: (ids) => setSeenRows((current) => new Set([...current, ...ids])),
    applyResult: (result) => {
      const id = result.entity.id as string;
      setBadges((current) => new Map(current).set(id, badgeOf(result.entity)));
      // The server has spoken for this root: its badge is now the answer, so
      // the optimistic hide is no longer needed (and must not outlive a new
      // request arriving later).
      setHiddenRoots((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    },
    setUndo,
    currentUndo: () => live.current.undo,
    setError: showError,
    refresh,
    now,
    newId,
  }), [seam, setUndo, showError, refresh, now, newId]);

  const api = useMemo<AttentionApi>(() => ({
    ...commands,
    status: pending.state.phase,
    chipFor(entity) {
      const id = String(entity.id);
      if (hiddenRoots.has(id)) return null;
      const here = rows.filter((row) => countsOn(row, id as EntityId));
      // The freshest badge wins: an upsert or command response over the host's
      // summary. A ref with no badge at all (a bare id) falls back to the rows.
      const badge = badges.has(id) ? badges.get(id) : entity.badges?.attention;
      if (badge === undefined) return chipFromRows(here);
      return chipFromBadge(badge, maxLevelOf(here));
    },
    raisedChipFor(sessionOrChatId) {
      return chipFromRows(requestsRaisedBy(rows, sessionOrChatId as EntityId));
    },
    counts() {
      const visible = new Map([...byRoot].filter(([root]) => !hiddenRoots.has(root)));
      return countsOf(visible, viewerId);
    },
    queue(filter) {
      const visible = new Map([...byRoot].filter(([root]) => !hiddenRoots.has(root)));
      return buildQueue(visible, { filter, viewerId, names });
    },
    requestsFor(root) {
      if (hiddenRoots.has(String(root))) return [];
      return requestsOn(rows, root as EntityId);
    },
    undo,
    error,
    refresh,
  }), [commands, pending.state.phase, rows, byRoot, badges, hiddenRoots, names, viewerId, undo, error, refresh]);

  const counts = api.counts();
  useEffect(() => {
    onCountsChange?.(counts);
  }, [counts.mine, counts.all]); // eslint-disable-line react-hooks/exhaustive-deps

  return <AttentionContext.Provider value={api}>{children}</AttentionContext.Provider>;
}
