/**
 * Which non-entity browser source (`adapters/browserSources.ts`) the browser
 * column shows, per space; null is the entity list for `browsers.main.kind`.
 * UI-local and persisted the way `railStore.ts` keeps the rail's choices: a
 * source is not a D7 kind, so it cannot ride `workspace.browser.set`.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

export const browserSourceKey = (spaceId: string) => `tm8.workspace.browser-source:${spaceId}`;

export interface BrowserSourceState {
  source: string | null;
  setSource(source: string | null): void;
}
export type BrowserSourceStore = StoreApi<BrowserSourceState>;

function load(spaceId: string): string | null {
  try {
    const raw = window.localStorage.getItem(browserSourceKey(spaceId));
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function createBrowserSourceStore(spaceId: string): BrowserSourceStore {
  return createStore<BrowserSourceState>()((set, get) => ({
    source: load(spaceId),
    setSource(source) {
      if (get().source === source) return;
      try {
        if (source === null) window.localStorage.removeItem(browserSourceKey(spaceId));
        else window.localStorage.setItem(browserSourceKey(spaceId), JSON.stringify(source));
      } catch {
        // No storage ⇒ the choice lasts as long as the page.
      }
      set({ source });
    },
  }));
}

const stores = new Map<string, BrowserSourceStore>();

/** The kept-alive source store for a space; read from storage on first use. */
export function getBrowserSourceStore(spaceId: string): BrowserSourceStore {
  let store = stores.get(spaceId);
  if (!store) {
    store = createBrowserSourceStore(spaceId);
    stores.set(spaceId, store);
  }
  return store;
}

/** Test seam: forget the kept-alive stores so the next read re-loads storage. */
export function resetBrowserSourceStores(): void {
  stores.clear();
}
