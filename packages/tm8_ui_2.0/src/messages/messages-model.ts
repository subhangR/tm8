/**
 * `src/messages/messages-model.ts` — the pure core of the Messages view.
 *
 * Types and projections ONLY: no React, no seam, no DOM. `useMessagesData`
 * sequences the reads and `MessagesScreen` draws them; both import their shared
 * vocabulary from here, which is what keeps the hook and the screen from
 * drifting into two slightly different ideas of what a conversation is.
 *
 * THE ONE IDEA THIS FILE ENCODES. A "conversation" is not a new entity and not
 * a set of blessed kinds — it is ANY ANCHOR THAT HAS MESSAGES ON IT. A channel,
 * a task, a session and a doc are all conversations the moment someone posts,
 * and the whole point of this view is that the viewer stops having to know which
 * kind they are reading in order to read it.
 *
 * WHICH IS ALSO WHY THIS LANE NAMES NO KIND (§15.2, enforced by
 * `no-kind-literals.test.ts` in this directory). The first draft of this file
 * carried a `CONVERSATION_KINDS` array — channel, task, work_session, doc, … —
 * to send as `collections.query`'s `kinds` filter. That was the wrong shape
 * twice over: it is a kind branch by another name, and it would have gone stale
 * the moment a new kind learned to hold a discussion. The predicate that
 * replaced it is STRUCTURAL and needs no list:
 *
 *     counters.messages > 0
 *
 * The query therefore asks for NO kinds at all and sorts by `activityAt_desc`.
 * That is not a concession — it is exact. Every message insert bumps its
 * anchor's `activity_at` (`internal.maintain_message_counter`, migration 001),
 * so entities with live discussions are precisely the ones that sort to the
 * top, and the filter below keeps the ones that actually have messages.
 *
 * WHY `unread` IS `number | null` AND NEVER `0` BY DEFAULT. The server computes
 * per-anchor unread for CHANNELS only — `loadUnreadCounts` (server
 * `facade/entity-read.ts`) is scoped to the one kind whose state carries the
 * count. The underlying primitive is general (`public.unread_counts` groups over
 * every anchor and `read_marks` never had a channel constraint), so this is a
 * facade narrowing rather than a missing capability — but it is TODAY'S TRUTH,
 * and a row rendering `0 unread` would claim a measurement nobody took. `null`
 * means "not computed for this conversation"; the screen draws nothing for it.
 * When the server widens, these nulls become numbers with no change here — and
 * note the detection below is STRUCTURAL (does this state carry a count?), not
 * a test for the channel kind, so the widening needs no edit at all.
 */
import type { EntityId, EntityKind, EntitySummary, MessageView } from '@tm8/contract';

/** The two readings the screen offers. */
export type MessagesMode = 'conversations' | 'all';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The last message on a conversation, when we have been able to learn it. */
export interface LastMessage {
  id: EntityId;
  authorName: string;
  /** Server-truncated excerpt. Never the full body — that is the feed's job. */
  excerpt: string;
  createdAt: string;
}

/** One row in the conversation list. */
export interface ConversationRow {
  id: EntityId;
  /** Carried for its ICON and for filtering. Nothing here branches on it. */
  kind: EntityKind;
  title: string;
  /** `counters.messages` — how many messages live on this anchor. */
  messageCount: number;
  /** Bumped by every message insert, so this IS recency-of-conversation. */
  activityAt: string;
  /** Unread for this viewer, or `null` when uncomputed. `null` is not zero. */
  unread: number | null;
  /** `null` ⇒ we have not learned it, which is not the same as "none". */
  lastMessage: LastMessage | null;
}

