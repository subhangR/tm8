/**
 * Start surface (Spec A §13): "No open tabs" (By type: "No open tabs for the
 * selected types" + Change tab scope), search, Recent, New <kind> — the
 * chooser body rendered without a tab.
 *
 * `restoreSlot` holds "Restore N tabs from your last session" (W2-I's
 * `RestoreOffer`, the default); it renders under the heading, above the search.
 */
import type { ReactNode } from 'react';
import { ActiveSessions } from './ActiveSessions';
import { Chooser } from './Chooser';
import { RestoreOffer } from './RestoreOffer';

export function StartSurface({ restoreSlot = <RestoreOffer /> }: { restoreSlot?: ReactNode } = {}) {
  return (
    <div className="tws-startsurface" data-testid="tws-start">
      <Chooser tabId={null} variant="start" restoreSlot={restoreSlot} afterRecent={<ActiveSessions />} />
    </div>
  );
}
