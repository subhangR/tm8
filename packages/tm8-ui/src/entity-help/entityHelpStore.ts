/**
 * THE ENTITY HELP STORE — which kind's help is open, on which tab, and the
 * trail that brought the reader there.
 *
 * A vanilla zustand store rather than props, for the same reason `navStore`
 * is one: the opener (the (?) mark in `ListRootHeader`, inside the LIST
 * column) and the surface (the overlay over REGION B) are in different
 * subtrees of two different hosts, and threading a callback through
 * `ChatHomeScreen`'s forty props to connect them would be plumbing for its own
 * sake. Both hosts mount `EntityHelpOverlay`, both headers call `open`, and
 * the store is the seam.
 *
 * FOCUS RESTORATION lives beside the state, not in it: the opener element is
 * held in a module variable so React never diffs a DOM node, and `close`
 * hands it back through `takeOpener` for the overlay to focus.
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { isHelpTab, type HelpTab } from './types';

export interface EntityHelpState {
  /** The kind whose help is open, or null when the overlay is closed. */
  kind: string | null;
  tab: HelpTab;
  /**
   * The kinds visited before this one through the Constellation, oldest
   * first — the "back" affordance's data. Cleared on close.
   */
  trail: readonly string[];
}

export interface EntityHelpActions {
  /** Open (or switch to) a kind's help. Resets the trail; keeps the tab. */
  open(kind: string, tab?: HelpTab): void;
  /** Open a neighbour from the Constellation: the current kind joins the trail. */
  openNeighbour(kind: string): void;
  /** Return to the previous kind on the trail; no-op when the trail is empty. */
  back(): void;
  setTab(tab: HelpTab): void;
  close(): void;
}

export type EntityHelpStore = EntityHelpState & EntityHelpActions;

let opener: HTMLElement | null = null;

/** Remember the element to return focus to when the overlay closes. */
export function rememberOpener(element: HTMLElement | null): void {
  opener = element;
}

/** The remembered opener, cleared on read. */
export function takeOpener(): HTMLElement | null {
  const el = opener;
  opener = null;
  return el;
}

export const entityHelpStore: StoreApi<EntityHelpStore> = createStore<EntityHelpStore>()((set, get) => ({
  kind: null,
  tab: 'story',
  trail: [],
  open: (kind, tab) => set({ kind, trail: [], ...(tab && isHelpTab(tab) ? { tab } : {}) }),
  openNeighbour: (kind) => {
    const { kind: current, trail } = get();
    if (current === null || current === kind) return set({ kind });
    set({ kind, trail: [...trail, current] });
  },
  back: () => {
    const { trail } = get();
    if (trail.length === 0) return;
    set({ kind: trail[trail.length - 1] ?? null, trail: trail.slice(0, -1) });
  },
  setTab: (tab) => set({ tab }),
  close: () => set({ kind: null, trail: [] }),
}));

export function useEntityHelp<T>(selector: (state: EntityHelpStore) => T): T {
  return useStore(entityHelpStore, selector);
}

/** Open a kind's help from a control — remembers the control for focus return. */
export function openEntityHelp(kind: string, from?: HTMLElement | null): void {
  rememberOpener(from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  entityHelpStore.getState().open(kind);
}

/** Test seam: back to closed, no trail, story tab. */
export function resetEntityHelp(): void {
  opener = null;
  entityHelpStore.setState({ kind: null, tab: 'story', trail: [] });
}
