import { describe, expect, it } from 'vitest';
import type { EntityId, EntityKind, EntitySummary, MessageView } from '@tm8/contract';
import {
  anchorIdOf,
  anchorIndexOf,
  applyKindFilter,
  applyMessageCreated,
  authorNameOf,
  conversationRowOf,
  conversationRowsOf,
  dedupeById,
  isConversation,
  kindsPresent,
  lastMessagesByAnchor,
  messageRowsOf,
  relativeTime,
  sortByRecency,
  sortMessagesByRecency,
  unreadOf,
  withLastMessages,
  type ConversationRow,
} from './messages-model';

/**
 * THE PURE CORE OF THE MESSAGES VIEW, tested without a DOM and without a seam.
 *
 * These are not shape tests. Each block below pins a property that the model's
 * docblock argues for and that a careless edit would silently invert:
 *
 *   - a conversation is `counters.messages > 0`, NOT a list of blessed kinds;
 *   - `unread` is `number | null` and NEVER `0` by default, because a fake zero
 *     claims a measurement nobody took;
 *   - message-ness is reached STRUCTURALLY through `state.anchorId`;
 *   - "no kind filter" is spelled by `null` OR `[]`, never by "match nothing";
 *   - a newest-first page folds to one preview per anchor with the FIRST entry
 *     winning, and both sorts are TOTAL so the order cannot shimmer.
 *
 * Fixtures are synthesized partial shapes cast through `as unknown as`, which is
 * deliberate: these functions read three or four fields off an `EntitySummary`
 * and spelling out the other twenty would hide which ones they actually touch.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Overrides are keyed to REAL summary fields; the values are free so a test can
 *  synthesize a state that carries — or pointedly omits — one property. */
type SummaryOverrides = Partial<Record<keyof EntitySummary, unknown>>;

const ALEX = { id: 'act-alex', kind: 'member', displayName: 'alex', isAgent: false };
const OPUS = { id: 'act-opus', kind: 'team_member', displayName: 'Opus 5', isAgent: true };

function counters(messages: number): Record<string, unknown> {
  return { likes: 0, dislikes: 0, stars: 0, points: 0, messages, viewerReaction: null };
}

function summary(over: SummaryOverrides = {}): EntitySummary {
  return {
    id: 'ent-1',
    spaceId: 'sp-1',
    kind: 'task',
    title: 'Wire the guide x-offsets',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    createdBy: ALEX,
    counters: counters(0),
    state: { kind: 'task' },
    badges: {},
    ...over,
  } as unknown as EntitySummary;
}

/** An anchor people have talked on: the only thing that makes it a conversation
 *  is the counter, which is exactly the claim under test. */
function conversation(messages: number, over: SummaryOverrides = {}): EntitySummary {
  return summary({ counters: counters(messages), ...over });
}

/** A message summary — identified by the `anchorId` its state carries, which is
 *  how the model tells a message from its anchor without naming a kind. */
function messageSummary(over: SummaryOverrides = {}): EntitySummary {
  return summary({
    id: 'msg-1',
    kind: 'message',
    title: '',
    excerpt: 'Focus on the guide x-offsets first.',
    createdAt: '2026-08-01T10:00:00.000Z',
    state: { kind: 'message', anchorId: 'ent-1', author: ALEX, messageBatchId: null },
    ...over,
  });
}

function messageView(over: Record<string, unknown> = {}): MessageView {
  return {
    ...(messageSummary() as unknown as Record<string, unknown>),
    content: { kind: 'message', body: 'Body of the arriving message.' },
    replyCount: 0,
    ...over,
  } as unknown as MessageView;
}

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: 'ent-1',
    kind: 'task' as EntityKind,
    title: 'Wire the guide x-offsets',
    messageCount: 1,
    activityAt: '2026-08-01T10:00:00.000Z',
    unread: null,
    lastMessage: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// isConversation — the structural predicate that replaced a kind list
// ---------------------------------------------------------------------------

