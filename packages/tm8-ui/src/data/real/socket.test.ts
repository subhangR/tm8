/**
 * socket.ts — control-frame encoding and inbound frame discrimination (LLD §6).
 *
 * The encoding tests assert the EXACT JSON, key by key, because the server
 * parses control frames `.strict()`: one extra key makes the whole frame
 * malformed-refused, and a refused subscribe is indistinguishable from a quiet
 * space until the ack arrives. `toEqual` on the parsed frame is what catches an
 * extra key; a `toMatchObject` would not.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_CONTROL_FRAME_SPACES } from '@tm8/contract';
import { openSocket, parseFrame, type SocketHandlers } from './socket';
import { FakeSocket, fakeSocketPool } from './test-support';

interface Recorder extends SocketHandlers {
  events: unknown[];
  chatTurns: unknown[];
  refusals: unknown[];
  malformed: unknown[];
  opens: number;
  closes: number;
}

function handlers(): Recorder {
  const r: Recorder = {
    events: [],
    chatTurns: [],
    refusals: [],
    malformed: [],
    opens: 0,
    closes: 0,
    onOpen() { r.opens += 1; },
    onEvent(e) { r.events.push(e); },
    onChatTurn(frame) { r.chatTurns.push(frame); },
    onRefused(a) { r.refusals.push(a); },
    onClose() { r.closes += 1; },
    onMalformed(raw) { r.malformed.push(raw); },
  };
  return r;
}

function connected(): { ws: FakeSocket; h: Recorder; handle: ReturnType<typeof openSocket> } {
  const pool = fakeSocketPool();
  const h = handlers();
  const handle = openSocket('ws://fake/v2/ws', pool.factory, h);
  pool.last().openIt();
  return { ws: pool.last(), h, handle };
}

describe('socket: control-frame encoding — exact bytes (server parses .strict())', () => {
  it('subscribe is exactly {type, spaceIds}', () => {
    const { ws, handle } = connected();
    handle.subscribe(['sp-1', 'sp-2']);
    expect(ws.frames()).toEqual([{ type: 'subscribe', spaceIds: ['sp-1', 'sp-2'] }]);
    expect(ws.sent[0]).toBe('{"type":"subscribe","spaceIds":["sp-1","sp-2"]}');
  });

  it('resume is exactly {type, spaceId, since} with since as a NUMBER', () => {
    const { ws, handle } = connected();
    handle.resume('sp-1', 0);
    expect(ws.frames()).toEqual([{ type: 'resume', spaceId: 'sp-1', since: 0 }]);
    // ControlSinceSchema takes a number; a stringified seq would be malformed.
    expect(ws.sent[0]).toBe('{"type":"resume","spaceId":"sp-1","since":0}');
  });

  it('unsubscribe is exactly {type, spaceIds}', () => {
    const { ws, handle } = connected();
    handle.unsubscribe(['sp-1']);
    expect(ws.frames()).toEqual([{ type: 'unsubscribe', spaceIds: ['sp-1'] }]);
  });

  it('has NO way to send a presence frame at all (R8 — structural, not a comment)', () => {
    const { handle } = connected();
    expect(handle).not.toHaveProperty('presence');
    expect(Object.keys(handle).sort()).toEqual(['close', 'isOpen', 'resume', 'subscribe', 'unsubscribe']);
  });

  it('chunks past the 100-space frame cap — an over-long frame is refused WHOLE', () => {
    const { ws, handle } = connected();
    const ids = Array.from({ length: MAX_CONTROL_FRAME_SPACES + 20 }, (_, i) => `sp-${i}`);
    handle.subscribe(ids);
    const frames = ws.frames();
    expect(frames).toHaveLength(2);
    expect((frames[0]!.spaceIds as string[])).toHaveLength(MAX_CONTROL_FRAME_SPACES);
    expect((frames[1]!.spaceIds as string[])).toHaveLength(20);
    // No id lost, none duplicated: an exact set, not a count.
    expect([...(frames[0]!.spaceIds as string[]), ...(frames[1]!.spaceIds as string[])]).toEqual(ids);
  });

  it('sends nothing for an empty id list', () => {
    const { ws, handle } = connected();
    handle.subscribe([]);
    handle.unsubscribe([]);
    expect(ws.sent).toEqual([]);
  });

  it('sends nothing before the socket is OPEN', () => {
    const pool = fakeSocketPool();
    const handle = openSocket('ws://fake/v2/ws', pool.factory, handlers());
    handle.subscribe(['sp-1']);   // FakeSocket.send would THROW if this got through
    handle.resume('sp-1', 5);
    expect(pool.last().sent).toEqual([]);
    expect(handle.isOpen()).toBe(false);
  });
});

describe('socket: inbound frame discrimination', () => {
  it('a durable event reaches onEvent', () => {
    const { ws, h } = connected();
    const event = { type: 'entity.upsert', spaceId: 'sp-1', seq: 7, occurredAt: 'x', schemaVersion: 1, entity: {} };
    ws.deliver(event);
    expect(h.events).toEqual([event]);
  });

  it('control.refused reaches onRefused — the ONLY ack that exists', () => {
    const { ws, h } = connected();
    ws.deliver({ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-9', reason: 'forbidden' });
    expect(h.refusals).toEqual([{ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-9', reason: 'forbidden' }]);
    expect(h.events).toEqual([]);
  });

  it('routes C3 chat turn frames without requiring a workspace spaceId', () => {
    const { ws, h } = connected();
    const frame = {
      type: 'chat.turn.delta',
      chatId: 'root-1',
      messageId: 'message-1',
      seq: 4,
      part: { kind: 'text', text: 'durable delta' },
    };
    ws.deliver(frame);
    expect(h.chatTurns).toEqual([frame]);
    expect(h.events).toEqual([]);
    expect(h.malformed).toEqual([]);
  });

  it('a refusal with no spaceId keeps the key absent rather than undefined', () => {
    const { ws, h } = connected();
    ws.deliver({ type: 'control.refused', frame: 'resume', reason: 'malformed' });
    expect(h.refusals[0]).toEqual({ type: 'control.refused', frame: 'resume', reason: 'malformed' });
  });

  it('presence and typing are DROPPED before dispatch (R8) — never events, never malformed', () => {
    const { ws, h } = connected();
    ws.deliver({ type: 'presence.changed', spaceId: 'sp-1', seq: 3, entityId: 'e', presence: {} });
    ws.deliver({ type: 'typing.changed', spaceId: 'sp-1', seq: 4, anchorId: 'a', typingActorIds: [] });
    expect(h.events).toEqual([]);
    expect(h.malformed).toEqual([]);
  });

  it('an event without a finite seq is malformed, not dispatched — it could never be deduped', () => {
    const { ws, h } = connected();
    ws.deliver({ type: 'entity.upsert', spaceId: 'sp-1', entity: {} });
    ws.deliver({ type: 'entity.upsert', spaceId: 'sp-1', seq: 'nine', entity: {} });
    expect(h.events).toEqual([]);
    expect(h.malformed).toHaveLength(2);
  });

  it('an event without a spaceId is malformed — it belongs to no cursor', () => {
    const { ws, h } = connected();
    ws.deliver({ type: 'entity.upsert', seq: 1, entity: {} });
    expect(h.events).toEqual([]);
    expect(h.malformed).toHaveLength(1);
  });

  it('unparseable bytes are reported, not swallowed', () => {
    const { ws, h } = connected();
    ws.deliverRaw('{not json');
    expect(h.malformed).toEqual(['{not json']);
    expect(h.events).toEqual([]);
  });
});

describe('socket: parseFrame in isolation', () => {
  it('classifies each shape', () => {
    expect(parseFrame(null).kind).toBe('malformed');
    expect(parseFrame({ noType: 1 }).kind).toBe('malformed');
    expect(parseFrame({ type: 'control.refused', frame: 'subscribe', reason: 'bogus' }).kind).toBe('malformed');
    expect(parseFrame({ type: 'presence.changed' }).kind).toBe('presence');
    expect(parseFrame({
      type: 'chat.turn.done',
      chatId: 'r',
      messageId: 'm',
      usage: {},
    }).kind).toBe('chat-turn');
    expect(parseFrame({ type: 'x', spaceId: 's', seq: 1 }).kind).toBe('event');
  });

  it('seq 0 is a legal seq (falsy, and the mistake is easy)', () => {
    expect(parseFrame({ type: 'x', spaceId: 's', seq: 0 }).kind).toBe('event');
  });
});

describe('socket: lifecycle', () => {
  it('onClose fires once, whether the socket errored or closed', () => {
    const { ws, h } = connected();
    ws.onerror?.();
    ws.drop();
    expect(h.closes).toBe(1);
  });

  it('close() is idempotent, silences handlers, and does NOT report itself as a disconnect', () => {
    const { ws, h, handle } = connected();
    handle.close();
    handle.close();
    expect(ws.closeCalls).toBe(1);
    expect(h.closes).toBe(0);       // a deliberate close is not a disconnect
    expect(ws.onmessage).toBeNull();
    expect(handle.isOpen()).toBe(false);
  });

  it('a frame arriving after close() is ignored', () => {
    const pool = fakeSocketPool();
    const h = handlers();
    const handle = openSocket('ws://fake/v2/ws', pool.factory, h);
    const ws = pool.last();
    ws.openIt();
    const deliverAfterClose = ws.onmessage!;
    handle.close();
    deliverAfterClose({ data: JSON.stringify({ type: 'entity.upsert', spaceId: 's', seq: 1 }) });
    expect(h.events).toEqual([]);
  });

  it('opens the URL it was given and nothing else', () => {
    const pool = fakeSocketPool();
    const spy = vi.fn(pool.factory);
    openSocket('ws://fake.invalid/v2/ws', spy, handlers());
    expect(spy).toHaveBeenCalledExactlyOnceWith('ws://fake.invalid/v2/ws');
  });
});
