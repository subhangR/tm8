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

/** A trusted, non-scratch project is what @tag needs before it can spawn. */
export interface ChannelFeedProject {
  id: string;
  trusted: boolean;
  scratch?: boolean;
  selectedByDefault?: boolean;
}

export interface ChannelFeedPort {
  /** The seam slice the feed reads through. `entity` is required because the
      @tag picker resolves candidates through `loadChannelTagOptions`. */
  seam: Pick<Seam, 'feed' | 'onEvent' | 'query' | 'liveness' | 'entity' | 'files'>;
  spaceId: SpaceId;
  /** Live session ids — the @tag picker's session options come from these. */
  liveIds: readonly EntityId[];
  postMessage: (input: PostMessageInput) => Promise<void>;
  /** Returns the authoritative work-session id — @tag needs it to address the
      session it just started. */
  spawn: (input: ExecutionSpawnInput) => Promise<EntityId>;
  projects: readonly ChannelFeedProject[];
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
}

export function useChannelFeed(port: ChannelFeedPort, channelId: EntityId): ChannelFeed {
  const [page, setPage] = useState<EntityFeedPage>();
  const [loading, setLoading] = useState(true);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<ChannelRefusal | null>(null);
  const [mentionOptions, setMentionOptions] = useState<ComposerMentionOption[]>([]);
  const [attachEntityOptions, setAttachEntityOptions] = useState<ComposerMentionOption[]>([]);
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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRefusal(null);
    try {
      const next = await seam.feed(channelId, { scope: 'direct_v1' });
      // The server pages newest-first; a chat reads oldest-to-newest with the
      // latest at the bottom, so the page is re-sorted before it ever paints.
      setPage({ ...next, items: chronological(next.items) });
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
  }, [channelId, seam]);

  useEffect(() => {
    setPage(undefined);
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
      const older = await seam.feed(channelId, { cursor, scope: 'direct_v1' });
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
