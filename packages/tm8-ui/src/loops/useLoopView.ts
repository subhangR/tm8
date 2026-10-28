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
  inflight: Promise<void> | null;
}

const entries = new Map<string, Entry>();
const EMPTY: LoopPageSlot = { view: null, error: null, loading: true, runsEpoch: 0 };

function entry(loopId: string): Entry {
  let found = entries.get(loopId);
  if (!found) {
    found = { slot: EMPTY, listeners: new Set(), readFor: null, inflight: null };
    entries.set(loopId, found);
  }
  return found;
}

function write(loopId: string, next: Partial<LoopPageSlot>): void {
  const e = entry(loopId);
  e.slot = { ...e.slot, ...next };
  for (const listener of e.listeners) listener();
}

function read(port: LoopPagePort, loopId: string): Promise<void> {
  const e = entry(loopId);
  if (e.inflight) return e.inflight;
  write(loopId, { loading: true });
  e.inflight = port.get(loopId).then(
    (view) => { write(loopId, { view, error: null, loading: false }); },
    (error: unknown) => { write(loopId, { error, loading: false }); },
  ).finally(() => { e.inflight = null; });
  return e.inflight;
}

/** Test seam only. */
export function resetLoopPageStore(): void {
  entries.clear();
}

export function useLoopView(port: LoopPagePort | null | undefined, loopId: string, detailVersion: number) {
  const subscribe = useCallback((listener: () => void) => {
    const e = entry(loopId);
    e.listeners.add(listener);
    return () => { e.listeners.delete(listener); };
  }, [loopId]);
  const slot = useSyncExternalStore(subscribe, () => entry(loopId).slot, () => EMPTY);

  useEffect(() => {
    if (!port) return;
    const e = entry(loopId);
    if (e.readFor === detailVersion) return;
    e.readFor = detailVersion;
    void read(port, loopId);
  }, [port, loopId, detailVersion]);

  const reload = useCallback(() => (port ? read(port, loopId) : Promise.resolve()), [port, loopId]);
  const setView = useCallback((view: LoopView) => write(loopId, { view, error: null, loading: false }), [loopId]);
  const bumpRuns = useCallback(() => write(loopId, { runsEpoch: entry(loopId).slot.runsEpoch + 1 }), [loopId]);
  return { ...slot, reload, setView, bumpRuns };
}
