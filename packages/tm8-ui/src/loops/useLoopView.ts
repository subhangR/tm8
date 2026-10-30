import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { LoopPagePort, LoopView } from './page-port';

/*
 * ONE READ FOR THE WHOLE PAGE. The header and the runs table are separate
 * registry blocks, so each mounts on its own; without a shared slot each
 * would call `loops.get` and they could disagree for a frame about whether
 * the loop is enabled. The slot is keyed by loop id and holds the latest
 * `LoopView` (every `loops.*` command returns one, so a control never needs a
 * second read) plus a `runsEpoch` the runs table watches: Run now and Stop
 * bump it so the table re-reads page one.
 *
 * NEWER WINS. A read answers for the instant it started, so a read already in
 * flight when the loop moved (a firing, a command) is not reused for the new
 * version, a read overtaken by a later one is dropped, and no answer replaces
 * a view of a higher version. The slot lives while a block shows it: the last
 * block to unmount drops it, so reopening re-reads and a stale error does not
 * outlive the page.
 */
export interface LoopPageSlot {
  view: LoopView | null;
  error: unknown;
  loading: boolean;
  runsEpoch: number;
}

interface Entry {
  slot: LoopPageSlot;
  listeners: Set<() => void>;
  /** Detail version the last read was made for — a new version re-reads. */
  readFor: number | null;
  /** The read in flight and the version it was started for (null: a manual reload). */
  inflight: { forVersion: number | null; promise: Promise<void> } | null;
  /** Bumped per read started; only the latest read may write. */
  seq: number;
}

const entries = new Map<string, Entry>();
const EMPTY: LoopPageSlot = { view: null, error: null, loading: true, runsEpoch: 0 };

function entry(loopId: string): Entry {
  let found = entries.get(loopId);
  if (!found) {
    found = { slot: EMPTY, listeners: new Set(), readFor: null, inflight: null, seq: 0 };
    entries.set(loopId, found);
  }
  return found;
}

function write(e: Entry, next: Partial<LoopPageSlot>): void {
  e.slot = { ...e.slot, ...next };
  for (const listener of e.listeners) listener();
}

/** The newer of two reads of one loop; an equal version takes the incoming one. */
function newer(incoming: LoopView, held: LoopView | null): LoopView {
  return held && held.version > incoming.version ? held : incoming;
}

function read(port: LoopPagePort, loopId: string, forVersion: number | null): Promise<void> {
  const e = entry(loopId);
  if (e.inflight && e.inflight.forVersion === forVersion) return e.inflight.promise;
  const mine = ++e.seq;
  write(e, { loading: true });
  const current = () => entries.get(loopId) === e && mine === e.seq;
  const promise = port.get(loopId).then(
    (view) => { if (current()) write(e, { view: newer(view, e.slot.view), error: null, loading: false }); },
    (error: unknown) => { if (current()) write(e, { error, loading: false }); },
  ).finally(() => { if (e.inflight?.promise === promise) e.inflight = null; });
  e.inflight = { forVersion, promise };
  return promise;
}

/** Test seam only. */
export function resetLoopPageStore(): void {
  entries.clear();
}

export function useLoopView(port: LoopPagePort | null | undefined, loopId: string, detailVersion: number) {
  const subscribe = useCallback((listener: () => void) => {
    const e = entry(loopId);
    e.listeners.add(listener);
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0 && entries.get(loopId) === e) entries.delete(loopId);
    };
  }, [loopId]);
  const slot = useSyncExternalStore(subscribe, () => entry(loopId).slot, () => EMPTY);

  useEffect(() => {
    if (!port) return;
    const e = entry(loopId);
    if (e.readFor === detailVersion) return;
    e.readFor = detailVersion;
    // A command already answered with this version (or a newer one): nothing to read.
    if (e.slot.view && e.slot.view.version >= detailVersion) return;
    void read(port, loopId, detailVersion);
  }, [port, loopId, detailVersion]);

  const reload = useCallback(() => (port ? read(port, loopId, null) : Promise.resolve()), [port, loopId]);
  const setView = useCallback((view: LoopView) => {
    const e = entry(loopId);
    write(e, { view: newer(view, e.slot.view), error: null, loading: false });
  }, [loopId]);
  const bumpRuns = useCallback(() => {
    const e = entry(loopId);
    write(e, { runsEpoch: e.slot.runsEpoch + 1 });
  }, [loopId]);
  return { ...slot, reload, setView, bumpRuns };
}
