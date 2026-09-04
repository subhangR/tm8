/**
 * The session Debug surface, composed ONCE for every host that mounts an
 * `EntityDetailPanel`.
 *
 * WHY THIS FILE EXISTS. The Debug chip is rendered by `WorkSessionContent`,
 * which every host gets for free through the panel — but the BODY behind it is
 * a `debugSurface` prop the host has to hand down, because the panel layer is
 * presentational and never reaches for the seam itself. When only `EntityView`
 * passed it, the chip appeared in the Workspace, the Channel view and the Graph
 * screen with nothing behind it, and the panel fell back to "the debug journal
 * host is unavailable in this view".
 *
 * Wiring the four remaining hosts by hand would have fixed those four and left
 * the same trap armed for the fifth. So the composition lives here, and a host
 * opts in with one call rather than four lines it can get subtly wrong.
 *
 * A HOST WITHOUT A SEAM STILL GETS AN HONEST ANSWER. `GraphScreen` takes a
 * deliberately narrowed data interface; when it supplies no seam this returns
 * `undefined` and the panel's existing fallback renders. That is the correct
 * outcome — an explained absence, not a broken table.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { SessionDebugBody } from '../panels/bodies/SessionDebugBody';
import type { Seam, SessionLiveness } from '../data/seam';

export function debugSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  livenessOf: (id: string) => SessionLiveness,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <SessionDebugBody
      seam={seam}
      sessionId={entityId as EntityId}
      // Polling is for a session that can still produce records. An exited one
      // is read once.
      live={livenessOf(entityId) === 'live'}
    />
  );
}
