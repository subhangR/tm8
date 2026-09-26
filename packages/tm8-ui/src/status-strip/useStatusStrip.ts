/**
 * The status strip's two reads, polled while the tab is visible.
 *
 *   HOST     — `seam.nodeMetrics()` (`node.metrics.get`), every HOST_MS. Node
 *              admin only: a `forbidden` answer is PERMANENT for this session
 *              (the gate is the account, not the moment), so the strip stops
 *              asking and hides the host segments rather than showing dashes
 *              that will never fill in.
 *   LIVENESS — `seam.liveness.refresh(spaceId)`, every LIVENESS_MS, plus every
 *              snapshot anyone else's refresh produces (`onChange`), so a
 *              session-surface refresh or an event-triggered one lands here too.
 *
 * Both pause while `document.visibilityState` is `hidden` and read once
 * immediately on becoming visible again, so a background tab costs nothing.
 */
import { useEffect, useState } from 'react';
import type { NodeMetricsView, SpaceId } from '@tm8/contract';

import type { LivenessSnapshot, Seam } from '../data/seam';

export const HOST_MS = 5_000;
export const LIVENESS_MS = 15_000;

/**
 * `granted` — reading; `denied` — the node refused (not a node admin);
 * `unavailable` — this seam or node has no host read at all.
 */
export type HostAccess = 'pending' | 'granted' | 'denied' | 'unavailable';

export interface StatusStripState {
  host: NodeMetricsView | null;
  hostAccess: HostAccess;
  /** The latest host read failed (transient); `host` holds the last good one. */
  hostStale: boolean;
  liveness: LivenessSnapshot | null;
}

const INITIAL: StatusStripState = { host: null, hostAccess: 'pending', hostStale: false, liveness: null };

function codeOf(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

export function useStatusStrip(seam: Seam, spaceId: SpaceId): StatusStripState {
  const [state, setState] = useState<StatusStripState>(() => ({
    ...INITIAL,
    hostAccess: seam.nodeMetrics ? 'pending' : 'unavailable',
  }));

  useEffect(() => {
    // A new space or seam starts from nothing: another space's counts must
    // never show under this one's name while its first read is in flight.
    setState({ ...INITIAL, hostAccess: seam.nodeMetrics ? 'pending' : 'unavailable' });
    let disposed = false;
    let hostTimer: ReturnType<typeof setInterval> | null = null;
    let livenessTimer: ReturnType<typeof setInterval> | null = null;
    let hostBlocked = !seam.nodeMetrics;
    let hostInFlight = false;

    const readHost = async (): Promise<void> => {
      const read = seam.nodeMetrics;
      if (!read || hostBlocked || hostInFlight) return;
      hostInFlight = true;
      try {
        const host = await read.call(seam);
        if (!disposed) setState((s) => ({ ...s, host, hostAccess: 'granted', hostStale: false }));
      } catch (err) {
        const code = codeOf(err);
        if (code === 'forbidden' || code === 'not_implemented') {
          hostBlocked = true;
          if (hostTimer) clearInterval(hostTimer);
          hostTimer = null;
          if (!disposed) {
            setState((s) => ({
              ...s,
              host: null,
              hostAccess: code === 'forbidden' ? 'denied' : 'unavailable',
              hostStale: false,
            }));
          }
        } else if (!disposed) {
          setState((s) => ({ ...s, hostStale: true }));
        }
      } finally {
        hostInFlight = false;
      }
    };

    const readLiveness = (): void => {
      // The real seam also fans this out through `onChange` below; applying
      // the resolved value too keeps the strip correct on a seam that does
      // not. A failed read keeps the last snapshot rather than blanking.
      seam.liveness.refresh(spaceId).then(
        (snap) => {
          if (!disposed && snap.spaceId === spaceId) setState((s) => ({ ...s, liveness: snap }));
        },
        () => {},
      );
    };

    const offLiveness = seam.liveness.onChange((snap) => {
      if (disposed || snap.spaceId !== spaceId) return;
      setState((s) => ({ ...s, liveness: snap }));
    });

    const start = (): void => {
      void readHost();
      readLiveness();
      if (!hostBlocked && !hostTimer) hostTimer = setInterval(() => void readHost(), HOST_MS);
      if (!livenessTimer) livenessTimer = setInterval(readLiveness, LIVENESS_MS);
    };
    const stop = (): void => {
      if (hostTimer) clearInterval(hostTimer);
      if (livenessTimer) clearInterval(livenessTimer);
      hostTimer = null;
      livenessTimer = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };

    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      stop();
      offLiveness();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [seam, spaceId]);

  return state;
}
