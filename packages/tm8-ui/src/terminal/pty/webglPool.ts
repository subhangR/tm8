/**
 * A BOUNDED POOL OF WEBGL RENDERERS — WebGL on the terminals you look at, DOM
 * on the rest.
 *
 * Why bounded: Chromium caps live WebGL contexts at ~16 per renderer process
 * and, past the cap, silently LOSES THE OLDEST one to make room. One context
 * per cached terminal therefore degrades quietly — terminal 17 opens fine and
 * terminal 1 goes blank behind your back (Agent Orchestrator PR #6465). So
 * WebGL is held by at most `cap` (8) terminals: the most-recently-SHOWN ones,
 * leaving headroom under the browser's cap for anything else on the page.
 *
 * How it decides: the same truth the visibility driver and write scheduler use
 * — `isElementPaintable` on the xterm element and its ancestors — never React
 * state about which tab is active.
 *
 *  - ACQUIRE only when a terminal is visible and inside the MRU window. A
 *    hidden terminal never gets a fresh context; there is nothing to draw.
 *  - EVICT the least-recently-shown terminal once it falls out of the window:
 *    dispose the addon, xterm puts its DOM renderer back. Evictions run BEFORE
 *    acquisitions in a pass, so the live count never exceeds the cap.
 *  - CONTEXT LOSS: dispose (xterm falls back to DOM) and retry on the next
 *    SHOW — not on the next pass, so a GPU reset cannot become a reacquire loop.
 *    After MAX_CONTEXT_LOSSES on one terminal it stays on DOM.
 *  - FAIL SOFT: no WebGL2 (jsdom, old GPU, Safari < 16, blocklisted driver) and
 *    every terminal stays on the DOM renderer, silently.
 *
 * Inline images: `@xterm/addon-image` wraps `renderService.setRenderer`, drops
 * its overlay canvas whenever the renderer is swapped and re-inserts it on the
 * next render — so images survive a DOM↔WebGL swap in either direction. Its
 * layer is a 2D canvas, so it does not count toward the WebGL cap.
 */
import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

import { isElementPaintable } from './elementVisibility.js';

/** What the pool needs from a WebGL addon — `WebglAddon` satisfies it. */
export interface WebglAddonLike {
  onContextLoss(listener: () => void): { dispose(): void };
  dispose(): void;
}

export interface WebglPoolOptions {
  /** Max terminals holding a live WebGL context at once. */
  cap?: number;
  /** Builds the addon. Throwing (no WebGL2) is the fail-soft path. */
  createAddon?: () => WebglAddonLike;
  /** Is WebGL2 worth trying at all? Checked once, lazily. */
  isSupported?: () => boolean;
  isVisible?: (element: HTMLElement | undefined) => boolean;
}

export interface WebglPoolStats {
  /** Terminals currently on WebGL. */
  live: number;
  /** Context-loss events seen since the pool was created. */
  contextLosses: number;
  /** False once WebGL was found unavailable; everything is on DOM. */
  supported: boolean;
}

export interface WebglPool {
  /** Track a terminal. Returns the unregister function (disposes its addon). */
  register(id: string, term: Terminal): () => void;
  /** One pass: evict out-of-window terminals, acquire for visible ones. */
  reconcile(): void;
  /** Coalesce a reconcile into the next animation frame. */
  schedule(): void;
  /** Is this terminal currently on WebGL? */
  isAccelerated(id: string): boolean;
  stats(): WebglPoolStats;
}

export const WEBGL_POOL_CAP = 8;
const MAX_CONTEXT_LOSSES = 3;
const RECONCILE_INTERVAL_MS = 2000;

interface Entry {
  term: Terminal;
  addon: WebglAddonLike | null;
  offLoss: { dispose(): void } | null;
  /** Monotonic stamp of the last pass this terminal was seen visible. */
  lastShown: number;
  /** Set by a context loss; cleared once the terminal is seen hidden. */
  awaitingShow: boolean;
  losses: number;
  /** An acquire threw after WebGL worked elsewhere; this one stays on DOM. */
  failed: boolean;
}

/**
 * The addon's GL context, read through xterm-addon internals. `dispose()`
 * removes the canvas but does NOT release its context: Chromium keeps counting
 * it toward the cap until garbage collection, and at the cap it kills the
 * OLDEST context — which can be a live, visible terminal's. Releasing it
 * explicitly is what makes a freed slot actually free (measured: without it,
 * churning 24 terminals through an 8-slot pool still hit "Too many active
 * WebGL contexts").
 */
function contextOf(addon: WebglAddonLike): WebGL2RenderingContext | undefined {
  return (addon as { _renderer?: { _gl?: WebGL2RenderingContext } })._renderer?._gl;
}

function defaultIsSupported(): boolean {
  // jsdom and pre-WebGL2 browsers have no constructor at all; checking it
  // avoids creating (and leaking toward the cap) a probe context.
  return typeof WebGL2RenderingContext !== 'undefined';
}

