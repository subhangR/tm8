/**
 * `useMessagePulses` — the raw-event tap behind session-to-session motion.
 *
 * WHY THE RAW SEAM AND NOT THE DOMAIN STORE. The store already subscribes
 * globally (`data/project/domain-store.ts:193`) but it REDUCES THE TRANSIENCE
 * AWAY: `messagesByAnchor` answers "a message exists", and the pulse needs "a
 * message just arrived". The same is true of a session birth and a terminal
 * status transition. Those are transient facts, so this is a genuine second
 * consumer of `seam.onEvent`, matching
 * `channel-screen/chat-store.ts:379` — not a duplicate of the store.
 *
 * WHY THIS HOLDS A LIST AND NOT A FLAG PER ROW. Two sessions can message the
 * same target within one animation window, and a boolean map would silently
 * collapse them into one pulse. Each arrival is its own entry with its own
 * lifetime, so concurrent traffic looks like concurrent traffic.
 *
 * WHAT IS DELIBERATELY NOT HERE: no routing, no geometry, no knowledge that a
 * tree or graph exists. This hook only retains a bounded live tail of typed
 * `delegation | completion | message` pulses. `message-pulse.ts` derives and
 * routes them with pure functions that need no seam, DOM or clock.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DurableWorkspaceEvent, EntitySummary } from '@tm8/contract';

import type { Unsubscribe } from '../../data/seam';
import {
  advanceSessionEventState,
  appendBoundedPulse,
  createSessionEventState,
  deriveSessionTransition,
  isFreshSessionEvent,
  pulseFromEvent,
  seedSessionEventState,
  type SessionPulse,
} from './message-pulse';

export type {
  Completion,
  Delegation,
  SessionMessagePulse,
  SessionPulse,
  SessionPulseKind,
} from './message-pulse';
/** Compatibility name used by the existing GateData/ListPanel wiring. */
export type MessagePulse = SessionPulse;

/** Exactly the seam surface this hook consumes. A full `Seam` satisfies it. */
export interface MessagePulseSeamPort {
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
}

export interface MessagePulseOptions {
  /** Summaries the mounting screen already holds, used as the before image. */
  knownEntities?: readonly EntitySummary[];
  /** Optional liveness tap; the session graph uses it to refresh immediately. */
  onEvent?: (event: DurableWorkspaceEvent, pulse: SessionPulse | null) => void;
}

/**
 * How long an arrival stays animatable. Covers the hairline sweep plus the
 * per-segment stagger of the longest realistic path; the CSS decides the actual
 * motion, and this only decides when the entry stops existing.
 */
const PULSE_TTL_MS = 2_200;

/** Hard ceiling: bursts drop their oldest visual, never queue without bound. */
export const MAX_CONCURRENT_PULSES = 12;

/**
 * Arrivals currently worth animating. Empty is the steady state — this returns a
 * stable frozen empty array when idle so a consumer's memo dependencies do not
 * churn on every unrelated event.
 */
export function useMessagePulses(
  seam: MessagePulseSeamPort | undefined,
  options: MessagePulseOptions = EMPTY_OPTIONS,
): readonly SessionPulse[] {
  const [pulses, setPulses] = useState<readonly SessionPulse[]>(EMPTY);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const active = useRef<readonly SessionPulse[]>(EMPTY);
  const eventState = useRef(createSessionEventState(options.knownEntities));
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (seam === undefined || typeof seam.onEvent !== 'function') return undefined;
    const live = timers.current;
    let mounted = true;
    active.current = EMPTY;
    eventState.current = createSessionEventState(optionsRef.current.knownEntities);
    setPulses(EMPTY);

    const off = seam.onEvent((event) => {
      if (!mounted) return;
      eventState.current = seedSessionEventState(
        eventState.current,
        optionsRef.current.knownEntities ?? EMPTY_ENTITIES,
      );
      if (!isFreshSessionEvent(event, eventState.current)) return;

      const pulse = pulseFromEvent(event, eventState.current);
      const transition = deriveSessionTransition(event, eventState.current);
      eventState.current = advanceSessionEventState(eventState.current, event, transition);
      optionsRef.current.onEvent?.(event, pulse);
      if (pulse === null) return;

      const next = appendBoundedPulse(active.current, pulse, MAX_CONCURRENT_PULSES);
      const retained = new Set(next.map((item) => item.key));
      for (const [key, timer] of live) {
        if (!retained.has(key)) {
          clearTimeout(timer);
          live.delete(key);
        }
      }
      active.current = next;
      setPulses(next);

      clearTimeout(live.get(pulse.key));
      live.set(
        pulse.key,
        setTimeout(() => {
          if (!mounted) return;
          live.delete(pulse.key);
          const remaining = active.current.filter((item) => item.key !== pulse.key);
          if (remaining.length === active.current.length) return;
          active.current = remaining;
          setPulses(remaining.length === 0 ? EMPTY : remaining);
        }, PULSE_TTL_MS),
      );
    });

    return () => {
      mounted = false;
      off();
      for (const timer of live.values()) clearTimeout(timer);
      live.clear();
      active.current = EMPTY;
    };
  }, [seam]);

  return useMemo(() => (pulses.length === 0 ? EMPTY : pulses), [pulses]);
}

const EMPTY: readonly SessionPulse[] = Object.freeze([]);
const EMPTY_ENTITIES: readonly EntitySummary[] = Object.freeze([]);
const EMPTY_OPTIONS: MessagePulseOptions = Object.freeze({});
