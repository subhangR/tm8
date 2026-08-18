/**
 * `useAnchorFeed` — ONE conversation reader, for any anchor.
 *
 * It is the React binding over `createAnchorFeedController` plus the mutation
 * journal, and it exists to end a three-way split in which one renderer was fed
 * by three readers with three different sets of guarantees:
 *
 *   - `chat-store`'s controller — work_session only, scope hardcoded. Has the
 *     machinery: generation-guarded reads, coalesced refresh, reconnect reload,
 *     `onResync`, bidirectional paging, `loadAround`, persisted drafts, the
 *     mutation journal.
 *   - `useChannelFeed` — channel only, scope hardcoded. Has NONE of it, plus
 *     the branch read the other two lack.
 *   - `useMessagesData`'s feed slice — the only one that trusts the server to
 *     resolve the scope, and the only one that therefore works on a task or a
 *     doc at all.
 *
 * The union is the machinery of the first, the branch reads of the second and
 * the scope discipline of the third. What each surface OFFERS stays registry
 * config; what the hook can DO is now the same everywhere.
 *
 * NOT IN HERE, DELIBERATELY: `@tag` dispatch, mention/skill option reads,
 * attachment upload and turn graphs. They have different lifetimes, they
 * already live in composable helpers (`channel-tags.ts`, `rich-input`,
 * `chat-attachments.ts`, `live-graph-model.ts`), and folding them in is how a
 * feed hook becomes a god object. Surfaces compose them alongside this.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';
import type {
  CommandResult,
  Cursor,
  EntityFeedPage,
  EntityFeedQuery,
  EntityId,
  MessageBatchResult,
  MessageView,
  PostMessageInput,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { ChannelPostInput, ChannelRefusal } from './feed-model';
import {
  chatStateKey,
  chatStore,
  messageForReply,
  type ChatDrafts,
  type ChatMutationJournalEntry,
  type ChatStateKeyParts,
  type ChatStoreState,
} from './chat-store';
import {
  chatPageWithJournal,
  createChatMutationController,
  reconcileChatMutationEvent,
} from './chat-mutations';
import {
  createAnchorFeedController,
  type AnchorFeedSeam,
  type AnchorFeedThread,
} from './anchor-feed-controller';

export type { AnchorFeedThread } from './anchor-feed-controller';

export interface UseAnchorFeedSeam extends AnchorFeedSeam {
  commands: Pick<Seam['commands'], 'postMessage'>;
}

export interface UseAnchorFeedOptions {
  seam: UseAnchorFeedSeam;
  anchorId: EntityId;
  spaceId: SpaceId | string;
  viewerMemberId: string;
  /**
   * ABSENT unless the caller can defend it — see `anchor-feed-controller`. A
   * surface that names one is claiming to know the anchor's kind better than
   * the server does, and gets an `invalid_input` when it is wrong.
   */
  scope?: ChatStateKeyParts['scope'];
  /** Stable projection identity. Part of the draft key. */
  filter?: string;
  limit?: number;
  /** Branch reads + thread pane. Registry config decides, never a kind literal. */
  threads?: boolean;
  /**
   * A scope this surface USED to name, kept only so a draft written under the
   * old key survives its removal. Read once, and only when the current key
   * holds nothing. Delete the prop once no viewer can still have a draft under
   * the old spelling.
   */
  legacyScope?: ChatStateKeyParts['scope'];
  focusAround?: NonNullable<EntityFeedQuery['around']> | null;
  /**
   * The write, when the host's own is more than a seam call.
   *
   * Defaults to `seam.commands.postMessage`. A host overrides it when its
   * post does bookkeeping the feed cannot see — `GateData.postMessage`
   * re-reads the anchor's thread and ingests it into the domain store, which
   * is what keeps tab counters and hub cards current. Bypassing that to talk
   * to the seam directly would be invisible until a counter went stale.
   *
   * It MUST return the command result: the mutation journal settles a pending
   * row against the stored message ids, and a write that answers `void` can
   * only ever be settled by the event echo — later, and not at all if the
   * event is missed.
   */
  postMessage?: (input: PostMessageInput) => Promise<CommandResult | MessageBatchResult>;
  /** Test/integration injection. Production uses the retained global store. */
  store?: StoreApi<ChatStoreState>;
}

