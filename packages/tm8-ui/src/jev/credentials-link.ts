import type { CredentialsSpaceListView } from '@tm8/contract';

import { navStore } from '../stores/navStore';

/**
 * Where a missing TypeSafe key is fixed: Space → Credentials, which takes a
 * `typesafe` paste (credentials spec 01a0e248 decision 10). Ask Jev spends the
 * space's key only — my_default, else the space default — so this is the one
 * place a key can come from. A route, not a callback threaded through every
 * launch surface — `/settings/space-credentials` opens that section.
 */
export function openJevKeySettings(): void {
  navStore.getState().navigate({ view: 'settings', section: 'space-credentials' });
}

/** Whether ✦ has a key to spend in this space, as far as the viewer's list can say. */
export type JevKeyState = 'yes' | 'none' | 'unknown';

/**
 * ✦'s key, read from the space's credential list BEFORE the first click. The
 * server's ladder is my_default → space default → no_key. The list shows
 * every credential the viewer could spend (their own, private ones included,
 * and every public one — the space default is always public), so:
 *
 *   · no live `typesafe` row at all ⇒ `none`: nothing on the ladder can answer;
 *   · a live `typesafe` space default ⇒ `yes`;
 *   · otherwise `unknown`: the viewer may hold a my_default, which the list
 *     does not mark, so ✦ stays in colour until an ask says no_key.
 */
export function jevKeyStateOf(list: CredentialsSpaceListView): JevKeyState {
  const live = list.credentials.filter((c) => c.provider === 'typesafe' && c.status !== 'revoked');
  if (live.length === 0) return 'none';
  return live.some((c) => c.isDefault && c.status === 'active') ? 'yes' : 'unknown';
}
