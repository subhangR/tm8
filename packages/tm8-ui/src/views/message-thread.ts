import type { MessageView } from '@tm8/contract';

/**
 * Number of durable messages represented by a roots page. `replyCount` is
 * authoritative even when a large branch is intentionally not embedded, so
 * callers must not compare only the root-array length with an entity counter
 * and re-read forever.
 */
export function representedThreadMessageCount(messages: readonly MessageView[]): number {
  const rootIds = new Set(
    messages.filter((message) => !message.state.rootMessageId).map((message) => message.id),
  );
  let count = 0;
  for (const message of messages) {
    if (!message.state.rootMessageId) count += 1 + message.replyCount;
    else if (!rootIds.has(message.state.rootMessageId)) count += 1;
  }
  return count;
}
