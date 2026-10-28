/**
 * THE BROWSER STORE — guarded access to this origin's localStorage, for the
 * per-browser launch accelerators: the launch-source cache, the launch
 * recents, the launch defaults cache and the remembered picks.
 *
 * CONTRACT
 *  - `browserStorage()` returns the store, or null when there is none to use.
 *    It NEVER throws: private-mode Safari throws on write, a full quota throws
 *    on write, and a disabled-storage policy throws on READ. None of those may
 *    reach boot or a launch — every caller is an accelerator, and an
 *    accelerator that can break the workspace is worse than none.
 *  - `forgetKeysWithPrefix(prefix)` drops every key under a prefix — what an
 *    explicit sign-out owes each store keyed by node and space, never by
 *    account. It snapshots the keys BEFORE removing any: `key(i)` walks a live
 *    index, and deleting mid-walk skips entries.
 *
 * Writes stay with the callers, each inside its own try: what a refused write
 * costs (a lost ordering hint, a cold first frame) is theirs to state.
 */

export function browserStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function forgetKeysWithPrefix(prefix: string): void {
  const store = browserStorage();
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    // Storage refused. Nothing stored, nothing to forget.
  }
}
