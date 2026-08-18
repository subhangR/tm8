import { useEffect, useMemo, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type {
  ComposerInteractionPolicy,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import type { ConnectionState, Seam } from '../data/seam';
import { ChannelScreen } from './ChannelScreen';
import { chatStore, type ChatStoreState, type ChatSyncSeam } from './chat-store';
import { useAnchorFeed } from './useAnchorFeed';
import { createChatAttachmentUploadTask } from './chat-attachments';
import { loadSkillTriggerOptions, type SkillTriggerOption } from '../rich-input';
import { discoverComposerActions } from './composer-actions';
import type { ComposerMentionOption } from './Composer';

export interface SessionChatSeam extends ChatSyncSeam {
  commands: Pick<Seam['commands'], 'postMessage'>;
  query?: Seam['query'];
  files?: Seam['files'];
}

export interface SessionChatSurfaceProps {
  seam: SessionChatSeam;
  sessionId: EntityId;
  spaceId: SpaceId | string;
  viewerMemberId: string;
  connection: ConnectionState;
  sessionExited?: boolean;
  defaultLimit?: number;
  filter?: string;
  focusAround?: `message:${string}` | `activity:${string}` | null;
  composerPolicy?: ComposerInteractionPolicy | null;
  /** The session is quiet and may be waiting for a human — see ChannelScreen. */
  needsAttention?: boolean;
  attentionDetail?: string;
  /** Test/integration injection. Production uses the retained global store. */
  store?: StoreApi<ChatStoreState>;
  onOpenEntity?: (id: EntityId) => void;
  onSwitchToTerminal: () => void;
}

/**
 * Production adapter between the provider-neutral message/feed operations and
 * the presentation-only ChannelScreen. It intentionally accepts no provider,
 * agent-tool, or model input: those launch choices do not select this surface.
 */
export function SessionChatSurface({
  seam,
  sessionId,
  spaceId,
  viewerMemberId,
  connection,
  sessionExited = false,
  defaultLimit = 50,
  filter = 'chronological',
  focusAround = null,
  composerPolicy = null,
  needsAttention = false,
  attentionDetail,
  store = chatStore,
  onOpenEntity,
  onSwitchToTerminal,
}: SessionChatSurfaceProps) {
  const actions = useMemo(() => discoverComposerActions(composerPolicy), [composerPolicy]);
  const [mentionOptions, setMentionOptions] = useState<ComposerMentionOption[] | undefined>(undefined);
  const [skillOptions, setSkillOptions] = useState<SkillTriggerOption[] | undefined>(undefined);
  /*
   * NO SCOPE. This surface used to name `session_chat_v1`, which is exactly
   * what the server resolves for a work_session anchor (`feed-context.ts:176`)
   * — so naming it was the client re-deciding what the server already knew,
   * and it is the same hardcode that made two sibling surfaces unmountable on
   * any other kind.
   *
   * `legacyScope` is the cost of removing it, paid rather than ignored: the
   * key is also the localStorage draft key, so the correct fix would have
   * silently discarded whatever the viewer had half-written. One fallback read
   * carries it across; a draft under the new key always wins.
   */
  const feed = useAnchorFeed({
    seam,
    anchorId: sessionId,
    spaceId,
    viewerMemberId,
    filter,
    limit: defaultLimit,
    legacyScope: 'session_chat_v1',
    focusAround,
    store,
  });


  useEffect(() => {
    if (!actions.canMention || !seam.query) {
      setMentionOptions(undefined);
      return;
    }
    let current = true;
    setMentionOptions(undefined);
    void seam.query({
      spaceId,
      kinds: ['member', 'team_member'],
      sort: 'activityAt_desc',
      limit: 50,
    }).then((result) => {
      if (!current) return;
      setMentionOptions(result.page.items.flatMap((entity) =>
        entity.kind === 'member' || entity.kind === 'team_member'
          ? [{ id: entity.id, kind: entity.kind, display: entity.title }]
          : []));
    }).catch(() => {
      if (current) setMentionOptions(undefined);
    });
    return () => {
      current = false;
    };
  }, [actions.canMention, seam, spaceId]);

  /* Same capability law as mentions: no query seam ⇒ `/` types plain text.
     R1 needs no per-action gate beyond posting itself — the committed skill
     is body text, not a dispatch. */
  useEffect(() => {
    if (!seam.query) {
      setSkillOptions(undefined);
      return;
    }
    let current = true;
    void loadSkillTriggerOptions({ port: { query: seam.query.bind(seam) }, spaceId }).then(
      (skills) => {
        if (current) setSkillOptions(skills);
      },
      () => {
        if (current) setSkillOptions(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [seam, spaceId]);

  const startAttachmentUpload = useMemo(() => {
    if (!actions.canAttach || !seam.files) return undefined;
    return (file: File) => createChatAttachmentUploadTask({
      files: seam.files!,
      file,
      spaceId,
      anchorId: sessionId,
    });
  }, [actions.canAttach, seam.files, sessionId, spaceId]);

  if (feed.error) {
    return (
      <div className="chs-host-error" role="alert">
        {/* 'Chat' RETIRES FROM THE SESSION PANEL (Subhang's ruling): the strip
            is Terminal | Transcript | Git | Debug | Graph, and the word
            survives only for actual chat threads in Chat Home. This copy is
            about a conversation that could not be read, which is true whatever
            the surface ends up called. */}
        <strong>This session&rsquo;s conversation could not be read.</strong>
        <span>{feed.error}</span>
        <button type="button" onClick={() => void feed.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <ChannelScreen
      viewerActorId={viewerMemberId}
      anchorId={sessionId}
      anchorNoun="this session"
      page={feed.page}
      loading={feed.loading}
      loadingEarlier={feed.loadingEarlier}
      refreshedFromNewest={feed.refreshedFromNewest}
      refusal={feed.refusal}
      connection={connection}
      sessionExited={sessionExited}
      onPost={actions.canPost ? feed.post : undefined}
      onLoadEarlier={() => feed.loadOlder()}
      onOpenEntity={onOpenEntity}
      turnGraphs
      onSwitchToTerminal={onSwitchToTerminal}
      needsAttention={needsAttention}
      {...(attentionDetail ? { attentionDetail } : {})}
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
      onStartAttachmentUpload={startAttachmentUpload}
      mentionOptions={mentionOptions}
      skillOptions={skillOptions}
    />
  );
}