export interface AnchorFeed {
  /** Server truth projected with any journal entry whose storage is unknown. */
  page: EntityFeedPage | undefined;
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'refused';
  loading: boolean;
  error: string | null;
  refusal: ChannelRefusal | null;
  refreshedFromNewest: boolean;

  loadingEarlier: boolean;
  loadingNewer: boolean;
  loadOlder(): Promise<void>;
  loadNewer(): Promise<void>;
  loadAround(around: NonNullable<EntityFeedQuery['around']>): Promise<void>;
  reload(): Promise<void>;

  post(input: ChannelPostInput): Promise<void>;
  /** Non-null while a submission's storage outcome is unknown. */
  uncertainMutation: ChatMutationJournalEntry | null;
  reconcile(clientMutationId: string): Promise<void>;

  draft: string;
  setDraft(body: string): void;
  drafts: ChatDrafts;
  replyTo: MessageView | null;
  replyToId: EntityId | null;
  setReplyTarget(id: EntityId | null): void;

  thread: AnchorFeedThread | null;
  openThread(root: MessageView): void;
  closeThread(): void;
  loadMoreReplies(cursor: Cursor): Promise<void>;
}

export function useAnchorFeed({
  seam,
  anchorId,
  spaceId,
  viewerMemberId,
  scope,
  filter = 'chronological',
  limit = 50,
  threads = false,
  legacyScope,
  focusAround = null,
  postMessage,
  store = chatStore,
}: UseAnchorFeedOptions): AnchorFeed {
  const key = useMemo<ChatStateKeyParts>(() => ({
    viewerMemberId,
    sessionId: anchorId,
    /* Spread rather than `scope: scope` so the property is ABSENT, not present
       and undefined — `chatStateKey` and the request builder both distinguish
       them, and an explicitly-undefined scope in an object literal reads as a
       decision that was made rather than one that was declined. */
    ...(scope ? { scope } : {}),
    filter,
  }), [anchorId, filter, scope, viewerMemberId]);
  const keyId = chatStateKey(key);
  const legacyKey = useMemo<ChatStateKeyParts | undefined>(
    () => (legacyScope ? { ...key, scope: legacyScope } : undefined),
    [key, legacyScope],
  );

  /**
   * The branch lives in the controller (reads are host-sequenced) but has to
   * reach React. A store subscription would put per-pane state in a module
   * singleton keyed by conversation, which is wrong for a pane the viewer can
   * open in two places; local state bridged by the controller's callback keeps
   * the branch with the mount that opened it.
   *
   * IT CARRIES ITS OWN KEY. A branch belongs to the conversation it was read
   * from, so switching anchors must show no branch at all — not the previous
   * anchor's, and not for one frame. Comparing the held key on read makes that
   * true DURING the render that changes the key, where an effect-based reset
   * would paint the stale branch once first. It also discards a late write from
   * the outgoing controller, whose read may still be in flight when its
   * replacement is already mounted.
   */
  const [held, setHeld] = useState<HeldThread>(() => ({ keyId, thread: null }));
  const thread = held.keyId === keyId ? held.thread : null;

  const controller = useMemo(
    () => createAnchorFeedController({
      store,
      seam,
      key,
      spaceId: String(spaceId),
      limit,
      threads,
      ...(legacyKey ? { legacyKey } : {}),
      // `keyId` is closed over from THIS controller's creation, which is what
      // makes the comparison above able to tell whose write this was.
      onThreadChange: (next) => setHeld({ keyId, thread: next }),
    }),
    [key, keyId, legacyKey, limit, seam, spaceId, store, threads],
  );

  const mutationController = useMemo(
    () => createChatMutationController({
      store,
      key,
      spaceId,
      postMessage: (input: PostMessageInput) => (postMessage ?? seam.commands.postMessage)(input),
      /*
       * The echo is the JOURNAL, not this refresh. `chatPageWithJournal`
       * projects the pending row the moment `submit` records it, so the message
       * is on screen before the request resolves — visibly pending, which is a
       * different and honest claim from a fabricated settled row. The refresh
       * that follows is reconciliation, and nothing waits on it to see its own
       * message. `useChannelFeed.ts:368` awaited a full feed re-read instead,
       * which is the slowest echo available on the surface that is about to go
       * on every entity in the product.
       */
      refresh: () => controller.loadNewest(),
    }),
    [controller, key, postMessage, seam.commands, spaceId, store],
  );

  // -- narrow selectors: one conversation never subscribes to another --------

  const page = useStore(store, (state) => state.entries[keyId]?.page);
  const phase = useStore(store, (state) => state.entries[keyId]?.phase ?? 'idle');
  const error = useStore(store, (state) => state.entries[keyId]?.error ?? null);
  const refusal = useStore(store, (state) => state.entries[keyId]?.refusal ?? null);
  const loadingEarlier = useStore(store, (state) => state.entries[keyId]?.loadingEarlier ?? false);
  const loadingNewer = useStore(store, (state) => state.entries[keyId]?.loadingNewer ?? false);
  const refreshedFromNewest = useStore(
    store,
    (state) => state.entries[keyId]?.refreshedFromNewest ?? false,
  );
  const replyToId = useStore(store, (state) => state.entries[keyId]?.replyToId ?? null);
  const replyTo = useStore(store, (state) => {
    const entry = state.entries[keyId];
    return entry ? messageForReply(entry) : null;
  });
  const drafts = useStore(store, (state) => state.entries[keyId]?.drafts ?? EMPTY_DRAFTS);
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

  // -- lifecycle -------------------------------------------------------------

  useEffect(() => {
    const detach = controller.attach();
    if (focusAround) void controller.loadAround(focusAround);
    else void controller.loadNewest();
    return () => {
      detach();
      controller.dispose();
    };
  }, [controller, focusAround]);

  useEffect(
    () => seam.onEvent((event) => {
      reconcileChatMutationEvent(store, keyId, event);
    }),
    [keyId, seam, store],
  );

  const post = useCallback(
    (input: ChannelPostInput) => mutationController.submit(input),
    [mutationController],
  );

  const draft = replyToId ? drafts.replies[replyToId] ?? '' : drafts.newMessage;

  return {
    page: projectedPage,
    phase,
    loading: phase === 'idle' || phase === 'loading',
    error,
    refusal,
    refreshedFromNewest,

    loadingEarlier,
    loadingNewer,
    loadOlder: controller.loadOlder,
    loadNewer: controller.loadNewer,
    loadAround: controller.loadAround,
    reload: useCallback(() => controller.loadNewest(), [controller]),

    post,
    uncertainMutation,
    reconcile: useCallback(
      (clientMutationId: string) => mutationController.reconcile(clientMutationId),
      [mutationController],
    ),

    draft,
    setDraft: useCallback(
      (body: string) => store.getState().setDraft(key, body, replyToId),
      [key, replyToId, store],
    ),
    drafts,
    replyTo,
    replyToId,
    setReplyTarget: useCallback(
      (id: EntityId | null) => store.getState().setReplyTarget(keyId, id),
      [keyId, store],
    ),

    thread,
    openThread: controller.openThread,
    closeThread: controller.closeThread,
    loadMoreReplies: controller.loadMoreReplies,
  };
}

interface HeldThread {
  keyId: string;
  thread: AnchorFeedThread | null;
}

const EMPTY_DRAFTS: ChatDrafts = Object.freeze({
  newMessage: '',
  replies: Object.freeze({}),
  updatedAt: '',
});
