/**
 * The Workspace store: plain zustand, no persist middleware (persistence is
 * explicit, Spec B §8). ONE store per (viewer, space), created on first
 * mount and kept alive in a module map for the life of the app, so leaving
 * for Home and coming back preserves everything (§7 "Store lifecycle").
 * Stores are never mixed: a space or account switch simply selects another.
 *
 * `dispatch` (dispatch.ts) is the only writer.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { LAYOUT_BOUNDS, type WorkspaceState } from './types';

export type WorkspaceStore = StoreApi<WorkspaceState>;

function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** One id per page load: a window is a browser tab of the app. */
export const WINDOW_ID = newUuid();
export { newUuid };

export const DEFAULT_BROWSER_KIND = 'task';

export function initialWorkspaceState(viewerId: string, spaceId: string): WorkspaceState {
  return {
    revision: 0,
    spaceId,
    viewerId,
    windowId: WINDOW_ID,
    orderedTabIds: [],
    tabs: {},
    presentation: { surface: 'start' },
    scope: { mode: 'mixed', lastByTypeIds: [] },
    recency: [],
    rememberedActive: {},
    layout: {
      expanded: false,
      browserWidth: LAYOUT_BOUNDS.browserWidth.initial,
      chatWidth: LAYOUT_BOUNDS.chatWidth.initial,
    },
    browsers: {
      main: { kind: DEFAULT_BROWSER_KIND, perKind: { [DEFAULT_BROWSER_KIND]: { query: '', filters: null, scrollTop: 0 } } },
    },
  };
}

export function createWorkspaceStore(viewerId: string, spaceId: string): WorkspaceStore {
  return createStore<WorkspaceState>()(() => initialWorkspaceState(viewerId, spaceId));
}

export function storeKey(viewerId: string, spaceId: string): string {
  return `${viewerId}:${spaceId}`;
}

const stores = new Map<string, WorkspaceStore>();

/** The kept-alive store for (viewer, space); created on first use. */
export function getWorkspaceStore(viewerId: string, spaceId: string): WorkspaceStore {
  const key = storeKey(viewerId, spaceId);
  let store = stores.get(key);
  if (!store) {
    store = createWorkspaceStore(viewerId, spaceId);
    stores.set(key, store);
  }
  return store;
}

/** React binding over a workspace store. */
export function useWorkspaceStore<T>(store: WorkspaceStore, selector: (state: WorkspaceState) => T): T {
  return useStore(store, selector);
}
