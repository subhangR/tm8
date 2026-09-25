/**
 * THE CHAT BUTTON'S COUNT, shaped for `EntityDetailPanel.primaryCounts`
 * (design 01a0da4e §3.2: `❝ Chat · 3`, detail header only).
 *
 * A hook for hosts that render one detail panel, and a render-prop component
 * for a host that renders several from a callback (the workspace), where a
 * hook cannot be called.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ActionRef } from '../domain';
import { useChatsAbout, type ChatsAboutSeam } from './chatsAbout';

export type PrimaryCounts = Partial<Record<ActionRef, number>>;

/** `undefined` until the read lands — the button draws plain "Chat" until then. */
export function useChatCounts(seam: ChatsAboutSeam | null | undefined, aboutId: string | null | undefined): PrimaryCounts | undefined {
  const { chats } = useChatsAbout(seam, aboutId ? (aboutId as EntityId) : null);
  return chats ? { 'chat-about': chats.length } : undefined;
}

export function WithChatCounts({
  seam,
  aboutId,
  children,
}: {
  seam: ChatsAboutSeam | null | undefined;
  aboutId: string | null | undefined;
  children: (counts: PrimaryCounts | undefined) => ReactNode;
}) {
  return <>{children(useChatCounts(seam, aboutId))}</>;
}
