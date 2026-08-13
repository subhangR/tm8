/**
 * `src/messages/` — MESSAGES, the unified cross-entity message browser behind
 * the `messages` rail row.
 *
 * THE ONE IDEA, restated here because a barrel is where a reader arrives: a
 * conversation is not a kind, it is ANY ANCHOR THAT HAS MESSAGES ON IT. The
 * screen lists those anchors, and reads whichever one you pick through the
 * existing chat surface. Nothing in this directory names a kind.
 *
 * THE THREE FILES AND THEIR SEAM:
 *   · `messages-model.ts` — pure types, projections and ALL user-facing copy.
 *     No React, no seam, no DOM.
 *   · `useMessagesData.ts` — sequences the reads and holds the selection.
 *   · `MessagesScreen.tsx`  — draws it. Props-in, presentation only.
 *
 * MOUNTABLE, NOT MOUNTED. Nothing here is wired into a screen; the host owns
 * the one branch that renders it, beside the `files` and `graph` ones.
 *
 * THE STYLESHEET IS IMPORTED BY THE BARREL, following `kit/`, `panels/`,
 * `inbox/` and the rest: a host that imports one symbol from here cannot end
 * up with a half-styled screen.
 */
import './messages.css';

export { MessagesScreen, type MessagesScreenProps } from './MessagesScreen';
export { useMessagesData, type MessagesData } from './useMessagesData';
export {
  CONVERSATIONS_UNRESOLVED_NOTE,
  NO_CONVERSATIONS_NOTE,
  NO_MATCHES_NOTE,
  SEARCH_DISABLED_REASON,
  SESSION_DELIVERY_NOTE,
  UNREAD_NOT_COMPUTED_REASON,
  anchorIdOf,
  anchorIndexOf,
  applyKindFilter,
  applyMessageCreated,
  authorNameOf,
  conversationRowOf,
  conversationRowsOf,
  dedupeById,
  isConversation,
  kindsPresent,
  lastMessagesByAnchor,
  messageRowsOf,
  relativeTime,
  sortByRecency,
  sortMessagesByRecency,
  unreadOf,
  withLastMessages,
  type ConversationRow,
  type LastMessage,
  type MessageRow,
  type MessagesMode,
} from './messages-model';
