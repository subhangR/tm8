import { navStore } from '../stores/navStore';

/**
 * Where a missing TypeSafe key is fixed: Settings → Agent credentials, whose
 * Service keys block takes the paste (Lane K). A route, not a callback threaded
 * through every launch surface — `/settings/credentials` opens that section.
 */
export function openJevKeySettings(): void {
  navStore.getState().navigate({ view: 'settings', section: 'credentials' });
}
