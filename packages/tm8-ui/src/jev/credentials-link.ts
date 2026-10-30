import type { CredentialsServiceKeysStatusView } from '@tm8/contract';

import { navStore } from '../stores/navStore';

/**
 * Whether ✦ has a TypeSafe key to ask with — the viewer's own, else the
 * node's fallback (`credentials.serviceKeys.status`). Null when this node keeps
 * no key store at all: unknown, so ✦ stays in colour until an ask says
 * `no_key`. One reading of the status, for the launch card's ✦ and for the
 * port that decides which answers are worth remembering.
 */
export function jevKeyUsable(view: CredentialsServiceKeysStatusView): boolean | null {
  if (view.store === 'absent') return null;
  const key = view.keys.find((k) => k.provider === 'typesafe');
  return Boolean(key && (key.connected || key.nodeFallback));
}

/**
 * Where a missing TypeSafe key is fixed: Settings → Agent credentials, whose
 * Service keys block takes the paste (Lane K). A route, not a callback threaded
 * through every launch surface — `/settings/credentials` opens that section.
 */
export function openJevKeySettings(): void {
  navStore.getState().navigate({ view: 'settings', section: 'credentials' });
}
