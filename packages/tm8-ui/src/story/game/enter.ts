/**
 * DRILLING IN AND CLIMBING OUT (task 01a1090f). Opening a child story's portal
 * ENTERS its map: the child is saved as a game-mode story and the navStore is
 * moved onto it, so the page that hosts the story swaps to the child and
 * mounts it straight into the game. Ordinary places are not this — they go to
 * the page's `open` port as an Inspect, beside the map.
 *
 * WHICH ROUTE. When this story is the routed entity (`e/{id}?origin=…` on the
 * kind screen, `e/{id}?full=1` in the full view) the child takes its place in
 * the SAME shape — the same origin, the same full flag — so the surface does
 * not change under the player; the parent's graph filter (`hops`/`kinds`) is
 * the parent's and is dropped. Anywhere else (a workspace column, an aux
 * panel) the child opens in the full view, which is what the nav port's
 * promote does for a kind that built one.
 *
 * CLIMBING OUT. Esc from a child goes UP to its parent. When the child was
 * entered from that parent and nothing has moved the navStore since, the step
 * up IS the browser's previous entry, so it is `history.back()` and the
 * address history stays [parent, child] rather than growing a third entry.
 * Any other arrival (a pasted link, a crumb, a reload) navigates to the parent
 * in the same route shape. Either way the parent's StoryGame remounts from its
 * own save — its position, its fog — and its mode is still `game`.
 */
import type { EntityId } from '@tm8/contract';
import { navStore } from '../../stores/navStore';
import { storyGameStore } from './store';

type NavView = ReturnType<typeof navStore.getState>['view'];

/** The route that shows `storyId` in place of the routed `current` story. */
export function storyRoute(current: NavView, fromId: string, storyId: string): NavView {
  if (current.view === 'entity' && current.entityId === fromId) {
    const { hops: _hops, kinds: _kinds, ...shape } = current;
    return { ...shape, entityId: storyId as EntityId };
  }
  return { view: 'entity', entityId: storyId as EntityId, origin: null, full: true };
}

/** The last drill-in, and the navStore revision it left behind. In memory only. */
let entry: { from: string; to: string; revision: number } | null = null;

export function enterStory(fromId: string, childId: string): void {
  storyGameStore.getState().setMode(childId, 'game');
  const nav = navStore.getState();
  nav.navigate(storyRoute(nav.view, fromId, childId));
  entry = { from: fromId, to: childId, revision: navStore.getState().revision };
}

/** Esc from a child story: up to `parentId`, in game mode. */
export function leaveStory(storyId: string, parentId: string): void {
  storyGameStore.getState().setMode(parentId, 'game');
  const nav = navStore.getState();
  const stepBack = entry !== null && entry.from === parentId && entry.to === storyId && entry.revision === nav.revision;
  entry = null;
  if (stepBack && typeof window !== 'undefined') window.history.back();
  else nav.navigate(storyRoute(nav.view, storyId, parentId));
}

/** Whether `storyId` is the entity the navStore routes to — the page the Esc belongs to. */
export function isRoutedStory(storyId: string): boolean {
  const view = navStore.getState().view;
  return view.view === 'entity' && view.entityId === storyId;
}

/** Test seam: forget the last drill-in. */
export function resetEntry(): void {
  entry = null;
}
