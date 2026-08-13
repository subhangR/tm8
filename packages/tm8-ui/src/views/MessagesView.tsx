/**
 * `views/MessagesView.tsx` — the host for the ✉ Messages view.
 *
 * Same shape and same reason as `InboxView`: `useMessagesData` is a hook, and a
 * hook cannot live inside one arm of `GateApp`'s ternary. Mounting through a
 * component also means the conversation query only fires when the viewer is
 * actually on this screen.
 *
 * WHAT THIS VIEW IS. One browser over EVERY conversation in the space —
 * channels, tasks, sessions, docs, anything that has been posted on — with the
 * selected conversation rendered by the same `ChannelScreen` the channel and
 * session surfaces already use. The seamlessness the feature asks for is not
 * built here: it comes from `entities.feed` resolving the correct per-kind
 * reading server-side (`work_session` → session_chat_v1, `channel` →
 * channel_threads_v1, `task` → task_discussion_v1, everything else →
 * direct_v1), so the client never branches on kind to read a thread.
 *
 * MESSAGES IS A LENS, NEVER A DEAD END. `onOpenEntity` is what lets a reader
 * leave a conversation for the entity it lives on, which is why the screen
 * draws an explicit "open" control rather than making the whole surface a
 * terminus. A browser you cannot escape from is a worse version of the panel
 * the viewer already had.
 */
import type { EntityId, SpaceId } from '@tm8/contract';
import { MessagesScreen } from '../messages';
import { useMessagesData, type MessagesSeamPort } from '../messages/useMessagesData';

export interface MessagesViewProps {
  seam: MessagesSeamPort;
  spaceId: SpaceId;
  onOpenEntity?: (id: EntityId) => void;
  /** Injected for determinism in tests; the screen's recency column reads it. */
  now?: Date;
}

export function MessagesView({ seam, spaceId, onOpenEntity, now }: MessagesViewProps) {
  const data = useMessagesData(seam, spaceId);
  return (
    <MessagesScreen
      data={data}
      {...(onOpenEntity ? { onOpenEntity } : {})}
      {...(now ? { now } : {})}
    />
  );
}
