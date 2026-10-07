/**
 * What the workspace switcher shows (API doc 01a115c4 §7.6, §10): this
 * window's view of the identity's workspaces in one space, fed by the sync
 * (capability proof, `shown`, switches, `workspace.summary`) and by the
 * bridge (the events socket's liveness).
 *
 * One store per (viewer, space), like the runtime. The switcher reads it; the
 * `g w` chord and the palette open it through `openWorkspaceSwitcher`, which
 * is a no-op with a notice while the socket is down (S13).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { WorkspaceView } from './sync';

export interface WorkspaceListState extends WorkspaceView {
  /** The events socket is live; every switcher action is disabled while it is not (S13). */
  online: boolean;
  /** The switcher's popover is open. */
  open: boolean;
  /** Forget an answered (or vanished) prompt now; the sync owns the list, so the bridge points this at it. */
  dropPrompt(promptId: string): void;
}

export type WorkspaceListStore = StoreApi<WorkspaceListState>;

/** S13: the switcher's tooltip, and the chord's notice, while offline. */
export const WORKSPACE_SWITCHER_OFFLINE = 'Workspaces are unavailable while offline';

const stores = new Map<string, WorkspaceListStore>();

export function createWorkspaceListStore(initial: Partial<WorkspaceListState> = {}): WorkspaceListStore {
  return createStore<WorkspaceListState>((set) => ({
    capable: false,
    shown: null,
    switching: false,
    listRevision: 0,
    activeWorkspaceId: null,
    items: [],
    prompts: [],
    online: false,
    open: false,
    dropPrompt: (promptId) => set((s) => ({ prompts: s.prompts.filter((p) => p.promptId !== promptId) })),
    ...initial,
  }));
}

export function getWorkspaceListStore(viewerId: string, spaceId: string): WorkspaceListStore {
  const key = `${viewerId}:${spaceId}`;
  let store = stores.get(key);
  if (!store) {
    store = createWorkspaceListStore();
    stores.set(key, store);
  }
  return store;
}

/**
 * Open the switcher (`g w`, "Switch workspace…"). False, with a notice, while
 * the socket is down (S13) or before the node has proved it knows workspaces.
 */
export function openWorkspaceSwitcher(store: WorkspaceListStore, notify: (text: string) => void): boolean {
  const { online, capable } = store.getState();
  if (!online) {
    notify(WORKSPACE_SWITCHER_OFFLINE);
    return false;
  }
  if (!capable) return false;
  store.setState({ open: true });
  return true;
}
