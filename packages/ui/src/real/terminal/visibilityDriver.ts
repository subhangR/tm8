/**
 * Lazy terminal streaming: keep only ON-SCREEN terminals subscribed to their PTY
 * stream and SUSPEND the offscreen ones, so they neither receive nor VT-parse
 * output. This is what turns the cost of N concurrently-streaming agents from
 * O(running) into O(visible) — the browser main thread only parses the terminal
 * you are actually looking at (plus a small warm set).
 *
 * Ported from old maestro's terminalVisibilityDriver, including its WARM LRU.
 *
 * How it decides: it reads the SAME truth the write scheduler uses — the DOM
 * computed `visibility` of each mounted xterm element — never React state about
 * "which is active", so it transparently covers any view that reparents terminal
 * elements imperatively.
 *
 * Grace + resume semantics:
 *  - RESUME is immediate when a terminal becomes visible (a shown terminal must
 *    never be left frozen).
 *  - SUSPEND waits HIDE_GRACE_MS of CONTINUOUS invisibility, so flipping between
 *    terminals does not churn suspend→replay.
 *
 * CORRECTNESS SEAM: before suspending we FLUSH the write scheduler's buffered
 * output into xterm. The transport advances its resume offset as frames ARRIVE
 * (before they reach xterm), so flushing first guarantees xterm has been handed
 * everything the offset counts — resume() then replays the delta with no skipped
 * or duplicated bytes. The flush is synchronous and there is no await between it
 * and the suspend, so no arriving frame can advance the offset in between.
 */

export interface TerminalVisibilityDeps {
  /** All currently-mounted terminals: session id → its xterm root element. */
  listTerminals(): Array<{ id: string; element: HTMLElement | undefined }>;
  /** Force the scheduler's buffered output for a session into its xterm NOW. */
  flush(id: string): void;
  /** Suspend a session's live stream (close socket, preserve resume offset). */
  suspend(id: string): void;
  /** Resume a suspended session (reopen at offset → server replays the delta). */
  resume(id: string): void;
}

const HIDE_GRACE_MS = 10000;
const RECONCILE_INTERVAL_MS = 2000;
/**
 * How many terminals stay WARM (subscribed, live-parsing) at once — the visible
 * one plus the most-recently-viewed others. Terminals in this set are never
 * suspended even while offscreen, so switching back to a recently-used terminal
 * is instant (no reconnect/replay). Only terminals that fall OUT of the set, and
 * then stay hidden past the grace window, suspend.
 */
const WARM_LRU_SIZE = 3;

let deps: TerminalVisibilityDeps | null = null;
let intervalTimer: number | null = null;
/** Wall-clock ms at which each currently-hidden session first went hidden. */
const hiddenSince = new Map<string, number>();
/** Ids we have suspended, so reconcile knows to resume-on-show exactly once. */
const suspendedIds = new Set<string>();
/** Most-recently-visible first, capped at WARM_LRU_SIZE. */
const warmLru: string[] = [];

function touchWarm(id: string): void {
  const i = warmLru.indexOf(id);
  if (i >= 0) warmLru.splice(i, 1);
  warmLru.unshift(id);
  if (warmLru.length > WARM_LRU_SIZE) warmLru.length = WARM_LRU_SIZE;
}

function isVisible(element: HTMLElement | undefined): boolean {
  if (!element || !element.isConnected) return false;
  return getComputedStyle(element).visibility !== 'hidden';
}

/**
 * One reconciliation pass over every mounted terminal. Cheap (a handful of
 * getComputedStyle reads); safe to call on a timer and on active-tab changes.
 */
export function reconcileTerminalVisibility(): void {
  if (!deps) return;
  const now = Date.now();
  const seen = new Set<string>();

  for (const { id, element } of deps.listTerminals()) {
    seen.add(id);
    if (isVisible(element)) {
      hiddenSince.delete(id);
      touchWarm(id);
      if (suspendedIds.has(id)) {
        suspendedIds.delete(id);
        deps.resume(id);
      }
      continue;
    }
    // Hidden.
    if (suspendedIds.has(id)) continue; // already suspended
    // Kept warm: a recently-viewed terminal stays live so switching back is
    // instant. It only becomes suspend-eligible once evicted from the LRU.
    if (warmLru.includes(id)) {
      hiddenSince.delete(id);
      continue;
    }
    const since = hiddenSince.get(id);
    if (since === undefined) {
      hiddenSince.set(id, now);
      continue;
    }
    if (now - since >= HIDE_GRACE_MS) {
      // Drain buffered output into xterm so the resume offset matches what xterm
      // has, THEN suspend. Order matters — see the correctness seam above.
      deps.flush(id);
      deps.suspend(id);
      suspendedIds.add(id);
      hiddenSince.delete(id);
    }
  }

  // Forget bookkeeping for terminals that unmounted since the last pass, so these
  // structures cannot grow across a long session with many spawns.
  for (const id of hiddenSince.keys()) if (!seen.has(id)) hiddenSince.delete(id);
  for (const id of suspendedIds) if (!seen.has(id)) suspendedIds.delete(id);
  for (let i = warmLru.length - 1; i >= 0; i--) {
    const warm = warmLru[i];
    if (warm !== undefined && !seen.has(warm)) warmLru.splice(i, 1);
  }
}

export function startTerminalVisibilityDriver(d: TerminalVisibilityDeps): void {
  deps = d;
  if (intervalTimer === null) {
    intervalTimer = window.setInterval(reconcileTerminalVisibility, RECONCILE_INTERVAL_MS);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', reconcileTerminalVisibility);
  }
}

export function stopTerminalVisibilityDriver(): void {
  if (intervalTimer !== null) {
    window.clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', reconcileTerminalVisibility);
  }
  // RESUME everything we suspended before forgetting it. Otherwise a stop /
  // restart / HMR leaves the transport's socket suspended while THIS module
  // loses the record — a later reconcile (with an empty suspendedIds) would never
  // resume it, stranding a permanently frozen terminal.
  if (deps) {
    for (const id of suspendedIds) deps.resume(id);
  }
  hiddenSince.clear();
  suspendedIds.clear();
  warmLru.length = 0;
  deps = null;
}

/**
 * Eviction seam for the bounded mounted-terminal LRU. Forget every reference to
 * an xterm that is being fully disposed immediately, rather than waiting for
 * the next 2s reconciliation pass to discover that its DOM was detached.
 */
export function forgetTerminalVisibility(id: string): void {
  hiddenSince.delete(id);
  suspendedIds.delete(id);
  const warmIndex = warmLru.indexOf(id);
  if (warmIndex >= 0) warmLru.splice(warmIndex, 1);
}

/** Test-only reset of module state. */
export function __resetTerminalVisibilityDriver(): void {
  stopTerminalVisibilityDriver();
}
