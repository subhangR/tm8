/**
 * SPEC D1 §5.3.1 CASE 12 — ABOUT 10 s OF GRACE BEFORE A ROW LEAVES RUNNING.
 *
 * The Running tab is a server query, so a session whose process dies leaves
 * the result the moment its upsert lands — and comes straight back if it is
 * resumed seconds later, or if a late live event re-files it. That is the row
 * jumping between tabs the case names. This keeps a row that has just LEFT the
 * query on screen, with its last-seen summary, for `graceMs`; a row that
 * returns inside the window never visibly left.
 *
 * Keyed by row id. `enabled` false (any other tab) is a pass-through and drops
 * whatever was lingering, so switching tabs never carries a ghost across.
 * The pure half is `withGrace` (domain/session-outcome.ts).
 */
import { useEffect, useRef, useState } from 'react';
import { RUNNING_GRACE_MS, withGrace } from '../../domain';

export function useRunningGrace<R extends { id: string }>(
  rows: readonly R[],
  enabled: boolean,
  graceMs: number = RUNNING_GRACE_MS,
): readonly R[] {
  const previous = useRef<readonly R[]>(rows);
  const lingering = useRef(new Map<string, { row: R; leftAt: number }>());
  const [, wake] = useState(0);

  if (!enabled) {
    lingering.current.clear();
    previous.current = rows;
  } else if (previous.current !== rows) {
    const now = Date.now();
    const present = new Set(rows.map((r) => r.id));
    for (const row of previous.current) {
      if (!present.has(row.id) && !lingering.current.has(row.id)) {
        lingering.current.set(row.id, { row, leftAt: now });
      }
    }
    for (const id of [...lingering.current.keys()]) {
      if (present.has(id)) lingering.current.delete(id);
    }
    previous.current = rows;
  }

  const now = Date.now();
  for (const [id, l] of lingering.current) {
    if (now - l.leftAt >= graceMs) lingering.current.delete(id);
  }
  // The query's own array when nothing lingers, so memos downstream hold.
  const shown = enabled && lingering.current.size > 0 ? withGrace(rows, lingering.current, now, graceMs) : rows;

  // One wake-up when the oldest lingering row's grace runs out.
  const nextExpiry = enabled && lingering.current.size > 0
    ? Math.min(...[...lingering.current.values()].map((l) => l.leftAt + graceMs))
    : null;
  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, nextExpiry - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  return shown;
}
