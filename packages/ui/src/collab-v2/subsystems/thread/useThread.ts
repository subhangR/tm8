/**
 * useThread — everything the Thread knows, with no DOM in sight.
 *
 * Message history is paged from the facade into a local id-map (uncapped:
 * a virtualized thread is expected to hold 10k rows, while the graph store's
 * `messagesByAnchor` is a bounded LIVE TAIL cache). Every WorkspaceEvent that
 * touches this anchor lands in that store, and the hook overlays it on top of
 * the paged history — so history is complete and the tail is always current.
 *
 * Replies are child messages: the server hands back roots with one page of
 * direct replies inline, and `getMessages(anchor, {rootId})` returns a whole
 * subtree flat. Either way the tree is rebuilt here from `parentId`.
 *
 * Mutations are optimistic: a pending row appears immediately, the anchor's
 * counters are patched through the graph store's `clientMutationId` journal,
 * and the command either reconciles (event already delivered the real row) or
 * rolls back with a typed error code (contract §4 / DEV-8).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFacade } from '../../entity';
import { useGraphStore, usePresenceStore, dispatchWorkspaceEvent } from '../../stores';
import {
  isCollabError,
  type ActivityItem, type ActorSummary, type EntityDetail, type EntityId,
  type EntityState, type EntitySummary, type FileAttachment, type Mention,
  type MessageView,
} from '../../types/contract';
import type { MessageNode, PendingMessage, ThreadVariant } from './types';

const EMPTY_IDS: EntityId[] = [];

let mutationSeq = 0;
/** Per-session unique id — the idempotency key honoured on every mutation. */
export function newMutationId(): string {
  mutationSeq += 1;
  return `cmid_${Date.now().toString(36)}_${mutationSeq}`;
}

/** Unread lives on `state` for kinds that track it; absent means zero. */
function unreadOf(state: EntityState | undefined): number {
  return (state as { unreadCount?: number } | undefined)?.unreadCount ?? 0;
}

const byCreatedAt = (a: MessageView, b: MessageView): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt);

/** Rebuilds the reply forest from `parentId`, newest last at every level. */
export function buildTree(messages: readonly MessageView[]): MessageNode[] {
  const sorted = [...messages].sort(byCreatedAt);
  const present = new Set(sorted.map((m) => m.id));
  const childrenOf = new Map<EntityId, MessageView[]>();
  const roots: MessageView[] = [];

  for (const m of sorted) {
    const parentId = m.parentId;
    // An orphan (parent not paged in yet) is shown at root rather than dropped.
    if (parentId && present.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(m);
      childrenOf.set(parentId, list);
    } else {
      roots.push(m);
    }
  }

  const build = (message: MessageView, depth: number): MessageNode => {
    const kids = (childrenOf.get(message.id) ?? []).map((c) => build(c, depth + 1));
    return {
      message,
      depth,
      children: kids,
      missingReplies: Math.max(0, (message.replyCount ?? 0) - kids.length),
    };
  };
  return roots.map((r) => build(r, 0));
}

/**
 * A command result carries the message as an `EntityDetail`; a `MessageView`
 * is that plus `replyCount`. Only the stream knows the true count, so keep
 * whatever we already had and let `message.updated` correct it.
 */
function asMessageView(detail: EntityDetail, prev?: MessageView): MessageView | null {
  const state = detail.state as MessageView['state'];
  const content = detail.content as MessageView['content'];
  if (typeof state?.anchorId !== 'string' || typeof content?.body !== 'string') return null;
  return { ...detail, state, content, replyCount: prev?.replyCount ?? 0 };
}

function messagePatch(result: { patches: EntitySummary[] }): MessageView | null {
  const candidate = result.patches.find((patch) => 'content' in patch);
  return candidate ? asMessageView(candidate as EntityDetail) : null;
}

/** Roots plus every inline reply page, flattened for ingestion. */
function flattenPage(items: readonly MessageView[]): MessageView[] {
  const out: MessageView[] = [];
  const walk = (m: MessageView): void => {
    out.push(m);
    for (const r of m.replies?.items ?? []) walk(r);
  };
  for (const m of items) walk(m);
  return out;
}

export interface PostDraft {
  body: string;
  mentions?: Mention[];
  attachments?: FileAttachment[];
  parentMessageId?: EntityId | null;
}

