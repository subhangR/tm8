/**
 * `src/inbox/inbox-model.ts` — the PURE model behind T3-7.
 *
 * No React, no seam, no DOM: given a page of `NotificationItem` (+ a `now`),
 * this produces the rows, the fixed-order groups, the counts and the honest
 * notes the screen renders. Everything here is a projection of contract data —
 * nothing is invented, and where the oracle draws something the data cannot
 * supply, this module's job is to say so rather than to fill it in.
 *
 * TWO LAWS THE ORACLE STATES IN PROSE AND THIS FILE ENCODES:
 *
 *  1. **Read ≠ resolved.** A read row fades, it never vanishes. So `readAt`
 *     drives a `unread` FLAG on the row, never a filter — the only thing that
 *     removes a read row from view is the viewer's own explicit `unread`
 *     filter.
 *  2. **Groups are in FIXED order, and failures always sit above replies.**
 *     `INBOX_GROUP_ORDER` is that order, and `buildGroups` cannot reorder it —
 *     an ordering the caller could vary is an ordering that will vary.
 */
import type { EntitySummary, NotificationItem } from '@tm8/contract';

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * `other` is NOT drawn by the oracle. It exists because `NotificationItem.kind`
 * is an OPEN union (`'mention' | 'assignment' | 'award' | 'unblock' |
 * 'review_request' | 'stale' | string`) while the oracle draws exactly four
 * groups — so without a catch-all, an `award` or an `unblock` row would arrive
 * from the node and be silently dropped on the floor. A row the viewer was sent
 * and never sees is the worst failure this screen can have, worse than a group
 * heading the canvas does not draw. Flagged as a deliberate addition (see
 * HANDOVER "divergences").
 */
export type InboxGroupKey = 'mentions' | 'assignments' | 'delivery-failures' | 'replies' | 'other';

/** T3-7: "groups in fixed order, failures always above replies". */
export const INBOX_GROUP_ORDER: readonly InboxGroupKey[] = [
  'mentions',
  'assignments',
  'delivery-failures',
  'replies',
  'other',
];

export const INBOX_GROUP_LABEL: Readonly<Record<InboxGroupKey, string>> = {
  mentions: 'MENTIONS',
  assignments: 'ASSIGNMENTS',
  'delivery-failures': 'DELIVERY FAILURES',
  replies: 'REPLIES',
  other: 'EVERYTHING ELSE',
};

/**
 * The delivery-failure membership test.
 *
 * NOT MEASURED AGAINST A REAL NODE — stated plainly because the alternative is
 * a comment that reads like a measurement. The contract enumerates six
 * notification kinds and NONE of them names a delivery failure; the delivery
 * facets the oracle's failure row shows (`delivery: unknown`) come from
 * `seam.delivery(messageId)`, which is per-message and on-demand, not from
 * `inbox.list`. So this predicate is a PREPARED READER for a kind string the
 * server may or may not emit, and the group renders only if rows actually
 * arrive for it. It is deliberately prefix-shaped rather than an equality
 * against a guessed literal.
 */
function isDeliveryFailureKind(kind: string): boolean {
  return /^delivery|undeliver|delivery_fail/i.test(kind);
}

