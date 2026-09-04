import type { ReactNode } from 'react';
import { AlwaysDark } from './AlwaysDark';

/**
 * THE RESERVED TOOLBAR SEAM (RULING K, LLD §9.3).
 *
 * A 34px row above the chrome strip that is NEARLY EMPTY in Phase 1 and
 * renders ALWAYS. Both halves of that sentence are the point:
 *
 *   · it renders always, because reserving the height is the entire mechanism
 *     by which the surface switch landed "without relayout". A row that
 *     appears only once it has content would have shifted the terminal down
 *     the day the switch shipped — the relayout the ruling exists to prevent;
 *   · it is nearly empty, because the switch itself lives in the panel bar
 *     (it portals into `.pn-panelbar__surface`), not here. This seam holds
 *     height and hosts the toolbar drop target; it never grew a second copy
 *     of the switch.
 *
 * So the seam takes real Phase-1 content only: the session's share-context
 * drop target (§8 names the toolbar as a drop target). It never advertises
 * the surface switch.
 */
export function ReservedToolbarSeam({ children }: { children?: ReactNode }) {
  return (
    <AlwaysDark>
      <div className="term-seam" data-testid="reserved-toolbar-seam">
        {children}
      </div>
    </AlwaysDark>
  );
}
