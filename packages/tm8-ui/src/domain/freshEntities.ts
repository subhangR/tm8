/**
 * Which entities were born — or died — in front of this page, and how long ago.
 *
 * Subhang: "any entity that gets created, if it's in the view, shows a glow,
 * and it fades over time" — and "similarly for deletion". This store answers
 * exactly that question for every item surface (list rows, tiles, tabs, the
 * start surface, graph nodes) so none of them grows a private notion of "new".
 *
 * WHY NOT THE DOMAIN STORE. The domain store reduces the transience away: it
 * answers "this entity exists", and the glow needs "this entity appeared
 * thirty seconds ago". Same reasoning as `panels/list/useMessagePulses.ts`,
 * which is the other raw consumer of `seam.onEvent`.
 *
 * WHAT COUNTS AS A BIRTH. An `entity.upsert` whose server-side `occurredAt`
 * sits within `CREATION_EVENT_SLACK_MS` of the entity's own `createdAt` — the
 * creation's own upsert, not a later edit of an old row. Both stamps are on the
 * server's clock, so the test is immune to a skewed client clock. Initial
 * loads, restores and hydration never pass through `seam.onEvent` (the
 * connection resumes at the high-water mark), so a page load lights nothing.
 * Entities this browser created arrive on the same stream and count too.
 *
 * WHY THE SKEW ESTIMATE. A reconnect replays the events missed while offline,
 * and a row created twenty minutes ago must not light up on reconnect. The
 * event's age is judged as `(now - occurredAt) - skew`, where `skew` is the
 * smallest lag ever observed: live events arrive with near-zero latency, so
 * the minimum converges on the clock offset and a backfilled event reads old.
 * Lifetimes then run on the client clock from the corrected birth time, so a
 * row mounting mid-way picks up the fade where it is.
 */
import type { DurableWorkspaceEvent } from '@tm8/contract';

/** The whole glow: hold, then fade to nothing. */
export const FRESH_MS = 30_000;
/** Full strength before the fade starts (Design Advisor R40). */
export const FRESH_HOLD_MS = 2_000;
/** A live-deleted item's exit: 800ms hold, then 1200ms fade and collapse (R41). */
export const LEAVING_MS = 2_000;
/** Under reduced motion: a static tint and strike, then removal (R41). */
export const LEAVING_REDUCED_MS = 1_000;
/** How far apart a creation's upsert and its `createdAt` may be. */
export const CREATION_EVENT_SLACK_MS = 5_000;

export type FreshPhase = 'fresh' | 'leaving';

/** One live entry. Identity is stable for its lifetime (a snapshot for useSyncExternalStore). */
export interface FreshEntry {
  readonly id: string;
  readonly phase: FreshPhase;
  /** Client-clock start of the phase. */
  readonly startedAt: number;
  /** Client-clock end of the phase; the entry is gone after it. */
  readonly endsAt: number;
}

export interface FreshTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FreshEntityStoreOptions {
  now?: () => number;
  timers?: FreshTimers;
  /** Reduced motion shortens the exit. Defaults to the media query. */
  reducedMotion?: () => boolean;
}

type Listener = () => void;

export interface FreshEntityStore {
  /** Feed one event from the live stream. */
  observe(event: DurableWorkspaceEvent): void;
  /** Feed the live stream: returns the unsubscribe. */
  attach(source: { onEvent(cb: (e: DurableWorkspaceEvent) => void): () => void }): () => void;
  entryOf(id: string): FreshEntry | undefined;
  /** Ids currently leaving — for surfaces that keep a vanished row on screen. */
  isLeaving(id: string): boolean;
  subscribe(id: string, listener: Listener): () => void;
  /** Any change at all (surfaces retaining leaving rows listen to this). */
  subscribeAll(listener: Listener): () => void;
  /** Bumped on every change: the snapshot for `subscribeAll`. */
  version(): number;
  now(): number;
  reset(): void;
}

const realTimers: FreshTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function createFreshEntityStore(options: FreshEntityStoreOptions = {}): FreshEntityStore {
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? realTimers;
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion;
  const entries = new Map<string, FreshEntry>();
  const expiries = new Map<string, unknown>();
  const listeners = new Map<string, Set<Listener>>();
  const allListeners = new Set<Listener>();
  /** Smallest (client now - server occurredAt) seen: the clock offset plus ~0 latency. */
  let skew: number | null = null;
  let version = 0;

  const notify = (id: string) => {
    version += 1;
    for (const listener of listeners.get(id) ?? []) listener();
    for (const listener of allListeners) listener();
  };

  const remove = (id: string, entry: FreshEntry) => {
    if (entries.get(id) !== entry) return;
    entries.delete(id);
    expiries.delete(id);
    notify(id);
  };

  const put = (entry: FreshEntry) => {
    const at = now();
    if (entry.endsAt <= at) return;
    const held = expiries.get(entry.id);
    if (held !== undefined) timers.clearTimeout(held);
    entries.set(entry.id, entry);
    expiries.set(entry.id, timers.setTimeout(() => remove(entry.id, entry), entry.endsAt - at));
    notify(entry.id);
  };

  const observe = (event: DurableWorkspaceEvent) => {
    if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
    const at = now();
    const occurredAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredAt)) return;
    const lag = at - occurredAt;
    skew = skew === null ? lag : Math.min(skew, lag);
    const id = event.entity.id;

    if (event.type === 'entity.deleted') {
      const age = Math.max(0, lag - skew);
      if (age >= LEAVING_MS || entries.get(id)?.phase === 'leaving') return;
      const startedAt = at - age;
      const duration = reducedMotion() ? LEAVING_REDUCED_MS : LEAVING_MS;
      put({ id, phase: 'leaving', startedAt, endsAt: startedAt + duration });
      return;
    }

    if (entries.has(id)) return;
    const createdAt = Date.parse(event.entity.createdAt);
    if (!Number.isFinite(createdAt)) return;
    if (Math.abs(occurredAt - createdAt) > CREATION_EVENT_SLACK_MS) return;
    const bornAgo = Math.max(0, at - skew - createdAt);
    if (bornAgo >= FRESH_MS) return;
    const startedAt = at - bornAgo;
    put({ id, phase: 'fresh', startedAt, endsAt: startedAt + FRESH_MS });
  };

  return {
    observe,
    attach(source) {
      return source.onEvent(observe);
    },
    entryOf: (id) => entries.get(id),
    isLeaving: (id) => entries.get(id)?.phase === 'leaving',
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(listener);
      return () => {
        set!.delete(listener);
        if (set!.size === 0 && listeners.get(id) === set) listeners.delete(id);
      };
    },
    subscribeAll(listener) {
      allListeners.add(listener);
      return () => allListeners.delete(listener);
    },
    version: () => version,
    now,
    reset() {
      for (const handle of expiries.values()) timers.clearTimeout(handle);
      const ids = [...entries.keys()];
      entries.clear();
      expiries.clear();
      skew = null;
      for (const id of ids) notify(id);
    },
  };
}

/** The page's one store. The live stream is attached once, by `useGateData`. */
export const freshEntities: FreshEntityStore = createFreshEntityStore();