/** One row in the flat "All messages" reading. */
export interface MessageRow {
  id: EntityId;
  anchorId: EntityId;
  /** Resolved from the conversation index when known; `null` renders honestly. */
  anchorTitle: string | null;
  anchorKind: EntityKind | null;
  authorName: string;
  excerpt: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Structural discrimination — the alternative to naming a kind
// ---------------------------------------------------------------------------

/**
 * A message summary's anchor id, or `null` if this summary is not a message.
 *
 * STRUCTURAL, on purpose: a message is the only entity state carrying an
 * `anchorId`, so its presence identifies the shape without the lane ever
 * spelling the kind. Same move as `files/model.ts:rowFromEntity`, which
 * discriminates on name/mimeType rather than on the kind string.
 */
export function anchorIdOf(summary: EntitySummary): EntityId | null {
  const state = summary.state as { anchorId?: unknown };
  return typeof state?.anchorId === 'string' && state.anchorId.length > 0 ? state.anchorId : null;
}

/** A message summary's author display name, falling back to the entity's creator. */
export function authorNameOf(summary: EntitySummary): string {
  const state = summary.state as { author?: { displayName?: unknown } };
  const authored = state?.author?.displayName;
  if (typeof authored === 'string' && authored.length > 0) return authored;
  const created = summary.createdBy?.displayName;
  return typeof created === 'string' && created.length > 0 ? created : 'Unknown';
}

/**
 * Per-anchor unread, when the server computed one.
 *
 * STRUCTURAL for the same reason as `anchorIdOf`, and with a second payoff: the
 * day `loadUnreadCounts` stops being channel-scoped, every newly-counted
 * conversation starts rendering its unread through this function unchanged.
 * A `kind === 'channel'` test would have had to be found and edited.
 */
export function unreadOf(summary: EntitySummary): number | null {
  const state = summary.state as { unreadCount?: unknown };
  return typeof state?.unreadCount === 'number' ? state.unreadCount : null;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Is this summary a conversation at all?
 *
 * `counters.messages > 0` is the whole test — see the file docblock. An anchor
 * with no messages is not a quiet conversation, it is not a conversation, and
 * listing it would fill the view with every entity in the space and bury the
 * ones people are actually talking on.
 *
 * A message entity is excluded structurally: it ANCHORS on something else, and
 * a reply anchors on the channel rather than on its root, so a message as a
 * conversation ROW would duplicate the conversation it already lives in.
 */
export function isConversation(summary: EntitySummary): boolean {
  if (summary.deletedAt !== null) return false;
  if (anchorIdOf(summary) !== null) return false;
  return (summary.counters?.messages ?? 0) > 0;
}

/** An `EntitySummary` as a conversation row, without its last message yet. */
export function conversationRowOf(summary: EntitySummary): ConversationRow {
  return {
    id: summary.id,
    kind: summary.kind,
    title: summary.title,
    messageCount: summary.counters?.messages ?? 0,
    activityAt: summary.activityAt,
    unread: unreadOf(summary),
    lastMessage: null,
  };
}

/** Every conversation in a page of summaries, newest-active first. */
export function conversationRowsOf(summaries: readonly EntitySummary[]): ConversationRow[] {
  return sortByRecency(summaries.filter(isConversation).map(conversationRowOf));
}

/**
 * The newest message per anchor, from a page of message summaries.
 *
 * WHY THIS EXISTS RATHER THAN A PER-ROW READ. The conversation query gives
 * ordering and counts but NOT the last message body, and there is no batch
 * entity read in the catalog — `entities.get` is single-id and `CollectionQuery`
 * has no `ids` filter — so the obvious "fetch the newest message for each row"
 * is an N+1 over the page. One extra query for messages sorted newest-first
 * covers the most recently active conversations in a SINGLE round trip, and
 * this folds that page down to one entry per anchor. Conversations older than
 * that page simply have no preview, which renders as absence rather than as a
 * wrong preview.
 */
export function lastMessagesByAnchor(
  messages: readonly EntitySummary[],
): ReadonlyMap<EntityId, LastMessage> {
  const out = new Map<EntityId, LastMessage>();
  for (const m of messages) {
    const anchorId = anchorIdOf(m);
    if (anchorId === null) continue;
    // The page arrives newest-first, so the FIRST entry per anchor is the
    // newest; later entries are older and must not overwrite it.
    if (out.has(anchorId)) continue;
    out.set(anchorId, {
      id: m.id,
      authorName: authorNameOf(m),
      excerpt: m.excerpt ?? '',
      createdAt: m.createdAt,
    });
  }
  return out;
}

/** Attaches previews to rows. Rows with no known preview keep `lastMessage: null`. */
export function withLastMessages(
  rows: readonly ConversationRow[],
  previews: ReadonlyMap<EntityId, LastMessage>,
): ConversationRow[] {
  return rows.map((row) => {
    const preview = previews.get(row.id);
    return preview ? { ...row, lastMessage: preview } : row;
  });
}

/** Message summaries as flat rows, with anchor identity resolved where known. */
export function messageRowsOf(
  messages: readonly EntitySummary[],
  anchors: ReadonlyMap<EntityId, { title: string; kind: EntityKind }>,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const m of messages) {
    const anchorId = anchorIdOf(m);
    if (anchorId === null) continue;
    const anchor = anchors.get(anchorId);
    rows.push({
      id: m.id,
      anchorId,
      // NOT a placeholder title. An unresolved anchor is drawn as unresolved.
      anchorTitle: anchor?.title ?? null,
      anchorKind: anchor?.kind ?? null,
      authorName: authorNameOf(m),
      excerpt: m.excerpt ?? '',
      createdAt: m.createdAt,
    });
  }
  return rows;
}

/** A live `message.created` folded into the rows the screen is already showing. */
export function applyMessageCreated(
  rows: readonly ConversationRow[],
  anchorId: EntityId,
  message: MessageView,
): ConversationRow[] {
  let found = false;
  const next = rows.map((row) => {
    if (row.id !== anchorId) return row;
    found = true;
    return {
      ...row,
      messageCount: row.messageCount + 1,
      activityAt: message.createdAt,
      lastMessage: {
        id: message.id,
        authorName: authorNameOf(message),
        excerpt: message.excerpt ?? message.content?.body ?? '',
        createdAt: message.createdAt,
      },
    };
  });
  // An arrival on an anchor we are NOT showing is deliberately not synthesized
  // into a row: we would have to invent its title and kind, and a row reading
  // "Untitled" is worse than one that appears on the next read. The count and
  // ordering of what we DO show stay correct either way.
  return found ? sortByRecency(next) : [...rows];
}

/** Newest-active first. Ties break on id so the order is total and stable. */
export function sortByRecency(rows: readonly ConversationRow[]): ConversationRow[] {
  return [...rows].sort((a, b) => {
    if (a.activityAt !== b.activityAt) return a.activityAt < b.activityAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

/** Newest-first for the flat reading. Same total-order rule. */
export function sortMessagesByRecency(rows: readonly MessageRow[]): MessageRow[] {
  return [...rows].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
}

/** Dedupe by id, keeping first occurrence — pages can overlap on a live list. */
export function dedupeById<T extends { id: EntityId }>(rows: readonly T[]): T[] {
  const seen = new Set<EntityId>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** The kinds actually present, in the order the rows first show them. */
export function kindsPresent(rows: readonly ConversationRow[]): EntityKind[] {
  const seen: EntityKind[] = [];
  for (const row of rows) if (!seen.includes(row.kind)) seen.push(row.kind);
  return seen;
}

/** `null` / empty selection means "no filter", never "match nothing". */
export function applyKindFilter(
  rows: readonly ConversationRow[],
  kinds: readonly EntityKind[] | null,
): ConversationRow[] {
  if (!kinds || kinds.length === 0) return [...rows];
  return rows.filter((row) => kinds.includes(row.kind));
}

/** The anchor index the flat reading resolves names against. */
export function anchorIndexOf(
  rows: readonly ConversationRow[],
): ReadonlyMap<EntityId, { title: string; kind: EntityKind }> {
  const out = new Map<EntityId, { title: string; kind: EntityKind }>();
  for (const row of rows) out.set(row.id, { title: row.title, kind: row.kind });
  return out;
}

// ---------------------------------------------------------------------------
// Copy — one home, so the screen and its tests cannot disagree
// ---------------------------------------------------------------------------

/** Why a row's unread is blank. Surfaced on hover, never as a fake zero. */
export const UNREAD_NOT_COMPUTED_REASON =
  'Unread is computed for channels only — this conversation shows its message count instead.';

export const NO_CONVERSATIONS_NOTE =
  'No conversations yet. Anything in this space becomes a conversation the moment someone posts on it.';

export const NO_MATCHES_NOTE = 'Nothing matches these filters.';

export const CONVERSATIONS_UNRESOLVED_NOTE = 'Loading conversations…';

/**
 * Search is NOT implemented server-side — `search.query` is `status: 'reserved'`
 * in the operation catalog. A box that filtered only the rows already loaded
 * would look like search and not be it, so the control is rendered
 * disabled-with-reason rather than shipped as a half-truth.
 */
export const SEARCH_DISABLED_REASON =
  'Search across all messages is not built yet — the server has no message-search operation, so a box here could only filter the messages already loaded.';

/** The composer's honest note when the anchor is a running agent session. */
export const SESSION_DELIVERY_NOTE =
  'Messages to a session are typed into the agent’s terminal — a busy agent can take up to a minute to see this.';

/** Relative time, minute-grained. Pure so the screen stays deterministic. */
export function relativeTime(iso: string, now: Date): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 52) return `${weeks}w`;
  return `${Math.floor(days / 365)}y`;
}
