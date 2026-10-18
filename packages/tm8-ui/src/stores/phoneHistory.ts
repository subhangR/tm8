/**
 * phoneHistory — THE ENTRIES THIS TAB HAS WALKED, as the phone's ‹ needs them.
 *
 * CONTRACT §5 rulings 1, 4-6 (owner, 2026-10-18). Back is real browser history,
 * so the phone does not keep a second history: this is a PROJECTION of the one
 * the router writes, recorded from `attachRouter`'s own write and read paths
 * and never from a screen. It answers the three questions the phone's chrome
 * has to answer and the browser will not:
 *
 *   1. Is there an entry of OURS directly below this one? Then ‹ is Back
 *      (`history.back()`), and the page below comes back with its scroll and
 *      its draft (ruling 5).
 *   2. Is the entry below the drawer's Chat floor (ruling 3: a drawer
 *      destination resets the stack to [Chat, destination])? Then ‹ replaces
 *      this page with Chat.
 *   3. Neither — a cold link, or a walk older than the cap? Then ‹ is Up, and
 *      Up REPLACES the page with its kind's list (ruling 4).
 *
 * A destination is keyed by WHAT IT SHOWS (`destKeyOf`), not by its hash, so a
 * list's sort or a board's grouping does not make "the entry below" a
 * different place, and so a link can ask "is my target the entry directly
 * below?" — ruling 6: that link acts as Back.
 *
 * CAPPED AT 12 and the oldest drops (ruling 5). The browser keeps its own
 * entries past that; walking back beyond the cap arrives somewhere this
 * projection no longer holds, which it treats as a fresh start — ‹ is then Up,
 * the honest answer for a place we no longer have a page for.
 *
 * Desktop records into this too (the router is shared) and never reads it.
 * Bookkeeping only: nothing here writes an address.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { NavView } from '../routes/types';

export const PHONE_STACK_CAP = 12;

/** One scroller's offset, found again by its child-index path from the content root. */
export interface SavedScroll {
  readonly path: readonly number[];
  readonly top: number;
}
/** One composer's unsent text, found the same way. */
export interface SavedDraft {
  readonly path: readonly number[];
  readonly value: string;
}
export interface EntryPlace {
  readonly scrolls: readonly SavedScroll[];
  readonly drafts: readonly SavedDraft[];
}

export interface PhoneEntry {
  /** Unique per visit: a page popped and pushed again is a new entry with no place. */
  readonly seq: number;
  readonly dest: string;
  readonly place: EntryPlace | null;
}

/** How the top entry was last reached — the screen picks its slide from it. */
export type PhoneNavOp = 'push' | 'pop' | 'replace' | 'none';

export interface PhoneHistoryState {
  readonly entries: readonly PhoneEntry[];
  /** True after a drawer reset, while the bottom entry is the drawer's destination. */
  readonly chatFloor: boolean;
  readonly lastOp: PhoneNavOp;
}

const INITIAL: PhoneHistoryState = { entries: [], chatFloor: false, lastOp: 'none' };

export const phoneHistory: StoreApi<PhoneHistoryState> = createStore<PhoneHistoryState>()(() => INITIAL);

let seq = 0;
const entry = (dest: string): PhoneEntry => ({ seq: ++seq, dest, place: null });

/** Forward entries a Back walked past, so Forward finds their places again. */
let ahead: PhoneEntry[] = [];

/**
 * What a view SHOWS, for "is this the same place". Query state (sort, filter,
 * grouping, a message anchor) is not part of it: those are ways of looking at
 * one place, and none of them should turn ‹ into a push.
 */
export function destKeyOf(view: NavView): string {
  switch (view.view) {
    case 'entity':
      return `e:${view.entityId}`;
    case 'kind':
      return `k:${view.slug}`;
    case 'channel':
      return `c:${view.channelId}`;
    case 'voice':
      return `r:${view.voiceChannelId}`;
    default:
      return `v:${view.view}`;
  }
}

/** The router pushed an entry. */
export function recordPush(view: NavView): void {
  const dest = destKeyOf(view);
  const { entries } = phoneHistory.getState();
  if (entries[entries.length - 1]?.dest === dest) return;
  ahead = [];
  const next = [...entries, entry(dest)];
  const dropped = next.length > PHONE_STACK_CAP;
  phoneHistory.setState((s) => ({
    entries: next.slice(-PHONE_STACK_CAP),
    /* The floor sat under the bottom entry; once that entry is gone, so is it. */
    chatFloor: s.chatFloor && !dropped,
    lastOp: 'push',
  }));
}

/** The router replaced the current entry (a settle, a step up, a redirect). */
export function recordReplace(view: NavView): void {
  const dest = destKeyOf(view);
  const { entries } = phoneHistory.getState();
  const top = entries[entries.length - 1];
  if (top?.dest === dest) return;
  phoneHistory.setState({
    entries: [...entries.slice(0, -1), entry(dest)],
    lastOp: 'replace',
  });
}

/**
 * The ADDRESS moved on its own — back, forward, a pasted hash, the first read.
 * Back is recognised as the entry directly below; Forward as the entry Back
 * last walked past. Anything else starts over from here (a cold arrival).
 */
export function recordInbound(view: NavView): void {
  const dest = destKeyOf(view);
  const { entries } = phoneHistory.getState();
  const top = entries[entries.length - 1];
  if (top?.dest === dest) return;
  const below = entries[entries.length - 2];
  if (below?.dest === dest) {
    if (top) ahead = [top, ...ahead];
    phoneHistory.setState({ entries: entries.slice(0, -1), lastOp: 'pop' });
    return;
  }
  const forward = ahead[0];
  if (forward?.dest === dest) {
    ahead = ahead.slice(1);
    phoneHistory.setState({ entries: [...entries, forward].slice(-PHONE_STACK_CAP), lastOp: 'push' });
    return;
  }
  ahead = [];
  phoneHistory.setState({ entries: [entry(dest)], chatFloor: false, lastOp: 'none' });
}

/**
 * A drawer destination is top-level navigation (ruling 3): the stack becomes
 * [Chat, destination]. Called just before the drawer navigates, so the push
 * that follows lands as the only entry above the floor.
 */
export function resetToChatFloor(): void {
  ahead = [];
  phoneHistory.setState({ entries: [], chatFloor: true });
}

/** Keep where the reader is on the top entry, as they move. */
export function saveTopPlace(place: EntryPlace): void {
  const { entries } = phoneHistory.getState();
  const top = entries[entries.length - 1];
  if (!top) return;
  phoneHistory.setState({ entries: [...entries.slice(0, -1), { ...top, place }] });
}

/** What ‹ does from here. See the module head for the three answers. */
export type BackStep = 'back' | 'chat' | 'up';

export function backStepOf(state: PhoneHistoryState): BackStep {
  if (state.entries.length > 1) return 'back';
  if (state.chatFloor) return 'chat';
  return 'up';
}

/** Is `view` the entry directly below the top? Then a link to it is Back (ruling 6). */
export function isDirectlyBelow(view: NavView): boolean {
  const { entries } = phoneHistory.getState();
  return entries.length > 1 && entries[entries.length - 2]!.dest === destKeyOf(view);
}

export function topEntry(state: PhoneHistoryState = phoneHistory.getState()): PhoneEntry | null {
  return state.entries[state.entries.length - 1] ?? null;
}

export function usePhoneHistory<T>(selector: (state: PhoneHistoryState) => T): T {
  return useStore(phoneHistory, selector);
}

/** Test seam. */
export function resetPhoneHistory(): void {
  ahead = [];
  phoneHistory.setState(INITIAL, true);
}
