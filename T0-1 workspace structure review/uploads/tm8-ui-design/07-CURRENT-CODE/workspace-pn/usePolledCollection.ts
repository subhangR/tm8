/**
 * ONE POLL PER DATA CLASS — the workspace's shared refresh primitive.
 *
 * WHY THIS EXISTS. The workspace mounts three panels at once, and several of
 * them want the same rows: the Terminals tab lists `work_session`s, the center
 * pane needs the open session's status, a header may want a live count. Written
 * the obvious way — a `useEffect` + `setInterval` inside each component — that
 * is N intervals and N HTTP requests for ONE logical question, all landing at
 * slightly different times so the panels disagree with each other on screen.
 * With a handful of sessions and a 1.5s cadence that is a genuine request storm
 * against a node that answers every one of them from Postgres.
 *
 * So subscription is keyed by the QUERY, not by the component. Every consumer of
 * the same key shares one interval, one in-flight request, and one snapshot —
 * which also means they can never render inconsistent views of the same data.
 * The interval starts with the first subscriber and is cleared with the last, so
 * a closed tab genuinely stops polling rather than merely stopping rendering.
 *
 * WHY POLLING AT ALL. There is no live push on this node: `RealFacade.subscribe`
 * is an `EventPoller` over `events.poll` and says so in its own header. Session
 * status is worse than that — it changes WITHOUT emitting a graph event at all
 * (see SessionsScreen's note), so even a perfect event stream would not carry
 * it. Polling is the design here, not a shortcut, and naming the primitive after
 * what it does keeps that honest.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CollectionQuery, EntitySummary } from '../../collab-v2/types/contract';
import type { RealFacade } from '../RealFacade';

/** What every subscriber sees. `items === null` means "first load has not finished". */
export interface PollState {
  items: EntitySummary[] | null;
  error: string | null;
}

interface Entry {
  state: PollState;
  subscribers: Set<(s: PollState) => void>;
  timer: ReturnType<typeof setInterval> | null;
  /** Guards against overlapping requests when the server is slower than the interval. */
  inFlight: boolean;
  /** When the last successful read landed — drives the warm-resubscribe decision. */
  fetchedAt: number;
  /** Eviction timer running while the entry is warm but unsubscribed. */
  evictTimer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, Entry>();

/**
 * How long an unsubscribed entry keeps its data before eviction.
 *
 * THE BUG THIS FIXES, found by the lane's own test. The Resources panel renders
 * only the ACTIVE tab, so Docs and Drawings — which are deliberately one query
 * split by format — never exist at the same moment. Dropping the entry the
 * instant its last subscriber left meant every tab switch threw the rows away,
 * re-fetched them, and flashed "Loading…" at data we already had. Sharing that
 * only works while components overlap is not sharing; it is a cache that
 * evicts exactly when it would have paid off.
 *
 * So the entry OUTLIVES its subscribers by a grace window: polling stops (an
 * unwatched query must not keep costing requests), but the snapshot is kept so
 * coming back is instant.
 */
export const WARM_MS = 60_000;

/**
 * The subscription key. Built from the query rather than passed in by callers so
 * two components asking the same question CANNOT accidentally choose different
 * keys and de-duplicate into two polls — which is the whole bug this file is
 * here to prevent.
 *
 * `JSON.stringify` is safe here because these queries are small, flat, and
 * constructed literal-side in the tabs; key order is stable per call site.
 */
export function queryKey(query: CollectionQuery): string {
  return JSON.stringify(query);
}

function emit(entry: Entry): void {
  for (const cb of entry.subscribers) cb(entry.state);
}

function runFetch(facade: RealFacade, key: string, query: CollectionQuery): void {
  const entry = registry.get(key);
  if (!entry || entry.inFlight) return;
  entry.inFlight = true;
  facade.queryCollection(query).then(
    (result) => {
      const live = registry.get(key);
      if (!live) return; // last subscriber left mid-flight
      live.inFlight = false;
      live.fetchedAt = Date.now();
      live.state = { items: result.page.items, error: null };
      emit(live);
    },
    (err: unknown) => {
      const live = registry.get(key);
      if (!live) return;
      live.inFlight = false;
      // A failed REFRESH must not blank rows the user is already reading — the
      // node dropping one request is not the same statement as "there is
      // nothing here". Keep the last good items and surface the error beside
      // them; only a first-load failure shows an empty errored panel.
      live.state = { items: live.state.items, error: String((err as Error)?.message ?? err) };
      emit(live);
    },
  );
}

/**
 * Subscribe to a polled collection. Returns an unsubscribe.
 *
 * Exported separately from the hook so non-React callers (and tests) can drive
 * the same registry without mounting a component.
 */
export function subscribeCollection(
  facade: RealFacade,
  query: CollectionQuery,
  intervalMs: number,
  cb: (s: PollState) => void,
): () => void {
  const key = queryKey(query);
  let entry = registry.get(key);
  if (!entry) {
    entry = {
      state: { items: null, error: null }, subscribers: new Set(),
      timer: null, inFlight: false, fetchedAt: 0, evictTimer: null,
    };
    registry.set(key, entry);
  }

  // Coming back inside the warm window cancels the eviction — the snapshot is
  // still good, so this resubscribe costs nothing and renders instantly.
  if (entry.evictTimer !== null) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  }

  entry.subscribers.add(cb);
  // Hand the newcomer whatever is already known — a second consumer of a warm
  // key must not have to wait a full interval to render.
  cb(entry.state);

  if (entry.timer === null) {
    // Only re-read if the snapshot is actually STALE. A tab switch moments after
    // a poll would otherwise fire a redundant request for rows that are
    // milliseconds old — which is the duplicate this whole entry exists to avoid.
    if (Date.now() - entry.fetchedAt >= intervalMs) runFetch(facade, key, query);
    entry.timer = setInterval(() => runFetch(facade, key, query), intervalMs);
  }

  return () => {
    const live = registry.get(key);
    if (!live) return;
    live.subscribers.delete(cb);
    if (live.subscribers.size > 0) return;

    // Nobody is watching: stop SPENDING (an unwatched query must not keep
    // issuing requests) but keep the data warm for a quick return.
    if (live.timer !== null) {
      clearInterval(live.timer);
      live.timer = null;
    }
    live.evictTimer = setTimeout(() => registry.delete(key), WARM_MS);
  };
}

/** Force an immediate re-read of a key, out of band from its interval. */
export function refreshCollection(facade: RealFacade, query: CollectionQuery): void {
  runFetch(facade, queryKey(query), query);
}

/**
 * React binding. `query` is serialized into the dep list rather than compared by
 * reference: tabs build their query object inline on every render, so a
 * reference dep would tear down and re-create the subscription each pass —
 * restarting the interval forever and never actually polling.
 */
export function usePolledCollection(
  facade: RealFacade,
  query: CollectionQuery,
  intervalMs: number,
): PollState & { reload: () => void } {
  const [state, setState] = useState<PollState>({ items: null, error: null });
  const key = queryKey(query);

  useEffect(
    () => subscribeCollection(facade, query, intervalMs, setState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facade, key, intervalMs],
  );

  const reload = useCallback(
    () => refreshCollection(facade, query),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facade, key],
  );

  return { ...state, reload };
}

/** Test seam: drop every subscription and timer. */
export function __resetPollRegistry(): void {
  for (const entry of registry.values()) {
    if (entry.timer !== null) clearInterval(entry.timer);
    if (entry.evictTimer !== null) clearTimeout(entry.evictTimer);
  }
  registry.clear();
}
