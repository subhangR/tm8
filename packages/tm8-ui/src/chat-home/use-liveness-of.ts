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
 * Every snapshot re-mints the function, so every consumer that lists it as a
 * memo or render input asks again. Nothing here caches a verdict.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EntityId, WorkSessionStatus } from '@tm8/contract';
import type { Seam } from '../data/seam';

export type LivenessOf = (session: { id: string; status: WorkSessionStatus | null }) =>
  ReturnType<Seam['liveness']['statusOf']>;

export function useLivenessOf(liveness: Pick<Seam['liveness'], 'onChange' | 'statusOf'>): LivenessOf {
  const [version, setVersion] = useState(0);
  useEffect(() => liveness.onChange(() => setVersion((current) => current + 1)), [liveness]);
  return useMemo<LivenessOf>(
    () => (session) => liveness.statusOf({ id: session.id as EntityId, status: session.status }),
    // `version` is the point: a new snapshot is a new question.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [liveness, version],
  );
}
