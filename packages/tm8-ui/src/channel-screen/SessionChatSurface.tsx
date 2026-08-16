import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type {
  ComposerInteractionPolicy,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import type { ConnectionState, Seam } from '../data/seam';
import { ChannelScreen } from './ChannelScreen';
import type { ChannelPostInput } from './feed-model';
import {
  chatStateKey,
  chatStore,
  createChatSessionController,
  messageForReply,
  type ChatStoreState,
  type ChatSyncSeam,
} from './chat-store';
import {
  chatPageWithJournal,
  createChatMutationController,
  reconcileChatMutationEvent,
} from './chat-mutations';
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
  const key = useMemo(() => ({
    viewerMemberId,
    sessionId,
    scope: 'session_chat_v1' as const,
    filter,
  }), [filter, sessionId, viewerMemberId]);
  const keyId = chatStateKey(key);
  const controller = useMemo(
    () => createChatSessionController({ store, seam, key, spaceId, limit: defaultLimit }),
    [defaultLimit, key, seam, spaceId, store],
  );
  const mutationController = useMemo(
    () => createChatMutationController({
      store,
      key,
      spaceId,
      postMessage: (input) => seam.commands.postMessage(input),
      refresh: () => controller.loadNewest(),
    }),
    [controller, key, seam.commands, spaceId, store],
  );

  // Narrow selectors: feed rendering never subscribes to another session's
  // entry or to the entire store.
  const page = useStore(store, (state) => state.entries[keyId]?.page);
  const phase = useStore(store, (state) => state.entries[keyId]?.phase ?? 'idle');
  const error = useStore(store, (state) => state.entries[keyId]?.error ?? null);
  const refusal = useStore(store, (state) => state.entries[keyId]?.refusal ?? null);
  const loadingEarlier = useStore(store, (state) => state.entries[keyId]?.loadingEarlier ?? false);
  const refreshedFromNewest = useStore(
    store,
    (state) => state.entries[keyId]?.refreshedFromNewest ?? false,
  );
  const replyTo = useStore(store, (state) => {
    const entry = state.entries[keyId];
    return entry ? messageForReply(entry) : null;
  });
  const replyToId = useStore(store, (state) => state.entries[keyId]?.replyToId ?? null);
  const draft = useStore(store, (state) => {
    const entry = state.entries[keyId];
    if (!entry) return '';
    return entry.replyToId
      ? entry.drafts.replies[entry.replyToId] ?? ''
      : entry.drafts.newMessage;
  });
  const mutations = useStore(store, (state) => state.entries[keyId]?.mutations);
  const uncertainMutation = useStore(store, (state) => {
    const entry = state.entries[keyId];
    return Object.values(entry?.mutations ?? {}).find((mutation) =>
      mutation.mutationState === 'uncertain' || mutation.mutationState === 'reconciling') ?? null;
  });
  const projectedPage = useMemo(() => {
    const entry = store.getState().entries[keyId];
    if (!entry) return page;
    if (!page && Object.keys(mutations ?? {}).length === 0) return undefined;
    return chatPageWithJournal({ ...entry, page, mutations: mutations ?? {} });
  }, [keyId, mutations, page, store]);

  useEffect(() => {
    const detach = controller.attach();
    if (focusAround) void controller.loadAround(focusAround);
    else void controller.loadNewest();
    return detach;
  }, [controller, focusAround]);

  useEffect(
    () => seam.onEvent((event) => {
      reconcileChatMutationEvent(store, keyId, event);
    }),
    [keyId, seam, store],
  );

  const post = useCallback(async (input: ChannelPostInput) => {
    await mutationController.submit(input);
  }, [mutationController]);

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

  if (error) {
    return (
      <div className="chs-host-error" role="alert">
        <strong>The session Chat feed could not be read.</strong>
        <span>{error}</span>
        <button type="button" onClick={() => void controller.loadNewest()}>
          Retry Chat
        </button>
      </div>
    );
  }

  return (
    <ChannelScreen
      anchorId={sessionId}
      anchorNoun="this session"
      page={projectedPage}
      loading={phase === 'idle' || phase === 'loading'}
      loadingEarlier={loadingEarlier}
      refreshedFromNewest={refreshedFromNewest}
      refusal={refusal}
      connection={connection}
      sessionExited={sessionExited}
      onPost={actions.canPost ? post : undefined}
      onLoadEarlier={() => controller.loadOlder()}
      onOpenEntity={onOpenEntity}
      turnGraphs
      onSwitchToTerminal={onSwitchToTerminal}
      needsAttention={needsAttention}
      {...(attentionDetail ? { attentionDetail } : {})}
      draft={draft}
      onDraftChange={(body) => store.getState().setDraft(key, body, replyToId)}
      replyState={{
        value: replyTo,
        onChange: (message) => store.getState().setReplyTarget(keyId, message?.id ?? null),
      }}
      uncertainSubmission={uncertainMutation ? {
        message: 'Storage outcome unknown — the message may or may not exist. Reconcile the same submission before sending another.',
        reconciling: uncertainMutation.mutationState === 'reconciling',
        onReconcile: () => {
          void mutationController.reconcile(uncertainMutation.clientMutationId).catch(() => undefined);
        },
      } : null}
      onStartAttachmentUpload={startAttachmentUpload}
      mentionOptions={mentionOptions}
      skillOptions={skillOptions}
    />
  );
}
