/**
 * The push text per previews setting (ac2) and the payload's routing record.
 *
 * The property under test: `full` says what the inbox row says, `sender` says
 * who and what kind of thing and nothing about the content, `none` says
 * nothing at all, and `data` is the same ids-only record whatever the setting.
 * Every payload produced here must also parse as the contract's PushPayloadV1.
 */
import { describe, expect, it } from 'vitest';

import { PUSH_BODY_MAX, PUSH_TITLE_MAX, PushPayloadV1Schema, type PushPreviews } from '@tm8/contract';

import { buildPushPayload, NO_PREVIEW_BODY, pushHeadlineOf, pushWebAddressOf } from '../../src/push/payload.js';
import { CHANNEL, MESSAGE, ORIGIN, SPACE, TASK, actor, notification, target } from './fixtures.js';

function build(previews: PushPreviews, item = notification(), messageId: string | null = MESSAGE) {
  const payload = buildPushPayload({ notification: item, messageId, previews, origin: ORIGIN });
  expect(PushPayloadV1Schema.safeParse(payload).success).toBe(true);
  return payload;
}

describe('previews: full', () => {
  it('a mention reads like the inbox: headline in #channel, the quoted message as the body', () => {
    const payload = build('full');
    expect(payload.title).toBe('Priya mentioned you in #mobile');
    expect(payload.body).toBe('@subhang can you look at the tablet overflow?');
    expect(payload.categoryId).toBe('tm8.reply');
  });

  it('a mention on a task names the task, without a #', () => {
    const payload = build('full', notification({ target: target('task', 'Desktop-shell reflow', TASK) }));
    expect(payload.title).toBe('Priya mentioned you in Desktop-shell reflow');
  });

  it('an assignment is the headline, with the task title as the body (s-inbox)', () => {
    const payload = build('full', notification({
      kind: 'assignment', actor: actor('Marco'), target: target('task', 'Desktop-shell reflow overflow', TASK),
      message: undefined,
    }));
    expect(payload.title).toBe('Marco assigned you');
    expect(payload.body).toBe('Desktop-shell reflow overflow');
    expect(payload.categoryId).toBe('tm8.task');
  });

  it('uses the inbox verbs, and the server kind names for replies and watched-task messages', () => {
    const cases: Array<[string, string]> = [
      ['review_request', 'Priya requested your review'],
      ['unblock', 'Priya unblocked you'],
      ['award', 'Priya awarded you'],
      ['message_reply', 'Priya replied in #mobile'],
      ['anchor_message', 'Priya posted in #mobile'],
    ];
    for (const [kind, title] of cases) {
      expect(build('full', notification({ kind })).title, kind).toBe(title);
    }
  });

  it('with no actor the verb stands alone, capitalised, and nobody is invented', () => {
    const payload = build('full', notification({
      kind: 'stale', actor: null, target: target('task', 'Bridge as an entity', TASK), message: undefined,
    }));
    expect(payload.title).toBe('Flagged this as stale');
    expect(payload.title).not.toMatch(/someone/i);
    expect(payload.body).toBe('Bridge as an entity');
  });

  it('an unknown kind is humanised, never dropped', () => {
    const payload = build('full', notification({ kind: 'foo_bar', target: null, message: undefined }));
    expect(payload.title).toBe('Priya foo bar');
    expect(payload.categoryId).toBe('tm8.activity');
  });

  it('flattens markup the stored text cannot carry into one line', () => {
    const payload = build('full', notification({
      actor: actor('Pri\nya\u0007'), message: 'line one\n\n  line two\ttabbed',
    }));
    expect(payload.title).toBe('Pri ya mentioned you in #mobile');
    expect(payload.body).toBe('line one line two tabbed');
  });

  it('caps both texts, with an ellipsis, without splitting an emoji', () => {
    const long = notification({ message: '😀'.repeat(400), target: target('channel', 'x'.repeat(400), CHANNEL) });
    const payload = build('full', long);
    expect(payload.title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
    expect(payload.title.endsWith('…')).toBe(true);
    expect(payload.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX);
    expect(payload.body.endsWith('…')).toBe(true);
    // No lone surrogate before the ellipsis.
    expect(payload.body).toBe(`${'😀'.repeat((PUSH_BODY_MAX - 2) / 2)}…`);
  });
});

describe('previews: sender only', () => {
  it('says who and what kind of thing: no channel name, no title, no message text', () => {
    const mention = build('sender');
    expect(mention.title).toBe('Priya mentioned you');
    expect(mention.body).toBe('');

    const assignment = build('sender', notification({
      kind: 'assignment', actor: actor('Marco'), target: target('task', 'Secret launch plan', TASK), message: undefined,
    }));
    expect(assignment.title).toBe('Marco assigned you');
    expect(JSON.stringify(assignment)).not.toContain('Secret launch plan');
  });

  it('leaks none of the content anywhere in the payload', () => {
    const json = JSON.stringify(build('sender'));
    expect(json).not.toContain('mobile');
    expect(json).not.toContain('tablet overflow');
  });
});

describe('previews: none', () => {
  it('names nobody and nothing', () => {
    const payload = build('none');
    expect(payload.title).toBe('');
    expect(payload.body).toBe(NO_PREVIEW_BODY);
    const json = JSON.stringify(payload);
    for (const word of ['Priya', 'mentioned', 'mobile', 'tablet overflow']) expect(json).not.toContain(word);
  });
});

describe('data: the same ids-only routing record under every setting', () => {
  it('is identical across previews and carries no text', () => {
    const item = notification();
    const datas = (['full', 'sender', 'none'] as const).map((previews) => build(previews, item).data);
    expect(datas[1]).toEqual(datas[0]);
    expect(datas[2]).toEqual(datas[0]);
    expect(datas[0]).toEqual({
      v: 1, o: ORIGIN, sp: SPACE, n: item.id, e: CHANNEL, k: 'mention',
      h: `${ORIGIN}/#/s/${SPACE}/channel/${CHANNEL}?msg=${MESSAGE}`,
    });
  });

  it('groups by server and space', () => {
    expect(build('full').threadId).toBe(`${ORIGIN}/s/${SPACE}`);
  });

  it('e is null when the recipient cannot read the target, and h falls back to the inbox', () => {
    const payload = build('full', notification({ target: null }));
    expect(payload.data.e).toBeNull();
    expect(payload.data.h).toBe(`${ORIGIN}/#/s/${SPACE}/inbox`);
    expect(payload.title).toBe('Priya mentioned you');
  });
});

describe('pushWebAddressOf: the web routes', () => {
  it('a channel message opens the channel at the message; without one, the channel', () => {
    const item = notification();
    expect(pushWebAddressOf(ORIGIN, item, MESSAGE)).toBe(`${ORIGIN}/#/s/${SPACE}/channel/${CHANNEL}?msg=${MESSAGE}`);
    expect(pushWebAddressOf(ORIGIN, item, null)).toBe(`${ORIGIN}/#/s/${SPACE}/channel/${CHANNEL}`);
  });

  it('anything else opens its entity page (the web has no ?msg= there)', () => {
    const item = notification({ target: target('task', 'T', TASK) });
    expect(pushWebAddressOf(ORIGIN, item, MESSAGE)).toBe(`${ORIGIN}/#/s/${SPACE}/e/${TASK}`);
  });
});

describe('pushHeadlineOf', () => {
  it('matches the web inbox headline grammar', () => {
    expect(pushHeadlineOf(notification({ kind: 'assignment', actor: actor('Marco') }))).toBe('Marco assigned you');
    expect(pushHeadlineOf(notification({ kind: 'stale', actor: undefined }))).toBe('Flagged this as stale');
    expect(pushHeadlineOf(notification({ kind: 'constructor' }))).toBe('Priya constructor');
  });
});
