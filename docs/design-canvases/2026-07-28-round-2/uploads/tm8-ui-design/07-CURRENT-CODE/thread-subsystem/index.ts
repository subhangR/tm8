/**
 * Thread subsystem (Layer 2.1) — the universal discussion component.
 *
 * `<Thread anchorId variant />` is the channel feed, the task comment list, the
 * doc margin thread and the member wall. `discussionSlot()` is the adapter that
 * drops it into `EntityPanel` / `EntityFullView`'s Discussion slot, so every
 * kind's Discussion tab is the same conversation surface.
 */
import './thread.css';

export { Thread, flattenRows, foldActivity, countMessages } from './Thread';
export { ThreadGallery, type ThreadGalleryProps } from './ThreadGallery';
export { Composer, type ComposerProps } from './Composer';
export { MessageRow, PendingRow, ReactionsReadout, type MessageRowProps } from './MessageRow';
export { MessageBody, type MessageBodyProps } from './MessageBody';
export {
  VirtualList, type VirtualListProps, type VirtualListHandle,
} from './VirtualList';
export {
  discussionSlot, DiscussionPanel, variantForKind,
  type DiscussionSlotOptions,
} from './DiscussionSlot';
export {
  useThread, buildTree, newMutationId,
  type ThreadController, type UseThreadOptions, type PostDraft,
} from './useThread';
export {
  parseBody, embedIdsIn, stripTokens, appendEmbed, embedToken, refToken,
  draftFromMarkup, markupFromBody, MENTION_MARKUP, REF_MARKUP,
  type BodySegment, type ComposerDraft,
} from './body';
export type {
  ThreadProps, ThreadVariant, ThreadRow, MessageNode, PendingMessage,
  MentionCandidate,
} from './types';
