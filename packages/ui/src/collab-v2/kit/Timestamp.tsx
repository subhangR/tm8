/**
 * Timestamp (L0) — the one way the UI renders "when".
 *
 * A real `<time>` element, so the machine-readable instant travels with the
 * label; the relative text ticks off the shared clock; the full local date and
 * time is on `title` for inspect. Callers pass the field they mean —
 * `createdAt` for a message, `activityAt` for a row that sorts by recency —
 * because no single field is right everywhere.
 *
 * There is deliberately no format prop. A surface that wants a different date
 * format wants a change in `kit/time`, where every surface gets it.
 */
import { absTime, parseInstant, relTime, useNow } from './time';

export interface TimestampProps {
  /** ISO string (or epoch ms) from the entity. */
  at: string | number | Date | null | undefined;
  /** Leading word rendered with the label: 'active', 'since', 'created'. */
  prefix?: string;
  className?: string;
  /** Extra context for the hover title; the absolute time is appended to it. */
  title?: string;
  /**
   * Pins the clock the label is measured against. For tests and replay only —
   * app code omits it and gets the shared ticking clock.
   */
  now?: string | number | Date;
}

export function Timestamp({ at, prefix, className, title, now: pinnedNow }: TimestampProps) {
  // Subscribed before the early return so hook order never depends on data.
  const ticking = useNow();
  const now = parseInstant(pinnedNow) ?? ticking;
  const t = parseInstant(at);
  if (t === null) return null;

  const absolute = absTime(t);
  return (
    <time
      className={className}
      dateTime={new Date(t).toISOString()}
      title={title ? `${title} · ${absolute}` : absolute}
    >
      {prefix ? `${prefix} ${relTime(t, now)}` : relTime(t, now)}
    </time>
  );
}
