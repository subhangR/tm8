import { Fragment, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Cursor, EntityFeedPage, EntityId, FeedItem, MessageView, Page } from '@tm8/contract';
import type { ConnectionState } from '../data/seam';
import { DisabledAction, NOT_WIRED_REASON } from '../panels/honesty/DisabledWithReason';
import { HollowInline } from '../panels/honesty/HollowValue';
import { Composer, type ComposerProps } from './Composer';
import type { ComposerMentionOption } from './Composer';
import type { ChatAttachmentUploadTask } from './chat-attachments';
import { FeedRowGroup } from './FeedRow';
import { ThreadPane } from './ThreadPane';
import { dayLabel as formatDay, dayStart } from '../kit/time';
import { groupByOperation, type ChannelPostInput, type ChannelRefusal } from './feed-model';
import './channel-screen.css';

/**
 * THE CHAT SURFACE — T10, mounted as the destination a hub's Feed points at.
 *
 * `T10 Chat Surface Hi-Fi.dc.html` (repo root, ` (1)` directory) draws 27
 * frames. Its hero draws a whole PANEL: breadcrumb, entity header, the
 * Content/Discussion/Connections/Activity tab strip, the Terminal|Chat surface
 * switch, and inside all of that, a feed and a composer. THIS COMPONENT IS THE
 * INSIDE — the feed region, the composer, and the provenance footer. The panel
 * chrome around it already exists and is owned elsewhere; re-drawing it here
 * would be a second implementation of a solved surface, and the two would
 * drift.
 *
 * THE BAR THIS MEETS IS LINK-LEVEL COMPLETENESS, NOT FIDELITY. Every control
 * the canvas draws exists here and either dispatches through the real seam or
 * refuses visibly with its true reason (R7). Geometry and colour are tokenised
 * and plausible; they are NOT canvas-diffed, and a later parity session owns
 * that. Nothing in this file should be read as a pixel claim.
 *
 * THE READ IT CONSUMES is `seam.feed(id, opts)` → `EntityFeedPage`, which is
 * what the oracle's own footer names ("entities.feed · scope session_chat_v1").
 * The page arrives as a PROP rather than being fetched here, for the reason
 * every other body in this package takes its data as props: the surface stays
 * testable without a seam, and the host keeps one place where reads are
 * sequenced.
 */

export interface ChannelScreenProps {
  /** The entity this surface is anchored on — a channel, a session, anything. */
  anchorId: EntityId;
  /**
   * The caller's word for that anchor ("this channel", "this session"). A PROP
   * because naming a kind is registry knowledge; a component that looked it up
   * would be branching on kind by another name (§15.2).
   */
  anchorNoun: string;
  /**
   * The feed page. `undefined` and an empty `items` array are DIFFERENT FACTS
   * and stay different: nothing read this anchor, versus a read that found
   * nothing. Collapsing them is how a screen claims a measurement it never
   * took.
   */
  page?: EntityFeedPage;
  /** A read is in flight and there is nothing to show yet (S06). */
  loading?: boolean;
  /** An older page is in flight (S08). */
  loadingEarlier?: boolean;
  /** S10 — the cursor expired and history was re-seeded from newest. */
  refreshedFromNewest?: boolean;
  /** S12 / S13 — a refusal REPLACES the surface; it never overlays it. */
  refusal?: ChannelRefusal | null;
  /** T4 connection honesty, passed straight through to the composer. */
  connection?: ConnectionState;
  /** S21 — the anchor's session has exited; composing stores but never wakes. */
  sessionExited?: boolean;
  /** Client-local divider: the first item that arrived after this surface opened. */
  newSinceItemId?: string | null;
  /** Controlled production draft; omitted keeps the standalone local fallback. */
  draft?: string;
  onDraftChange?: (body: string) => void;
  /** Controlled reply target; omitted keeps the standalone local fallback. */
  replyState?: { value: MessageView | null; onChange: (message: MessageView | null) => void };
  uncertainSubmission?: ComposerProps['uncertainSubmission'];
  onStartAttachmentUpload?: (file: File) => ChatAttachmentUploadTask;
  mentionOptions?: readonly ComposerMentionOption[];
  /** Workspace entities (tasks, docs, people) the attach picker offers. */
  attachEntityOptions?: readonly ComposerMentionOption[];

