/**
 * Thread — THE discussion component. One implementation renders the channel
 * feed, task comments, doc margin threads and the member wall; the only
 * difference is the anchor entity and a `variant` that trims chrome.
 *
 * What makes it one component rather than four: a conversation is just
 * messages anchored to an entity, and messages are entities themselves. So
 * replies are child messages (a collapsible subtree), embeds are entity ids in
 * the body (live Z2 cards), mentions and refs are entity ids (chips), and
 * reactions are the same reaction command every other entity takes. Nothing
 * here branches on the anchor's kind.
 *
 * Everything is windowed: the flattened row list goes through `VirtualList`,
 * so a 10k-message room mounts a few dozen rows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../../kit';
import { relTime } from '../../registry';
import { useGraphStore } from '../../stores';
import type {
  ActivityItem, ActorSummary, EntityId, EntityKind, MessageView,
} from '../../types/contract';
import { Composer } from './Composer';
import { MessageRow, PendingRow } from './MessageRow';
import { useChannelTagging, type ChannelTagTarget } from './tags';
import { VirtualList, type VirtualListHandle } from './VirtualList';
import { useThread } from './useThread';
import type { MentionCandidate, MessageNode, ThreadProps, ThreadRow } from './types';

/** Kinds that never make sense as a `#` completion inside a message. */
const UNREFERENCEABLE: ReadonlySet<EntityKind> = new Set<EntityKind>(['message']);

/** Consecutive activity items fold into one row; this many opens expanded. */
const ACTIVITY_FOLD_MIN = 2;

function nodeCount(node: MessageNode): number {
  return 1 + node.children.reduce((n, c) => n + nodeCount(c), 0);
}

/**
 * Tree → the flat row list the virtualizer windows. Collapsed subtrees
 * contribute nothing, which is what keeps deep threads cheap.
 */
export function flattenRows(
  nodes: readonly MessageNode[],
  expanded: ReadonlySet<EntityId>,
  firstUnreadId: EntityId | null,
  unreadCount: number,
): ThreadRow[] {
  const rows: ThreadRow[] = [];
  const walk = (node: MessageNode): void => {
    if (firstUnreadId && node.message.id === firstUnreadId) {
      rows.push({ kind: 'unread', key: `unread:${firstUnreadId}`, count: unreadCount });
    }
    rows.push({ kind: 'message', key: node.message.id, node });
    if (!expanded.has(node.message.id)) return;
    for (const child of node.children) walk(child);
    if (node.missingReplies > 0) {
      rows.push({ kind: 'more-replies', key: `more:${node.message.id}`, node });
    }
  };
  for (const node of nodes) walk(node);
  return rows;
}

/** Interleaves activity into the feed, folding consecutive runs into one row. */
export function foldActivity(rows: ThreadRow[], activity: readonly ActivityItem[]): ThreadRow[] {
  if (activity.length === 0) return rows;
  const timeOf = (row: ThreadRow): number =>
    (row.kind === 'message' ? Date.parse(row.node.message.createdAt) : Number.POSITIVE_INFINITY);

  const sorted = [...activity].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const out: ThreadRow[] = [];
  let bucket: ActivityItem[] = [];
  let cursor = 0;

  const flush = (): void => {
    if (bucket.length === 0) return;
    out.push({ kind: 'activity', key: `act:${bucket[0].id}:${bucket.length}`, items: bucket });
    bucket = [];
  };

  for (const row of rows) {
    const at = timeOf(row);
    while (cursor < sorted.length && Date.parse(sorted[cursor].createdAt) <= at) {
      bucket.push(sorted[cursor]);
      cursor += 1;
    }
    flush();
    out.push(row);
  }
  while (cursor < sorted.length) { bucket.push(sorted[cursor]); cursor += 1; }
  flush();
  return out;
}

