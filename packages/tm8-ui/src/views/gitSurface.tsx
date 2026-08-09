/**
 * The session GIT surface, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — same shape and same reason as `debugSurface.tsx`:
 * the Git chip is rendered by `WorkSessionContent` for every host, but the
 * BODY behind it is a prop the host hands down, and hand-wiring each host
 * would leave the same trap armed for the next one.
 *
 * A host without a seam still gets an honest answer: `undefined` here makes
 * the panel render its explained fallback rather than a broken rail.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { SessionGitBody } from '../git/SessionGitBody';
import type { Seam, SessionLiveness } from '../data/seam';

export function gitSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  livenessOf: (id: string) => SessionLiveness,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <SessionGitBody
      seam={seam}
      sessionId={entityId as EntityId}
      // Poll only a session that can still change its worktree.
      live={livenessOf(entityId) === 'live'}
    />
  );
}
