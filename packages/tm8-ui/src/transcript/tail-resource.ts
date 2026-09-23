/**
 * ONE TAIL READ PER SESSION, however many surfaces are watching it.
 *
 * The newest transcript window — the default read, no cursor and no
 * `files` — is wanted by several surfaces at once: the Transcript tab, the
 * Debug tab, and the context number on the panel bar, which is mounted for
 * as long as the panel is. Each used to own its own `setInterval`, so two
 * surfaces on one live session read the same bytes twice per tick.
 *
 * This store is the one place that read happens:
 *
 *  · KEYED BY (seam, session). The seam is a WeakMap key, so a test's fresh
 *    seam is a fresh store and a dropped seam takes its entries with it.
 *  · BOUNDED. At most one read in flight per session; a refresh asked for
 *    while one is flying joins it. The next poll is scheduled only AFTER the
 *    previous read settles, so a slow node can never stack reads up.
 *  · THE FASTEST SUBSCRIBER SETS THE PACE. Each subscriber names its own
 *    interval (or `null` — read, don't poll); the store polls at the
 *    smallest, and stops entirely when no subscriber is polling.
 *  · NOT WHILE HIDDEN. A backgrounded tab schedules nothing; becoming visible
 *    again reads at once if anyone is polling.
 *  · A FAILED READ NEVER DROPS A PAGE. The last good page is kept, and the
 *    failure is reported beside it with when it happened — so a surface can
 *    say "update delayed" without blanking what it knows.
 *
 * The entry is deleted with its last subscriber: nothing here is a cache that
 * outlives the surfaces using it.
 */
import { useEffect, useRef, useState } from 'react';
import type { EntityId, SessionTranscriptPage } from '@tm8/contract';
import type { Seam } from '../data/seam';

type TranscriptSeam = Pick<Seam, 'transcript'>;

export interface TailSnapshot {
  /** The newest page that landed. Kept across failed reads. */
  page: SessionTranscriptPage | null;
  /** The last read's failure, or null once a read has succeeded since. */
  error: string | null;
  /** Wall-clock ms the current `error` happened at. */
  errorAt: number | null;
  /** Wall-clock ms the current `page` landed at — the poll's time, NOT the sample's. */
  receivedAt: number | null;
}

type Listener = (snapshot: TailSnapshot) => void;

interface Subscriber {
  listener: Listener;
  intervalMs: number | null;
}

interface Entry {
  seam: TranscriptSeam;
  sessionId: EntityId;
  snapshot: TailSnapshot;
  inflight: Promise<void> | null;
  /** When the last read settled, either way — gates the read-on-subscribe. */
  settledAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<Subscriber>;
}

/** A subscriber arriving this soon after a read settled takes that read. */
const FRESH_MS = 1_000;

const stores = new WeakMap<TranscriptSeam, Map<EntityId, Entry>>();
const live = new Set<Entry>();
let watchingVisibility = false;

const EMPTY: TailSnapshot = { page: null, error: null, errorAt: null, receivedAt: null };

function hidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function pace(entry: Entry): number | null {
  let min: number | null = null;
  for (const sub of entry.subscribers) {
    if (sub.intervalMs !== null && (min === null || sub.intervalMs < min)) min = sub.intervalMs;
  }
  return min;
}

function notify(entry: Entry): void {
  for (const sub of [...entry.subscribers]) sub.listener(entry.snapshot);
}

function clearTimer(entry: Entry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

function schedule(entry: Entry): void {
  clearTimer(entry);
  if (entry.inflight !== null || entry.subscribers.size === 0 || hidden()) return;
  const interval = pace(entry);
  if (interval === null) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void read(entry);
  }, interval);
}

function read(entry: Entry): Promise<void> {
  if (entry.inflight) return entry.inflight;
  clearTimer(entry);
  const run = (async () => {
    try {
      const page = await entry.seam.transcript(entry.sessionId);
      entry.snapshot = { page, error: null, errorAt: null, receivedAt: Date.now() };
    } catch (err) {
      entry.snapshot = {
        ...entry.snapshot,
        error: err instanceof Error ? err.message : 'Transcript read failed',
        errorAt: Date.now(),
      };
    } finally {
      entry.settledAt = Date.now();
      entry.inflight = null;
    }
    // Deleted mid-flight: nobody is listening, and nothing should reschedule.
    if (entry.subscribers.size === 0) return;
    notify(entry);
    schedule(entry);
  })();
  entry.inflight = run;
  return run;
}

