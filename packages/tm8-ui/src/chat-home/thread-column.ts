/**
 * THREAD COLUMN — the pure fold from a thread list to the grouped, filtered
 * rows a selector draws. Day buckets and the find-box filter, nothing else.
 *
 * WHY THIS IS ITS OWN MODULE. Two surfaces now draw the same list of
 * conversations: Home's left column, and Craft's pane-header picker. The
 * fold lived inside `ChatHomeScreen`, which is behind a deliberate route
 * boundary (`ChatHomeSurface` lazy-loads it precisely so Chat and its
 * markdown renderer stay out of non-Home chunks) — so importing the helper
 * from there would have pulled the whole chat screen into Craft's bundle to
 * get thirty lines of date arithmetic.
 *
 * Re-implementing it in Craft was the other option, and the worse one: two
 * copies of "what counts as Today" drift, and they drift silently, because
 * nothing renders both lists side by side.
 */
import type { ChatThreadSummary } from './types';

export interface ThreadGroup<T> {
  label: string;
  rows: T[];
}

/**
 * Most recent first, grouped Today / Yesterday / Earlier.
 *
 * An unparseable timestamp sorts to the bottom as `Earlier` rather than
 * throwing or vanishing: a row with a bad date is still a conversation
 * someone can open, and dropping it would be a silent cap.
 */
export function bucketByDay<T>(rows: readonly { at: string; row: T }[]): ThreadGroup<T>[] {
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOfDay(new Date());
  const dayMs = 24 * 60 * 60 * 1000;

  const buckets: ThreadGroup<T>[] = [];
  for (const entry of sorted) {
    const at = new Date(entry.at);
    const stamp = Number.isNaN(at.getTime()) ? 0 : startOfDay(at);
    const label = stamp >= today ? 'Today' : stamp >= today - dayMs ? 'Yesterday' : 'Earlier';
    const existing = buckets.find((bucket) => bucket.label === label);
    if (existing) existing.rows.push(entry.row);
    else buckets.push({ label, rows: [entry.row] });
  }
  return buckets;
}

/**
 * The find box filters what is ALREADY LOADED — title, preview and teammate.
 * It is not a server search, and both surfaces say so in the input's title.
 */
export function composeThreadColumn(
  threads: readonly ChatThreadSummary[],
  query: string,
): ThreadGroup<ChatThreadSummary>[] {
  const q = query.trim().toLowerCase();
  return bucketByDay(
    threads
      .filter(
        (thread) =>
          !q ||
          `${thread.title} ${thread.preview} ${thread.config.teammateLabel}`
            .toLowerCase()
            .includes(q),
      )
      .map((thread) => ({ at: thread.updatedAt, row: thread })),
  );
}
