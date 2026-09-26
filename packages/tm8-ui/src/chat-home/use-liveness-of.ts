/**
 * THE SEAM'S LIVENESS VERDICT, AS A FUNCTION THAT CHANGES WHEN THE VERDICT DOES.
 *
 * `seam.liveness.statusOf` is THE predicate (R-UI-5), and it reads the seam's
 * latest snapshot on every call — but a function whose identity never moves
 * gives React no reason to call it again. The surface memoised it on `[seam]`
 * alone and nothing in chat home subscribed to `liveness.onChange`, so the
 * ledger panel's `N live` pill (and the fleet stage's dots) kept the verdict
 * of the last unrelated re-render: `2 live` long after both workers had
 * exited (found by L4 while building its spawned-session card).
 *
 * A snapshot that can change the answer re-mints the function, so every
 * consumer that lists it as a memo or render input asks again. Nothing here
 * caches a verdict.
 *
 * ONLY A SNAPSHOT THAT CAN CHANGE THE ANSWER (#878 review, F5). The store
 * publishes one on every read — the 30s cadence, every work-session upsert,
 * every reconnect — and re-minting on each re-ran every consumer (the ledger's
 * pill, the fleet's dots, every spawned-session card) to reach the verdict it
 * already had. For THIS space `statusOf` can only answer differently when:
 *   - its live set changed (an id joined or left);
 *   - the node restarted (`nodeBootId`) — the store drops the other spaces'
 *     snapshots then, so their verdicts moved too;
 *   - the snapshot before this one had gone STALE (older than the store's
 *     freshness window when this one landed): `statusOf` was answering
 *     'unknown' for it, and a fresh one with the same ids turns that back
 *     into 'live'.
 * Anything else — the same ids re-read on schedule — is the same answer.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EntityId, WorkSessionStatus } from '@tm8/contract';
import { DEFAULT_LIVENESS_CONFIG } from '../data/real/liveness';
import type { LivenessSnapshot, Seam } from '../data/seam';

export type LivenessOf = (session: { id: string; status: WorkSessionStatus | null }) =>
  ReturnType<Seam['liveness']['statusOf']>;

export function useLivenessOf(
  liveness: Pick<Seam['liveness'], 'onChange' | 'statusOf'>,
  spaceId: string,
): LivenessOf {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let last: { key: string; checkedAt: number } | null = null;
    return liveness.onChange((snapshot) => {
      if (snapshot.spaceId !== spaceId) return;
      const key = liveSetKey(snapshot);
      const checkedAt = Date.parse(snapshot.checkedAt);
      // Written as "not within the window" so an unparseable time counts as
      // lapsed: an answer we cannot date is re-asked, never assumed.
      const lapsed = last === null || !(checkedAt - last.checkedAt <= DEFAULT_LIVENESS_CONFIG.staleAfterMs);
      const changed = lapsed || last === null || last.key !== key;
      last = { key, checkedAt };
      if (changed) setVersion((current) => current + 1);
    });
  }, [liveness, spaceId]);
  return useMemo<LivenessOf>(
    () => (session) => liveness.statusOf({ id: session.id as EntityId, status: session.status }),
    // `version` is the point: a new snapshot is a new question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveness, version],
  );
}

/** What `statusOf` reads from one space's snapshot: the process and its ids. */
function liveSetKey(snapshot: LivenessSnapshot): string {
  return `${snapshot.nodeBootId}|${[...snapshot.liveEntityIds].sort().join(',')}`;
}
