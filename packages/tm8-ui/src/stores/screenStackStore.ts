/**
 * screenStackStore — one navigation stack per DETAIL SCREEN, so that leaving a
 * screen and coming back returns you to what you were looking at.
 *
 * THE DEFECT THIS EXISTS FOR (user report, 2026-07-31): every entity detail
 * screen held its open entity in a component-local `useState`
 * (`EntityView.tsx`, `ChannelView.tsx`). The menu rail switches screens by
 * swapping a branch of a ternary in `GateApp`, which UNMOUNTS the old view —
 * so the selection was not "cleared", it ceased to exist. Returning to the
 * screen rendered the attention inbox as though nothing had ever been opened.
 * `WorkspaceView` never had the bug because it reads `navStore`, which is
 * module-level and outlives any unmount. This store gives every other detail
 * screen the same property.
 *
 * WHY NOT `navStore`: that store's `stack` is the workspace's PANEL-COLUMN
 * stack — the thing pins, tab state, `contentSurface` and the C_min demotion
 * loop are all defined against, with exactly one live instance. These are
 * per-screen histories, many at once, with none of that machinery. Folding
 * them together would mean teaching every navStore selector which screen it
 * was being asked about.
 *
 * KEYED BY SCREEN INSTANCE, NOT BY KIND (user ruling): every channel gets its
 * own stack, not one shared "channels" stack — see `screenKeyOf`. This also
 * subsumes a rule EntityView used to enforce by hand. It reset its selection
 * on every kind change, with the comment "carrying a selection across kinds
 * would show a doc in the Tasks view's centre". That is still true and still
 * enforced — a doc and a task simply live under different keys now, so the
 * bleed is structurally impossible rather than swept up after the fact.
 *
 * NOT PERSISTED, and that is a decision (user ruling: in-memory only). A
 * reload starts clean. The route codec in `src/routes/` already encodes this
 * exact state — `#/s/{space}/e/{id}` with a `p` stack param — but
 * `attachRouter` has never had a non-test caller, so mounting it is a separate
 * piece of work and not a side effect of fixing this.
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EntityId } from '@tm8/contract';

/**
 * A screen's identity. `kind:` for the rail's kind screens, `channel:` for one
 * channel — the two hosts that own a detail region.
 */
export type ScreenKey = string;

export const screenKeyOf = {
  kind: (kind: string): ScreenKey => `kind:${kind}`,
  channel: (channelId: string): ScreenKey => `channel:${channelId}`,
};

/**
 * Depth cap. A stack is a history, so it grows with use and nothing else would
 * ever bound it; past this the OLDEST entry is dropped. 50 is far past any
 * plausible drill-down, so the cap is a memory backstop rather than a UX rule
 * a user could hit and be confused by.
 */
export const MAX_DEPTH = 50;

export interface ScreenStackState {
  /** screen key → entity stack, bottom → top. Absent key = empty stack. */
  stacks: Readonly<Record<ScreenKey, readonly EntityId[]>>;
}

export interface ScreenStackStore extends ScreenStackState {
  /** Open an entity on a screen — the push half of the stack. */
  open(key: ScreenKey, id: EntityId): void;
  /** Drop the top entry, revealing whatever was under it. */
  pop(key: ScreenKey): void;
  /** Empty one screen's stack (back to its attention page). */
  clear(key: ScreenKey): void;
  /**
   * Empty EVERY screen's stack. Entities are space-scoped, and this store is
   * module-level: without this, switching space or server would restore an
   * entity id belonging to the space you just left.
   */
  clearAll(): void;
}

const INITIAL: ScreenStackState = { stacks: {} };

export const screenStackStore: StoreApi<ScreenStackStore> = createStore<ScreenStackStore>()(
  (set, get) => ({
    ...INITIAL,

    open(key, id) {
      const stack = get().stacks[key] ?? [];
      const top = stack[stack.length - 1];
      // Re-opening what is already open is not a navigation.
      if (top === id) return;
      /*
       * REVISITING TRUNCATES rather than pushing a duplicate. Walking A→B→A
       * leaves [A], not [A,B,A], so Esc from there lands on the list instead
       * of on a B the user already backed out of. It also means a cycle
       * cannot grow the stack without bound.
       */
      const seen = stack.indexOf(id);
      const next = seen >= 0 ? stack.slice(0, seen + 1) : [...stack, id];
      set({
        stacks: { ...get().stacks, [key]: next.slice(-MAX_DEPTH) },
      });
    },

    pop(key) {
      const stack = get().stacks[key] ?? [];
      if (stack.length === 0) return;
      set({ stacks: { ...get().stacks, [key]: stack.slice(0, -1) } });
    },

    clear(key) {
      if (get().stacks[key] === undefined) return;
      const { [key]: _dropped, ...rest } = get().stacks;
      set({ stacks: rest });
    },

    clearAll() {
      set({ stacks: {} });
    },
  }),
);

/** The entity a screen is currently showing, or null for its empty state. */
export function topOf(state: ScreenStackState, key: ScreenKey): EntityId | null {
  const stack = state.stacks[key] ?? [];
  return stack.length > 0 ? (stack[stack.length - 1] as EntityId) : null;
}

export function stackOf(state: ScreenStackState, key: ScreenKey): readonly EntityId[] {
  return state.stacks[key] ?? [];
}

export function useScreenStackStore<T>(selector: (state: ScreenStackStore) => T): T {
  return useStore(screenStackStore, selector);
}

/**
 * The screen-side view of its own stack. Returns the open entity, whether
 * there is anything to go back TO, and the three gestures — so a host never
 * touches the store's shape or another screen's key.
 */
export function useScreenStack(key: ScreenKey) {
  const selected = useScreenStackStore((s) => topOf(s, key));
  const depth = useScreenStackStore((s) => stackOf(s, key).length);
  const store = screenStackStore.getState();
  return {
    selected,
    depth,
    /** Esc has somewhere to go back to, as opposed to somewhere to close to. */
    canGoBack: depth > 1,
    open: (id: EntityId) => store.open(key, id),
    pop: () => store.pop(key),
    clear: () => store.clear(key),
  };
}