  /** The seam command. Absent ⇒ Send and Send-again refuse with their reason. */
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  /** Pages backwards on `nextCursor`. Absent ⇒ the control refuses visibly. */
  onLoadEarlier?: (cursor: Cursor) => Promise<void> | void;
  onOpenEntity?: (id: EntityId) => void;
  /**
   * The surface switch the S07 empty state offers. OPTIONAL AND MEANINGFULLY
   * SO: "the agent's native output lives in Terminal" is true of a session
   * anchor and false of a channel, so the sentence and its button appear only
   * where the host says a terminal exists. An absent control here is not a
   * hidden one — there is nothing to hide.
   */
  onSwitchToTerminal?: () => void;
  /**
   * THREADS MODE — a registry fact (`panel.threads` on the kind row), passed
   * through by the host exactly like `anchorNoun`: naming a kind's grammar is
   * registry knowledge, and this component never asks what kind its anchor
   * is. When true, the feed is THREAD ROOTS (`channel_threads_v1`), a root
   * with replies draws the persistent thread footer, the channel composer
   * posts roots only (`parentMessageId` always null), and an open thread
   * renders as a column beside the feed. When absent, the session surface's
   * flat conversation — replies inline, `replyState` armed on the one
   * composer — is byte-for-byte what it was.
   */
  threads?: boolean;
  /** The breadcrumb's word for this anchor — "#design-review". */
  anchorTitle?: string;
  /** The open branch. The HOST owns this state; reads stay host-sequenced. */
  thread?: {
    root: MessageView;
    replies?: Page<MessageView>;
    loading?: boolean;
    loadingMore?: boolean;
    error?: string | null;
  } | null;
  /** Opens a root's branch. `threads` without this ⇒ footers refuse visibly. */
  onOpenThread?: (root: MessageView) => void;
  onCloseThread?: () => void;
  /** Pages the branch FORWARD on its `nextCursor` (oldest-first read). */
  onLoadMoreReplies?: (cursor: Cursor) => Promise<void> | void;
  /**
   * The session has gone quiet and may be waiting for a human.
   *
   * WHY CHAT NEEDS ITS OWN. The terminal surface has shown this since R8
   * (`NeedsYouBanner`), but the two surfaces are both mounted and only one is
   * visible, so a signal drawn in the terminal alone is invisible to exactly the
   * person this feature exists for: the non-developer reading chat. That is the
   * disagreement between the two views, in its smallest form.
   *
   * Ignored on a channel anchor, which has no session to be blocked.
   */
  needsAttention?: boolean;
  /** What the host measured, in words. See `QUIET_SESSION_DETAIL`. */
  attentionDetail?: string;
}

