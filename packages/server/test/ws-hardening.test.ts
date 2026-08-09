import { Duplex } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WsConnection } from '../src/events/ws-connection.js';
import { OPCODE } from '../src/events/ws-frame.js';
import { PtyWsConnection, PTY_SOCKET_STATE } from '../src/pty/pty-ws-connection.js';

class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  setNoDelay(): this { return this; }
  _read(): void {}
  _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function maskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
  const header = payload.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : Buffer.from([0x80 | opcode, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, mask, masked]);
}

afterEach(() => vi.useRealTimers());

describe('WebSocket backpressure, timeouts and inbound caps', () => {
  it('closes a slow event-stream consumer before its queued bytes exceed the cap', () => {
    const socket = new FakeSocket();
    Object.defineProperty(socket, 'writableLength', { configurable: true, get: () => 100 });
    const conn = new WsConnection(socket, { kind: 'anonymous' }, { maxBufferedBytes: 110 });
    conn.send('this frame cannot fit');
    expect(conn.isOpen).toBe(false);
  });

  it('enforces idle and absolute lifetimes', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const idle = new WsConnection(
      new FakeSocket(),
      { kind: 'anonymous' },
      { idleTimeoutMs: 50, absoluteTimeoutMs: 1_000 },
    );
    vi.advanceTimersByTime(51);
    expect(idle.isOpen).toBe(false);

    const absolute = new PtyWsConnection(
      new FakeSocket(),
      {},
      { idleTimeoutMs: 1_000, absoluteTimeoutMs: 50 },
    );
    vi.advanceTimersByTime(51);
    expect(absolute.readyState).toBe(PTY_SOCKET_STATE.closed);
  });

  it('caps PTY input/control frames and inbound rate before handler dispatch', () => {
    const inputs: Buffer[] = [];
    const oversized = new PtyWsConnection(
      new FakeSocket(),
      { onInput: (data) => inputs.push(data) },
      { maxInputBytes: 4 },
    );
    oversized.ingest(maskedClientFrame(OPCODE.binary, Buffer.from('12345')));
    expect(inputs).toHaveLength(0);
    expect(oversized.readyState).toBe(PTY_SOCKET_STATE.closed);

    const controls: string[] = [];
    const control = new PtyWsConnection(
      new FakeSocket(),
      { onControl: (text) => controls.push(text) },
      { maxControlBytes: 4 },
    );
    control.ingest(maskedClientFrame(OPCODE.text, Buffer.from('12345')));
    expect(controls).toHaveLength(0);
    expect(control.readyState).toBe(PTY_SOCKET_STATE.closed);

    const rateInputs: Buffer[] = [];
    const rate = new PtyWsConnection(
      new FakeSocket(),
      { onInput: (data) => rateInputs.push(data) },
      { maxMessagesPerWindow: 1, maxInboundBytesPerWindow: 100 },
    );
    rate.ingest(Buffer.concat([
      maskedClientFrame(OPCODE.binary, Buffer.from('a')),
      maskedClientFrame(OPCODE.binary, Buffer.from('b')),
    ]));
    expect(rateInputs).toHaveLength(1);
    expect(rate.readyState).toBe(PTY_SOCKET_STATE.closed);
  });

  it('closes a slow PTY consumer at the configured queue cap', () => {
    const socket = new FakeSocket();
    Object.defineProperty(socket, 'writableLength', { configurable: true, get: () => 100 });
    const conn = new PtyWsConnection(socket, {}, { maxBufferedBytes: 110 });
    conn.send(Buffer.from('this frame cannot fit'));
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.closed);
  });
});
