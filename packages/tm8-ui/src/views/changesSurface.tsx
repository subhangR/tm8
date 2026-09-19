/**
 * The session CHANGES surface, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — the same shape and the same reason as
 * `gitSurface.tsx`: the Changes chip is rendered by `WorkSessionContent` for
 * every host, but the BODY behind it is a prop the host hands down, and
 * hand-wiring each host would leave the same trap armed for the next one.
 * `panel-host-wiring.test.ts` asserts that no host builds this element itself.
 *
 * A host without a seam still gets an honest answer: `undefined` here makes
 * the panel render its explained fallback rather than an empty review pane.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { SessionChangesBody } from '../git/SessionChangesBody';
import type { Seam, SessionLiveness } from '../data/seam';

export function changesSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  livenessOf: (id: string) => SessionLiveness,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <SessionChangesBody
      seam={seam}
      sessionId={entityId as EntityId}
      // Poll only a session that can still change its worktree.
      live={livenessOf(entityId) === 'live'}
    />
  );
}
