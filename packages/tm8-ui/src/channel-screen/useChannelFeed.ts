/**
 * THE CHANNEL FEED, extracted so it has exactly one implementation.
 *
 * It lived inside `views/ChannelView.tsx` for as long as the channel had one
 * home — a rail section with its own screen. The user ruling of 2026-08-01
 * moved channels into the Entity List Panel, which means a channel now opens
 * in the ENTITY DETAIL PANEL like every other entity, and that panel needs the
 * same feed: the same paging, the same refusal handling, the same @tag
 * dispatch (which can SPAWN a teammate — the one part nobody would want a
 * second copy of).
 *
 * So the logic moved here and both hosts consume it. The alternative — copying
 * ~150 lines into a panel body — is the shape that produces two feeds which
 * agree until the day one of them is fixed.
 *
 * PORT, NOT `GateData`. The hook takes the narrow slice it actually uses, so
 * `channel-screen/` keeps pointing away from `views/` rather than back into
 * it (views compose channel-screen, not the reverse).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Cursor,
  EntityFeedPage,
  EntityId,
  ExecutionSpawnInput,
  MessageView,
  Page,
  PostMessageInput,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { createChatAttachmentUploadTask } from './chat-attachments';
import {
  dispatchTaggedChannelMessage,
  loadChannelAttachOptions,
  loadChannelTagOptions,
  type ComposerMentionOption,
} from './channel-tags';
import type { ChannelPostInput, ChannelRefusal } from './feed-model';

/**
 * THREAD ROOTS, not every message.
 *
 * `direct_v1` is `['anchored','replies','subject']`, and those first two
 * partition a channel's messages on `root_message_id is null` — so unioning
 * them and ordering by time is precisely what made a channel read FLAT: a
 * reply was drawn wherever it landed in the timeline rather than under the
 * message it answers. `channel_threads_v1` is the same scope minus `replies`.
 *
 * NOTHING IS HIDDEN. A reply is still stored, still RLS-covered, and still
 * read through `messages.list?rootMessageId=` — the branch read that has
 * returned roots-with-reply-counts since it was written. It stops being drawn
 * as a PEER of its parent, which is the entire point.
 *
 * NAMED RATHER THAN LEFT TO `default`. The server resolves `default` for a
 * channel to this same scope, so omitting it would behave identically today.
 * It is named because BOTH reads here must agree — `reload` and `loadEarlier`
 * page the same list, and a keyset cursor is fingerprinted over its scope, so
 * two spellings would mean the second page rejects the first page's cursor.
 * One constant makes that a compile-time fact rather than a convention.
 */
const CHANNEL_FEED_SCOPE = 'channel_threads_v1' as const;

/** A trusted, non-scratch project is what @tag needs before it can spawn. */
export interface ChannelFeedProject {
  id: string;
  trusted: boolean;
  scratch?: boolean;
  selectedByDefault?: boolean;
}

export interface ChannelFeedPort {
  /** The seam slice the feed reads through. `entity` is required because the
      @tag picker resolves candidates through `loadChannelTagOptions`;
      `messages` is the thread pane's branch read. */
  seam: Pick<Seam, 'feed' | 'onEvent' | 'query' | 'liveness' | 'entity' | 'files' | 'messages'>;
  spaceId: SpaceId;
  /** Live session ids — the @tag picker's session options come from these. */
  liveIds: readonly EntityId[];
  postMessage: (input: PostMessageInput) => Promise<void>;
  /** Returns the authoritative work-session id — @tag needs it to address the
      session it just started. */
  spawn: (input: ExecutionSpawnInput) => Promise<EntityId>;
  projects: readonly ChannelFeedProject[];
}

/**
 * The open branch, owned HERE because reads are host-sequenced: the pane
 * renders what this hook read, never fetches. `replies === undefined` means
 * the branch read has not completed — a different fact from a measured zero.
 */
