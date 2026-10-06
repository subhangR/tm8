/**
 * Start surface (Spec A §13): "No open tabs" (By type: "No open tabs for the
 * selected types" + Change tab scope), search, Recent, New <kind> — the
 * chooser body rendered without a tab.
 *
 * `restoreSlot` is W2-I's seam for "Restore N tabs from your last session";
 * it renders under the heading, above the search.
 */
import type { ReactNode } from 'react';
import { Chooser } from './Chooser';

export function StartSurface({ restoreSlot }: { restoreSlot?: ReactNode } = {}) {
  return (
    <div className="tws-startsurface" data-testid="tws-start">
      <Chooser tabId={null} variant="start" restoreSlot={restoreSlot} />
    </div>
  );
}
