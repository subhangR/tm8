/**
 * The panel bar's live CONTEXT NUMBER, composed once for every host that
 * mounts an `EntityDetailPanel` — same shape, and same reason, as
 * `debugSurfaceFor`: the panel layer holds no seam, so the read is composed
 * here and handed down as a node. `panel-host-wiring.test.ts` scans every
 * mount for this prop.
 *
 * Creating the node reads nothing. The panel renders it only for the terminal
 * archetype, so an entity that is not a work session never starts a read.
 *
 * A HOST WITHOUT A SEAM RETURNS `undefined`, and the bar keeps exactly the
 * shape it had before: a number nobody read would be a claim, not a reading.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam, SessionLiveness } from '../data/seam';
import { SessionContextNumber } from '../transcript/SessionContextNumber';

export function sessionContextSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  livenessOf: (id: string) => SessionLiveness,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <SessionContextNumber
      // Keyed by session so a remembered "last known" sample, an open details
      // card and a fit measurement can never carry across to another session.
      key={entityId}
      seam={seam}
      sessionId={entityId as EntityId}
      live={livenessOf(entityId) === 'live'}
    />
  );
}
