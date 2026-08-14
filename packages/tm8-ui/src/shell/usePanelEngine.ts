/**
 * The panel engine (LLD §5.3) — where the pure geometry law meets a measured
 * DOM and A1a's nav store.
 *
 * Everything decision-shaped lives in `geometry.ts` and is unit-tested there
 * without React. This hook only does the three things that genuinely need a
 * live shell: take the measurement, feed it to the law, and hand the settled
 * result to the store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import { admitPin, normalize, type PinAdmission, type PoolFacts } from './geometry';
import type { NavPort } from './nav-port';
import { demotionNotice, type Notice } from './notices';

/**
 * Measures an element's content-box width. `ResizeObserver` is the only honest
 * source — a layout that changes because a sibling grew emits no window resize.
 *
 * Returns `null` until a real measurement exists. That is deliberate: `0` would
 * be a *claim* that the center is zero-wide, and the demotion loop acting on it
 * would demote every pin the instant the shell mounted. Callers must treat
 * `null` as "not measured yet" and do nothing.
 */
export function useMeasuredWidth<T extends HTMLElement>(): [
  React.RefCallback<T>,
  number | null,
] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    // jsdom has no ResizeObserver and no layout engine. Rather than shim a
    // fake width (which would let a test "prove" a layout that never
    // happened), we simply never report one — D10 is explicit that pixel
    // acceptance is the real-browser pass.
    if (typeof ResizeObserver === 'undefined') return;

    const instance = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const next = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      setWidth((current) => (current === next ? current : next));
    });
    instance.observe(node);
    observer.current = instance;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, width];
}

export interface PanelEngineOptions {
  nav: NavPort;
  /** Measured center width, or null before first measurement. */
  centerWidth: number | null;
  onNotice?(notice: Notice): void;
  pool?: Omit<PoolFacts, 'candidateTakesLease'>;
}

export interface PanelEngine {
  /** Settled render state. Width-only demotion never mutates the route-bearing nav state. */
  visible: { stack: EntityId[]; pinned: EntityId[] };
  /**
   * Would pinning `id` be admitted? Call BEFORE `nav.pin` and render the
   * refusal on the pin control itself (L6) — never a silent no-op.
   */
  canPin(id: EntityId, candidateTakesLease?: boolean): PinAdmission;
  /** Admission-checked pin. Returns the refusal instead of pinning when refused. */
  requestPin(id: EntityId, candidateTakesLease?: boolean): PinAdmission;
  /** Esc: pops the stack top ONLY. Never a pin. */
  popStackTop(): void;
}

export function usePanelEngine(options: PanelEngineOptions): PanelEngine {
  const { nav, centerWidth, onNotice, pool } = options;

  const settled = useMemo(
    () => centerWidth === null
      ? { stack: [...nav.stack], pinned: [...nav.pinned], cause: null, demoted: [] }
      : normalize({ stack: nav.stack, pinned: nav.pinned, centerWidth }),
    [centerWidth, nav.stack, nav.pinned],
  );
  const visible = useMemo(
    () => ({ stack: settled.stack, pinned: settled.pinned }),
    [settled.stack, settled.pinned],
  );

  // The normalization loop. Runs on every width/state change, which is safe
  // because `applyNormalization` is idempotent and a no-op result writes no
  // history (A1a's contract).
  useEffect(() => {
    if (centerWidth === null) return; // not measured — never act on a guess
    if (settled.demoted.length === 0) return;
    if (settled.cause === 'width') return;

    nav.applyNormalization({ stack: settled.stack, pinned: settled.pinned });
    const notice = demotionNotice(settled.demoted);
    if (notice && onNotice) onNotice(notice);
    // `nav` is a fresh object each render; the state it carries is the real
    // dependency, so we key on the ids and the width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerWidth, nav.stack.join(','), nav.pinned.join(','), settled.cause]);

  const canPin = useCallback(
    (id: EntityId, candidateTakesLease = false): PinAdmission =>
      admitPin({
        stack: nav.stack,
        pinned: nav.pinned,
        id,
        // Before the first measurement we cannot honestly evaluate the width
        // clause. Infinity makes the WIDTH check pass while leaving the
        // max-pins and pool clauses fully in force — the alternative (refusing
        // every pin until a ResizeObserver fires) would make the control lie
        // about a limit that has not been measured.
        centerWidth: centerWidth ?? Number.POSITIVE_INFINITY,
        pool: pool ? { ...pool, candidateTakesLease } : undefined,
      }),
    [nav.stack, nav.pinned, centerWidth, pool],
  );

  const requestPin = useCallback(
    (id: EntityId, candidateTakesLease = false): PinAdmission => {
      const admission = canPin(id, candidateTakesLease);
      if (!admission.admitted) return admission;
      const outcome = nav.pin(id);
      // The store keeps its own state-pure guard; if the two ever disagree the
      // store wins and we surface its reason rather than pretending we pinned.
      if (!outcome.ok) {
        return {
          admitted: false,
          reason: 'max-pins',
          cause: "Can't pin",
          remedy: outcome.reason,
        };
      }
      return admission;
    },
    [canPin, nav],
  );

  const popStackTop = useCallback(() => {
    if (nav.stack.length === 0) return;
    nav.pop();
  }, [nav]);

  return { visible, canPin, requestPin, popStackTop };
}
