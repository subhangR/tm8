/**
 * `src/messages/useMessagesData.ts` — the ONLY place this lane touches the seam.
 *
 * WHY A NARROW PORT rather than `GateData`: `src/messages/` must not import
 * upward from `views/`, and naming exactly what this screen consumes is what
 * makes the mount a type check rather than a promise (the `inbox`/`graph`/
 * `home` precedent). A full `Seam` satisfies `MessagesSeamPort` structurally,
 * so the narrowing is enforced by this type and never by a mapping layer that
 * could quietly widen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FOUR READS, AND WHY EACH IS SHAPED THE WAY IT IS
 *
 * 1. THE CONVERSATION LIST — `query({ spaceId, sort: 'activityAt_desc' })` with
 *    NO `kinds` filter at all. That is not laziness, it is the design: a kind
 *    list would be a kind branch by another name (§15.2) and would go stale the
 *    moment a new kind learned to hold a discussion. The predicate is
 *    structural and lives in the model — `counters.messages > 0`. It is also
 *    exactly right, because every message insert bumps its anchor's
 *    `activity_at` (`internal.maintain_message_counter`, migration 001), so the
 *    entities with live discussions are precisely the ones this sort brings to
 *    the top.
 *
 *    THE COST, NAMED: because the filter runs client-side, a page of 100
 *    entities can thin to a handful of conversations. `loadMore` therefore
 *    CHAINS pages until it has collected something worth showing — but chains
 *    at most `MAX_CHAINED_PAGES`, so one click can never become an unbounded
 *    fetch loop against a space with a long quiet tail.
 *
 * 2. THE PREVIEWS — one extra query per conversation page, for message entities
 *    newest-first, folded to one entry per anchor by `lastMessagesByAnchor`.
 *    The alternative was a read per row: message summaries carry `anchorId` but
 *    the conversation query does not carry the last message BODY, and there is
 *    no batch entity read in the catalog (`entities.get` is single-id and
 *    `CollectionQuery` has no `ids` filter). One extra round trip beats N.
 *
 * 3. THE THREAD — `feed(anchorId)` with NO `scope`. This is the whole reason
 *    the view can be kind-blind: the SERVER resolves the right reading per
 *    anchor kind (`work_session` → session_chat_v1, `channel` →
 *    channel_threads_v1, `task` → task_discussion_v1, `message` → thread_v1,
 *    everything else → direct_v1). Passing a scope from here would be the
 *    client re-deciding what the server already knows, and would break on the
 *    next kind that gains its own reading.
 *
 * 4. THE FLAT READING — the same message query as (2), paged, projected against
 *    the anchor index the conversation list already built. An anchor outside
 *    that index stays `null` rather than being backfilled with a guess.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `null` IS NOT `[]`, EVERYWHERE. A list stays `null` until a read RESOLVES.
 * A rejection sets the error and leaves it `null` — flattening a refusal to an
 * empty array would make "we could not ask" render identically to "there is
 * nothing", and only one of those is a fact about the workspace.
 *
 * EVERY EFFECT IS CANCELLABLE. Selection changes fast, and a slow response for
 * a conversation the viewer already left must never overwrite the one they are
 * looking at now.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CollectionQuery,
  CollectionResult,
  CommandResult,
  Cursor,
  DurableWorkspaceEvent,
  EntityFeedPage,
  EntityId,
  EntityKind,
  EntitySummary,
  MessageBatchResult,
  PostMessageInput,
  SpaceId,
} from '@tm8/contract';
import type { ConnectionState, FeedOpts, Unsubscribe } from '../data/seam';
import type { ChannelPostInput } from '../channel-screen/feed-model';
import { allKinds } from '../domain';
import {
  anchorIndexOf,
  applyMessageCreated,
  conversationRowsOf,
  dedupeById,
  lastMessagesByAnchor,
  messageRowsOf,
  sortByRecency,
  sortMessagesByRecency,
  withLastMessages,
  type ConversationRow,
  type MessageRow,
  type MessagesMode,
} from './messages-model';

/** Exactly the seam surface this screen consumes. A full `Seam` satisfies it. */
export interface MessagesSeamPort {
  query(input: CollectionQuery): Promise<CollectionResult>;
  feed(id: EntityId, opts?: FeedOpts): Promise<EntityFeedPage>;
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
  onConnection(cb: (s: ConnectionState) => void): Unsubscribe;
  /* The conversation surface reloads on a resync of its own space. Present on
     the real `Seam` all along; named here now that this screen mounts the
     shared surface instead of feeding it a page it read itself. */
  onResync(cb: (spaceId: string) => void): Unsubscribe;
  getConnection(): ConnectionState;
  commands: {
    postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult>;
  };
}