export interface ChannelFeedThread {
  root: MessageView;
  replies?: Page<MessageView>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

export interface ChannelFeed {
  page: EntityFeedPage | undefined;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  refusal: ChannelRefusal | null;
  mentionOptions: ComposerMentionOption[];
  attachEntityOptions: ComposerMentionOption[];
  startAttachmentUpload: ((file: File) => ReturnType<typeof createChatAttachmentUploadTask>) | undefined;
  reload: () => Promise<void>;
  loadEarlier: (cursor: Cursor) => Promise<void>;
  post: (input: ChannelPostInput) => Promise<void>;
  thread: ChannelFeedThread | null;
  openThread: (root: MessageView) => void;
  closeThread: () => void;
  loadMoreReplies: (cursor: Cursor) => Promise<void>;
}

export function useChannelFeed(port: ChannelFeedPort, channelId: EntityId): ChannelFeed {
  const [page, setPage] = useState<EntityFeedPage>();
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ChannelRefusal | null>(null);
  const [mentionOptions, setMentionOptions] = useState<ComposerMentionOption[]>([]);
  const [attachEntityOptions, setAttachEntityOptions] = useState<ComposerMentionOption[]>([]);
  const [thread, setThread] = useState<ChannelFeedThread | null>(null);
  /* The reload path refreshes an open branch without re-running on every
     thread state change — reload's identity must depend only on the channel
     and the seam, or the event subscription churns. */
  const threadRef = useRef<ChannelFeedThread | null>(null);
  threadRef.current = thread;
  const mutationSequence = useRef(0);

  const { seam, spaceId, liveIds, postMessage, spawn, projects } = port;
  const liveSessionKey = liveIds.join('\u0000');

  /*
   * The canonical upload seam, wired exactly as the session chat wires it:
   * init grant → PUT bytes → complete into a file entity, with the task owning
   * abort. The attached file is anchored on this channel, and its entity id
   * rides the post as `attachmentIds` — there is no second upload path.
   */
  const startAttachmentUpload = useMemo(
    () => seam.files
      ? (file: File) => createChatAttachmentUploadTask({
          files: seam.files!,
          file,
          spaceId,
          anchorId: channelId,
        })
      : undefined,
    [seam, spaceId, channelId],
  );

  const readMentionOptions = useCallback(
    (liveSessionIds: readonly EntityId[]) => loadChannelTagOptions({
      port: seam,
      spaceId,
      liveSessionIds,
    }),
    [seam, spaceId],
  );

  useEffect(() => {
    let current = true;
    setMentionOptions([]);
    setAttachEntityOptions([]);
    void readMentionOptions(liveIds).then(
      async (options) => {
        if (current) setMentionOptions(options);
        const attachable = await loadChannelAttachOptions({
          port: seam,
          spaceId,
          mentionOptions: options,
        });
        if (current) setAttachEntityOptions(attachable);
      },
      () => {
        // [] is an honest measured absence and keeps the @ control available
        // so the picker can say there are no options instead of disappearing.
        if (current) setMentionOptions([]);
      },
    ).catch(() => {
      // The tasks/docs read failed — the picker stays with a measured zero.
      if (current) setAttachEntityOptions([]);
    });
    return () => {
      current = false;
    };
  }, [channelId, liveIds, seam, spaceId, liveSessionKey, readMentionOptions]);

  /**
   * THE BRANCH READ — `messages.list?rootMessageId=`, keyset-paginated
   * OLDEST-FIRST by the server (a conversation reads in the order it
   * happened; no client re-sort). Guarded on the root id so a stale response
   * can never land in a thread opened after it.
   */
  const readBranch = useCallback(async (root: MessageView) => {
    try {
      const branch = await seam.messages(channelId, { rootMessageId: root.id });
      setThread((current) => current && current.root.id === root.id
        ? { ...current, replies: branch, loading: false, error: null }
        : current);
    } catch (thrown: unknown) {
      setThread((current) => current && current.root.id === root.id
        ? { ...current, loading: false, error: errorMessage(thrown, 'The thread could not be read.') }
        : current);
    }
  }, [channelId, seam]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRefusal(null);
    try {
      const next = await seam.feed(channelId, { scope: CHANNEL_FEED_SCOPE });
      // The server pages newest-first; a chat reads oldest-to-newest with the
      // latest at the bottom, so the page is re-sorted before it ever paints.
      setPage({ ...next, items: chronological(next.items) });
      /*
       * An open thread rides every reload: the ROOT's rollup (replyCount,
       * participants, last-reply time) refreshes from the new page, and the
       * branch re-reads so a reply another client just posted appears without
       * closing and reopening the pane.
       */
      const openRoot = threadRef.current?.root;
      if (openRoot) {
        const fresh = next.items.find(
          (item) => item.itemKind === 'message' && item.message.id === openRoot.id,
        );
        if (fresh && fresh.itemKind === 'message') {
          setThread((current) => current && current.root.id === openRoot.id
            ? { ...current, root: fresh.message }
            : current);
        }
        void readBranch(openRoot);
      }
    } catch (thrown: unknown) {
      const code = errorCode(thrown);
      if (code === 'forbidden' || code === 'not_found') {
        setRefusal({
          kind: code,
          message: errorMessage(thrown, code === 'forbidden'
            ? 'You no longer have access to this channel’s Chat.'
            : 'This channel no longer exists.'),
        });
      } else {
        setError(errorMessage(thrown, 'The channel feed could not be read.'));
      }
    } finally {
      setLoading(false);
    }
  }, [channelId, seam, readBranch]);

