/**
 * PushPayloadV1 (`src/push.ts`, s-lld §11).
 *
 * What is under test is the wire the node and the phone share: the payload is
 * strict (nothing rides along that the phone did not agree to read), `data`
 * carries ids and an address only, `h` can only point at the server named by
 * `o`, and every notification kind (an open union) lands on a category and a
 * channel the app actually registers.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PUSH_PREVIEWS,
  PUSH_ANDROID_CHANNEL_IDS,
  PUSH_BODY_MAX,
  PUSH_CATEGORY_IDS,
  PUSH_PREVIEWS,
  PUSH_TITLE_MAX,
  PushPayloadV1Schema,
  pushRouteOf,
  pushThreadIdOf,
  type PushPayloadV1,
} from '../src/index.js';

const ORIGIN = 'https://tm8.acme.dev';
const SPACE = '01a0fb3d-558e-7d92-b370-d0601112607a';
const NOTIFICATION = '01a18776-4a6b-7ede-89df-0abb5b9581e4';
const ENTITY = '01a1867c-d1bf-7dbd-a158-3a49377518b7';

function payload(overrides: Partial<PushPayloadV1> = {}, data: Partial<PushPayloadV1['data']> = {}): unknown {
  return {
    title: 'Priya mentioned you in #mobile',
    body: '@subhang can you look at the tablet overflow?',
    categoryId: 'tm8.reply',
    threadId: pushThreadIdOf(ORIGIN, SPACE),
    ...overrides,
    data: {
      v: 1,
      o: ORIGIN,
      sp: SPACE,
      n: NOTIFICATION,
      e: ENTITY,
      k: 'mention',
      h: `${ORIGIN}/#/s/${SPACE}/channel/${ENTITY}`,
      ...data,
    },
  };
}

describe('PushPayloadV1Schema', () => {
  it('accepts the payload s-lld §11 draws', () => {
    expect(PushPayloadV1Schema.safeParse(payload()).success).toBe(true);
  });

  it('accepts a notification about nothing (e null) and the empty texts previews none produces', () => {
    const parsed = PushPayloadV1Schema.safeParse(payload({ title: '', body: 'New notification' }, {
      e: null, h: `${ORIGIN}/#/s/${SPACE}/inbox`, k: 'role.changed',
    }));
    expect(parsed.success).toBe(true);
  });

  it('is strict at both levels: no field rides along the phone did not agree to read', () => {
    expect(PushPayloadV1Schema.safeParse({ ...(payload() as object), badge: 3 }).success).toBe(false);
    const extraData = payload({}, {}) as { data: Record<string, unknown> };
    extraData.data.actorName = 'Priya';
    expect(PushPayloadV1Schema.safeParse(extraData).success).toBe(false);
  });

  it('refuses another version', () => {
    expect(PushPayloadV1Schema.safeParse(payload({}, { v: 2 as 1 })).success).toBe(false);
  });

  it('o is a bare origin: no path, no trailing slash, http(s) only', () => {
    for (const o of ['https://tm8.acme.dev/', 'https://tm8.acme.dev/app', 'tm8://open', 'not a url']) {
      expect(PushPayloadV1Schema.safeParse(payload({}, { o, h: `${o}/#/s/${SPACE}/inbox` })).success, o).toBe(false);
    }
    expect(PushPayloadV1Schema.safeParse(payload({}, {
      o: 'http://127.0.0.1:4827', h: `http://127.0.0.1:4827/#/s/${SPACE}/inbox`,
    })).success).toBe(true);
  });

  it('h can only point at the server o names', () => {
    expect(PushPayloadV1Schema.safeParse(payload({}, { h: `https://evil.example/#/s/${SPACE}/inbox` })).success)
      .toBe(false);
    // A prefix match is not a same-origin match.
    expect(PushPayloadV1Schema.safeParse(payload({}, { h: `${ORIGIN}.evil.example/#/s/${SPACE}/inbox` })).success)
      .toBe(false);
  });

  it('ids are uuids', () => {
    expect(PushPayloadV1Schema.safeParse(payload({}, { sp: 'atelier' })).success).toBe(false);
    expect(PushPayloadV1Schema.safeParse(payload({}, { n: '' })).success).toBe(false);
    expect(PushPayloadV1Schema.safeParse(payload({}, { e: 'x' })).success).toBe(false);
  });

  it('caps the texts', () => {
    expect(PushPayloadV1Schema.safeParse(payload({ title: 'x'.repeat(PUSH_TITLE_MAX) })).success).toBe(true);
    expect(PushPayloadV1Schema.safeParse(payload({ title: 'x'.repeat(PUSH_TITLE_MAX + 1) })).success).toBe(false);
    expect(PushPayloadV1Schema.safeParse(payload({ body: 'x'.repeat(PUSH_BODY_MAX + 1) })).success).toBe(false);
  });

  it('categoryId is one the app registers', () => {
    expect(PushPayloadV1Schema.safeParse(payload({ categoryId: 'tm8.other' as 'tm8.reply' })).success).toBe(false);
  });
});

describe('pushRouteOf: category, Android channel and iOS interruption per kind', () => {
  it('maps the s-lld §11 table', () => {
    expect(pushRouteOf('mention').categoryId).toBe('tm8.reply');
    expect(pushRouteOf('assignment').categoryId).toBe('tm8.task');
    expect(pushRouteOf('review_request').categoryId).toBe('tm8.review');
    expect(pushRouteOf('unblock').categoryId).toBe('tm8.task');
    expect(pushRouteOf('stale').categoryId).toBe('tm8.task');
    expect(pushRouteOf('award').categoryId).toBe('tm8.activity');
  });

  it('replies share the mentions channel (s-inbox: "Mentions and replies")', () => {
    expect(pushRouteOf('mention').androidChannelId).toBe('mentions');
    expect(pushRouteOf('message_reply')).toEqual(pushRouteOf('mention'));
  });

  it('an unknown kind falls back to tm8.activity on the activity channel, passively', () => {
    expect(pushRouteOf('foo_bar')).toEqual({
      categoryId: 'tm8.activity', androidChannelId: 'activity', interruptionLevel: 'passive',
    });
    // Not a prototype lookup.
    expect(pushRouteOf('constructor')).toEqual(pushRouteOf('foo_bar'));
    expect(pushRouteOf('__proto__')).toEqual(pushRouteOf('foo_bar'));
  });

  it('nothing a notification row carries is time-sensitive (only a waiting session is, s-inbox)', () => {
    for (const kind of ['mention', 'message_reply', 'anchor_message', 'assignment', 'review_request',
      'unblock', 'stale', 'award', 'join', 'foo']) {
      expect(pushRouteOf(kind).interruptionLevel).not.toBe('time-sensitive');
      expect(PUSH_ANDROID_CHANNEL_IDS).toContain(pushRouteOf(kind).androidChannelId);
      expect(PUSH_CATEGORY_IDS).toContain(pushRouteOf(kind).categoryId);
    }
  });

  it('inside quiet hours every kind goes passive on the quiet channel, keeping its category', () => {
    for (const kind of ['mention', 'assignment', 'award', 'foo']) {
      expect(pushRouteOf(kind, { quiet: true })).toEqual({
        categoryId: pushRouteOf(kind).categoryId, androidChannelId: 'quiet', interruptionLevel: 'passive',
      });
    }
  });
});

describe('previews and threads', () => {
  it('previews are full, sender or none, and default to sender (decide Q5)', () => {
    expect(PUSH_PREVIEWS).toEqual(['full', 'sender', 'none']);
    expect(DEFAULT_PUSH_PREVIEWS).toBe('sender');
  });

  it('a thread is one server and one space (s-inbox lock screen)', () => {
    expect(pushThreadIdOf(ORIGIN, SPACE)).toBe(`${ORIGIN}/s/${SPACE}`);
    expect(pushThreadIdOf(ORIGIN, SPACE)).not.toBe(pushThreadIdOf('https://other.example', SPACE));
  });
});
