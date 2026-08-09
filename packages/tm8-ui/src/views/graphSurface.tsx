/**
 * The session Graph surface, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — the same shape, and for the same reason, as
 * `debugSurfaceFor`.
 *
 * The Graph chip is rendered by `WorkSessionContent`, so every host gets the
 * CHIP for free through the panel; the BODY behind it is a prop, because the
 * panel layer is presentational and never reaches for the seam. Wiring the five
 * mount sites by hand is exactly how `debugSurface` and `onResumeSession` each
 * ended up live on one screen and dead on the rest, so the composition lives
 * here and a host opts in with one call.
 *
 * NAVIGATION IS OPTIONAL, AND ITS ABSENCE IS STATED. A host that cannot open
 * another entity passes no `onOpenEntity`, and the selection card renders a
 * `DisabledAction` explaining that the SCREEN cannot navigate — never a missing
 * button, which a viewer would read as a fact about the entity.
 *
 * A host without a seam gets `undefined` and the panel's own fallback, which is
 * the honest outcome rather than an empty canvas that would read as "this
 * session did nothing".
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { SessionGraphBody } from '../session-graph';
import type { Seam, SessionLiveness } from '../data/seam';

export function graphSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  livenessOf: (id: string) => SessionLiveness,
  onOpenEntity?: (id: string) => void,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <SessionGraphBody
      seam={seam}
      sessionId={entityId as EntityId}
      // A session that can still act can still grow edges. An exited one cannot,
      // so it is read once.
      live={livenessOf(entityId) === 'live'}
      onOpenEntity={onOpenEntity}
    />
  );
}
