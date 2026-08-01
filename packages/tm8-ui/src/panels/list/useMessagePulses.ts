/**
 * `useMessagePulses` — the raw-event tap behind the session-tree pulse.
 *
 * WHY THE RAW SEAM AND NOT THE DOMAIN STORE. The store already subscribes
 * globally (`data/project/domain-store.ts:193`) but it REDUCES THE TRANSIENCE
 * AWAY: `messagesByAnchor` answers "a message exists", and the pulse needs "a
 * message just arrived". Those are different facts, and only the second one is
 * animatable. So this is a genuine second consumer of `seam.onEvent`, matching
 * `channel-screen/chat-store.ts:379` — not a duplicate of the store.
 *
 * WHY THIS HOLDS A LIST AND NOT A FLAG PER ROW. Two sessions can message the
 * same target within one animation window, and a boolean map would silently
 * collapse them into one pulse. Each arrival is its own entry with its own
 * lifetime, so concurrent traffic looks like concurrent traffic.
 *
 * WHAT IS DELIBERATELY NOT HERE: no routing, no geometry, no knowledge that a
 * tree exists. This hook only says "A sent to B, just now". `message-pulse.ts`
 * decides what that looks like, and it is pure so it can be tested without a
 * seam, a DOM or a clock.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DurableWorkspaceEvent } from '@tm8/contract';

import type { Unsubscribe } from '../../data/seam';

/** Exactly the seam surface this hook consumes. A full `Seam` satisfies it. */
export interface MessagePulseSeamPort {
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
}

export interface MessagePulse {
  /** Stable per arrival, so React keeps one animation per message. */
  key: string;
  /** The sending work session. */
  fromId: string;
  /** The anchor the message landed on. */
  toId: string;
}

/**
 * How long an arrival stays animatable. Covers the hairline sweep plus the
 * per-segment stagger of the longest realistic path; the CSS decides the actual
 * motion, and this only decides when the entry stops existing.
 */
const PULSE_TTL_MS = 1400;

/**
 * Arrivals currently worth animating. Empty is the steady state — this returns a
 * stable frozen empty array when idle so a consumer's memo dependencies do not
 * churn on every unrelated event.
 */
export function useMessagePulses(seam: MessagePulseSeamPort | undefined): readonly MessagePulse[] {
  const [pulses, setPulses] = useState<readonly MessagePulse[]>(EMPTY);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (seam === undefined) return undefined;
    const live = timers.current;

    const off = seam.onEvent((event) => {
      if (event.type !== 'message.created') return;
      // Provenance is hydrated by the event mapper from the recorder-owned
      // `authored_from` edge. It is absent for a human-authored message, which
      // is the ordinary case and simply has no wire to travel.
      const fromId = event.sourceWorkSessionId;
      const toId = event.anchorId;
      if (typeof fromId !== 'string' || fromId === '' || fromId === toId) return;

      // The message id keys the animation. Re-delivery of the same event (the
      // poll fallback merging with the socket) must refresh the existing pulse
      // rather than stack a second copy on the same wire.
      const key = event.message.id;
      setPulses((prev) => [...prev.filter((pulse) => pulse.key !== key), { key, fromId, toId }]);

      clearTimeout(live.get(key));
      live.set(
        key,
        setTimeout(() => {
          live.delete(key);
          setPulses((prev) => (prev.some((pulse) => pulse.key === key) ? prev.filter((p) => p.key !== key) : prev));
        }, PULSE_TTL_MS),
      );
    });

    return () => {
      off();
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
    };
  }, [seam]);

  return useMemo(() => (pulses.length === 0 ? EMPTY : pulses), [pulses]);
}

const EMPTY: readonly MessagePulse[] = Object.freeze([]);
