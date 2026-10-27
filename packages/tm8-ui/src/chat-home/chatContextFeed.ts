/**
 * THE OPEN CHAT'S CONTEXT READING, for a host that draws it outside the screen.
 *
 * The chat screen already holds the reading the header draws — the chat's
 * stored one, replaced by each live `chat.context` frame. In a Workspace chat
 * tab the screen runs solo, without that header, and the reading belongs in
 * the tab's action strip, which is not inside the screen's tree (a kept chat
 * screen is not even inside the tab's). So the screen publishes what it holds,
 * per chat, and the strip reads it here: the same data on the same refresh,
 * with no second read.
 */
import { useSyncExternalStore } from 'react';
import type { SessionTranscriptContext } from '@tm8/contract';

export interface ChatContextEntry {
  context: SessionTranscriptContext;
  /** Why the reading is no longer updating, or null while the runtime runs. */
  stale: string | null;
}

const entries = new Map<string, ChatContextEntry>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Publish (or, with null, withdraw) the reading a screen holds for one chat. */
export function publishChatContext(chatId: string, entry: ChatContextEntry | null): void {
  const was = entries.get(chatId);
  if (entry === null) {
    if (!was) return;
    entries.delete(chatId);
  } else {
    if (was && was.context === entry.context && was.stale === entry.stale) return;
    entries.set(chatId, entry);
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The reading a mounted chat screen holds for this chat, or null. */
export function useChatContextFeed(chatId: string | null): ChatContextEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => (chatId === null ? null : entries.get(chatId) ?? null),
    () => null,
  );
}