export function createWebglPool(options: WebglPoolOptions = {}): WebglPool {
  const cap = options.cap ?? WEBGL_POOL_CAP;
  const createAddon = options.createAddon ?? (() => new WebglAddon());
  const isVisible = options.isVisible ?? isElementPaintable;
  const isSupported = options.isSupported ?? defaultIsSupported;

  const entries = new Map<string, Entry>();
  let supported: boolean | null = null;
  let everAcquired = false;
  let clock = 0;
  let contextLosses = 0;
  let rafId: number | null = null;
  let intervalId: number | null = null;

  const release = (entry: Entry) => {
    const { addon, offLoss } = entry;
    entry.addon = null;
    entry.offLoss = null;
    if (!addon) return;
    const gl = contextOf(addon);
    try {
      offLoss?.dispose();
      addon.dispose();
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // A renderer swap must never take down the PTY; xterm keeps a renderer.
    }
  };

  const acquire = (id: string, entry: Entry) => {
    let addon: WebglAddonLike | null = null;
    try {
      addon = createAddon();
      entry.term.loadAddon(addon as unknown as Parameters<Terminal['loadAddon']>[0]);
    } catch {
      // A failed activate leaves the addon registered with xterm; dispose
      // unloads it (nothing was swapped yet, so the DOM renderer stays).
      try { addon?.dispose(); } catch { /* already gone */ }
      // Never worked anywhere: WebGL is unavailable on this page. Worked
      // before: this one terminal stays on DOM rather than retrying forever.
      if (!everAcquired) supported = false;
      else entry.failed = true;
      return;
    }
    everAcquired = true;
    entry.addon = addon;
    entry.offLoss = addon.onContextLoss(() => {
      const current = entries.get(id);
      if (current !== entry || entry.addon !== addon) return;
      contextLosses += 1;
      entry.losses += 1;
      entry.awaitingShow = true;
      release(entry);
    });
  };

  const reconcile = () => {
    if (supported === null) supported = isSupported();
    if (!supported) {
      for (const entry of entries.values()) if (entry.addon) release(entry);
      return;
    }
    clock += 1;
    const visible = new Set<string>();
    for (const [id, entry] of entries) {
      if (isVisible(entry.term.element)) {
        visible.add(id);
        entry.lastShown = clock;
      } else {
        entry.awaitingShow = false;
      }
    }
    // The window: the `cap` most-recently-shown terminals. Never-shown ones
    // (lastShown 0) are outside it by construction.
    const inWindow = new Set(
      [...entries]
        .filter(([, entry]) => entry.lastShown > 0)
        .sort(([, a], [, b]) => b.lastShown - a.lastShown)
        .slice(0, cap)
        .map(([id]) => id),
    );
    for (const [id, entry] of entries) {
      if (entry.addon && !inWindow.has(id)) release(entry);
    }
    let live = 0;
    for (const entry of entries.values()) if (entry.addon) live += 1;
    for (const [id, entry] of entries) {
      if (live >= cap || !supported) break;
      if (entry.addon || !inWindow.has(id) || !visible.has(id)) continue;
      if (entry.failed || entry.awaitingShow || entry.losses >= MAX_CONTEXT_LOSSES) continue;
      acquire(id, entry);
      if (entry.addon) live += 1;
    }
  };

  const schedule = () => {
    if (rafId !== null || typeof requestAnimationFrame === 'undefined') return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      reconcile();
    });
  };

  const startTimers = () => {
    if (intervalId !== null || typeof window === 'undefined') return;
    intervalId = window.setInterval(reconcile, RECONCILE_INTERVAL_MS);
    document.addEventListener('visibilitychange', schedule);
  };

  const stopTimers = () => {
    if (intervalId !== null) window.clearInterval(intervalId);
    intervalId = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', schedule);
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  };

  return {
    register(id, term) {
      const previous = entries.get(id);
      if (previous) release(previous);
      const entry: Entry = {
        term,
        addon: null,
        offLoss: null,
        lastShown: 0,
        awaitingShow: false,
        losses: 0,
        failed: false,
      };
      entries.set(id, entry);
      startTimers();
      schedule();
      return () => {
        if (entries.get(id) !== entry) return;
        release(entry);
        entries.delete(id);
        if (entries.size === 0) stopTimers();
        // A freed slot can go to a visible terminal that was waiting on it.
        else schedule();
      };
    },
    reconcile,
    schedule,
    isAccelerated: (id) => Boolean(entries.get(id)?.addon),
    stats() {
      let live = 0;
      for (const entry of entries.values()) if (entry.addon) live += 1;
      return { live, contextLosses, supported: supported !== false };
    },
  };
}

/** The page's one pool — every LiveTerminal registers here. */
export const webglPool = createWebglPool();
