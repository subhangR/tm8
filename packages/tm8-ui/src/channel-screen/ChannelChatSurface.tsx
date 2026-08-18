/**
 * THE CHANNEL FEED, hosted inside the entity detail panel.
 *
 * The twin of `SessionChatSurface`: same ChannelScreen, same composer, a
 * different anchor. It exists because the user ruling of 2026-08-01 moved
 * channels out of the rail and into the Entity List Panel, which means a
 * channel opens where every other entity opens — the detail panel — and a
 * channel whose panel showed only a description and a pin shelf would be a
 * channel you cannot read or post to.
 *
 * It owns NO feed logic: `useChannelFeed` is the single implementation, shared
 * with the full-screen ChannelView.
 */
import type { EntityId } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { LazyChannelScreen } from './LazyChannelScreen';
import { useChannelFeed, type ChannelFeedPort } from './useChannelFeed';

export interface ChannelChatSurfaceProps {
  port: ChannelFeedPort;
  channelId: EntityId;
  connection: ConnectionState;
  /** Opening an entity from the feed pushes it onto the host's panel stack. */
  onOpenEntity?: (id: EntityId) => void;
  /**
   * REGISTRY DATA passed through by the host (`getKind(kind).panel.threads`)
   * — the surface never asks what kind its anchor is. True ⇒ thread footers,
   * roots-only composer, and the thread pane column.
   */
  threads?: boolean;
  /** The breadcrumb's word for this anchor — "#design-review". */
  anchorTitle?: string;
  /** The viewer, for own-message sidedness — see ChannelScreen. */
  viewerMemberId?: string | null;
}

export function ChannelChatSurface({
  port,
  channelId,
  connection,
  onOpenEntity,
  threads = false,
  anchorTitle,
  viewerMemberId,
}: ChannelChatSurfaceProps) {
  const feed = useChannelFeed(port, channelId);

  if (feed.error) {
    return (
      <div className="chv-error" role="alert">
        <strong>The channel feed could not be read.</strong>
        <span>{feed.error}</span>
        <button type="button" onClick={() => void feed.reload()}>Retry feed</button>
      </div>
    );
  }

  return (
    <LazyChannelScreen
      {...(viewerMemberId ? { viewerActorId: viewerMemberId } : {})}
      anchorId={channelId}
      anchorNoun="this channel"
      page={feed.page}
      loading={feed.loading}
      loadingEarlier={feed.loadingEarlier}
      refusal={feed.refusal}
      connection={connection}
      onPost={feed.post}
      mentionOptions={feed.mentionOptions}
      skillOptions={feed.skillOptions}
      attachEntityOptions={feed.attachEntityOptions}
      onStartAttachmentUpload={feed.startAttachmentUpload}
      onLoadEarlier={feed.loadEarlier}
      onOpenEntity={onOpenEntity}
      threads={threads}
      anchorTitle={anchorTitle}
      thread={feed.thread}
      onOpenThread={feed.openThread}
      onCloseThread={feed.closeThread}
      onLoadMoreReplies={feed.loadMoreReplies}
    />
  );
}
