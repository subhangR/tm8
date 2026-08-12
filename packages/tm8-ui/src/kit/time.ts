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
 */
import { useEffect, useState } from 'react';

/** Past this age a relative label stops informing and we show the date. */
export const RELATIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Cadence of the single shared clock. Coarse enough to be free on a long list. */
export const CLOCK_TICK_MS = 30_000;

/** Milliseconds since epoch, or null when the input is not a usable instant. */
export function parseInstant(value: string | number | Date | null | undefined): number | null {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function dateFormat(options: Intl.DateTimeFormatOptions, t: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, options).format(new Date(t));
  } catch {
    return '';
  }
}

/** '12 Aug' — or '12 Aug 2025' once the year differs from the year we are in. */
export function shortDate(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const t = parseInstant(value);
  if (t === null) return '';
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return dateFormat(
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
    t,
  );
}

/**
 * The full local date and time — what `title`/hover reveals behind every
 * relative label, and the answer to "but *when* exactly?".
 */
export function absTime(value: string | number | Date | null | undefined): string {
  const t = parseInstant(value);
  if (t === null) return '';
  return dateFormat({ dateStyle: 'full', timeStyle: 'short' }, t);
}

/**
 * 'HH:MM' local — the channel rail's per-row clock. `seconds` adds ':SS' for
 * the debug surfaces, which read a transcript rather than a conversation.
 */
export function clockTime(
  value: string | number | Date | null | undefined,
  { seconds = false }: { seconds?: boolean } = {},
): string {
  const t = parseInstant(value);
  if (t === null) return '';
  return dateFormat(
    { hour: '2-digit', minute: '2-digit', hour12: false, ...(seconds ? { second: '2-digit' } : {}) },
    t,
  );
}

/** Local midnight for an instant — the stable key a day divider groups on. */
export function dayStart(value: string | number | Date | null | undefined): number | null {
  const t = parseInstant(value);
  return t === null ? null : new Date(t).setHours(0, 0, 0, 0);
}

/** 'Mon 12 Aug' — the compact weekday form day markers and datelines use. */
export function weekdayDate(value: string | number | Date | null | undefined): string {
  const t = parseInstant(value);
  if (t === null) return '';
  return dateFormat({ weekday: 'short', day: 'numeric', month: 'short' }, t);
}

/** 'Today' / 'Yesterday' / 'Friday, 8 August' — the divider between day runs. */
export function dayLabel(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const start = dayStart(value);
  if (start === null) return '';
  const diff = Math.round((new Date(now).setHours(0, 0, 0, 0) - start) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const sameYear = new Date(start).getFullYear() === new Date(now).getFullYear();
  return dateFormat(
    { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) },
    start,
  );
}

/**
 * 'just now' / '4m ago' / '3d ago' inside the relative window; the absolute
 * date past it. Future instants read forward ('in 2d') so an expiry or a due
 * date never renders as though it had already happened.
 */
export function relTime(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const t = parseInstant(value);
  if (t === null) return '';
  const delta = now - t;
  if (Math.abs(delta) >= RELATIVE_WINDOW_MS) return shortDate(t, now);

  const ahead = delta < 0;
  const span = spanLabel(Math.round(Math.abs(delta) / 1000));
  if (span === null) return ahead ? 'in a moment' : 'just now';
  return ahead ? `in ${span}` : `${span} ago`;
}

/**
 * Bare magnitude with no direction — 'since 4m', 'ran for 2h'. The caller
 * supplies the preposition, so it never reads as a point in time.
 */
export function elapsed(
  value: string | number | Date | null | undefined,
  now: number = Date.now(),
): string {
  const t = parseInstant(value);
  if (t === null) return '';
  return spanLabel(Math.round(Math.abs(now - t) / 1000)) ?? '<1m';
}

/** '4m' / '3h' / '2d' for a magnitude in seconds; null below the noise floor. */
function spanLabel(seconds: number): string | null {
  if (seconds < 45) return null;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

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