describe('isConversation', () => {
  it('is exactly "this anchor has messages" — any kind qualifies', () => {
    // The whole point of the view: a task, a session and a doc are conversations
    // the moment someone posts, and none of them is named here.
    expect(isConversation(conversation(1, { kind: 'task' }))).toBe(true);
    expect(isConversation(conversation(12, { kind: 'work_session' }))).toBe(true);
    expect(isConversation(conversation(3, { kind: 'doc' }))).toBe(true);
    expect(isConversation(conversation(400, { kind: 'c:recipe' }))).toBe(true);
  });

  it('excludes an anchor with no messages — silence is not a quiet conversation', () => {
    // A `>= 0` here would list every entity in the space and bury the rows
    // people are actually talking on.
    expect(isConversation(conversation(0))).toBe(false);
  });

  it('excludes a summary whose counters were never projected', () => {
    expect(isConversation(summary({ counters: undefined }))).toBe(false);
  });

  it('excludes a soft-deleted entity even when it carries messages', () => {
    expect(isConversation(conversation(9, { deletedAt: '2026-08-02T00:00:00.000Z' }))).toBe(false);
  });

  it('excludes a MESSAGE entity even when it somehow carries counters', () => {
    // A message ANCHORS elsewhere — a reply anchors on the channel, not on its
    // root — so a message drawn as a conversation row would duplicate the
    // conversation it already lives in. Detected by the presence of
    // `state.anchorId`, never by comparing a kind.
    const messageWithCounters = messageSummary({ counters: counters(5) });
    expect(messageWithCounters.counters.messages).toBe(5);
    expect(isConversation(messageWithCounters)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unreadOf — the most consequential null in this file
// ---------------------------------------------------------------------------

describe('unreadOf', () => {
  it('returns the number when the state carries one', () => {
    expect(unreadOf(summary({ state: { kind: 'channel', unreadCount: 7 } }))).toBe(7);
  });

  it('returns a genuine zero when the server actually computed zero', () => {
    // Zero IS a measurement when someone took it. The distinction below is the
    // whole reason this returns a union rather than a number.
    expect(unreadOf(summary({ state: { kind: 'channel', unreadCount: 0 } }))).toBe(0);
  });

  it('returns null — NOT 0 — for a state with no unread count', () => {
    // THE SINGLE MOST IMPORTANT ASSERTION IN THIS FILE.
    //
    // `loadUnreadCounts` is channel-scoped on the server today, so a task row
    // and a session row arrive with no count at all. If this function ever
    // returned `0` for them — via `?? 0`, or by typing the result as `number` —
    // every task and every session in the list would render a fake "all caught
    // up" badge: a claim that someone measured this conversation and found
    // nothing new, when in truth nobody measured it. `null` means "not
    // computed", and the screen draws nothing for it.
    //
    // `toBe(null)` rather than a falsy check on purpose: `expect(x).toBeFalsy()`
    // passes for 0 and would let the regression through.
    const unread = unreadOf(summary({ state: { kind: 'task', status: 'doing' } }));
    expect(unread).toBe(null);
    expect(unread).not.toBe(0);
  });

  it('returns null when the field is present but not a number', () => {
    expect(unreadOf(summary({ state: { kind: 'channel', unreadCount: '3' } }))).toBe(null);
    expect(unreadOf(summary({ state: { kind: 'channel', unreadCount: null } }))).toBe(null);
  });

  it('returns null for a state that is missing entirely', () => {
    expect(unreadOf(summary({ state: undefined }))).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// anchorIdOf / authorNameOf — structural extraction
// ---------------------------------------------------------------------------

describe('anchorIdOf', () => {
  it('reads the anchor a message hangs on', () => {
    expect(anchorIdOf(messageSummary({ state: { kind: 'message', anchorId: 'ent-chan' } }))).toBe(
      'ent-chan',
    );
  });

  it('returns null for a non-message summary — no kind comparison involved', () => {
    expect(anchorIdOf(conversation(4, { kind: 'channel' }))).toBe(null);
  });

  it('returns null for an empty or non-string anchorId', () => {
    expect(anchorIdOf(summary({ state: { kind: 'message', anchorId: '' } }))).toBe(null);
    expect(anchorIdOf(summary({ state: { kind: 'message', anchorId: 42 } }))).toBe(null);
    expect(anchorIdOf(summary({ state: undefined }))).toBe(null);
  });
});

describe('authorNameOf', () => {
  it('prefers the author the message state carries', () => {
    expect(
      authorNameOf(
        messageSummary({ state: { kind: 'message', anchorId: 'ent-1', author: OPUS }, createdBy: ALEX }),
      ),
    ).toBe('Opus 5');
  });

  it('falls back to the entity creator when the state names no author', () => {
    expect(
      authorNameOf(messageSummary({ state: { kind: 'message', anchorId: 'ent-1' }, createdBy: OPUS })),
    ).toBe('Opus 5');
  });

  it('falls back to Unknown rather than rendering an empty byline', () => {
    expect(
      authorNameOf(summary({ state: { kind: 'message', anchorId: 'ent-1' }, createdBy: undefined })),
    ).toBe('Unknown');
  });

  it('treats an empty display name as absent at every step of the chain', () => {
    expect(
      authorNameOf(
        summary({
          state: { kind: 'message', anchorId: 'ent-1', author: { displayName: '' } },
          createdBy: { displayName: '' },
        }),
      ),
    ).toBe('Unknown');
  });
});

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

describe('conversationRowOf', () => {
  it('carries the kind for its icon and leaves the preview unlearned', () => {
    const projected = conversationRowOf(
      conversation(6, { id: 'ent-9', kind: 'doc', title: 'Spec', activityAt: '2026-08-03T00:00:00.000Z' }),
    );
    expect(projected).toEqual({
      id: 'ent-9',
      kind: 'doc',
      title: 'Spec',
      messageCount: 6,
      activityAt: '2026-08-03T00:00:00.000Z',
      unread: null,
      lastMessage: null,
    });
  });
});

describe('conversationRowsOf', () => {
  it('keeps only conversations and returns them newest-active first', () => {
    const rows = conversationRowsOf([
      conversation(1, { id: 'ent-old', activityAt: '2026-08-01T00:00:00.000Z' }),
      conversation(0, { id: 'ent-silent', activityAt: '2026-08-09T00:00:00.000Z' }),
      messageSummary({ id: 'msg-a', counters: counters(2) }),
      conversation(4, { id: 'ent-new', activityAt: '2026-08-05T00:00:00.000Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ent-new', 'ent-old']);
  });
});

// ---------------------------------------------------------------------------
// lastMessagesByAnchor — the newest-first fold
// ---------------------------------------------------------------------------

describe('lastMessagesByAnchor', () => {
  it('folds a page to ONE entry per anchor and the FIRST occurrence wins', () => {
    // The page arrives newest-first, so entry two is OLDER. Overwriting here
    // would put a stale preview on a live conversation — the exact bug a
    // `map.set` without the `has` guard produces, and it is invisible on a page
    // where every anchor happens to appear once.
    const previews = lastMessagesByAnchor([
      messageSummary({
        id: 'msg-newer',
        excerpt: 'Newest thing said.',
        createdAt: '2026-08-05T12:00:00.000Z',
        state: { kind: 'message', anchorId: 'ent-1', author: OPUS },
      }),
      messageSummary({
        id: 'msg-older',
        excerpt: 'Said an hour ago.',
        createdAt: '2026-08-05T11:00:00.000Z',
        state: { kind: 'message', anchorId: 'ent-1', author: ALEX },
      }),
    ]);
    expect(previews.size).toBe(1);
    expect(previews.get('ent-1')).toEqual({
      id: 'msg-newer',
      authorName: 'Opus 5',
      excerpt: 'Newest thing said.',
      createdAt: '2026-08-05T12:00:00.000Z',
    });
  });

  it('separates anchors and skips summaries that are not messages', () => {
    const previews = lastMessagesByAnchor([
      messageSummary({ id: 'msg-a', state: { kind: 'message', anchorId: 'ent-a' } }),
      conversation(3, { id: 'ent-b' }),
      messageSummary({ id: 'msg-b', state: { kind: 'message', anchorId: 'ent-b' } }),
    ]);
    expect([...previews.keys()]).toEqual(['ent-a', 'ent-b']);
  });

  it('renders a missing excerpt as empty rather than undefined', () => {
    const previews = lastMessagesByAnchor([messageSummary({ excerpt: undefined })]);
    expect(previews.get('ent-1')?.excerpt).toBe('');
  });
});

describe('withLastMessages', () => {
  it('attaches known previews and leaves the rest honestly null', () => {
    const attached = withLastMessages(
      [row({ id: 'ent-1' }), row({ id: 'ent-2' })],
      new Map([
        ['ent-1', { id: 'msg-1', authorName: 'alex', excerpt: 'hi', createdAt: '2026-08-05T00:00:00.000Z' }],
      ]),
    );
    expect(attached[0]?.lastMessage?.id).toBe('msg-1');
    // Not "no messages" — "we did not learn this one", which draws as absence.
    expect(attached[1]?.lastMessage).toBe(null);
  });
});

describe('messageRowsOf', () => {
  it('resolves anchor identity where known and stays null where not', () => {
    const rows = messageRowsOf(
      [
        messageSummary({ id: 'msg-a', state: { kind: 'message', anchorId: 'ent-known', author: ALEX } }),
        messageSummary({ id: 'msg-b', state: { kind: 'message', anchorId: 'ent-unknown', author: ALEX } }),
        conversation(2, { id: 'ent-not-a-message' }),
      ],
      new Map([['ent-known', { title: 'Design review', kind: 'channel' as EntityKind }]]),
    );
    expect(rows.map((r) => r.id)).toEqual(['msg-a', 'msg-b']);
    expect(rows[0]).toMatchObject({ anchorTitle: 'Design review', anchorKind: 'channel' });
    // An unresolved anchor is DRAWN as unresolved; no invented placeholder title.
    expect(rows[1]).toMatchObject({ anchorTitle: null, anchorKind: null });
  });
});

// ---------------------------------------------------------------------------
// applyMessageCreated — the live event
// ---------------------------------------------------------------------------

describe('applyMessageCreated', () => {
  it('increments the count, refreshes the preview and moves the row to the top', () => {
    const rows = [
      row({ id: 'ent-loud', messageCount: 2, activityAt: '2026-08-05T00:00:00.000Z' }),
      row({ id: 'ent-quiet', messageCount: 1, activityAt: '2026-08-06T00:00:00.000Z' }),
    ];
    const next = applyMessageCreated(
      rows,
      'ent-loud',
      messageView({
        id: 'msg-live',
        excerpt: 'Just landed.',
        createdAt: '2026-08-07T00:00:00.000Z',
        state: { kind: 'message', anchorId: 'ent-loud', author: OPUS },
      }),
    );
    expect(next.map((r) => r.id)).toEqual(['ent-loud', 'ent-quiet']);
    expect(next[0]).toMatchObject({
      messageCount: 3,
      activityAt: '2026-08-07T00:00:00.000Z',
      lastMessage: {
        id: 'msg-live',
        authorName: 'Opus 5',
        excerpt: 'Just landed.',
        createdAt: '2026-08-07T00:00:00.000Z',
      },
    });
    // Pure: the caller's array is untouched.
    expect(rows[0]?.messageCount).toBe(2);
  });

  it('falls back to the message body when the event carries no excerpt', () => {
    const next = applyMessageCreated(
      [row({ id: 'ent-1' })],
      'ent-1',
      messageView({ excerpt: undefined, content: { kind: 'message', body: 'Body text.' } }),
    );
    expect(next[0]?.lastMessage?.excerpt).toBe('Body text.');
  });

  it('does NOT synthesize a row for an anchor that is not being shown', () => {
    // We would have to invent the new row's title and kind — the event carries
    // neither — and a row reading "Untitled" is worse than one that appears on
    // the next read. Length unchanged is the assertion that catches a
    // well-meaning `else rows.push(...)`.
    const rows = [row({ id: 'ent-1', messageCount: 2 })];
    const next = applyMessageCreated(
      rows,
      'ent-somewhere-else',
      messageView({ state: { kind: 'message', anchorId: 'ent-somewhere-else', author: ALEX } }),
    );
    expect(next).toHaveLength(1);
    expect(next).toEqual(rows);
  });
});

// ---------------------------------------------------------------------------
// Ordering — total and stable, or the list shimmers between reads
// ---------------------------------------------------------------------------

describe('sortByRecency', () => {
  it('puts the most recently active conversation first', () => {
    const sorted = sortByRecency([
      row({ id: 'ent-a', activityAt: '2026-08-01T00:00:00.000Z' }),
      row({ id: 'ent-b', activityAt: '2026-08-09T00:00:00.000Z' }),
      row({ id: 'ent-c', activityAt: '2026-08-05T00:00:00.000Z' }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['ent-b', 'ent-c', 'ent-a']);
  });

  it('breaks ties on id, so identical timestamps still order deterministically', () => {
    // Without the tie-break, two rows stamped in the same millisecond — which is
    // what a batch insert produces — would land in whatever order the input
    // happened to have, and the list would reshuffle on every refetch.
    const at = '2026-08-05T00:00:00.000Z';
    const one = sortByRecency([row({ id: 'ent-a', activityAt: at }), row({ id: 'ent-b', activityAt: at })]);
    const other = sortByRecency([row({ id: 'ent-b', activityAt: at }), row({ id: 'ent-a', activityAt: at })]);
    expect(one.map((r) => r.id)).toEqual(other.map((r) => r.id));
    expect(one.map((r) => r.id)).toEqual(['ent-b', 'ent-a']);
  });

  it('does not mutate its input', () => {
    const rows = [row({ id: 'ent-a', activityAt: '2026-08-01T00:00:00.000Z' }), row({ id: 'ent-b' })];
    sortByRecency(rows);
    expect(rows.map((r) => r.id)).toEqual(['ent-a', 'ent-b']);
  });
});

describe('sortMessagesByRecency', () => {
  const messageRow = (id: string, createdAt: string) => ({
    id,
    anchorId: 'ent-1' as EntityId,
    anchorTitle: null,
    anchorKind: null,
    authorName: 'alex',
    excerpt: '',
    createdAt,
  });

  it('is newest first', () => {
    const sorted = sortMessagesByRecency([
      messageRow('msg-a', '2026-08-01T00:00:00.000Z'),
      messageRow('msg-c', '2026-08-09T00:00:00.000Z'),
      messageRow('msg-b', '2026-08-05T00:00:00.000Z'),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['msg-c', 'msg-b', 'msg-a']);
  });

  it('breaks ties on id, so a same-millisecond batch has one settled order', () => {
    const at = '2026-08-05T00:00:00.000Z';
    const one = sortMessagesByRecency([messageRow('msg-a', at), messageRow('msg-b', at)]);
    const other = sortMessagesByRecency([messageRow('msg-b', at), messageRow('msg-a', at)]);
    expect(one.map((r) => r.id)).toEqual(other.map((r) => r.id));
    expect(one.map((r) => r.id)).toEqual(['msg-b', 'msg-a']);
  });
});

// ---------------------------------------------------------------------------
// Paging and filtering
// ---------------------------------------------------------------------------

describe('dedupeById', () => {
  it('keeps the FIRST occurrence when overlapping pages collide', () => {
    const deduped = dedupeById([
      row({ id: 'ent-1', title: 'from page one' }),
      row({ id: 'ent-2' }),
      row({ id: 'ent-1', title: 'from page two' }),
    ]);
    expect(deduped.map((r) => r.id)).toEqual(['ent-1', 'ent-2']);
    expect(deduped[0]?.title).toBe('from page one');
  });
});

describe('applyKindFilter', () => {
  const rows = [row({ id: 'ent-1', kind: 'task' }), row({ id: 'ent-2', kind: 'doc' })];

  it('treats null as NO FILTER, not as "match nothing"', () => {
    // The damaging inversion: an unselected filter that filters everything out
    // shows an empty list on a space full of conversations, and it reads like a
    // loading bug rather than like a control nobody touched.
    expect(applyKindFilter(rows, null)).toHaveLength(2);
  });

  it('treats an empty selection as NO FILTER too', () => {
    // Deselecting the last chip returns you to everything — the same state you
    // started in — rather than to a blank screen.
    expect(applyKindFilter(rows, [])).toHaveLength(2);
  });

  it('keeps only the selected kinds when a selection exists', () => {
    expect(applyKindFilter(rows, ['doc']).map((r) => r.id)).toEqual(['ent-2']);
    expect(applyKindFilter(rows, ['task', 'doc'])).toHaveLength(2);
  });

  it('does not mutate its input', () => {
    const copy = [...rows];
    applyKindFilter(rows, ['doc']);
    expect(rows).toEqual(copy);
  });
});

describe('kindsPresent', () => {
  it('lists each kind once, in the order the rows first show it', () => {
    // First-seen order, not alphabetical: the chip strip must not reorder itself
    // when a new conversation arrives.
    expect(
      kindsPresent([
        row({ id: 'a', kind: 'work_session' }),
        row({ id: 'b', kind: 'task' }),
        row({ id: 'c', kind: 'work_session' }),
        row({ id: 'd', kind: 'doc' }),
      ]),
    ).toEqual(['work_session', 'task', 'doc']);
  });

  it('is empty for no rows', () => {
    expect(kindsPresent([])).toEqual([]);
  });
});

describe('anchorIndexOf', () => {
  it('indexes title and kind by conversation id for the flat reading', () => {
    const index = anchorIndexOf([
      row({ id: 'ent-1', kind: 'channel', title: 'Design review' }),
      row({ id: 'ent-2', kind: 'task', title: 'Ship it' }),
    ]);
    expect(index.get('ent-1')).toEqual({ title: 'Design review', kind: 'channel' });
    expect(index.get('ent-2')).toEqual({ title: 'Ship it', kind: 'task' });
    expect(index.get('ent-missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// relativeTime — boundaries, and the malformed input that must not read "NaN"
// ---------------------------------------------------------------------------

describe('relativeTime', () => {
  const NOW = new Date('2026-08-13T12:00:00.000Z');
  const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

  it('says "now" below a minute, on both sides of the boundary', () => {
    expect(relativeTime(ago(0), NOW)).toBe('now');
    expect(relativeTime(ago(59), NOW)).toBe('now');
    expect(relativeTime(ago(60), NOW)).toBe('1m');
  });

  it('counts minutes up to an hour', () => {
    expect(relativeTime(ago(60 * 5), NOW)).toBe('5m');
    expect(relativeTime(ago(60 * 59), NOW)).toBe('59m');
    expect(relativeTime(ago(60 * 60), NOW)).toBe('1h');
  });

  it('counts hours up to a day', () => {
    expect(relativeTime(ago(3600 * 23), NOW)).toBe('23h');
    expect(relativeTime(ago(3600 * 24), NOW)).toBe('1d');
  });

  it('counts days up to a week', () => {
    expect(relativeTime(ago(86400 * 6), NOW)).toBe('6d');
    expect(relativeTime(ago(86400 * 7), NOW)).toBe('1w');
  });

  it('counts weeks, then years', () => {
    expect(relativeTime(ago(86400 * 21), NOW)).toBe('3w');
    expect(relativeTime(ago(86400 * 400), NOW)).toBe('1y');
  });

  it('clamps a future timestamp to "now" rather than a negative age', () => {
    // Clock skew between the server stamp and the browser is normal; "-1m" is
    // not a thing a reader should ever see.
    expect(relativeTime(new Date(NOW.getTime() + 5000).toISOString(), NOW)).toBe('now');
  });

  it('returns an empty string for an unparseable timestamp — never "NaN"', () => {
    // A row with a broken stamp draws no time at all. `NaNm` in a list is the
    // kind of thing that survives a whole release because nobody owns it.
    expect(relativeTime('not a timestamp', NOW)).toBe('');
    expect(relativeTime('', NOW)).toBe('');
  });
});
