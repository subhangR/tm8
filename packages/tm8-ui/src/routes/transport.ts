/**
 * Router TRANSPORT (LLD §14: the one harvested piece of the old router).
 *
 * Harvested pattern: `collab-v2/shell/router.ts:36-97` — `createBrowserTarget`
 * / `createMemoryTarget`. The old `startRouter` loop is hard-coupled to the old
 * nav store and is rebuilt fresh (see `src/stores/navStore.ts`); `buildHash` in
 * the same file is CONDEMNED and is not here.
 *
 * One correction to the harvested memory target: the original notified
 * subscribers only on back/forward, so a test double could not drive the sync
 * loop through a push. This one notifies on every hash change, which is what
 * the browser target does.
 */

export interface RouterTarget {
  getHash(): string;
  setHash(hash: string, opts?: { replace?: boolean }): void;
  subscribe(cb: (hash: string) => void): () => void;
  /**
   * How many entries are behind this one, so a caller can tell a COLD ENTRY
   * (someone arrived here by pasting a link — depth 1, nothing to go back to)
   * from a walk that reached the same address.
   *
   * That distinction is R15, and it cannot be derived from the hash: the two
   * cases produce identical addresses and opposite meanings for the back
   * affordance. Optional so a bare `RouterTarget` still satisfies the shape;
   * both real implementations provide it.
   */
  historyDepth?(): number;
}

export function createBrowserTarget(win: Window = window): RouterTarget {
  return {
    getHash: () => win.location.hash || '#/',
    setHash: (hash, opts = {}) => {
      if (opts.replace) {
        // replaceState keeps the settle out of the back stack (LLD §6 history
        // discipline: normalization never creates a history entry).
        win.history.replaceState(null, '', hash);
      } else if (win.location.hash !== hash) {
        win.location.hash = hash;
      }
    },
    subscribe: (cb) => {
      const handler = () => cb(win.location.hash || '#/');
      win.addEventListener('hashchange', handler);
      return () => win.removeEventListener('hashchange', handler);
    },
    historyDepth: () => win.history.length,
  };
}

export interface MemoryTarget extends RouterTarget {
  entries: string[];
  index: number;
  back(): void;
  forward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
}

/** In-memory history stack — the test double for back/forward walks. */
export function createMemoryTarget(initial = '#/'): MemoryTarget {
  const listeners = new Set<(hash: string) => void>();
  const notify = () => {
    for (const cb of listeners) cb(target.getHash());
  };
  const target: MemoryTarget = {
    entries: [initial],
    index: 0,
    getHash: () => target.entries[target.index],
    setHash: (hash, opts = {}) => {
      if (target.entries[target.index] === hash) return;
      if (opts.replace) {
        target.entries[target.index] = hash;
      } else {
        target.entries = [...target.entries.slice(0, target.index + 1), hash];
        target.index += 1;
      }
      notify();
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    historyDepth: () => target.entries.length,
    canGoBack: () => target.index > 0,
    canGoForward: () => target.index < target.entries.length - 1,
    back: () => {
      if (!target.canGoBack()) return;
      target.index -= 1;
      notify();
    },
    forward: () => {
      if (!target.canGoForward()) return;
      target.index += 1;
      notify();
    },
  };
  return target;
}