/** Total over any `kind` string — an unrecognised kind lands in `other`, never nowhere. */
export function groupOf(kind: string): InboxGroupKey {
  if (kind === 'mention') return 'mentions';
  if (kind === 'assignment') return 'assignments';
  if (kind === 'reply') return 'replies';
  if (isDeliveryFailureKind(kind)) return 'delivery-failures';
  return 'other';
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface InboxRow {
  id: string;
  group: InboxGroupKey;
  /** `readAt == null`. Drives the brass dot + tinted row; NEVER hides anything. */
  unread: boolean;
  /** "@noa mentioned you" — actor + verb. */
  headline: string;
  /** The actor, for the avatar. `null` when the item carries none. */
  actor: { id: string; label: string; isAgent: boolean; avatar?: string | null } | null;
  /** "▤ Menu spec" — the entity the notification points at. */
  target: { id: string; kind: string; title: string } | null;
  /** "12m" — relative, computed against an injected `now`. */
  recency: string;
  /** The quoted line under the headline. `null` when the item carries none. */
  preview: string | null;
  /** The raw kind, for the type filter and for honest display of unknown kinds. */
  kind: string;
  createdAt: string;
}

/**
 * Verb phrasing per kind. A kind absent from this table is NOT dropped and NOT
 * mis-labelled: `humaniseKind` turns `review_request` into "review request" so
 * an unknown-but-real notification still reads as a sentence.
 */
const VERB: Readonly<Record<string, string>> = {
  mention: 'mentioned you',
  assignment: 'assigned you',
  reply: 'replied',
  review_request: 'requested your review',
  unblock: 'unblocked you',
  award: 'awarded you',
  stale: 'flagged this as stale',
};

function humaniseKind(kind: string): string {
  return kind.replace(/[_-]+/g, ' ');
}

/**
 * The headline. With no actor the verb stands alone, capitalised — inventing
 * "Someone" would be a fabricated fact on the loudest line of the row.
 */
export function headlineOf(item: NotificationItem): string {
  const verb = VERB[item.kind] ?? humaniseKind(item.kind);
  const actor = item.actor?.displayName;
  if (!actor) return verb.charAt(0).toUpperCase() + verb.slice(1);
  return `${actor} ${verb}`;
}

function targetOf(target: EntitySummary | null | undefined): InboxRow['target'] {
  if (!target) return null;
  // The KIND travels, not a mark for it: the screen draws the registry's
  // artwork (§15.2 — this module still never names a kind, and now it does not
  // have to know how one is pictured either).
  return { id: target.id, kind: target.kind, title: target.title };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "12m" / "2h" / "1d". `now` is INJECTED rather than read from the clock so the
 * projection is a pure function and its tests are not time-of-day-dependent.
 * An unparseable timestamp returns `'—'` rather than `NaNm`.
 */
export function recencyOf(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const delta = Math.max(0, now.getTime() - then);
  if (delta < MINUTE) return 'now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  return `${Math.floor(delta / DAY)}d`;
}

export function inboxRowOf(item: NotificationItem, now: Date): InboxRow {
  return {
    id: item.id,
    group: groupOf(item.kind),
    unread: item.readAt == null,
    headline: headlineOf(item),
    actor: item.actor ? {
      id: item.actor.id,
      label: item.actor.displayName,
      isAgent: item.actor.isAgent,
      avatar: item.actor.avatar,
    } : null,
    target: targetOf(item.target),
    recency: recencyOf(item.createdAt, now),
    preview: item.message?.trim() ? item.message.trim() : null,
    kind: item.kind,
    createdAt: item.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface InboxFilters {
  unreadOnly: boolean;
  /** `null` ⇒ every kind. A non-null set is the viewer's explicit choice. */
  kinds: readonly string[] | null;
}

export const NO_FILTERS: InboxFilters = { unreadOnly: false, kinds: null };

export function filtersActive(f: InboxFilters): boolean {
  return f.unreadOnly || (f.kinds != null && f.kinds.length > 0);
}

export function applyFilters(rows: readonly InboxRow[], f: InboxFilters): InboxRow[] {
  return rows.filter((r) => {
    if (f.unreadOnly && !r.unread) return false;
    if (f.kinds != null && f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
    return true;
  });
}

/** The kinds actually present, for the `type ▾` menu — never a hardcoded list. */
export function kindsPresent(rows: readonly InboxRow[]): string[] {
  return [...new Set(rows.map((r) => r.kind))].sort();
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface InboxGroup {
  key: InboxGroupKey;
  label: string;
  rows: InboxRow[];
  /** The heading's count. Reads "· 2", or "· 1 READ" when the group is fully read. */
  countLabel: string;
  /** `delivery-failures` heads in the block tone; everything else is neutral. */
  alarm: boolean;
}

/**
 * Non-empty groups only, in `INBOX_GROUP_ORDER`. Rows inside a group stay
 * newest-first — the ORDER THE SERVER SENT is not trusted to be sorted, because
 * `inbox.list`'s ordering is not part of the contract's stated guarantees.
 */
export function buildGroups(rows: readonly InboxRow[]): InboxGroup[] {
  const out: InboxGroup[] = [];
  for (const key of INBOX_GROUP_ORDER) {
    const members = rows
      .filter((r) => r.group === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (members.length === 0) continue;
    const unread = members.filter((r) => r.unread).length;
    out.push({
      key,
      label: INBOX_GROUP_LABEL[key],
      rows: members,
      countLabel: unread === 0 ? `${members.length} READ` : `${members.length}`,
      alarm: key === 'delivery-failures',
    });
  }
  return out;
}

export function unreadCount(rows: readonly InboxRow[]): number {
  return rows.filter((r) => r.unread).length;
}

// ---------------------------------------------------------------------------
// The honest notes
// ---------------------------------------------------------------------------

/**
 * THE ABSENCE LINE. Design law 9: an absence is STATED, quieter — not shouted
 * by an expanded empty section, and not silently omitted either. This names the
 * oracle-drawn groups that have no rows, so the viewer learns the group exists
 * and is empty rather than concluding the app forgot it.
 *
 * `other` is excluded on purpose: it is this build's catch-all, not a promise
 * the screen made, so "no everything else" would be noise.
 */
export function emptyGroupsNote(rows: readonly InboxRow[]): string | null {
  const drawn: InboxGroupKey[] = ['mentions', 'assignments', 'delivery-failures', 'replies'];
  const missing = drawn.filter((k) => !rows.some((r) => r.group === k));
  if (missing.length === 0) return null;
  return `nothing here: ${missing.map((k) => INBOX_GROUP_LABEL[k].toLowerCase()).join(' · ')}`;
}

/**
 * The list's own empty state. FOUR distinct facts, never collapsed into one —
 * "we haven't asked yet", "the read failed", "your filter hides everything" and
 * "your inbox really is empty" are different, and a viewer who cannot tell them
 * apart cannot act on any of them.
 */
export function inboxEmptyNote(
  items: readonly NotificationItem[] | null,
  error: string | null,
  filters: InboxFilters,
): string {
  if (error) return `The inbox read failed — ${error}. Nothing is hidden; this list has no data to show.`;
  if (items == null) return 'Loading your inbox…';
  if (items.length > 0 && filtersActive(filters)) {
    return `${items.length} notification${items.length === 1 ? '' : 's'} loaded, none match this filter. Clear the filter to see them.`;
  }
  return 'Nothing in your inbox. Mentions, assignments and replies land here as they happen.';
}

// ---------------------------------------------------------------------------
// The stated gaps (R7 copy, one home so the screen and the handover agree)
// ---------------------------------------------------------------------------

/**
 * GAP 1 — the audience split. The oracle draws `[you | your teammates · 2]` and
 * a whole second card of teammates' notifications. `Seam.inbox()` takes NO
 * actor parameter: it is the viewer's own inbox and nothing else. There is no
 * read behind this tab, so it is refused with the true reason and its count is
 * NOT rendered — a "· 2" nobody counted would be a fabricated number on a
 * control that cannot be opened.
 */
export const TEAMMATE_AUDIENCE_REASON = {
  cause: 'Your teammates’ inboxes aren’t readable in this build',
  remedy: 'seam.inbox() returns the viewer’s own notifications and takes no actor parameter',
} as const;

/**
 * GAP 2 — "Send again". `commands.postMessage` exists, but a `NotificationItem`
 * carries `{ kind, actor, target, message, recipient, readAt, createdAt }` and
 * no `PostMessageInput` can be rebuilt from that: no anchor, no body,
 * no original message id. Re-sending from a guess would send the WRONG message,
 * which is worse than not sending.
 */
export const SEND_AGAIN_REASON = {
  cause: 'Send again can’t be built from a notification',
  remedy: 'the row carries no message id or anchor, so there is nothing to re-send',
} as const;

/**
 * GAP 3 — the row is a link and this build has nowhere to send it. Structural
 * (is there a handler?), so it cannot drift out of sync with the wiring.
 */
export const ROW_NOT_WIRED_REASON = {
  cause: 'This row can’t open its entity yet',
  remedy: 'the screen is mounted without an open handler in this build',
} as const;

/** The click-through contract the oracle's CLICK-THROUGH card specifies. */
export const CLICK_THROUGH_CAPTION =
  'a row opens its entity, lands on Discussion with the message highlighted, and marks itself read';
