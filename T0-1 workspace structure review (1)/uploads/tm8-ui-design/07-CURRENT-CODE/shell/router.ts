/**
 * router — hash URL ⇄ nav-store sync.
 *
 * The nav store already owns the codec (`toHash` / `hydrateFromHash`), so the
 * router is only a transport: it pushes a history entry whenever the
 * addressable part of the store changes, and re-hydrates the store whenever
 * the location changes underneath it. That makes browser back/forward exactly
 * "graph browsing history" — every panel push, pin and promote is an entry.
 *
 *   #/s/{space}/{view}
 *   #/s/{space}/e/{entityId}
 *   ...?p=stack.ids&pin=pinned.ids&t=id:tab
 *
 * The transport is injectable (`RouterTarget`) so history walks are testable
 * without a real browser: see `createMemoryTarget`.
 */
import { useNavStore, type NavState } from '../stores/nav';

export interface RouterTarget {
  getHash(): string;
  /** Push a history entry, or overwrite the current one when `replace`. */
  setHash(hash: string, opts?: { replace?: boolean }): void;
  /** Fires when the location changes from *outside* the app (back/forward). */
  subscribe(cb: (hash: string) => void): () => void;
}

/** True for hashes the nav store knows how to hydrate. */
export function isRoutableHash(hash: string): boolean {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const segs = raw.split('?')[0].split('/').filter(Boolean);
  return segs[0] === 's' && Boolean(segs[1]);
}

// --- transports ---------------------------------------------------------------

export function createBrowserTarget(win: Window = window): RouterTarget {
  return {
    getHash: () => win.location.hash || '#/',
    setHash: (hash, opts = {}) => {
      if (opts.replace) {
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
  const target: MemoryTarget = {
    entries: [initial],
    index: 0,
    getHash: () => target.entries[target.index],
    setHash: (hash, opts = {}) => {
      if (target.entries[target.index] === hash) return;
      if (opts.replace) {
        target.entries[target.index] = hash;
        return;
      }
      target.entries = [...target.entries.slice(0, target.index + 1), hash];
      target.index += 1;
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    canGoBack: () => target.index > 0,
    canGoForward: () => target.index < target.entries.length - 1,
    back: () => {
      if (!target.canGoBack()) return;
      target.index -= 1;
      for (const cb of listeners) cb(target.getHash());
    },
    forward: () => {
      if (!target.canGoForward()) return;
      target.index += 1;
      for (const cb of listeners) cb(target.getHash());
    },
  };
  return target;
}

// --- the sync loop --------------------------------------------------------------

/** Only these fields are addressable — palette/selection must not push history. */
function routeKey(s: NavState): string {
  return JSON.stringify([s.spaceId, s.view, s.entityId, s.stack, s.pinned]);
}

export interface RouterOptions {
  /**
   * Applied when the initial location carries no route (`#/`). Without it the
   * router just publishes whatever the store already holds.
   */
  fallbackHash?: string;
}

/**
 * Wire the store to a history transport. Returns the teardown.
 *
 * On start it deep-links: a routable initial hash hydrates the store (stack and
 * pins included) before anything renders, so a pasted URL reproduces the whole
 * layout — otherwise the store's current state is written to the URL.
 */
export function startRouter(target: RouterTarget, opts: RouterOptions = {}): () => void {
  const store = useNavStore;
  let applying = false;
  let lastHash = '';

  const initial = target.getHash();
  if (isRoutableHash(initial)) {
    applying = true;
    store.getState().hydrateFromHash(initial);
    applying = false;
    // Re-publish: hydration normalizes (e.g. pins past the cap are dropped).
    lastHash = store.getState().toHash();
    target.setHash(lastHash, { replace: true });
  } else if (opts.fallbackHash && isRoutableHash(opts.fallbackHash)) {
    applying = true;
    store.getState().hydrateFromHash(opts.fallbackHash);
    applying = false;
    lastHash = store.getState().toHash();
    target.setHash(lastHash, { replace: true });
  } else {
    lastHash = store.getState().toHash();
    target.setHash(lastHash, { replace: true });
  }

  const unsubStore = store.subscribe((state, prev) => {
    if (applying) return;
    if (routeKey(state) === routeKey(prev)) return;
    const hash = state.toHash();
    if (hash === lastHash) return;
    lastHash = hash;
    target.setHash(hash);
  });

  const unsubTarget = target.subscribe((hash) => {
    if (hash === lastHash) return;
    lastHash = hash;
    if (!isRoutableHash(hash)) return;
    applying = true;
    try {
      store.getState().hydrateFromHash(hash);
    } finally {
      applying = false;
    }
  });

  return () => { unsubStore(); unsubTarget(); };
}

/** Build a hash without touching the store — for links, share menus, tests. */
export function buildHash(input: {
  spaceId: string;
  view?: NavState['view'];
  entityId?: string | null;
  stack?: string[];
  pinned?: string[];
}): string {
  const enc = encodeURIComponent;
  const view = input.view ?? 'home';
  const base = view === 'entity' || view === 'channel'
    ? `#/s/${enc(input.spaceId)}/e/${enc(input.entityId ?? '')}`
    : `#/s/${enc(input.spaceId)}/${view}`;
  const params = new URLSearchParams();
  if (input.stack?.length) params.set('p', input.stack.map(enc).join('.'));
  if (input.pinned?.length) params.set('pin', input.pinned.map(enc).join('.'));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
