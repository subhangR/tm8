/** Shared shapes for the Thread subsystem. */
import type { ReactNode } from 'react';
import type {
  ActivityItem, ActorSummary, EntityId, EntityKind, FileAttachment, Mention,
  MessageView,
} from '../../types/contract';

/**
 * `feed` — a channel room: newest at the bottom, activity items folded into
 * collapsed "N updates" rows, composer always present.
 * `comments` — a task/doc/member discussion: same component, quieter chrome,
 * no activity interleave (the panel already has an Activity tab).
 */
export type ThreadVariant = 'feed' | 'comments';

/** A message plus its reply subtree, built from `parentId` client-side. */
export interface MessageNode {
  message: MessageView;
  depth: number;
  children: MessageNode[];
  /** Direct replies the server says exist but that aren't loaded yet. */
  missingReplies: number;
}

/** An in-flight `postMessage`, shown optimistically until it reconciles. */
export interface PendingMessage {
  clientMutationId: string;
  body: string;
  mentions: Mention[];
  attachments: FileAttachment[];
  parentMessageId: EntityId | null;
  author?: ActorSummary;
  createdAt: string;
  /** Set when the command failed; the row offers Retry / Discard. */
  failed?: { code: string; message: string };
}

/** One flattened row — what the virtualizer actually windows over. */
export type ThreadRow =
  | { kind: 'message'; key: string; node: MessageNode }
  | { kind: 'unread'; key: string; count: number }
  | { kind: 'more-replies'; key: string; node: MessageNode }
  | { kind: 'activity'; key: string; items: ActivityItem[] }
  | { kind: 'pending'; key: string; pending: PendingMessage };

/** A candidate offered by the composer's `@` / `#` autocomplete. */
export interface MentionCandidate {
  id: EntityId;
  display: string;
  kind: EntityKind;
  /** Right-hand hint in the suggestion row (role, status, path…). */
  meta?: string;
}

export interface ThreadProps {
  /** The entity the conversation hangs off: channel, task, doc, member… */
  anchorId: EntityId;
  variant?: ThreadVariant;
  /** The viewing actor; resolved from space navigation when omitted. */
  viewer?: ActorSummary;
  /**
   * Reactions affordance per message. Railway's `ReactionsPointsBar` plugs in
   * here; the default is a read-only counter readout.
   */
  reactionsSlot?: (message: MessageView) => ReactNode;
  /** Show the composer (default true). */
  composer?: boolean;
  /** Overrides the anchor's self-reported unread count. */
  unreadCount?: number;
  /** Mark the anchor read as soon as the thread is scrolled to the end. */
  markReadOnView?: boolean;
  /** Autocomplete candidates; defaults to actors and entities already known. */
  mentionCandidates?: MentionCandidate[];
  /** Subscribe to WorkspaceEvents for this space (default true). */
  live?: boolean;
  /**
   * Reply subtrees open on load. Comment threads are shallow and want to be
   * read whole ('all'); a busy channel feed does not ('none').
   */
  defaultExpanded?: 'none' | 'all';
  estimateRowHeight?: number;
  overscan?: number;
  /** Assumed viewport height when the DOM reports none (tests, hidden tabs). */
  fallbackViewport?: number;
  emptyHint?: string;
  className?: string;
  ariaLabel?: string;
}
