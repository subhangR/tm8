import type { ReactNode } from 'react';
import { AlwaysDark } from './AlwaysDark';

/**
 * THE RESERVED TOOLBAR SEAM (RULING K, LLD §9.3).
 *
 * A 34px row above the chrome strip that is NEARLY EMPTY in Phase 1 and
 * renders ALWAYS. Both halves of that sentence are the point:
 *
 *   · it renders always, because reserving the height now is the entire
 *     mechanism by which the Phase-2 `[ Terminal | Chat ]` switch lands
 *     "without relayout". A row that appears only once it has content would
 *     shift the terminal down the day chat ships — which is the relayout the
 *     ruling exists to prevent;
 *   · it is nearly empty, because D12 clamps Phase 1 to the terminal surface
 *     with CHAT §5.1's UNFLAVORED presentation: no switch, no "coming soon",
 *     no error copy, no empty Chat tab. A `contentSurface=…:chat` URL is
 *     preserved and round-trips untouched, and the rendering simply shows
 *     terminal — the link is honored, not lied about, when Phase 2 lands.
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