export function ChannelScreen({
  anchorId,
  anchorNoun,
  page,
  loading = false,
  loadingEarlier = false,
  refreshedFromNewest = false,
  refusal = null,
  connection,
  sessionExited = false,
  newSinceItemId = null,
  draft,
  onDraftChange,
  replyState,
  uncertainSubmission,
  onStartAttachmentUpload,
  mentionOptions,
  attachEntityOptions,
  onPost,
  onLoadEarlier,
  onOpenEntity,
  onSwitchToTerminal,
  threads = false,
  anchorTitle,
  thread = null,
  onOpenThread,
  onCloseThread,
  onLoadMoreReplies,
  needsAttention = false,
  attentionDetail,
}: ChannelScreenProps) {
  const feedElement = useRef<HTMLDivElement>(null);
  const scrollSnapshot = useRef<{
    first: string | null;
    last: string | null;
    count: number;
    height: number;
    top: number;
    nearNewest: boolean;
  } | null>(null);
  const [newItemCount, setNewItemCount] = useState(0);
  const [localReplyTo, setLocalReplyTo] = useState<MessageView | null>(null);
  /*
   * THE COMPOSER SPLIT. In threads mode the channel composer posts ROOTS
   * ONLY — the reply-target state is pinned to null here rather than merely
   * left unarmed, so no code path (a stale host `replyState`, a future
   * handler) can thread a `parentMessageId` through the channel composer.
   * Replies are composed in the thread pane, which owns its own target.
   */
  const armedReplyTo = replyState ? replyState.value : localReplyTo;
  const replyTo = threads ? null : armedReplyTo;
  const setReplyTo = replyState ? replyState.onChange : setLocalReplyTo;

  const groups = useMemo(() => groupByOperation(page?.items ?? []), [page]);
  const plan = useMemo(() => planRows(groups, newSinceItemId, threads), [groups, newSinceItemId, threads]);
  const loadedMessages = useMemo(() => new Map(
    (page?.items ?? [])
      .filter((item): item is Extract<FeedItem, { itemKind: 'message' }> => item.itemKind === 'message')
      .map((item) => [item.message.id, item.message] as const),
  ), [page]);
  const itemIds = useMemo(() => (page?.items ?? []).map((item) => item.itemId), [page]);
  const virtualized = itemIds.length >= 100;

  const rememberScroll = useCallback(() => {
    const element = feedElement.current;
    if (!element) return;
    scrollSnapshot.current = {
      first: itemIds[0] ?? null,
      last: itemIds[itemIds.length - 1] ?? null,
      count: itemIds.length,
      height: element.scrollHeight,
      top: element.scrollTop,
      nearNewest: element.scrollHeight - element.scrollTop - element.clientHeight <= 48,
    };
  }, [itemIds]);

  useLayoutEffect(() => {
    const element = feedElement.current;
    if (!element) return;
    const previous = scrollSnapshot.current;
    const first = itemIds[0] ?? null;
    const last = itemIds[itemIds.length - 1] ?? null;
    if ((previous?.count ?? 0) === 0 && itemIds.length > 0) {
      // A chat OPENS at the newest message. The feed is chronological, so the
      // newest is at the bottom — the first painted page lands there, and only
      // user scrolling moves the viewport away from it.
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    } else if (previous && itemIds.length > previous.count) {
      if (previous.last === last && previous.first !== first) {
        element.scrollTop = previous.top + Math.max(0, element.scrollHeight - previous.height);
      } else if (previous.first === first && previous.last !== last) {
        const added = itemIds.length - previous.count;
        if (previous.nearNewest) {
          element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
          setNewItemCount(0);
        } else {
          setNewItemCount((count) => count + added);
        }
      }
    }
    rememberScroll();
  }, [itemIds, rememberScroll]);

  useLayoutEffect(() => {
    const list = feedElement.current?.querySelector<HTMLElement>('.chs-list');
    if (!virtualized || !list || typeof ResizeObserver === 'undefined') return;
    let measured = 0;
    let total = 0;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (height > 0) {
          total += height;
          measured += 1;
        }
      }
      if (measured > 0) list.style.setProperty('--chs-measured-row-size', `${Math.round(total / measured)}px`);
    });
    for (const row of list.querySelectorAll<HTMLElement>('.chs-row')) observer.observe(row);
    return () => observer.disconnect();
  }, [itemIds, virtualized]);

  const focusMessage = useCallback((id: EntityId) => {
    const rows = feedElement.current?.querySelectorAll<HTMLElement>('[data-feed-message-id]') ?? [];
    const row = [...rows].find((candidate) => candidate.dataset.feedMessageId === id);
    if (row) {
      row.scrollIntoView?.({ block: 'center' });
      row.focus({ preventScroll: true });
      return;
    }
    onOpenEntity?.(id);
  }, [onOpenEntity]);

  /*
   * S12 / S13 — a refusal REPLACES everything, composer included.
   *
   * "Nothing about its contents is shown. No titles, counts, or cached
   * excerpts survive." Rendering the refusal as a banner ABOVE a still-painted
   * feed is the exact leak the frame exists to forbid, and it is the shape a
   * hurried implementation reaches for first.
   */
  if (refusal) {
    return (
      <section className="chs-root chs-root--refused" data-testid="chs-root">
        <div className="chs-refusal" data-testid="chs-refusal">
          <span aria-hidden className="chs-refusal__glyph">
            {refusal.kind === 'forbidden' ? '⊘' : '⌀'}
          </span>
          <p className="chs-refusal__headline">{refusal.message}</p>
          <p className="chs-refusal__note">
            {refusal.kind === 'forbidden'
              ? 'Access to other surfaces on this entity is evaluated on its own.'
              : 'Entity tombstone — the former title is not recovered from cache.'}
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className="chs-root"
      data-testid="chs-root"
      data-thread-open={threads && thread ? 'true' : undefined}
    >
      {needsAttention ? (
        <div className="chs-needs-you" role="status" aria-live="polite" data-testid="chs-needs-you">
          <span className="chs-needs-you__label">⚠ needs you</span>
          {/*
            STATES THE MEASUREMENT, NOT A GUESS. The detector behind this knows
            only that the PTY fell silent; it cannot see which tool is waiting or
            what was asked. So the copy says the agent went quiet and points at
            the terminal, where the real question — if there is one — is drawn.
            Inventing a question here would be indistinguishable, to the reader,
            from having actually received one.
          */}
          {attentionDetail ? (
            <span className="chs-needs-you__detail">{attentionDetail}</span>
          ) : null}
          {onSwitchToTerminal ? (
            <button type="button" className="chs-chip-btn" onClick={onSwitchToTerminal}>
              Open the terminal
            </button>
          ) : null}
        </div>
      ) : null}
      {/* The three-column split's inner half: feed+composer is one column,
          the thread pane the next — the same aside-beside-a-feed shape as
          `chv-split`/`chv-aside`, solved here so both hosts inherit it. */}
      <div className="chs-columns">
        <div className="chs-main">
      <div
        ref={feedElement}
        className="chs-feed"
        role="region"
        aria-label="Chat history"
        onScroll={rememberScroll}
      >
        <div className="chs-feed__spacer" aria-hidden />
        {newItemCount > 0 ? (
          <button
            type="button"
            className="chs-new-items"
            aria-live="polite"
            onClick={() => {
              const element = feedElement.current;
              if (element) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
              setNewItemCount(0);
              rememberScroll();
            }}
          >
            {`${newItemCount} new ${newItemCount === 1 ? 'item' : 'items'} · jump to newest`}
          </button>
        ) : null}
        {refreshedFromNewest ? (
          <p className="chs-notice" data-testid="chs-refreshed">
            history refreshed from newest — the cursor expired · your draft is untouched
          </p>
        ) : null}

        {/* S09's honesty line describes the PAGING BOUNDARY, so it lives at
            the boundary — the top of the feed, beside "load earlier ↑" —
            not below the newest message, where the chat surface must end at
            the composer. */}
        <Provenance page={page} />
        <LoadEarlier
          cursor={page?.nextCursor ?? null}
          busy={loadingEarlier}
          onLoadEarlier={onLoadEarlier}
        />

        {loading && !page ? (
          <ul className="chs-list chs-list--skeleton" aria-busy="true" aria-label="Messages and activity">
            {/* Stable skeletons, fixed height — "no jumping" (S06). */}
            {[0, 1, 2].map((i) => (
              <li key={i} className="chs-skeleton" aria-hidden />
            ))}
          </ul>
        ) : !page ? (
          /*
           * THE HOLLOW STATE. No read has run for this anchor. Distinct from an
           * empty feed in exactly the way `messages === undefined` is distinct
           * from `messages === []` in HubBody: one is an absence of data, the
           * other an absence of a MEASUREMENT, and only the second is our bug.
           */
          <p className="chs-hollow" data-testid="chs-unread">
            <HollowInline caption="No feed read has run for this surface — the page was never passed to it.">
              — messages and activity
            </HollowInline>
          </p>
        ) : page.items.length === 0 ? (
          <EmptyFeed onSwitchToTerminal={onSwitchToTerminal} />
        ) : (
          <ul
            className="chs-list"
            aria-label="Messages and activity"
            aria-busy={loadingEarlier}
            data-virtualized={virtualized ? 'true' : 'false'}
          >
            {plan.map((row) => (
              <Fragment key={row.firstId}>
                {row.dayLabel ? (
                  <li className="chs-day" data-testid="chs-day">
                    <span className="chs-day__label">{row.dayLabel}</span>
                  </li>
                ) : null}
                <FeedRowGroupWithMark
                  mark={newSinceItemId === row.firstId}
                  group={row.group}
                  clustered={row.clustered}
                  anchorId={anchorId}
                  onPost={onPost}
                  onOpenEntity={onOpenEntity}
                  onReply={setReplyTo}
                  onFocusMessage={focusMessage}
                  loadedMessages={loadedMessages}
                  threads={threads}
                  onOpenThread={onOpenThread}
                />
              </Fragment>
            ))}
          </ul>
        )}
      </div>

      <Composer
        anchorId={anchorId}
        anchorNoun={anchorNoun}
        onPost={onPost}
        connection={connection}
        sessionExited={sessionExited}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        draft={draft}
        onDraftChange={onDraftChange}
        uncertainSubmission={uncertainSubmission}
        onStartAttachmentUpload={onStartAttachmentUpload}
        mentionOptions={mentionOptions}
        attachEntityOptions={attachEntityOptions}
      />
      <p className="chs-visually-hidden" role="status" aria-live="polite">
        {connection?.phase === 'offline'
          ? 'Chat is offline. Drafts remain available, but messages cannot be sent.'
          : connection?.phase === 'polling'
            ? 'Chat is reconnecting. Cached history remains available.'
            : connection?.phase === 'connecting'
              ? 'Chat is connecting.'
              : 'Chat is connected.'}
      </p>
        </div>

        {threads && thread ? (
          <ThreadPane
            anchorId={anchorId}
            anchorTitle={anchorTitle ?? anchorNoun}
            root={thread.root}
            replies={thread.replies}
            loading={thread.loading ?? false}
            loadingMore={thread.loadingMore ?? false}
            error={thread.error ?? null}
            onRetry={onOpenThread ? () => onOpenThread(thread.root) : undefined}
            connection={connection}
            sessionExited={sessionExited}
            onPost={onPost}
            onLoadMore={onLoadMoreReplies}
            onClose={onCloseThread}
            onOpenEntity={onOpenEntity}
            onStartAttachmentUpload={onStartAttachmentUpload}
            mentionOptions={mentionOptions}
            uncertainSubmission={uncertainSubmission}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * The chat's render plan — where the presentation-only chrome is decided.
 *
 * A DAY DIVIDER goes before the first row of each calendar day. A row is
 * CLUSTERED (no repeated byline) when it continues the author run directly
 * above it: same author, same day, within seven minutes, and carrying no
 * facts of its own that live in the byline — a reply target, an edit, a
 * pending state or any delivery facet all break the run, because collapsing
 * a row would otherwise hide the place those facts are shown.
 */
interface RowPlan {
  group: ReturnType<typeof groupByOperation>[number];
  clustered: boolean;
  dayLabel: string | null;
  firstId: string;
}

const CLUSTER_WINDOW_MS = 7 * 60 * 1000;

function planRows(
  groups: ReturnType<typeof groupByOperation>,
  newSinceItemId: string | null,
  threads = false,
): RowPlan[] {
  const out: RowPlan[] = [];
  let previous: FeedItem | null = null;
  let previousDay: number | null = null;
  for (const group of groups) {
    const first = group.kind === 'operation' ? group.items[0] : group.item;
    const day = dayStart(first.createdAt);
    const dayLabel = day !== null && day !== previousDay ? formatDay(first.createdAt) : null;
    const clustered = !dayLabel
      && newSinceItemId !== first.itemId
      && group.kind === 'single'
      && continuesRun(previous, group.item, threads);
    out.push({ group, clustered, dayLabel, firstId: first.itemId });
    previousDay = day ?? previousDay;
    previous = group.kind === 'operation' ? group.items[group.items.length - 1] : group.item;
  }
  return out;
}

function continuesRun(previous: FeedItem | null, current: FeedItem, threads: boolean): boolean {
  if (!previous || previous.itemKind !== 'message' || current.itemKind !== 'message') return false;
  const a = previous.message;
  const b = current.message;
  if (a.state.redactedAt || b.state.redactedAt) return false;
  /*
   * The reply-target guard exists because a reply's byline area carries its
   * ParentPreview, and collapsing the row would hide it. In THREADS MODE that
   * fact is gone twice over: the feed is roots-only (no `rootMessageId` ever)
   * and ParentPreview is not drawn — while `parentId` on a channel message is
   * the ENTITY parent (the channel itself, in fixture and anchor-parented
   * data), which read here as "this is a reply" and stopped every root from
   * ever clustering into an author run.
   */
  if (!threads && (b.parentId || b.state.rootMessageId)) return false;
  if (b.state.editedAt || b.pending) return false;
  if (current.delivery.length > 0) return false;
  const authorA = a.state.author?.id ?? a.createdBy?.id ?? null;
  const authorB = b.state.author?.id ?? b.createdBy?.id ?? null;
  if (!authorA || authorA !== authorB) return false;
  const delta = new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime();
  return Number.isFinite(delta) && delta >= 0 && delta <= CLUSTER_WINDOW_MS;
}

function FeedRowGroupWithMark({
  mark,
  group,
  clustered,
  anchorId,
  onPost,
  onOpenEntity,
  onReply,
  onFocusMessage,
  loadedMessages,
  threads,
  onOpenThread,
}: {
  mark: boolean;
  group: ReturnType<typeof groupByOperation>[number];
  clustered: boolean;
  anchorId: EntityId;
  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  onOpenEntity?: (id: EntityId) => void;
  onReply: (m: MessageView) => void;
  onFocusMessage: (id: EntityId) => void;
  loadedMessages: ReadonlyMap<EntityId, MessageView>;
  threads?: boolean;
  onOpenThread?: (root: MessageView) => void;
}) {
  return (
    <>
      {mark ? (
        /* The oracle labels this divider CLIENT-LOCAL in its own copy, and the
           label is load-bearing: this is not a read state and does not survive
           a reload, so calling it "unread" would promise durability we do not
           have. */
        <li className="chs-mark" aria-hidden data-testid="chs-mark">
          <span>NEW SINCE OPENED · CLIENT-LOCAL</span>
        </li>
      ) : null}
      <FeedRowGroup
        group={group}
        anchorId={anchorId}
        clustered={clustered}
        handlers={{
          onOpenEntity,
          onReply,
          onFocusMessage,
          loadedMessages,
          threads,
          onOpenThread,
          onPost: onPost
            ? (body, parentMessageId) => void onPost({ anchorIds: [anchorId], body, parentMessageId })
            : undefined,
        }}
      />
    </>
  );
}

/**
 * `load earlier` exists only when there IS an earlier page — `nextCursor` is
 * the whole condition. Drawing it against a null cursor would be a control
 * that cannot succeed; withholding it when a cursor exists but nothing
 * dispatches it would hide a real gap. So: no cursor ⇒ nothing; cursor with no
 * handler ⇒ refusal with its reason; both ⇒ a working button.
 */
function LoadEarlier({
  cursor,
  busy,
  onLoadEarlier,
}: {
  cursor: Cursor | null;
  busy: boolean;
  onLoadEarlier?: (cursor: Cursor) => Promise<void> | void;
}) {
  if (!cursor) return null;
  if (!onLoadEarlier) {
    return (
      <div className="chs-earlier">
        <DisabledAction label="Load earlier" reason={NOT_WIRED_REASON}>
          load earlier ↑
        </DisabledAction>
      </div>
    );
  }
  return (
    <div className="chs-earlier">
      <button
        type="button"
        className="chs-chip-btn"
        disabled={busy}
        onClick={() => void onLoadEarlier(cursor)}
      >
        {busy ? 'loading earlier…' : 'load earlier ↑'}
      </button>
    </div>
  );
}

/**
 * S07 — the empty feed is COMMON, NOT AN ERROR, and the copy says so without
 * apology. It explains where an agent's native output actually lives, and it
 * never offers to import a transcript (the oracle forbids that in writing).
 */
function EmptyFeed({ onSwitchToTerminal }: { onSwitchToTerminal?: () => void }) {
  return (
    <div className="chs-empty" data-testid="chs-empty">
      <span aria-hidden className="chs-empty__glyph">
        ◌
      </span>
      <p className="chs-empty__headline">No explicit tm8 messages or activity yet.</p>
      {onSwitchToTerminal ? (
        <>
          <p className="chs-empty__note">
            The agent’s native output lives in Terminal — Chat only shows deliberate tm8 messages and
            session activity.
          </p>
          <button type="button" className="chs-chip-btn" onClick={onSwitchToTerminal}>
            Switch to Terminal
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * The oracle's provenance line (rendered at the TOP of the feed, at the
 * paging boundary it describes), and the one number it is allowed to state.
 *
 * S09 is explicit: "1 item returned · continue via nextCursor — no total shown,
 * ever." A total would require counting rows the viewer may not be authorized
 * to see, so the only honest figures are what this page returned and whether
 * another page exists. `resolvedScope` is printed rather than the scope we
 * asked for — the server's answer outranks the request, the same shape as a
 * liveness verdict outranking a stored status.
 */
function Provenance({ page }: { page?: EntityFeedPage }) {
  if (!page) return null;
  const n = page.items.length;
  return (
    <p className="chs-provenance" data-testid="chs-provenance">
      {`entities.feed · scope ${page.resolvedScope} · ${n} item${n === 1 ? '' : 's'} returned · ${
        page.nextCursor ? 'continue via nextCursor' : 'no further pages'
      }`}
    </p>
  );
}
