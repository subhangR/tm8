/**
 * The PTY socket's interim slow-consumer policy: a viewer whose queue crosses
 * the soft cap gets a grace window to drain instead of being dropped on the
 * spot, while a hard ceiling still drops it immediately so memory stays
 * bounded. The fake socket stalls for real — `_write` holds its callbacks
 * until released — so `writableLength` and `'drain'` come from Node's own
 * Writable bookkeeping, not from stubs.
 */
import { Duplex } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLOSE_CODE, OPCODE, decodeClosePayload } from '../src/events/ws-frame.js';
import { PtyWsConnection, PTY_SOCKET_STATE } from '../src/pty/pty-ws-connection.js';

/** A socket whose peer can stop reading: writes queue until `release()`. */
class StallableSocket extends Duplex {
  chunks: Buffer[] = [];
  stalled = true;
  private pending: (() => void)[] = [];
  setNoDelay(): this {
    return this;
  }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    const deliver = () => {
      this.chunks.push(Buffer.from(chunk));
      cb();
    };
    if (this.stalled) this.pending.push(deliver);
    else deliver();
  }
  release(): void {
    this.stalled = false;
    const pending = this.pending;
    this.pending = [];
    for (const deliver of pending) deliver();
  }
}

interface Frame {
  opcode: number;
  payload: Buffer;
}

/** Decode UNMASKED server->client frames. */
function decodeServerFrames(raw: Buffer): Frame[] {
  const out: Frame[] = [];
  let buf = raw;
  while (buf.length >= 2) {
    const opcode = buf.readUInt8(0) & 0x0f;
    const len7 = buf.readUInt8(1) & 0x7f;
    let offset = 2;
    let length = len7;
    if (len7 === 126) {
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (len7 === 127) {
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    out.push({ opcode, payload: Buffer.from(buf.subarray(offset, offset + length)) });
    buf = buf.subarray(offset + length);
  }
  return out;
}

/** Let the stream flush the writes it released and emit 'drain'. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => process.nextTick(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const CAP = 32 * 1024;
const frameOf = (i: number) => Buffer.alloc(8 * 1024, 0x41 + i);
/** On-wire size of one `frameOf` frame: 2-byte header + 16-bit extended length. */
const FRAME_BYTES = 8 * 1024 + 4;

afterEach(() => vi.useRealTimers());

describe('PTY slow-consumer grace window', () => {
  it('survives a brief stall that drains inside the grace window, losing no frames', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new StallableSocket();
    const conn = new PtyWsConnection(socket, {}, {
      maxBufferedBytes: CAP,
      slowConsumerGraceMs: 100,
    });

    // 6 x 8 KiB = 48 KiB queued: over the 32 KiB soft cap, under the 128 KiB ceiling.
    const sent = Array.from({ length: 6 }, (_, i) => frameOf(i));
    for (const frame of sent) conn.send(frame);
    expect(socket.writableLength).toBeGreaterThan(CAP);
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.open);

    vi.advanceTimersByTime(50);
    socket.release();
    await settle();
    expect(socket.writableLength).toBe(0);

    // Well past the original deadline: the drain cancelled the timer.
    vi.advanceTimersByTime(1_000);
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.open);

    const frames = decodeServerFrames(Buffer.concat(socket.chunks));
    expect(frames.map((f) => f.opcode)).toEqual(sent.map(() => OPCODE.binary));
    expect(frames.map((f) => f.payload)).toEqual(sent);
    expect(socket.listenerCount('drain')).toBe(0);
  });

  it('closes a sustained stall with policyViolation "slow consumer" once the grace expires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new StallableSocket();
    const onClose = vi.fn();
    const conn = new PtyWsConnection(socket, { onClose }, {
      maxBufferedBytes: CAP,
      slowConsumerGraceMs: 100,
    });

    for (let i = 0; i < 6; i += 1) conn.send(frameOf(i));
    vi.advanceTimersByTime(99);
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.open);
    // Further writes inside the window must not push the deadline back.
    conn.send(frameOf(6));
    vi.advanceTimersByTime(1);

    expect(conn.readyState).toBe(PTY_SOCKET_STATE.closed);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(true);
  });

  it('closes immediately when a burst would pass the hard ceiling', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new StallableSocket();
    const conn = new PtyWsConnection(socket, {}, {
      maxBufferedBytes: CAP,
      hardMaxBufferedBytes: 8 * FRAME_BYTES,
      slowConsumerGraceMs: 10_000,
    });

    // 8 frames fill the ceiling exactly; the 9th would cross it.
    for (let i = 0; i < 8; i += 1) conn.send(frameOf(i));
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.open);
    conn.send(frameOf(8));
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.closed);
    expect(socket.destroyed).toBe(true);
    // The frame that would have broken the ceiling was never queued — only
    // the small close frame went in after the eight that fit.
    expect(socket.writableLength).toBeLessThan(9 * FRAME_BYTES);
  });

  it('a hard ceiling below the soft cap is raised to it, keeping the grace window', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new StallableSocket();
    const conn = new PtyWsConnection(socket, {}, {
      maxBufferedBytes: CAP,
      hardMaxBufferedBytes: 1,
      slowConsumerGraceMs: 100,
    });
    conn.send(frameOf(0));
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.open);
  });

  it('sends the slow-consumer close frame with the same code and reason as before', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new StallableSocket();
    const conn = new PtyWsConnection(socket, {}, {
      maxBufferedBytes: CAP,
      slowConsumerGraceMs: 100,
    });
    for (let i = 0; i < 6; i += 1) conn.send(frameOf(i));
    const write = vi.spyOn(socket, 'write');
    vi.advanceTimersByTime(100);
    const closeFrame = decodeServerFrames(write.mock.calls[0]![0] as Buffer)[0]!;
    expect(closeFrame.opcode).toBe(OPCODE.close);
    expect(decodeClosePayload(closeFrame.payload)).toEqual({
      code: CLOSE_CODE.policyViolation,
      reason: 'slow consumer',
    });
  });

  it('clears the grace timer and drain listener when the connection finishes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const socket = new StallableSocket();
    const onClose = vi.fn();
    const conn = new PtyWsConnection(socket, { onClose }, {
      maxBufferedBytes: CAP,
      slowConsumerGraceMs: 100,
    });
    for (let i = 0; i < 6; i += 1) conn.send(frameOf(i));
    expect(socket.listenerCount('drain')).toBe(1);
    // heartbeat is an interval (unfaked); idle + absolute + grace are timeouts.
    expect(vi.getTimerCount()).toBe(3);

    socket.emit('close');

    expect(conn.readyState).toBe(PTY_SOCKET_STATE.closed);
    expect(vi.getTimerCount()).toBe(0);
    expect(socket.listenerCount('drain')).toBe(0);
    vi.advanceTimersByTime(1_000);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