function onVisibility(): void {
  if (hidden()) {
    for (const entry of live) clearTimer(entry);
    return;
  }
  for (const entry of live) {
    if (pace(entry) !== null) void read(entry);
  }
}

function track(entry: Entry): void {
  live.add(entry);
  if (!watchingVisibility && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    watchingVisibility = true;
  }
}

function untrack(entry: Entry): void {
  live.delete(entry);
  if (live.size === 0 && watchingVisibility) {
    document.removeEventListener('visibilitychange', onVisibility);
    watchingVisibility = false;
  }
}

function entryFor(seam: TranscriptSeam, sessionId: EntityId): Entry {
  let byId = stores.get(seam);
  if (!byId) {
    byId = new Map();
    stores.set(seam, byId);
  }
  let entry = byId.get(sessionId);
  if (!entry) {
    entry = {
      seam,
      sessionId,
      snapshot: EMPTY,
      inflight: null,
      settledAt: 0,
      timer: null,
      subscribers: new Set(),
    };
    byId.set(sessionId, entry);
    track(entry);
  }
  return entry;
}

export interface TailSubscription {
  /**
   * Change this subscriber's pace; `null` stops it asking for polls. When that
   * stops ALL polling, one final read captures the session's last writes —
   * unless `finalRead: false`, for a pause (a reader paging back) rather than
   * an exit, whose result nobody would look at.
   */
  setInterval: (intervalMs: number | null, opts?: { finalRead?: boolean }) => void;
  close: () => void;
}

/**
 * Watch one session's newest window. The listener is called with every
 * settled read, and immediately with what is already held. A read is started
 * unless one is in flight or has only just settled.
 */
export function subscribeTail(
  seam: TranscriptSeam,
  sessionId: EntityId,
  listener: Listener,
  intervalMs: number | null,
): TailSubscription {
  const entry = entryFor(seam, sessionId);
  const sub: Subscriber = { listener, intervalMs };
  entry.subscribers.add(sub);
  if (entry.snapshot !== EMPTY) listener(entry.snapshot);
  if (entry.inflight === null && Date.now() - entry.settledAt >= FRESH_MS) void read(entry);
  else schedule(entry);

  return {
    setInterval: (next, opts) => {
      if (next === sub.intervalMs || !entry.subscribers.has(sub)) return;
      const before = pace(entry);
      sub.intervalMs = next;
      const after = pace(entry);
      if (after === before) return;
      // Polling just STOPPED — typically the session exited. One last read
      // captures what it wrote on the way out; after that it cannot change.
      if (after === null && before !== null) {
        clearTimer(entry);
        if (entry.inflight === null && opts?.finalRead !== false) void read(entry);
        return;
      }
      schedule(entry);
    },
    close: () => {
      if (!entry.subscribers.delete(sub)) return;
      if (entry.subscribers.size > 0) {
        schedule(entry);
        return;
      }
      clearTimer(entry);
      untrack(entry);
      const byId = stores.get(seam);
      if (byId?.get(sessionId) === entry) byId.delete(sessionId);
    },
  };
}

/** Read the newest window now, joining a read already in flight. */
export function refreshTail(seam: TranscriptSeam, sessionId: EntityId): Promise<void> {
  const entry = stores.get(seam)?.get(sessionId);
  return entry ? read(entry) : Promise.resolve();
}

/**
 * The newest window of one session, from the shared read. `intervalMs: null`
 * reads once (and once more when polling stops) — pass the session's own
 * liveness, exactly as for `useSessionTranscript`.
 */
export function useTranscriptTail(
  seam: TranscriptSeam | undefined,
  sessionId: EntityId,
  intervalMs: number | null,
): TailSnapshot {
  const [snapshot, setSnapshot] = useState<TailSnapshot>(EMPTY);
  const sub = useRef<TailSubscription | null>(null);
  const paceRef = useRef(intervalMs);
  paceRef.current = intervalMs;

  useEffect(() => {
    setSnapshot(EMPTY);
    if (!seam) return;
    const s = subscribeTail(seam, sessionId, setSnapshot, paceRef.current);
    sub.current = s;
    return () => {
      sub.current = null;
      s.close();
    };
  }, [seam, sessionId]);

  useEffect(() => {
    sub.current?.setInterval(intervalMs);
  }, [intervalMs]);

  return snapshot;
}