export interface ThreadController {
  anchor: EntitySummary | undefined;
  viewer: ActorSummary | undefined;
  loading: boolean;
  error: string | null;
  nodes: MessageNode[];
  messageCount: number;
  hasMore: boolean;
  loadMore: () => void;
  expanded: ReadonlySet<EntityId>;
  toggleReplies: (id: EntityId) => void;
  expandMany: (ids: readonly EntityId[]) => void;
  loadReplies: (node: MessageNode) => void;
  pending: PendingMessage[];
  activity: ActivityItem[];
  unreadCount: number;
  firstUnreadId: EntityId | null;
  typingActorIds: EntityId[];
  post: (draft: PostDraft) => void;
  edit: (id: EntityId, draft: { body: string; mentions?: Mention[] }) => Promise<void>;
  remove: (id: EntityId) => void;
  retry: (clientMutationId: string) => void;
  discard: (clientMutationId: string) => void;
  markRead: () => void;
}

export interface UseThreadOptions {
  anchorId: EntityId;
  variant: ThreadVariant;
  viewer?: ActorSummary;
  unreadCount?: number;
  live?: boolean;
}

export function useThread({
  anchorId, variant, viewer: viewerProp, unreadCount: unreadProp, live = true,
}: UseThreadOptions): ThreadController {
  const facade = useFacade();
  const [history, setHistory] = useState<Map<EntityId, MessageView>>(() => new Map());
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<EntityId>>(() => new Set());
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [resolvedViewer, setResolvedViewer] = useState<ActorSummary | undefined>(viewerProp);

  const anchor = useGraphStore((s) => s.entities[anchorId]);
  const liveTail = useGraphStore((s) => s.messagesByAnchor[anchorId]);
  const typingActorIds = usePresenceStore((s) => s.typingByAnchor[anchorId] ?? EMPTY_IDS);

  const viewer = viewerProp ?? resolvedViewer;
  const viewerId = viewer?.id;

  // Latest history without widening any callback's dependency list.
  const historyRef = useRef(history);
  historyRef.current = history;

  const ingest = useCallback((items: readonly MessageView[]): void => {
    if (items.length === 0) return;
    setHistory((prev) => {
      const next = new Map(prev);
      for (const m of items) next.set(m.id, m);
      return next;
    });
  }, []);

  // --- anchor summary --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    facade.getEntity(anchorId)
      .then((detail) => { if (!cancelled) useGraphStore.getState().ingestDetail(detail); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [facade, anchorId]);

  // --- first page ------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setHistory(new Map());
    setCursor(null);
    facade.getMessages(anchorId)
      .then((page) => {
        if (cancelled) return;
        ingest(flattenPage(page.items));
        setCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(isCollabError(e) ? e.code : 'unavailable');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [facade, anchorId, ingest]);

  // --- feed variant folds the anchor's activity in ---------------------------
  useEffect(() => {
    if (variant !== 'feed') { setActivity([]); return; }
    let cancelled = false;
    facade.getActivity(anchorId)
      .then((page) => { if (!cancelled) setActivity(page.items); })
      .catch(() => { if (!cancelled) setActivity([]); });
    return () => { cancelled = true; };
  }, [facade, anchorId, variant]);

  // --- realtime --------------------------------------------------------------
  const spaceId = anchor?.spaceId;
  useEffect(() => {
    if (!live || !spaceId) return;
    // Double-subscribing is harmless: dispatch de-dups on eventId.
    return facade.subscribe(spaceId, dispatchWorkspaceEvent);
  }, [facade, live, spaceId]);

  // --- viewer ----------------------------------------------------------------
  useEffect(() => {
    if (viewerProp || resolvedViewer || !spaceId) return;
    let cancelled = false;
    facade.getNavigation(spaceId)
      .then((nav) => { if (!cancelled) setResolvedViewer(nav.viewer); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [facade, spaceId, viewerProp, resolvedViewer]);

  // --- merged history + live tail -------------------------------------------
  const messages = useMemo(() => {
    const merged = new Map(history);
    for (const m of liveTail ?? []) {
      if (m.state.anchorId === anchorId || merged.has(m.id)) merged.set(m.id, m);
    }
    return [...merged.values()];
  }, [history, liveTail, anchorId]);

  const nodes = useMemo(() => buildTree(messages), [messages]);

  // --- unread line: computed once per anchor, then frozen --------------------
  const unreadCount = unreadProp ?? unreadOf(anchor?.state);
  const frozen = useRef<{ anchorId: EntityId; count: number; firstUnreadId: EntityId | null } | null>(null);
  if (frozen.current?.anchorId !== anchorId) frozen.current = null;
  if (frozen.current === null && unreadCount > 0 && messages.length > 0 && viewerId) {
    const chronological = [...messages].sort(byCreatedAt);
    let seen = 0;
    let firstUnreadId: EntityId | null = null;
    for (let i = chronological.length - 1; i >= 0 && seen < unreadCount; i -= 1) {
      const m = chronological[i];
      if (m.state.author.id === viewerId) continue;
      firstUnreadId = m.id;
      seen += 1;
    }
    frozen.current = { anchorId, count: seen, firstUnreadId };
  }

  // --- actions ---------------------------------------------------------------
  const loadMore = useCallback((): void => {
    if (!cursor) return;
    const at = cursor;
    setCursor(null);
    facade.getMessages(anchorId, { cursor: at })
      .then((page) => { ingest(flattenPage(page.items)); setCursor(page.nextCursor); })
      .catch(() => setCursor(at));
  }, [facade, anchorId, cursor, ingest]);

  const loadReplies = useCallback((node: MessageNode): void => {
    const rootId = node.message.state.rootMessageId ?? node.message.id;
    facade.getMessages(anchorId, { rootId })
      .then((page) => ingest(flattenPage(page.items)))
      .catch(() => {});
  }, [facade, anchorId, ingest]);

  const toggleReplies = useCallback((id: EntityId): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandMany = useCallback((ids: readonly EntityId[]): void => {
    if (ids.length === 0) return;
    setExpanded((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const markRead = useCallback((): void => {
    facade.markRead(anchorId, { clientMutationId: newMutationId() }).catch(() => {});
  }, [facade, anchorId]);

  const send = useCallback((entry: PendingMessage): void => {
    const graph = useGraphStore.getState();
    const current = graph.entities[anchorId];
    if (current) {
      graph.applyOptimistic(entry.clientMutationId, [{
        ...current,
        counters: { ...current.counters, messages: current.counters.messages + 1 },
      }]);
    }
    facade.postMessage({
      anchorId,
      body: entry.body,
      mentions: entry.mentions,
      attachments: entry.attachments,
      parentMessageId: entry.parentMessageId,
      clientMutationId: entry.clientMutationId,
    })
      .then((res) => {
        useGraphStore.getState().reconcile(entry.clientMutationId);
        // The created message normally arrives by event; ingest defensively so
        // a facade without a live stream still shows what it just wrote.
        const created = res.entity ? asMessageView(res.entity) : messagePatch(res);
        if (created) ingest([created]);
        setPending((prev) => prev.filter((p) => p.clientMutationId !== entry.clientMutationId));
      })
      .catch((e: unknown) => {
        useGraphStore.getState().rollback(entry.clientMutationId);
        const code = isCollabError(e) ? e.code : 'unavailable';
        const message = e instanceof Error ? e.message : 'Could not send';
        setPending((prev) => prev.map((p) =>
          (p.clientMutationId === entry.clientMutationId ? { ...p, failed: { code, message } } : p)));
      });
  }, [facade, anchorId, ingest]);

  const post = useCallback((draft: PostDraft): void => {
    if (!draft.body.trim()) return;
    const entry: PendingMessage = {
      clientMutationId: newMutationId(),
      body: draft.body,
      mentions: draft.mentions ?? [],
      attachments: draft.attachments ?? [],
      parentMessageId: draft.parentMessageId ?? null,
      author: viewer,
      createdAt: new Date().toISOString(),
    };
    setPending((prev) => [...prev, entry]);
    send(entry);
  }, [send, viewer]);

  const retry = useCallback((clientMutationId: string): void => {
    setPending((prev) => {
      const entry = prev.find((p) => p.clientMutationId === clientMutationId);
      if (entry) send({ ...entry, failed: undefined });
      return prev.map((p) => (p.clientMutationId === clientMutationId ? { ...p, failed: undefined } : p));
    });
  }, [send]);

  const discard = useCallback((clientMutationId: string): void => {
    setPending((prev) => prev.filter((p) => p.clientMutationId !== clientMutationId));
  }, []);

  const edit = useCallback(async (id: EntityId, draft: { body: string; mentions?: Mention[] }): Promise<void> => {
    try {
      const res = await facade.patchMessage(id, {
        body: draft.body,
        mentions: draft.mentions,
        clientMutationId: newMutationId(),
      });
      const updated = res.entity ? asMessageView(res.entity, historyRef.current.get(id)) : null;
      if (updated) ingest([updated]);
    } catch (e: unknown) {
      setError(isCollabError(e) ? e.code : 'unavailable');
      throw e;
    }
  }, [facade, ingest]);

  const remove = useCallback((id: EntityId): void => {
    facade.deleteMessage(id, { clientMutationId: newMutationId() })
      .catch((e: unknown) => setError(isCollabError(e) ? e.code : 'unavailable'));
  }, [facade]);

  return {
    anchor,
    viewer,
    loading,
    error,
    nodes,
    messageCount: messages.length,
    hasMore: cursor !== null,
    loadMore,
    expanded,
    toggleReplies,
    expandMany,
    loadReplies,
    pending,
    activity,
    unreadCount: frozen.current?.count ?? 0,
    firstUnreadId: frozen.current?.firstUnreadId ?? null,
    typingActorIds,
    post,
    edit,
    remove,
    retry,
    discard,
    markRead,
  };
}