function UnreadDivider({ count }: { count: number }) {
  return (
    <div className="cv2-thread__unread" data-cv2-unread="true" role="separator"
      aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`}>
      <span className="cv2-thread__unreadline" />
      <span className="cv2-thread__unreadlabel">{count} new</span>
    </div>
  );
}

function ActivityRow({ items }: { items: ActivityItem[] }) {
  const [open, setOpen] = useState(items.length < ACTIVITY_FOLD_MIN);
  return (
    <div className="cv2-thread__activity" data-cv2-activity={items.length}>
      <button type="button" className="cv2-thread__activitytoggle" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {items.length} {items.length === 1 ? 'update' : 'updates'}
      </button>
      {open && (
        <ul className="cv2-thread__activitylist">
          {items.map((a) => (
            <li key={a.id}>
              {a.actor && <Avatar actor={a.actor} size={16} />}
              <span className="t-code">{a.verb}</span>
              <span className="cv2-thread__time">{relTime(a.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Actors seen in this thread + entities already cached = what `@`/`#` offer. */
function useCandidates(
  nodes: readonly MessageNode[],
  override?: readonly MentionCandidate[],
): MentionCandidate[] {
  const cached = useGraphStore((s) => s.entities);
  return useMemo(() => {
    if (override) return [...override];
    const byId = new Map<EntityId, MentionCandidate>();
    const addActor = (a: ActorSummary): void => {
      if (!byId.has(a.id)) {
        byId.set(a.id, { id: a.id, display: a.displayName, kind: a.kind, meta: a.isAgent ? 'agent' : (a.role ?? 'member') });
      }
    };
    const walk = (n: MessageNode): void => {
      addActor(n.message.state.author);
      for (const m of n.message.content.mentions) {
        if (!byId.has(m.entityId)) byId.set(m.entityId, { id: m.entityId, display: m.display, kind: m.kind });
      }
      n.children.forEach(walk);
    };
    nodes.forEach(walk);
    for (const e of Object.values(cached)) {
      if (UNREFERENCEABLE.has(e.kind) || e.deletedAt) continue;
      byId.set(e.id, { id: e.id, display: e.title, kind: e.kind, meta: e.kind });
    }
    return [...byId.values()];
  }, [nodes, cached, override]);
}

export function Thread({
  anchorId,
  variant = 'comments',
  viewer,
  reactionsSlot,
  composer = true,
  unreadCount: unreadProp,
  markReadOnView = true,
  mentionCandidates,
  live = true,
  defaultExpanded,
  estimateRowHeight = 92,
  overscan = 6,
  fallbackViewport,
  emptyHint = 'No messages yet — say something, @ someone, or drop a chip in to embed it.',
  className,
  ariaLabel,
}: ThreadProps) {
  const t = useThread({ anchorId, variant, viewer, unreadCount: unreadProp, live });
  const channelTagging = useChannelTagging();
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [tagTargets, setTagTargets] = useState<ChannelTagTarget[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagLoadError, setTagLoadError] = useState<string | null>(null);
  const listRef = useRef<VirtualListHandle | null>(null);
  const markedRef = useRef(false);
  const candidates = useCandidates(t.nodes, mentionCandidates);
  const tagSpaceId = variant === 'feed' ? t.anchor?.spaceId : undefined;

  useEffect(() => {
    if (!channelTagging || !tagSpaceId) {
      setTagTargets([]);
      setTagsLoading(false);
      setTagLoadError(null);
      return;
    }
    let cancelled = false;
    setTagsLoading(true);
    setTagLoadError(null);
    channelTagging.loadTargets(tagSpaceId).then(
      (targets) => {
        if (cancelled) return;
        setTagTargets(targets);
        setTagsLoading(false);
      },
      (error: unknown) => {
        if (cancelled) return;
        setTagTargets([]);
        setTagsLoading(false);
        setTagLoadError(error instanceof Error && error.message ? error.message : 'unavailable');
      },
    );
    return () => { cancelled = true; };
  }, [channelTagging, tagSpaceId]);

  // Comment threads read as one conversation, so their subtrees start open.
  // A first page carries only ONE level of replies inline, so anything deeper
  // is fetched per root (once) and expanded as it arrives.
  const expandMode = defaultExpanded ?? (variant === 'feed' ? 'none' : 'all');
  const { nodes, expandMany, loadReplies } = t;
  const fetchedRoots = useRef<Set<EntityId>>(new Set());
  useEffect(() => { fetchedRoots.current = new Set(); }, [anchorId]);
  useEffect(() => {
    if (expandMode !== 'all') return;
    const ids: EntityId[] = [];
    const incomplete: MessageNode[] = [];
    const walk = (n: MessageNode): void => {
      if (n.children.length > 0) ids.push(n.message.id);
      if (n.missingReplies > 0) incomplete.push(n);
      n.children.forEach(walk);
    };
    nodes.forEach(walk);
    for (const n of incomplete) {
      const rootId = n.message.state.rootMessageId ?? n.message.id;
      if (fetchedRoots.current.has(rootId)) continue;
      fetchedRoots.current.add(rootId);
      loadReplies(n);
    }
    expandMany(ids);
  }, [nodes, expandMode, expandMany, loadReplies, anchorId]);

  const rows = useMemo(() => {
    const base = flattenRows(t.nodes, t.expanded, t.firstUnreadId, t.unreadCount);
    const withActivity = variant === 'feed' ? foldActivity(base, t.activity) : base;
    return [
      ...withActivity,
      ...t.pending.map((p): ThreadRow => ({ kind: 'pending', key: p.clientMutationId, pending: p })),
    ];
  }, [t.nodes, t.expanded, t.firstUnreadId, t.unreadCount, t.activity, t.pending, variant]);

  const unreadIndex = useMemo(() => rows.findIndex((r) => r.kind === 'unread'), [rows]);

  const markRead = useCallback((): void => {
    if (markedRef.current) return;
    markedRef.current = true;
    t.markRead();
  }, [t]);

  // New rows arriving while parked at the bottom keep the view pinned there.
  const rowCount = rows.length;
  useEffect(() => {
    if (listRef.current?.isAtBottom()) listRef.current.scrollToBottom();
  }, [rowCount]);

  const toggleReplies = useCallback((id: EntityId): void => {
    const find = (list: readonly MessageNode[]): MessageNode | undefined => {
      for (const n of list) {
        if (n.message.id === id) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return undefined;
    };
    const node = find(t.nodes);
    if (node && !t.expanded.has(id) && node.missingReplies > 0) t.loadReplies(node);
    t.toggleReplies(id);
  }, [t]);

  const onSubmit = useCallback((draft: {
    body: string;
    mentions: MessageView['content']['mentions'];
    attachments: MessageView['content']['attachments'];
    selectedTagTargetIds: EntityId[];
  }): Promise<void> => (async () => {
    if (draft.selectedTagTargetIds.length > 0) {
      if (replyTo) {
        throw new Error('Team and session @Tags are available only on top-level channel messages');
      }
      if (!channelTagging || !tagSpaceId) {
        throw new Error('Team and session @Tags are not available for this discussion');
      }
      await channelTagging.send({
        spaceId: tagSpaceId,
        channelId: anchorId,
        body: draft.body,
        selectedTagIds: draft.selectedTagTargetIds,
        mentionIds: draft.mentions.map((mention) => mention.entityId),
        attachmentIds: draft.attachments.map((attachment) => attachment.fileEntityId),
      });
    } else {
      t.post({
        body: draft.body,
        mentions: draft.mentions,
        attachments: draft.attachments,
        parentMessageId: replyTo?.id ?? null,
      });
    }
    if (replyTo) {
      // A reply must be visible where it lands.
      const rootId = replyTo.state.rootMessageId ?? replyTo.id;
      if (!t.expanded.has(rootId)) t.toggleReplies(rootId);
      if (!t.expanded.has(replyTo.id)) t.toggleReplies(replyTo.id);
      setReplyTo(null);
    }
    markRead();
  })(), [t, replyTo, markRead, channelTagging, tagSpaceId, anchorId]);

  const renderRow = useCallback((row: ThreadRow) => {
    switch (row.kind) {
      case 'unread':
        return <UnreadDivider count={row.count} />;
      case 'activity':
        return <ActivityRow items={row.items} />;
      case 'more-replies':
        return (
          <button type="button" className="cv2-thread__more"
            style={{ marginLeft: Math.min(row.node.depth + 1, 6) * 20 }}
            onClick={() => t.loadReplies(row.node)}>
            Load {row.node.missingReplies} more {row.node.missingReplies === 1 ? 'reply' : 'replies'}
          </button>
        );
      case 'pending':
        return (
          <PendingRow
            body={row.pending.body}
            mentions={row.pending.mentions}
            attachments={row.pending.attachments}
            author={row.pending.author}
            failed={row.pending.failed}
            onRetry={() => t.retry(row.pending.clientMutationId)}
            onDiscard={() => t.discard(row.pending.clientMutationId)}
          />
        );
      default:
        return (
          <MessageRow
            node={row.node}
            viewer={t.viewer}
            expanded={t.expanded.has(row.node.message.id)}
            onToggleReplies={toggleReplies}
            onReply={setReplyTo}
            onEdit={t.edit}
            onDelete={t.remove}
            reactionsSlot={reactionsSlot}
            unread={row.node.message.id === t.firstUnreadId}
            compact={variant === 'comments'}
          />
        );
    }
  }, [t, toggleReplies, reactionsSlot, variant]);

  const typing = t.typingActorIds;

  return (
    <section
      className={`cv2-thread cv2-thread--${variant}${className ? ` ${className}` : ''}`}
      data-cv2-thread={anchorId}
      data-variant={variant}
      aria-label={ariaLabel ?? `Discussion on ${t.anchor?.title ?? anchorId}`}
    >
      {t.unreadCount > 0 && (
        <div className="cv2-thread__jump">
          <button type="button" className="cv2-actionbtn" onClick={() => {
            if (unreadIndex >= 0) listRef.current?.scrollToIndex(unreadIndex, 'center');
          }}>
            ↑ {t.unreadCount} new · jump to unread
          </button>
          <button type="button" className="cv2-thread__act" onClick={markRead}>Mark read</button>
        </div>
      )}

      {t.error && <p className="cv2-thread__error" role="alert">Discussion unavailable — <span className="t-code">{t.error}</span></p>}

      {t.loading ? (
        <div className="cv2-thread__loading" aria-hidden="true">
          <span className="cv2-skel" style={{ width: '72%' }} />
          <span className="cv2-skel" style={{ width: '55%' }} />
          <span className="cv2-skel" style={{ width: '64%' }} />
        </div>
      ) : rows.length === 0 ? (
        <p className="cv2-empty-line" data-cv2-empty="true">{emptyHint}</p>
      ) : (
        <VirtualList
          items={rows}
          itemKey={(row) => row.key}
          renderItem={renderRow}
          estimateHeight={estimateRowHeight}
          overscan={overscan}
          fallbackViewport={fallbackViewport}
          className="cv2-thread__list"
          ariaLabel="Messages"
          onAtBottomChange={(atBottom) => { if (atBottom && markReadOnView) markRead(); }}
          handleRef={listRef}
          header={t.hasMore ? (
            <button type="button" className="cv2-thread__more" onClick={t.loadMore}>Load earlier messages</button>
          ) : undefined}
        />
      )}

      {typing.length > 0 && (
        <p className="cv2-thread__typing" aria-live="polite">
          {typing.length === 1 ? 'someone is' : `${typing.length} people are`} typing…
        </p>
      )}

      {composer && (
        <Composer
          anchorId={anchorId}
          spaceId={t.anchor?.spaceId}
          candidates={candidates}
          tagTargets={tagTargets}
          tagSuggestionsEnabled={!replyTo}
          tagsLoading={!replyTo && tagsLoading}
          tagLoadError={!replyTo ? tagLoadError : null}
          contextLabel={replyTo ? `Replying to ${replyTo.state.author.displayName}` : undefined}
          onCancel={replyTo ? () => setReplyTo(null) : undefined}
          onSubmit={onSubmit}
          placeholder={t.anchor
            ? `Message ${t.anchor.title} — @ mentions, # entities, or add anything`
            : undefined}
        />
      )}
    </section>
  );
}

/** Total messages held by a node list — handy for callers and tests. */
export function countMessages(nodes: readonly MessageNode[]): number {
  return nodes.reduce((n, node) => n + nodeCount(node), 0);
}
