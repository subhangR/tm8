import { useEffect, useState } from 'react';
import type { ConnectionState } from '../data/seam';

/**
 * WHAT THE COMPOSER IS ALLOWED TO SAY ABOUT THE CONNECTION.
 *
 * The composer used to collapse `offline` and `polling` into one boolean and
 * print one sentence over both: "You're offline — nothing is reaching the
 * node." For `polling` that sentence is FALSE IN BOTH HALVES, and the
 * connection machine says so in its own docblock:
 *
 *   polling → socket down, but the node still answers `events.poll`, so data
 *             keeps advancing on the SAME seq spine, just slower.
 *   offline → the socket is down and HTTP is not reaching the node either.
 *
 * `noteTransport(false)` — the only thing that produces `offline` — fires only
 * when a request never reached the node at all. So `polling` is positive
 * evidence that HTTP works, which makes "nothing is reaching the node" the
 * exact opposite of what the state means.
 *
 * The screen-reader live region in `ChannelScreen` has always drawn the
 * distinction correctly ("Chat is reconnecting. Cached history remains
 * available."). The visible composer was the only surface conflating them.
 *
 * AND IT DECIDED SEND ON THAT CONFLATION. `messages.post` is an ordinary HTTP
 * write, so under `polling` a send SUCCEEDS — the transport carrying it is the
 * one the state proves is working. Withdrawing Send there refused something the
 * product can actually do, which is the same error `sessionExited` was
 * deliberately spared (HANDOVER ruling 2: storing is a permitted, successful
 * write, so the composer states the smaller consequence instead of pretending
 * the write is impossible). Only `offline` withdraws Send, because only
 * `offline` means the write cannot leave the browser.
 */
export type ConnectionPosture = 'ready' | 'degraded' | 'offline';

export function postureOf(connection: ConnectionState | undefined): ConnectionPosture {
  switch (connection?.phase) {
    case 'offline':
      return 'offline';
    case 'polling':
      return 'degraded';
    // `connecting` is the FIRST socket, before it has opened or failed. It is
    // not evidence of anything yet, and treating it as degraded would put a
    // warning on every cold start.
    default:
      return 'ready';
  }
}

/** Send is withdrawn ONLY when the write cannot leave the browser. */
export function canSendUnder(posture: ConnectionPosture): boolean {
  return posture !== 'offline';
}

/**
 * How long a `degraded` reading must persist before it is worth showing.
 *
 * THE FLICKER THIS EXISTS TO KILL. A socket that opens and then dies cycles
 * the phase live → polling → live, and `handleOpen` resets `reconnectAttempt`
 * to 0, so the next retry is `backoffBaseMs` (500ms) with jitter rather than a
 * backed-off delay. A composer that mirrors the phase directly therefore
 * strobes a warning on and off roughly twice a second, which reads as a broken
 * UI and buries the one case that matters.
 *
 * Deliberately one-directional: bad news waits to be confirmed, good news is
 * instant (see the hook). A recovery is never delayed, so this can only ever
 * make the UI quieter, never staler.
 */
export const DEGRADED_SETTLE_MS = 3_000;

/**
 * The posture, with `degraded` held back until it has persisted.
 *
 * `offline` is NEVER delayed — it withdraws Send, and a control that stays live
 * for three seconds after the write became impossible would invite exactly the
 * send that cannot succeed. Only the advisory state waits.
 */
export function useSettledPosture(
  posture: ConnectionPosture,
  settleMs: number = DEGRADED_SETTLE_MS,
): ConnectionPosture {
  const [settled, setSettled] = useState<ConnectionPosture>(
    posture === 'degraded' ? 'ready' : posture,
  );

  useEffect(() => {
    // Anything that is not the advisory state applies immediately: `offline`
    // because it is consequential, `ready` because recovery must never lag.
    if (posture !== 'degraded') {
      setSettled(posture);
      return;
    }
    const handle = setTimeout(() => setSettled('degraded'), settleMs);
    return () => clearTimeout(handle);
  }, [posture, settleMs]);

  return settled;
}
