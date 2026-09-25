/**
 * THE CHAT VERB'S DISPATCH (design 01a0da4e §3.2, Q1): open the slot about
 * this entity, on the CURRENT surface, reopening its most recent chat — or
 * the composer when it has none.
 *
 * The header button and the row hover verb both land here, so the two cannot
 * disagree about which chat "Chat" means.
 */
import type { EntityId } from '@tm8/contract';
import type { ChatSlot, NavView } from '../routes';
import { navStore } from '../stores/navStore';
import { readChatsAbout, type ChatAboutRow, type ChatsAboutSeam } from './chatsAbout';

/** `{about, thread: latest ?? 'new'}` from a list already in hand. */
export function chatSlotFor(aboutId: EntityId, chats: readonly ChatAboutRow[]): ChatSlot {
  return { about: aboutId, thread: chats[0]?.id ?? 'new' };
}

/** Read the chats about `aboutId`, then open the slot (a history PUSH). */
export async function openEntityChat(seam: ChatsAboutSeam, aboutId: EntityId): Promise<ChatSlot> {
  const slot = chatSlotFor(aboutId, await readChatsAbout(seam, aboutId));
  navStore.getState().openChat(slot);
  return slot;
}

/**
 * WHICH SURFACES DRAW THE SLOT IN THEIR OWN LAYOUT — the seam lanes D and E
 * flip (§3.1: Home's third column / overlay, Work's centre, the phone sheet).
 *
 * `false` for every other surface: until a layout hosts the slot itself, the
 * shell's `EntityChatDock` draws it as a sheet from the right over whatever
 * is on screen, so the verb is usable end to end everywhere. A lane that
 * hosts the slot returns `true` for its view here and mounts `EntityChatSlot`
 * in its own layout; the dock then stands aside on that view by itself.
 */
export function surfaceHostsChatSlot(view: NavView): boolean {
  /* Home: the third column / <1200px overlay (lane D, `HomeView`).
     Work: the slot replaces the centre panel stack (`WorkspaceView`).
     The phone never mounts the dock at all — `MobileShell` hosts its own sheet. */
  return view.view === 'home' || view.view === 'workspace';
}