export interface MessagesData {
  mode: MessagesMode;
  setMode(mode: MessagesMode): void;

  /** `null` ⇒ no read has resolved. `[]` ⇒ a read found nothing. */
  conversations: readonly ConversationRow[] | null;
  conversationsError: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore(): void;

  kindFilter: readonly EntityKind[] | null;
  setKindFilter(kinds: readonly EntityKind[] | null): void;

  selectedId: EntityId | null;
  select(id: EntityId | null): void;
  selected: ConversationRow | null;

  allMessages: readonly MessageRow[] | null;
  allMessagesError: string | null;
  allHasMore: boolean;
  allLoadingMore: boolean;
  loadMoreAll(): void;

  connection: ConnectionState;
}

/**
 * The message kind ref, resolved from registry DATA rather than typed.
 *
 * §15.2 forbids a kind literal in this lane and `no-kind-literals.test.ts`
 * enforces it here, so `kinds: ['message']` — exactly what a message query
 * means — is not available. The registry answers better anyway: `message` is
 * the only `strategy: 'anchored'` row, and that is the DEFINITION rather than a
 * coincidence to exploit — "anchored" IS the routing strategy of a thing with
 * no view of its own because it hangs off something else.
 *
 * THROWS on ambiguity rather than picking one. A silently wrong message query
 * would render a plausible, wrong list; a loud failure is the better outcome.
 * Same shape and same loudness as `files/port.ts:fileKindRef()`.
 */
export function messageKindRef(): EntityKind {
  const rows = allKinds().filter((row) => row.strategy === 'anchored');
  if (rows.length !== 1) {
    throw new Error(
      `messages: expected exactly one registry row with an anchored routing strategy, found ${rows.length}`,
    );
  }
  return rows[0]!.kind as EntityKind;
}

/** One request's worth of entities. The server caps this independently. */
const PAGE_LIMIT = 100;

/**
 * How many pages ONE `loadMore` may chain while hunting for conversations.
 *
 * The client-side `counters.messages > 0` filter means a page can yield zero
 * rows, and a "load more" that visibly does nothing is worse than a slow one.
 * Three is the compromise: enough to cross a quiet stretch, bounded enough that
 * a space with a long tail of message-less entities cannot turn one click into
 * an open-ended crawl. When the chain gives up with the cursor still live,
 * `hasMore` stays true and the control stays offered — nothing is hidden.
 */
const MAX_CHAINED_PAGES = 3;

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const shaped = error as { message?: unknown; code?: unknown };
    if (typeof shaped.message === 'string' && shaped.message.length > 0) return shaped.message;
    if (typeof shaped.code === 'string') return shaped.code;
  }
  return String(error);
}

