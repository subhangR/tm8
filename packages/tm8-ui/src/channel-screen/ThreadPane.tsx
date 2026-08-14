import { useState } from 'react';
import type { Cursor, EntityId, FeedItem, MessageView, Page } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { DisabledAction, DisabledIconControl, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import { HollowInline } from '../panels/honesty/HollowValue';
import { Composer, type ComposerProps } from './Composer';
import type { ComposerMentionOption } from './channel-tags';
import { FeedRowGroup, type FeedRowHandlers } from './FeedRow';
import type { ChannelPostInput } from './feed-model';

/**
 * THE THREAD PANE — the branch under one root, as a column beside the feed.
 *
 * The third column of the channel's three-column split (list · feed · thread),
 * following the pattern the codebase already uses twice: `chv-split`/`chv-aside`
 * beside a channel feed and the WorkspaceGrid's side-panel tracks. This one
 * lives INSIDE ChannelScreen rather than in a host's split so that BOTH hosts
 * (the full ChannelView route and the panel-hosted ChannelChatSurface) get it
 * from one implementation, and the narrow-width collapse is solved once, at
 * the surface's own container.
 *
 * Top to bottom: the ROOT pinned, an `N replies` divider, the branch
 * OLDEST-FIRST (a conversation is read in the order it happened), then its own
 * composer. The pane NEVER FETCHES — the branch page arrives as a prop, read
 * by the host through `useChannelFeed`, the same sequencing rule as the feed
 * itself.
 *
 * `replies === undefined` and `replies.items === []` are DIFFERENT FACTS: no
 * branch read has run, versus a read that measured zero. The first renders the
 * hollow treatment, the second an honest empty line.
 */
export interface ThreadPaneProps {
  anchorId: EntityId;
  /** The breadcrumb's word for where back leads — "#design-review". */
  anchorTitle: string;
  root: MessageView;
  /** The branch, oldest-first. `undefined` = no read ran; `[]` = a real zero. */
  replies?: Page<MessageView>;
  /** The branch read is in flight and there is nothing to show yet. */
  loading?: boolean;
  /** A later page of the branch is in flight. */
  loadingMore?: boolean;
  /** The branch read FAILED — a different fact from not having run. */
  error?: string | null;
  /** Re-runs the failed branch read. Absent ⇒ the retry refuses visibly. */
  onRetry?: () => void;
  connection?: ConnectionState;
  sessionExited?: boolean;
  /** The seam command — same dispatcher as the channel composer. */
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  /** Pages FORWARD on `nextCursor` (the branch reads oldest-first). */
  onLoadMore?: (cursor: Cursor) => Promise<void> | void;
  onClose?: () => void;
  onOpenEntity?: (id: EntityId) => void;
  onStartAttachmentUpload?: ComposerProps['onStartAttachmentUpload'];
  mentionOptions?: readonly ComposerMentionOption[];
  skillOptions?: ComposerProps['skillOptions'];
  uncertainSubmission?: ComposerProps['uncertainSubmission'];
}

export function ThreadPane({
  anchorId,
  anchorTitle,
  root,
  replies,
  loading = false,
  loadingMore = false,
  error = null,
  onRetry,
  connection,
  sessionExited = false,
  onPost,
  onLoadMore,
  onClose,
  onOpenEntity,
  onStartAttachmentUpload,
  mentionOptions,
  skillOptions,
  uncertainSubmission,
}: ThreadPaneProps) {
  /*
   * The armed reply target — the `replyTo` path that used to live on the
   * channel composer, now owned by the thread's. Unarmed, the composer
   * replies to the ROOT (that is what composing in a thread means); arming a
   * message inside the branch replies to that message instead.
   */
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);

  const loadedMessages = new Map<EntityId, MessageView>([
    [root.id, root],
    ...(replies?.items ?? []).map((reply) => [reply.id, reply] as const),
  ]);
  const rowHandlers: FeedRowHandlers = {
    onOpenEntity,
    onReply: setReplyTo,
    loadedMessages,
    pinnedParentId: root.id,
  };
  const replyCount = root.replyCount;
  const countLabel = `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;

  return (
    <section className="chs-thread" data-testid="chs-thread" aria-label={`Thread · ${countLabel}`}>
      <header className="chs-thread__head">
        {/*
          THE BREADCRUMB AND THE CLOSE ARE ONE FACT TWICE: leave the thread.
          Below the collapse threshold the pane REPLACES the feed, so the
          breadcrumb names where back leads; at full width the feed is beside
          us and ✕ is the ordinary dismiss. CSS shows exactly one of them —
          responsive presentation of a single wired control, not a control
          vanishing.
        */}
        {onClose ? (
          <button type="button" className="chs-thread__back" onClick={onClose}>
            {`← ${anchorTitle}`}
          </button>
        ) : (
          <span className="chs-thread__back">
            <DisabledAction label="Back to channel" reason={NOT_WIRED_REASON}>{`← ${anchorTitle}`}</DisabledAction>
          </span>
        )}
        <span className="chs-thread__title">Thread</span>
        {onClose ? (
          <button type="button" className="chs-iconbtn chs-thread__close" aria-label="Close thread" onClick={onClose}>
            <span aria-hidden>✕</span>
          </button>
        ) : (
          <span className="chs-thread__close">
            <DisabledIconControl label="Close thread" glyph="✕" reason={NOT_WIRED_REASON} />
          </span>
        )}
      </header>

      <div className="chs-thread__scroll" role="region" aria-label="Thread messages">
        {/* The root, PINNED at the top by construction — which is why no row
            in the branch needs an "in reply to" preview of it. */}
        <ul className="chs-list chs-thread__root" aria-label="Thread root">
          <FeedRowGroup
            group={{ kind: 'single', item: threadFeedItem(root) }}
            anchorId={anchorId}
            handlers={{ ...rowHandlers, onReply: () => setReplyTo(null) }}
          />
        </ul>

        <div className="chs-thread__divider" data-testid="chs-thread-divider">
          <span>{countLabel}</span>
        </div>

        {error ? (
          <div className="chs-thread__error" role="alert" data-testid="chs-thread-error">
            <span>{error}</span>
            {onRetry ? (
              <button type="button" className="chs-chip-btn" onClick={onRetry}>Retry thread</button>
            ) : (
              <DisabledAction label="Retry thread" reason={NOT_WIRED_REASON}>Retry thread</DisabledAction>
            )}
          </div>
        ) : null}

        {loading && !replies ? (
          <ul className="chs-list chs-list--skeleton" aria-busy="true" aria-label="Thread replies">
            {[0, 1].map((i) => (
              <li key={i} className="chs-skeleton" aria-hidden />
            ))}
          </ul>
        ) : !replies ? (
          // A FAILED read already said so above; the hollow claims "never
          // ran", which would be false beside it.
          error ? null : (
            <p className="chs-hollow" data-testid="chs-thread-unread">
              <HollowInline caption="No branch read has run for this thread — the page was never passed to it.">
                — replies
              </HollowInline>
            </p>
          )
        ) : replies.items.length === 0 ? (
          <p className="chs-thread__empty" data-testid="chs-thread-empty">
            No replies stored yet — yours starts the branch.
          </p>
        ) : (
          <ul className="chs-list" aria-label="Thread replies" aria-busy={loadingMore}>
            {replies.items.map((reply) => (
              <FeedRowGroup
                key={reply.id}
                group={{ kind: 'single', item: threadFeedItem(reply) }}
                anchorId={anchorId}
                handlers={rowHandlers}
              />
            ))}
          </ul>
        )}

        {replies?.nextCursor ? (
          <div className="chs-earlier">
            {onLoadMore ? (
              <button
                type="button"
                className="chs-chip-btn"
                disabled={loadingMore}
                onClick={() => void onLoadMore(replies.nextCursor as Cursor)}
              >
                {loadingMore ? 'loading more replies…' : 'load more replies ↓'}
              </button>
            ) : (
              <DisabledAction label="Load more replies" reason={NOT_WIRED_REASON}>
                load more replies ↓
              </DisabledAction>
            )}
          </div>
        ) : null}
      </div>

      <Composer
        anchorId={anchorId}
        anchorNoun="this thread"
        onPost={onPost}
        connection={connection}
        sessionExited={sessionExited}
        threadRoot={root}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        uncertainSubmission={uncertainSubmission}
        onStartAttachmentUpload={onStartAttachmentUpload}
        mentionOptions={mentionOptions}
        skillOptions={skillOptions}
      />
    </section>
  );
}

/**
 * A branch message dressed as a feed item so `FeedRowGroup` renders it with
 * the exact chat grammar the feed uses — byline, markdown body, tombstones,
 * mentions — instead of a second, drifting row implementation. The synthetic
 * envelope states only facts: `via: ['replies']` is the predicate this read
 * IS, and an empty delivery list is a message with no delivery facet.
 */
function threadFeedItem(message: MessageView): Extract<FeedItem, { itemKind: 'message' }> {
  return {
    itemId: `thread-${message.id}`,
    createdAt: message.createdAt,
    sortId: `${message.createdAt}#${message.id}`,
    via: ['replies'],
    actor: message.state.author ?? message.createdBy ?? null,
    sourceWorkSessionId: null,
    anchor: null,
    logicalOperationId: null,
    itemKind: 'message',
    message,
    delivery: [],
  };
}
