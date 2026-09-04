/**
 * THE CHAT ENTITY, TRANSLATED — the mapping that used to be a cast.
 *
 * `snapshot as { chatThreads?: ChatThreadLite[] }` asserted three fields that
 * the old `ChatThreadSummary` did not have (`id`, `activityAt`, `messageCount`),
 * and a cast is precisely the construct that stops the compiler checking. Every
 * chat on Home therefore had no id, no time and no count. The id was the
 * expensive one: sixty threads collapsed onto one React key and defeated the
 * top-ten cap.
 *
 * A type test would not have caught this — the cast made the types agree. Only
 * asking what the VALUES are catches it, so that is what this file does, and it
 * is why the file survives 176 rather than being deleted with the type it was
 * written against.
 *
 * 176 REPAIR (mechanical only; R-D still rules this tree experimental and
 * tm8-ui canonical): `ChatThreadSummary` and `HomeSnapshot.chatThreads` are
 * gone — a chat is an entity and the list is `entities.list kind=chat`. So the
 * input is now an ordinary `EntitySummary`, and the three fields the note above
 * is about stop being a translation at all: `id` and `activityAt` are the row's
 * own, and the count comes off the chat state. THAT IS THE POINT WORTH KEEPING
 * — the original defect was a mapping inventing fields the source lacked, and
 * the source now has them.
 */
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { chatRowOf } from './useHomeData';

function chat(over: Record<string, unknown> = {}): EntitySummary {
  const { state: stateOver, ...rest } = over as { state?: Record<string, unknown> };
  return {
    id: 'chat-1',
    kind: 'chat',
    title: 'yo',
    spaceId: 'space-1',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    createdAt: '2026-08-29T09:00:00.000Z',
    updatedAt: '2026-08-30T16:00:00.000Z',
    activityAt: '2026-08-30T16:00:00.000Z',
    deletedAt: null,
    state: {
      kind: 'chat',
      teammateId: 'tm-1',
      model: 'claude-opus-5',
      provider: 'anthropic',
      agentTool: 'claude-code',
      mode: 'ask',
      workdirMode: 'scratch',
      projectId: null,
      runtimeState: 'cold',
      turnState: 'idle',
      turnCount: 0,
      lastTurnAt: null,
      ...stateOver,
    },
    ...rest,
  } as unknown as EntitySummary;
}

describe('a chat entity becomes a Home row', () => {
  it('takes its identity from the row itself, because a chat now HAS an id', () => {
    expect(chatRowOf(chat({ id: 'chat-42' })).id).toBe('chat-42');
  });

  it('never yields an id-less row, whatever else is missing', () => {
    /* The one field the strip cannot do without: it is the React key, the cap's
       seat and the argument to `onOpen`. */
    const row = chatRowOf(chat({ title: '', state: { lastTurnAt: null } }));
    expect(row.id).toBeTruthy();
  });

  it('dates a chat by its own activity, which the server already maintains', () => {
    expect(chatRowOf(chat()).activityAt).toBe('2026-08-30T16:00:00.000Z');
  });

  it('counts TURNS, not replies — a chat is flat and has no reply count', () => {
    expect(chatRowOf(chat({ state: { turnCount: 7 } })).messageCount).toBe(7);
  });

  it('answers null for a row whose state is not a chat, never a made-up zero', () => {
    // "no count" and "no turns" are different claims, and a non-chat row that
    // reached this mapper has neither.
    expect(chatRowOf(chat({ state: { kind: 'doc' } })).messageCount).toBeNull();
  });

  it('carries the title through and does not invent one', () => {
    expect(chatRowOf(chat({ title: 'yo' })).title).toBe('yo');
    // An empty title is legal — `chats.title` defaults to '' — and the row says
    // so with null rather than drawing an empty string as a name.
    expect(chatRowOf(chat({ title: '' })).title).toBeNull();
  });
});