export function useMessagesData(seam: MessagesSeamPort, spaceId: SpaceId): MessagesData {
  const [mode, setMode] = useState<MessagesMode>('conversations');
  const [kindFilter, setKindFilter] = useState<readonly EntityKind[] | null>(null);

  const [conversations, setConversations] = useState<readonly ConversationRow[] | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selectedId, setSelectedId] = useState<EntityId | null>(null);

  const [allMessages, setAllMessages] = useState<readonly MessageRow[] | null>(null);
  const [allMessagesError, setAllMessagesError] = useState<string | null>(null);
  const [allCursor, setAllCursor] = useState<Cursor | null>(null);
  const [allLoadingMore, setAllLoadingMore] = useState(false);

  const [connection, setConnection] = useState<ConnectionState>(() => seam.getConnection());

  /**
   * The live selection, readable from inside event callbacks.
   *
   * The `onEvent` subscription is deliberately established ONCE per seam. If it
   * closed over `selectedId` it would have to resubscribe on every selection
   * change, and a resubscribe drops whatever arrives in the gap.
   */
  const selectedRef = useRef<EntityId | null>(null);
  selectedRef.current = selectedId;

  // -- the conversation query ------------------------------------------------

  /**
   * One page of conversations plus its previews.
   *
   * Returns the rows and the next cursor rather than setting state, so the
   * chaining loop below can decide whether the yield was worth stopping on.
   */
  const fetchConversationPage = useCallback(
    async (from: Cursor | null): Promise<{ rows: ConversationRow[]; next: Cursor | null }> => {
      const page = await seam.query({
        spaceId,
        sort: 'activityAt_desc',
        limit: PAGE_LIMIT,
        ...(from ? { cursor: from } : {}),
      });
      const rows = conversationRowsOf(page.page.items);
      if (rows.length === 0) return { rows, next: page.page.nextCursor };

      // The previews ride a SECOND query rather than N reads — see the docblock.
      // A preview failure is deliberately non-fatal: a conversation list with no
      // excerpts is degraded, a conversation list that refused to load is
      // broken, and these are not the same outcome.
      let previews: ReadonlyMap<EntityId, ReturnType<typeof lastMessagesByAnchor> extends
        ReadonlyMap<EntityId, infer V> ? V : never> = new Map();
      try {
        const messages = await seam.query({
          spaceId,
          kinds: [messageKindRef()],
          sort: 'createdAt_desc',
          limit: PAGE_LIMIT,
        });
        previews = lastMessagesByAnchor(messages.page.items);
      } catch {
        // Intentionally swallowed. The rows below still render with
        // `lastMessage: null`, which the screen draws as absence.
      }
      return { rows: withLastMessages(rows, previews), next: page.page.nextCursor };
    },
    [seam, spaceId],
  );

  useEffect(() => {
    let cancelled = false;
    setConversations(null);
    setConversationsError(null);
    setCursor(null);
    void fetchConversationPage(null)
      .then(({ rows, next }) => {
        if (cancelled) return;
        setConversations(rows);
        setCursor(next);
      })
      .catch((error: unknown) => {
        // The list stays `null`. A refusal is not an empty workspace.
        if (!cancelled) setConversationsError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, [fetchConversationPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || cursor === null) return;
    setLoadingMore(true);
    void (async () => {
      let from: Cursor | null = cursor;
      const gathered: ConversationRow[] = [];
      try {
        for (let page = 0; page < MAX_CHAINED_PAGES && from !== null; page += 1) {
          const result: { rows: ConversationRow[]; next: Cursor | null } =
            await fetchConversationPage(from);
          gathered.push(...result.rows);
          from = result.next;
          if (gathered.length > 0) break;
        }
        setConversations((current) =>
          sortByRecency(dedupeById([...(current ?? []), ...gathered])),
        );
        setCursor(from);
      } catch (error: unknown) {
        setConversationsError(messageOf(error));
      } finally {
        setLoadingMore(false);
      }
    })();
  }, [cursor, fetchConversationPage, loadingMore]);

  // -- the flat reading ------------------------------------------------------

  const anchorIndex = useMemo(() => anchorIndexOf(conversations ?? []), [conversations]);

  useEffect(() => {
    // Only paid for when the viewer actually asks for the flat reading — the
    // conversation list is the default and most sessions never leave it.
    if (mode !== 'all' || allMessages !== null || allMessagesError !== null) return undefined;
    let cancelled = false;
    void seam
      .query({ spaceId, kinds: [messageKindRef()], sort: 'createdAt_desc', limit: PAGE_LIMIT })
      .then((result) => {
        if (cancelled) return;
        setAllMessages(messageRowsOf(result.page.items, anchorIndex));
        setAllCursor(result.page.nextCursor);
      })
      .catch((error: unknown) => {
        if (!cancelled) setAllMessagesError(messageOf(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, allMessages, allMessagesError, seam, spaceId, anchorIndex]);

  /**
   * Anchor names resolve LATE, and that is fine.
   *
   * A flat row whose anchor was outside the loaded conversation index renders
   * unresolved; when a later conversation page brings that anchor in, this
   * re-projects the names onto rows already on screen. It never invents one.
   */
  useEffect(() => {
    if (allMessages === null || anchorIndex.size === 0) return;
    setAllMessages((current) => {
      if (current === null) return current;
      let changed = false;
      const next = current.map((row) => {
        if (row.anchorTitle !== null) return row;
        const anchor = anchorIndex.get(row.anchorId);
        if (!anchor) return row;
        changed = true;
        return { ...row, anchorTitle: anchor.title, anchorKind: anchor.kind };
      });
      return changed ? next : current;
    });
    // `allMessages` is deliberately absent from the deps: this reacts to the
    // INDEX growing, and including the list it sets would re-enter on its own
    // output.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorIndex]);

  const loadMoreAll = useCallback(() => {
    if (allLoadingMore || allCursor === null) return;
    setAllLoadingMore(true);
    void seam
      .query({
        spaceId,
        kinds: [messageKindRef()],
        sort: 'createdAt_desc',
        limit: PAGE_LIMIT,
        cursor: allCursor,
      })
      .then((result) => {
        const rows = messageRowsOf(result.page.items, anchorIndex);
        setAllMessages((current) => sortMessagesByRecency(dedupeById([...(current ?? []), ...rows])));
        setAllCursor(result.page.nextCursor);
      })
      .catch((error: unknown) => setAllMessagesError(messageOf(error)))
      .finally(() => setAllLoadingMore(false));
  }, [allCursor, allLoadingMore, anchorIndex, seam, spaceId]);

  /*
   * THE OPEN THREAD USED TO BE READ HERE — the feed effect, `loadEarlier` and
   * its cursor, about 120 lines. The screen now mounts `DiscussionSurface`,
   * which reads for itself through `useAnchorFeed`, so this hook no longer
   * owns a feed at all. It owns the conversation LIST, which is a different
   * question and the one thing here that was never duplicated.
   *
   * The reading is unchanged in kind: still `entities.feed(anchorId)` with NO
   * scope, still the server resolving per anchor kind. What changed is that
   * one implementation of it now serves every surface instead of four.
   */

  // -- live ------------------------------------------------------------------

  // Connection posture rides straight through to the composer, which refuses
  // visibly rather than queueing into a void when the socket is down.
  useEffect(() => seam.onConnection(setConnection), [seam]);

  useEffect(() => {
    return seam.onEvent((event) => {
      if (event.type !== 'message.created') return;
      const anchorId = event.anchorId;
      setConversations((current) =>
        current === null ? current : applyMessageCreated(current, anchorId, event.message),
      );
      /*
       * THE OPEN CONVERSATION'S RE-READ IS NO LONGER THIS HOOK'S JOB — the
       * surface subscribes for itself, and coalesces a burst into one read
       * where this bumped an epoch per event. Only the LIST row moves here now.
       *
       * THE RULE THAT PRODUCED IT STILL STANDS AND IS WORTH KEEPING WRITTEN
       * DOWN, because it is the thing most likely to be re-attempted: the first
       * version of this SYNTHESIZED a `FeedItem` from the event and pushed it
       * onto `items`. A feed item is a SERVER-COMPOSED DTO carrying fields the
       * event does not have — its delivery summaries above all — so
       * hand-building one means inventing what the event never carried and
       * rendering it as though the server had said it. The scope's predicates
       * also decide what belongs in a feed at all, and a client append silently
       * bypasses that decision. A re-read is the honest price.
       */
    });
  }, [seam]);

  const selected = useMemo(
    () => (conversations ?? []).find((row) => row.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const select = useCallback((id: EntityId | null) => setSelectedId(id), []);

  return {
    mode,
    setMode,
    conversations,
    conversationsError,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    kindFilter,
    setKindFilter,
    selectedId,
    select,
    selected,
    allMessages,
    allMessagesError,
    allHasMore: allCursor !== null,
    allLoadingMore,
    loadMoreAll,
    connection,
  };
}
