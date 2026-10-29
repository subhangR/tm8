/**
 * The ONE timestamp helper for this app.
 *
 * Every surface that shows "when" — messages, channel entries, task rows,
 * activity rows, hub and graph meta — formats through this module. Before it
 * there were EIGHT private copies (`replyTimeAgo`, two private `timeAgo`s,
 * `relativeTileTime`, `elapsed`, and three bare `toLocaleString` calls), and
 * `channel-screen/feed-model.ts` had already written the problem down: "a
 * private twin of this lives in HubBody (and a third in GraphView) — flagged,
 * not solved". This is the solve.
 *
 * Rules the whole app inherits:
 *  · Relative inside the RELATIVE_WINDOW (7 days) — "just now", "4m ago", "3d ago".
 *  · Absolute past it — "12 Aug", or "12 Aug 2025" once the year differs.
 *  · The full local date and time is always available on inspect (`absTime`),
 *    so the relative label never has to be the only answer.
 *  · Unparseable input renders as nothing at all. Never 'Invalid Date', never
 *    a raw ISO string leaked into the UI.
 *  · Local timezone, current UI language — no per-user format preference.
 *
 * Ticking lives here too: ONE interval for the whole document (`useNow`), not
 * one per row, because these labels appear on every cell of a long list.
 *
 * The sibling app in `packages/ui` carries a matching module; each app owns
 * one formatter and a test that greps its own tree for a second.
 *
 * SPLIT (t-p0-client-core, 2026-10-29). The formatters moved to
 * `@tm8/client-core/time`, which the phone app shares; import them from there.
 * This file keeps the clocks, because they read `document` and React.
 */
import { useEffect, useState } from 'react';

/** Cadence of the single shared clock. Coarse enough to be free on a long list. */
export const CLOCK_TICK_MS = 30_000;

/* ── the one clock ──────────────────────────────────────────────────────── */

type ClockListener = (now: number) => void;

const listeners = new Set<ClockListener>();
let timer: ReturnType<typeof setInterval> | null = null;

function broadcast(): void {
  const now = Date.now();
  for (const listener of listeners) listener(now);
}

function onVisible(): void {
  if (!document.hidden) broadcast();
}

function subscribe(listener: ClockListener): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(broadcast, CLOCK_TICK_MS);
    // A backgrounded tab has its intervals throttled, so its labels come back
    // stale. Catching up on the way in is cheaper than a faster interval.
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/**
 * Current wall clock, re-rendering the caller every CLOCK_TICK_MS — from ONE
 * interval shared by every timestamp on screen, so a thousand-row list costs
 * the same as one row.
 */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}

/* ── the seconds clock ──────────────────────────────────────────────────── */

/**
 * Cadence of the OPT-IN seconds clock. A separate clock rather than a faster
 * `CLOCK_TICK_MS`, because the list clock's coarseness is what makes it free:
 * only a surface that reads "8s ago" pays per second, and only while it is
 * both mounted and visible.
 */
export const SECONDS_TICK_MS = 1_000;

const secondListeners = new Set<ClockListener>();
let secondTimer: ReturnType<typeof setInterval> | null = null;

function broadcastSeconds(): void {
  const now = Date.now();
  for (const listener of secondListeners) listener(now);
}

function startSeconds(): void {
  if (secondTimer === null && !document.hidden) secondTimer = setInterval(broadcastSeconds, SECONDS_TICK_MS);
}

function stopSeconds(): void {
  if (secondTimer !== null) {
    clearInterval(secondTimer);
    secondTimer = null;
  }
}

// Hidden tabs do not tick at all — nobody is reading the seconds.
function onSecondsVisibility(): void {
  if (document.hidden) {
    stopSeconds();
    return;
  }
  broadcastSeconds();
  startSeconds();
}

function subscribeSeconds(listener: ClockListener): () => void {
  secondListeners.add(listener);
  if (secondListeners.size === 1) {
    document.addEventListener('visibilitychange', onSecondsVisibility);
    startSeconds();
  }
  return () => {
    secondListeners.delete(listener);
    if (secondListeners.size === 0) {
      stopSeconds();
      document.removeEventListener('visibilitychange', onSecondsVisibility);
    }
  };
}

/**
 * Current wall clock at one-second resolution, from ONE interval shared by
 * every subscriber and running only while one is `active` and the tab is
 * visible. Pass `active: false` when nothing on screen needs seconds — the
 * caller then re-renders never, and `now` is its mount time.
 */
export function useNowSeconds(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    return subscribeSeconds(setNow);
  }, [active]);
  return now;
}
