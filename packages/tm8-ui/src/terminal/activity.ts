import { useEffect, useState } from 'react';

/**
 * THE TERMINAL-ACTIVITY PORT — the app's only streaming source.
 *
 * WHY A PORT AND NOT A POOL. The LLD puts this signal on `TerminalPool`
 * (§9.2): the real pool wraps the write sink it already injects into the
 * verbatim write scheduler, and each flush through that wrapper marks
 * activity — no bytes read, no transplant file edited, just an observation at
 * an injection seam the pool already owns. But the pool is a mounting
 * adaptation that belongs with the transport transplant, and R9 keeps the
 * transport out of Phase 1 entirely. Building a whole pool now to obtain one
 * boolean would be inventing the thing the ruling defers.
 *
 * So the CONSUMER side is declared here, at the exact `onActivity` signature
 * the LLD gives `TerminalPool`. A scriptable source satisfies it for the gate
 * demo; the real pool satisfies it at integration by passing `pool.onActivity`
 * — no call site changes. (Approved by fe-coordinator; ledgered.)
 *
 * THE GATE THE CONSUMER MUST NOT FORGET. Activity is one of TWO sources and
 * it is the subordinate one: it may refine a `live` verdict into "streaming"
 * and may never promote anything else. That gate lives in
 * `session-presentation.ts`, in one place, so no caller can drop it — a pulse
 * that outranked liveness would be precisely the lie the vocabulary exists to
 * prevent. Never derive activity from `EntitySummary.activityAt` recency:
 * that is D6's named forbidden inference.
 */

export type Unsubscribe = () => void;

/** The §9.2 signature, verbatim. `TerminalPool` satisfies this structurally. */
export interface ActivitySource {
  onActivity(cb: (sessionId: string, active: boolean) => void): Unsubscribe;
}

export interface ScriptedActivitySource extends ActivitySource {
  /** Drive the gate demo (and tests) deterministically. */
  setActive(sessionId: string, active: boolean): void;
  /** Current state — for a component mounting mid-stream. */
  isActive(sessionId: string): boolean;
}

/**
 * Phase-1 stub. Deliberately has no timers: the real signal decays ~1s after
 * the last flush, but a decay clock here would make every test time-dependent
 * for no fidelity gain. Tests and the gate demo drive `setActive` explicitly.
 */
export function createScriptedActivitySource(
  initial: Readonly<Record<string, boolean>> = {},
): ScriptedActivitySource {
  const active = new Map<string, boolean>(Object.entries(initial));
  const subscribers = new Set<(sessionId: string, isActive: boolean) => void>();

  return {
    onActivity(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    setActive(sessionId, isActive) {
      if (active.get(sessionId) === isActive) return; // idempotent: no redundant fanout
      active.set(sessionId, isActive);
      for (const cb of subscribers) cb(sessionId, isActive);
    },
    isActive(sessionId) {
      return active.get(sessionId) ?? false;
    },
  };
}

/**
 * Runtime terminal activity, using Maestro's two-second idle debounce. The PTY
 * transport calls `markTerminalActivity` only for live output frames; replay
 * hydration never makes a session appear to be actively streaming.
 */
export const terminalActivitySource = createScriptedActivitySource();
const terminalActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function markTerminalActivity(sessionId: string): void {
  terminalActivitySource.setActive(sessionId, true);
  const previous = terminalActivityTimers.get(sessionId);
  if (previous) clearTimeout(previous);
  terminalActivityTimers.set(sessionId, setTimeout(() => {
    terminalActivityTimers.delete(sessionId);
    terminalActivitySource.setActive(sessionId, false);
  }, 2_000));
}

/**
 * Subscribe one session's activity. Returns raw activity — NOT a licence to
 * render "streaming"; pass it through `presentSession`, which applies the
 * live-verdict gate.
 */
export function useTerminalActivity(
  source: ActivitySource | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!source || !sessionId) {
      setActive(false);
      return;
    }
    // A source that can report current state closes the mount-mid-stream gap;
    // one that cannot starts false and corrects on the next flush.
    const scripted = source as Partial<ScriptedActivitySource>;
    setActive(scripted.isActive?.(sessionId) ?? false);

    return source.onActivity((id, isActive) => {
      if (id === sessionId) setActive(isActive);
    });
  }, [source, sessionId]);

  return active;
}

/** Subscribe every session's activity — the live-session bar's dot needs it. */
export function useTerminalActivityMap(
  source: ActivitySource | null | undefined,
): Readonly<Record<string, boolean>> {
  const [map, setMap] = useState<Readonly<Record<string, boolean>>>({});

  useEffect(() => {
    if (!source) {
      setMap({});
      return;
    }
    return source.onActivity((id, isActive) => {
      setMap((prev) => (prev[id] === isActive ? prev : { ...prev, [id]: isActive }));
    });
  }, [source]);

  return map;
}
