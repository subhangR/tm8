/**
 * THE DISCUSSION SURFACE — the shared conversation, on the tab that every
 * entity already has.
 *
 * The Discussion tab used to draw its own renderer and its own composer
 * (`panels/detail/tabs.tsx`), reading `messages.list`. That reading is a STRICT
 * SUBSET of what the same conversation shows one tab over: `messages.list`
 * applies the `anchored` predicate only, where `entities.feed` on a session
 * resolves `session_chat_v1` — `anchored` PLUS `authored`, `caused` and
 * `replies` (`feed-context.ts:103`). It also did not page: it printed
 * "N more replies" and stopped. So the weaker rendering was the one that was
 * always visible, and the stronger one was behind a chip.
 *
 * This is the same "TWO ENTRANCES, ONE SURFACE" move `views/graphSurface.tsx`
 * already made for Connections/Graph, applied to the one place it was not.
 *
 * NO SCOPE. The whole reason this works on every kind is that the server
 * resolves the reading per anchor kind. A scope named here would be the client
 * re-deciding what the server knows, and would raise `invalid_input` on the
 * first kind it guessed wrong about.
 */
import type { EntityId, SpaceId } from '@tm8/contract';
import type { ConnectionState, Seam } from '../data/seam';
import { ChannelScreen } from './ChannelScreen';
import { useAnchorFeed, type UseAnchorFeedSeam } from './useAnchorFeed';
import type { ComposerMentionOption } from './Composer';
import type { TriggerOption } from '../rich-input';
import { createChatAttachmentUploadTask } from './chat-attachments';

export interface DiscussionSurfaceProps {
  seam: UseAnchorFeedSeam & { files?: Seam['files'] };
  anchorId: EntityId;
  /** Read for the header only. The FEED is kind-blind by construction. */
  anchorNoun: string;
  anchorTitle?: string;
  spaceId: SpaceId | string;
  viewerMemberId: string;
  connection?: ConnectionState;
  /**
   * Registry config (`panel.threads`), never a kind literal. The branch read is
   * available on every anchor; whether this surface OFFERS it is per-kind.
   */
  threads?: boolean;
  mentionOptions?: readonly ComposerMentionOption[];
  skillOptions?: readonly TriggerOption[];
  canPost?: boolean;
  onOpenEntity?: (id: EntityId) => void;
}

export function DiscussionSurface({
  seam,
  anchorId,
  anchorNoun,
  anchorTitle,
  spaceId,
  viewerMemberId,
  connection,
  threads = false,
  mentionOptions,
  skillOptions,
  canPost = true,
  onOpenEntity,
}: DiscussionSurfaceProps) {
  const feed = useAnchorFeed({
    seam,
    anchorId,
    spaceId,
    viewerMemberId,
    threads,
    // NO `scope` — see the docblock. This is the entire reason one surface can
    // sit on a task, a doc, a channel and a session without branching on kind.
  });

  /* A file attached to a reply is an attachment of the entity being discussed,
     so the anchor is bound here — the same binding the tab's own composer did,
     and the reason paste and drop worked there at all. */
  const startAttachmentUpload = seam.files
    ? (file: File) => createChatAttachmentUploadTask({
        files: seam.files!,
        file,
        spaceId,
        anchorId,
      })
    : undefined;

  /*
   * A READ FAILURE IS NOT AN EMPTY CONVERSATION, and this surface shipped for
   * one commit as though it were.
   *
   * `ChannelScreen` handles a REFUSAL (`forbidden`/`not_found`) by replacing
   * itself, but a plain read error is not a refusal — it arrives as
   * `phase: 'error'` with no page, which draws as a conversation with nothing
   * in it. "Nobody has said anything here" and "we could not ask" are not the
   * same fact, and only one of them is about the workspace. `SessionChatSurface`
   * has always drawn this card; the Discussion tab now does too.
   */
  if (feed.error) {
    return (
      <div className="chs-host-error" role="alert">
        <strong>This conversation could not be read.</strong>
        <span>{feed.error}</span>
        <button type="button" onClick={() => void feed.reload()}>Retry</button>
      </div>
    );
  }

  return (
    <ChannelScreen
      anchorId={anchorId}
      anchorNoun={anchorNoun}
      /* Own-message sidedness. The same viewer that keys the draft and the
         journal decides which rows are theirs — one fact, two consumers, so
         the surface forwards it rather than asking its host twice. Without
         this the Discussion tab would be the one conversation in the app that
         draws your own messages as someone else's. */
      viewerActorId={viewerMemberId}
      {...(anchorTitle ? { anchorTitle } : {})}
      page={feed.page}
      loading={feed.loading}
      loadingEarlier={feed.loadingEarlier}
      refreshedFromNewest={feed.refreshedFromNewest}
      refusal={feed.refusal}
      {...(connection ? { connection } : {})}
      onPost={canPost ? feed.post : undefined}
      /* The hook holds its own cursor; the screen has none to give. */
      onLoadEarlier={() => feed.loadOlder()}
      {...(onOpenEntity ? { onOpenEntity } : {})}
      draft={feed.draft}
      onDraftChange={feed.setDraft}
      replyState={{
        value: feed.replyTo,
        onChange: (message) => feed.setReplyTarget(message?.id ?? null),
      }}
      uncertainSubmission={feed.uncertainMutation ? {
        message: 'Storage outcome unknown — the message may or may not exist. Reconcile the same submission before sending another.',
        reconciling: feed.uncertainMutation.mutationState === 'reconciling',
        onReconcile: () => {
          void feed.reconcile(feed.uncertainMutation!.clientMutationId).catch(() => undefined);
        },
      } : null}
      {...(startAttachmentUpload ? { onStartAttachmentUpload: startAttachmentUpload } : {})}
      {...(mentionOptions ? { mentionOptions } : {})}
      {...(skillOptions ? { skillOptions } : {})}
      threads={threads}
      thread={feed.thread}
      onOpenThread={feed.openThread}
      onCloseThread={feed.closeThread}
      onLoadMoreReplies={feed.loadMoreReplies}
    />
  );
}