  useEffect(() => {
    setPage(undefined);
    // A thread belongs to its channel; switching channels closes it.
    setThread(null);
    void reload();
  }, [channelId, reload]);

  // Keep an open channel current when another client posts into it.
  useEffect(
    () => seam.onEvent((event) => {
      if ('anchorId' in event && event.anchorId === channelId) void reload();
    }),
    [channelId, seam, reload],
  );

  const loadEarlier = useCallback(async (cursor: Cursor) => {
    setLoadingEarlier(true);
    try {
      const older = await seam.feed(channelId, { cursor, scope: CHANNEL_FEED_SCOPE });
      setPage((current) => current
        ? {
            ...current,
            items: mergeFeedItems(older.items, current.items),
            nextCursor: older.nextCursor,
          }
        : { ...older, items: chronological(older.items) });
    } finally {
      setLoadingEarlier(false);
    }
  }, [channelId, seam]);

  const post = useCallback(async (input: ChannelPostInput) => {
    mutationSequence.current += 1;
    const mutationId = `channel-post:${channelId}:${Date.now()}:${mutationSequence.current}`;
    if (input.tagTargetIds?.length) {
      const liveness = await seam.liveness.refresh(spaceId);
      const freshOptions = await readMentionOptions(liveness.liveEntityIds);
      await dispatchTaggedChannelMessage({
        channelId,
        body: input.body,
        parentMessageId: input.parentMessageId,
        selectedTagIds: input.tagTargetIds,
        candidates: freshOptions,
        mentionIds: input.mentionIds,
        attachmentIds: input.attachmentIds,
        extraAnchorIds: input.anchorIds.filter((id) => id !== channelId),
        spawnTeamMember: async (teamMemberId) => {
          const project = projects.find((candidate) =>
            candidate.trusted && candidate.selectedByDefault && !candidate.scratch)
            ?? projects.find((candidate) => candidate.trusted && !candidate.scratch);
          if (!project) {
            throw new Error('A trusted linked project is required before @Tag can start a teammate session');
          }
          return spawn({
            clientMutationId: `${mutationId}:spawn:${teamMemberId}`,
            spaceId,
            teamMemberId,
            taskIds: [],
            projectId: project.id,
            workdir: { mode: 'project' },
            mode: 'worker',
          });
        },
        post: (resolved) => postMessage({
          clientMutationId: mutationId,
          ...resolved,
        }),
      });
    } else {
      await postMessage({
        clientMutationId: mutationId,
        anchorIds: input.anchorIds,
        conversationAnchorId: channelId,
        body: input.body,
        parentMessageId: input.parentMessageId,
        mentionIds: input.mentionIds,
        attachmentIds: input.attachmentIds,
      });
    }
    await reload();
  }, [channelId, seam, spaceId, projects, spawn, postMessage, reload, readMentionOptions]);

  const openThread = useCallback((root: MessageView) => {
    setThread({ root, replies: undefined, loading: true, loadingMore: false, error: null });
    void readBranch(root);
  }, [readBranch]);

  const closeThread = useCallback(() => setThread(null), []);

  const loadMoreReplies = useCallback(async (cursor: Cursor) => {
    const current = threadRef.current;
    if (!current?.replies) return;
    const rootId = current.root.id;
    setThread((t) => t && t.root.id === rootId ? { ...t, loadingMore: true } : t);
    try {
      const next = await seam.messages(channelId, { rootMessageId: rootId, cursor });
      setThread((t) => {
        if (!t || t.root.id !== rootId || !t.replies) return t;
        const seen = new Set(t.replies.items.map((m) => m.id));
        return {
          ...t,
          loadingMore: false,
          replies: {
            items: [...t.replies.items, ...next.items.filter((m) => !seen.has(m.id))],
            nextCursor: next.nextCursor,
          },
        };
      });
    } catch (thrown: unknown) {
      setThread((t) => t && t.root.id === rootId
        ? { ...t, loadingMore: false, error: errorMessage(thrown, 'More replies could not be read.') }
        : t);
    }
  }, [channelId, seam]);

  return {
    page,
    loading,
    loadingEarlier,
    error,
    refusal,
    mentionOptions,
    attachEntityOptions,
    startAttachmentUpload,
    reload,
    loadEarlier,
    post,
    thread,
    openThread,
    closeThread,
    loadMoreReplies,
  };
}

// ---------------------------------------------------------------------------

function mergeFeedItems(
  older: EntityFeedPage['items'],
  current: EntityFeedPage['items'],
): EntityFeedPage['items'] {
  const seen = new Set<string>();
  return chronological([...older, ...current].filter((item) => {
    if (seen.has(item.itemId)) return false;
    seen.add(item.itemId);
    return true;
  }));
}

function chronological(items: EntityFeedPage['items']): EntityFeedPage['items'] {
  return [...items].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
