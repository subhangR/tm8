/**
 * The Graph surface, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — the same shape, and for the same reason, as
 * `debugSurfaceFor`.
 *
 * TWO ENTRANCES, ONE SURFACE. A session reaches it through the Graph chip
 * `WorkSessionContent` draws; every other kind reaches it through the
 * Connections tab's List/Graph switch. Sessions never take the second door (the
 * terminal archetype returns before the tab arm), so nothing has two entrances
 * to the same canvas.
 *
 * The chip and the switch are rendered by the panel layer, so every host gets
 * them for free; the BODY behind them is a prop, because that layer is
 * presentational and never reaches for the seam. Wiring the five
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
      focusId={entityId as EntityId}
      // An entity that can still act can still grow edges. A finished one
      // cannot, so it is read once. `livenessOf` answers 'unknown' for every
      // non-session kind, which lands on the read-once arm — correct: a task
      // grows edges through its sessions, and those are what poll.
      live={livenessOf(entityId) === 'live'}
      onOpenEntity={onOpenEntity}
    />
  );
}
