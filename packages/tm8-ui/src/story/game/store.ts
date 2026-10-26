/**
 * THE GAME'S SAVE — per story, kept across remounts and reloads. The world is
 * rebuilt from the page on every read; what the page cannot tell us is where
 * the PLAYER stands, which places they have REVEALED (walked near) and which
 * they have VISITED (opened). Those three, plus which VIEW the story opens in
 * (the normal page or the game), round-trip localStorage the way
 * `homeRailStore` does: storage that fails is a cold start, not an error.
 */
import { createStore, useStore } from 'zustand';

// 'story' remains the persisted key for the Graph tab.
export type StoryViewMode = 'story' | 'tree' | 'game';

export interface StoryGameSave {
  x: number;
  z: number;
  revealed: string[];
  visited: string[];
}

interface StoryGameState {
  mode: Record<string, StoryViewMode>;
  saves: Record<string, StoryGameSave>;
  setMode: (storyId: string, mode: StoryViewMode) => void;
  reveal: (storyId: string, ids: readonly string[]) => void;
  visit: (storyId: string, id: string) => void;
  savePosition: (storyId: string, x: number, z: number) => void;
  reset: (storyId: string) => void;
  resetAll: () => void;
}

const KEY = 'tm8.story-game.v1';
/** Where a new game starts: in front of the hub, not on top of it. */
export const HOME = { x: 0, z: 2.6 } as const;
const EMPTY_SAVE: StoryGameSave = { x: HOME.x, z: HOME.z, revealed: [], visited: [] };

function load(): Pick<StoryGameState, 'mode' | 'saves'> {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(KEY);
    if (!raw) return { mode: {}, saves: {} };
    const parsed = JSON.parse(raw) as Partial<Pick<StoryGameState, 'mode' | 'saves'>>;
    return { mode: parsed.mode ?? {}, saves: parsed.saves ?? {} };
  } catch {
    return { mode: {}, saves: {} };
  }
}

function persist(state: StoryGameState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ mode: state.mode, saves: state.saves }));
  } catch {
    /* storage full or unavailable: the next session starts cold */
  }
}

export const storyGameStore = createStore<StoryGameState>()((set, get) => ({
  ...load(),
  setMode: (storyId, mode) => set((s) => (s.mode[storyId] === mode ? {} : { mode: { ...s.mode, [storyId]: mode } })),
  reveal: (storyId, ids) => {
    const save = get().saves[storyId] ?? EMPTY_SAVE;
    const fresh = ids.filter((id) => !save.revealed.includes(id));
    if (!fresh.length) return;
    set((s) => ({ saves: { ...s.saves, [storyId]: { ...save, revealed: [...save.revealed, ...fresh] } } }));
  },
  visit: (storyId, id) => {
    const save = get().saves[storyId] ?? EMPTY_SAVE;
    const revealed = save.revealed.includes(id) ? save.revealed : [...save.revealed, id];
    const visited = save.visited.includes(id) ? save.visited : [...save.visited, id];
    if (revealed === save.revealed && visited === save.visited) return;
    set((s) => ({ saves: { ...s.saves, [storyId]: { ...save, revealed, visited } } }));
  },
  savePosition: (storyId, x, z) => {
    const save = get().saves[storyId] ?? EMPTY_SAVE;
    if (Math.abs(save.x - x) < 0.05 && Math.abs(save.z - z) < 0.05) return;
    set((s) => ({ saves: { ...s.saves, [storyId]: { ...save, x, z } } }));
  },
  reset: (storyId) =>
    set((s) => {
      const saves = { ...s.saves };
      delete saves[storyId];
      return { saves };
    }),
  resetAll: () => set({ mode: {}, saves: {} }),
}));

storyGameStore.subscribe(persist);

export function useStoryGameStore<T>(selector: (s: StoryGameState) => T): T {
  return useStore(storyGameStore, selector);
}

export function useStoryViewMode(storyId: string): StoryViewMode {
  return useStoryGameStore((s) => s.mode[storyId] ?? 'story');
}

export function useStoryGameSave(storyId: string): StoryGameSave {
  return useStoryGameStore((s) => s.saves[storyId] ?? EMPTY_SAVE);
}
