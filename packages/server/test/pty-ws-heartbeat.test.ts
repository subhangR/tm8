/**
 * The PTY socket's server-originated ping/pong heartbeat (drift item b): a
 * subscriber that vanishes without a clean close frame (killed process,
 * dropped wifi, laptop sleep) must be REAPED, not linger as a phantom
 * forever. These tests prove reaping actually happens — a dead socket is
 * destroyed and removed from both the connection set and the PTY's
 * subscriber list — not merely that a timer fires.
 *
 * Fake timers are scoped to setInterval/clearInterval only (`toFake`), so
 * PtyHostService's own setTimeout-driven output coalescing keeps running on
 * the real clock while the heartbeat's cadence is under test control.
 */
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '@tm8/execution';

import { createPtyWsServer } from '../src/pty/index.js';
import { PtyWsConnection, PTY_SOCKET_STATE } from '../src/pty/pty-ws-connection.js';
import { OPCODE } from '../src/events/ws-frame.js';

const CWD = process.cwd();
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  destroyCalls = 0;
  setNoDelay(): this {
    return this;
  }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  override destroy(error?: Error): this {
    this.destroyCalls += 1;
    return super.destroy(error);
  }
  written(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface Frame {
  opcode: number;
  payload: Buffer;
}

/** Decode UNMASKED server->client frames (RFC 6455 §5.1: server frames are never masked). */
function decodeServerFrames(raw: Buffer): Frame[] {
  const sep = raw.indexOf('\r\n\r\n');
  let buf = sep >= 0 ? raw.subarray(sep + 4) : raw;
  const out: Frame[] = [];
  while (buf.length >= 2) {
    const b0 = buf.readUInt8(0);
    const opcode = b0 & 0x0f;
    const len7 = buf.readUInt8(1) & 0x7f;
    let offset = 2;
    let length = len7;
    if (len7 === 126) {
      if (buf.length < 4) break;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (len7 === 127) {
      if (buf.length < 10) break;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (buf.length < offset + length) break;
    out.push({ opcode, payload: Buffer.from(buf.subarray(offset, offset + length)) });
    buf = buf.subarray(offset + length);
  }
  return out;
}

/** A masked client->server frame — required by RFC 6455 §5.1, or the decoder rejects it. */
function maskedClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  const len = payload.length;
  const header =
    len < 126
      ? Buffer.from([0x80 | opcode, 0x80 | len])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), Buffer.alloc(2)]);
  if (len >= 126) header.writeUInt16BE(len, 2);
  return Buffer.concat([header, mask, masked]);
}

function upgradeReq(url: string): IncomingMessage {
  return {
    url,
    headers: {
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  } as unknown as IncomingMessage;
}

describe('PtyWsConnection heartbeat (unit)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pings every sweep while unanswered, then reaps on the configured miss limit', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sock = new FakeSocket();
    let closed = false;
    const conn = new PtyWsConnection(
      sock,
      { onClose: () => (closed = true) },
      { heartbeatMs: 1000, missedPongLimit: 2 },
    );

    vi.advanceTimersByTime(1000); // sweep 1: miss 1, ping #1
    let pings = decodeServerFrames(sock.written()).filter((f) => f.opcode === OPCODE.ping);
    expect(pings.length).toBe(1);
    expect(closed).toBe(false);
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.open);

    vi.advanceTimersByTime(1000); // sweep 2: miss 2, ping #2 (still not yet over the limit)
    pings = decodeServerFrames(sock.written()).filter((f) => f.opcode === OPCODE.ping);
    expect(pings.length).toBe(2);
    expect(closed).toBe(false);

    vi.advanceTimersByTime(1000); // sweep 3: miss count reached the limit — reap, not another ping
    pings = decodeServerFrames(sock.written()).filter((f) => f.opcode === OPCODE.ping);
    expect(pings.length).toBe(2); // no third ping — the peer was terminated instead
    expect(closed).toBe(true); // onClose fired: a real subscriber-list caller would detach here
    expect(sock.destroyCalls).toBeGreaterThan(0); // the dead socket was actually destroyed
    expect(conn.readyState).toBe(PTY_SOCKET_STATE.closed);
  });

  it('a pong resets the miss counter, so a responsive peer is never reaped', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sock = new FakeSocket();
    let closed = false;
    new PtyWsConnection(sock, { onClose: () => (closed = true) }, { heartbeatMs: 1000, missedPongLimit: 2 });

    // A pong resets the counter, not the deadline: it must arrive again within
    // every `missedPongLimit`-sweep window, same as the peer answering a real
    // ping every cycle. Verify that holds over several cycles, well past the
    // point a non-responsive peer would have been reaped by (see the sibling
    // "pings every sweep..." test).
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      sock.emit('data', maskedClientFrame(OPCODE.pong, Buffer.alloc(0)));
      expect(closed).toBe(false);
    }
    const pings = decodeServerFrames(sock.written()).filter((f) => f.opcode === OPCODE.ping);
    expect(pings.length).toBe(5); // a ping every sweep, never a gap long enough to reap
  });

  it('stops the heartbeat on close() — no pings after graceful shutdown', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sock = new FakeSocket();
    const conn = new PtyWsConnection(sock, {}, { heartbeatMs: 1000, missedPongLimit: 2 });

    conn.close();
    const before = sock.written().length;
    vi.advanceTimersByTime(1000 * 10);
    expect(sock.written().length).toBe(before); // nothing more was written — the timer is gone
  });

  it('unrefs the heartbeat timer so it never keeps the process alive on its own', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const sock = new FakeSocket();
    // Constructing must not throw even though the fake timer's `unref` may be
    // absent/no-op under fake timers — the connection only ever calls it
    // optionally (`timer.unref?.()`).
    expect(() => new PtyWsConnection(sock, {}, { heartbeatMs: 1000 })).not.toThrow();
  });
});

describe('PTY WebSocket heartbeat (through the real server + PtyHostService)', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
    vi.useRealTimers();
  });

  it('reaps a subscriber that never answers pings — the server actually drops it', async () => {
    // Installed BEFORE the connection exists: only setInterval/clearInterval
    // are faked (PtyHostService's own setTimeout-driven coalescing stays on
    // the real clock), but the heartbeat's own setInterval must be created
    // under the fake clock, or advancing it later has nothing to advance.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-heartbeat', command: 'sleep 5', cwd: CWD, env: {} });
    await new Promise((r) => setTimeout(r, 200));

    const server = createPtyWsServer({ pty: host, heartbeatMs: 1000, missedPongLimit: 2 });
    const sock = new FakeSocket();
    await server.handleUpgrade(
      upgradeReq('/v2/ws?sessionId=s-heartbeat&offset=0'),
      sock,
      Buffer.alloc(0),
    );
    expect(server.connectionCount()).toBe(1);

    // This subscriber never answers a single ping — a killed client process,
    // never a clean close frame. Sweep 1 (miss 1), sweep 2 (miss 2), sweep 3
    // (miss count already at the limit -> reap instead of a third ping).
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);

    expect(server.connectionCount()).toBe(0); // dropped from the live connection set
    expect(sock.destroyCalls).toBeGreaterThan(0); // and the underlying socket was destroyed
  });
});
