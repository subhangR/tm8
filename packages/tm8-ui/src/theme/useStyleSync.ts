/**
 * Mount the style sync for a signed-in shell (styles spec v8 §1.6). ONE owner,
 * like `useTheme`: `GateApp` calls it for both shells, so desktop and phone
 * paint from the same prefs and the same event subscription.
 */
import { useEffect } from 'react';

import { setStyleSyncSpace, startStyleSync, type StyleSyncSeam } from './style-sync';

export function useStyleSync(
  seam: StyleSyncSeam | null | undefined,
  spaceId: string | null,
  viewerMemberId: string | null,
): void {
  /* Restarted only when the SEAM changes (another server, a fresh sign-in).
     A space switch is a cheap update below, not a re-read of the prefs. */
  useEffect(() => {
    if (!seam) return undefined;
    return startStyleSync(seam, { spaceId, viewerMemberId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seam]);

  useEffect(() => {
    setStyleSyncSpace(spaceId, viewerMemberId);
  }, [spaceId, viewerMemberId]);
}
