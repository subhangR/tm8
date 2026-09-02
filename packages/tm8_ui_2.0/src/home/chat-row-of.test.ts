/**
 * THE CONTRACT'S CHAT THREAD, TRANSLATED — the mapping that used to be a cast.
 *
 * `snapshot as { chatThreads?: ChatThreadLite[] }` asserted three fields that
 * `ChatThreadSummary` does not have (`id`, `activityAt`, `messageCount`), and a
 * cast is precisely the construct that stops the compiler checking. Every chat
 * on Home therefore had no id, no time and no count. The id was the expensive
 * one: sixty threads collapsed onto one React key and defeated the top-ten cap.
 *
 * A type test would not have caught this — the cast made the types agree. Only
 * asking what the VALUES are catches it, so that is what this file does.
 */
import { describe, expect, it } from 'vitest';
import type { ChatThreadSummary } from '@tm8/contract';
import { chatRowOf } from './useHomeData';

function thread(over: Partial<ChatThreadSummary> = {}): ChatThreadSummary {
  return {
    rootMessageId: 'msg-1',
    anchorId: 'anchor-1',
    teammateId: 'tm-1',
    model: 'claude-opus-5',
    mode: 'ask',
    createdAt: '2026-08-29T09:00:00.000Z',
    lastReplyAt: '2026-08-30T16:00:00.000Z',
    projectId: null,
    workdirMode: 'scratch',
    ...over,
  } as ChatThreadSummary;
}

describe('a contract chat thread becomes a Home row', () => {
  it('takes its identity from the root message, because there is no `id`', () => {
    expect(chatRowOf(thread({ rootMessageId: 'msg-42' })).id).toBe('msg-42');
  });

  it('never yields an id-less row, whatever else is missing', () => {
    /* The one field the strip cannot do without: it is the React key, the cap's
       seat and the argument to `onOpen`. */
    const row = chatRowOf(thread({ title: null, lastReplyAt: null }));
    expect(row.id).toBeTruthy();
  });

  it('dates a thread by its last reply', () => {
    expect(chatRowOf(thread()).activityAt).toBe('2026-08-30T16:00:00.000Z');
  });

  it('falls back to when it began, because an unanswered thread still has a time', () => {
    expect(chatRowOf(thread({ lastReplyAt: null })).activityAt).toBe('2026-08-29T09:00:00.000Z');
  });

  it('counts turns from the reply count', () => {
    expect(chatRowOf(thread({ replyCount: 7 })).messageCount).toBe(7);
    // Absent is null, not zero — "no count" and "no replies" are different claims.
    expect(chatRowOf(thread()).messageCount).toBeNull();
  });

  it('carries the title through and does not invent one', () => {
    expect(chatRowOf(thread({ title: 'yo' })).title).toBe('yo');
    expect(chatRowOf(thread({ title: null })).title).toBeNull();
  });
});
