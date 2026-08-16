/**
 * Integration tests for the PTY WebSocket, driven over a fake duplex so the REAL
 * upgrade path, the REAL frame codec and a REAL PTY are all exercised without a
 * network listener.
 *
 * What matters here is the handshake ORDER and the exactly-once accounting:
 *   size (text) -> attached (text) -> replay (ONE binary) -> live (binary)
 * and, on a ring eviction, that the client is handed a coherent terminal-state
 * SNAPSHOT with an honest `gap` rather than a raw prefix that begins mid-escape.
 */
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { PtyHostService } from '@tm8/execution';

import { createPtyWsServer, isPtyUpgrade } from '../src/pty/index.js';

const CWD = process.cwd();
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** A Duplex that captures everything the server writes to the socket. */
class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  setNoDelay(): this {
    return this;
  }
  _read(): void {}
  _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  written(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

interface Frame {
  kind: 'text' | 'binary' | 'close' | 'other';
  payload: Buffer;
}

/**
 * Decode the server's UNMASKED frames. Server→client frames are never masked
 * (RFC 6455 §5.1), so this stays small; it skips the HTTP 101 preamble first.
 */
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
    const payload = buf.subarray(offset, offset + length);
    out.push({
      kind: opcode === 0x1 ? 'text' : opcode === 0x2 ? 'binary' : opcode === 0x8 ? 'close' : 'other',
      payload: Buffer.from(payload),
    });
    buf = buf.subarray(offset + length);
  }
  return out;
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

const waitFor = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const texts = (f: Frame[]) => f.filter((x) => x.kind === 'text').map((x) => JSON.parse(x.payload.toString('utf8')));
const bins = (f: Frame[]) => f.filter((x) => x.kind === 'binary');

describe('PTY WebSocket', () => {
  let host: PtyHostService | undefined;

  afterEach(() => {
    host?.shutdownAll();
    host = undefined;
  });

  it('routes only upgrades carrying a sessionId to the PTY socket', () => {
    expect(isPtyUpgrade(upgradeReq('/v2/ws?sessionId=abc'))).toBe(true);
    // The workspace event stream shares the path and must NOT be captured.
    expect(isPtyUpgrade(upgradeReq('/v2/ws'))).toBe(false);
  });

  it('refuses a session with no live PTY over plain HTTP, BEFORE the 101 (trap 5)', async () => {
    // Identity v2 Stage 1 (2026-08-02): the old behaviour wrote the 101 first
    // and then closed 1011, which made the socket a session-id oracle. A ghost
    // session is now a plain-HTTP 404 and no WebSocket ever exists.
    host = new PtyHostService({ logger: quiet });
    const server = createPtyWsServer({ pty: host });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=ghost&offset=0'), sock, Buffer.alloc(0));

    const raw = sock.written().toString('utf8');
    expect(raw).not.toContain('101 Switching Protocols');
    expect(raw).toContain('404 Not Found');
    expect(raw).toContain('no live PTY for session');
  });

  it('refuses the attach when the authorizer says no, BEFORE the 101', async () => {
    host = new PtyHostService({ logger: quiet });
    const server = createPtyWsServer({
      pty: host,
      authorize: async () => ({ ok: false, status: 404, message: 'no such session' }),
    });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=ghost&offset=0'), sock, Buffer.alloc(0));

    const raw = sock.written().toString('utf8');
    expect(raw).not.toContain('101 Switching Protocols');
    expect(raw).toContain('404 Not Found');
    expect(raw).toContain('no such session');
  });

  it('sends size -> attached -> ONE replay frame, in that order, then live output', async () => {
    host = new PtyHostService({ logger: quiet });
    host.spawn({
      sessionId: 's-order',
      command: 'for i in $(seq 1 40); do echo "L$i"; done; sleep 2',
      cwd: CWD,
      env: {},
    });
    // Let output accumulate so the attach has scrollback to replay.
    await new Promise((r) => setTimeout(r, 700));

    const server = createPtyWsServer({ pty: host });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-order&offset=0'), sock, Buffer.alloc(0));

    const frames = decodeServerFrames(sock.written());
    const ctrl = texts(frames);
    expect(ctrl[0].type).toBe('size');
    expect(ctrl[1].type).toBe('attached');

    const attached = ctrl[1];
    expect(attached.gap).toBe(0);
    expect(attached.hasReplay).toBe(true);
    expect(attached.replayKind).toBeUndefined(); // delta replay omits the key
    expect(typeof attached.epoch).toBe('string');

    // EXACTLY ONE replay binary frame, and it must come AFTER the attached ack.
    const firstBinaryIdx = frames.findIndex((f) => f.kind === 'binary');
    const attachedIdx = frames.findIndex((f) => f.kind === 'text' && JSON.parse(f.payload.toString()).type === 'attached');
    expect(firstBinaryIdx).toBeGreaterThan(attachedIdx);

    const body = Buffer.concat(bins(frames).map((b) => b.payload)).toString('utf8');
    expect(body).toContain('L1');

    // `next` is authoritative and is NOT base + replay length: the replay is
    // sanitized, so it may be shorter than the raw span it stands for.
    expect(attached.next).toBeGreaterThanOrEqual(attached.base + bins(frames)[0]!.payload.length);
  });

  it('resuming at `next` replays nothing (no duplication)', async () => {
    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-resume', command: 'echo hello; sleep 3', cwd: CWD, env: {} });
    await new Promise((r) => setTimeout(r, 600));

    const server = createPtyWsServer({ pty: host });
    const a = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-resume&offset=0'), a, Buffer.alloc(0));
    const attachedA = texts(decodeServerFrames(a.written())).find((c) => c.type === 'attached');
    expect(attachedA.hasReplay).toBe(true);

    const b = new FakeSocket();
    await server.handleUpgrade(
      upgradeReq(`/v2/ws?sessionId=s-resume&offset=${attachedA.next}`),
      b,
      Buffer.alloc(0),
    );
    const framesB = decodeServerFrames(b.written());
    const attachedB = texts(framesB).find((c) => c.type === 'attached');
    expect(attachedB.gap).toBe(0);
    expect(attachedB.base).toBe(attachedA.next);
    expect(attachedB.hasReplay).toBe(false);
    expect(bins(framesB).length).toBe(0);
  });

  it('an evicted prefix is restored as a SNAPSHOT with an honest gap', async () => {
    // A deliberately tiny ring so a modest burst overflows it and forces the
    // gap>0 branch — the path that replaces a raw (possibly mid-escape) prefix
    // with a coherent serialized terminal state.
    host = new PtyHostService({ logger: quiet, outputCapBytes: 2048 });
    host.spawn({
      sessionId: 's-gap',
      command: 'for i in $(seq 1 800); do echo "LINE-$i"; done; sleep 3',
      cwd: CWD,
      env: {},
    });
    // Gate on BOTH conditions the assertions below depend on: the ring has
    // evicted (gap>0) AND the final line has actually been produced. Waiting on
    // gap>0 alone is a load-sensitive race — eviction can fire after LINE-400
    // while the shell is still printing, so a snapshot taken then would not yet
    // contain LINE-800 and the test flakes only under concurrent-suite load. The
    // tail line is always retained (it is the newest), so this is deterministic.
    await waitFor(() => {
      const r = host!.getReplay('s-gap', 0);
      return !!r && r.gap > 0 && r.data.toString('utf8').includes('LINE-800');
    });

    const server = createPtyWsServer({ pty: host });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-gap&offset=0'), sock, Buffer.alloc(0));
    // The snapshot path awaits the headless mirror.
    await waitFor(() => texts(decodeServerFrames(sock.written())).some((c) => c.type === 'attached'));

    const frames = decodeServerFrames(sock.written());
    const ctrl = texts(frames);
    expect(ctrl[0].type).toBe('size');
    const attached = ctrl.find((c) => c.type === 'attached');
    expect(attached.gap).toBeGreaterThan(0);
    expect(attached.replayKind).toBe('snapshot');
    // base === next on the snapshot path: the state IS the stream boundary.
    expect(attached.base).toBe(attached.next);

    const body = Buffer.concat(bins(frames).map((b) => b.payload)).toString('utf8');
    // A snapshot is a full repaint, so it begins with a reset rather than
    // resuming mid-stream, and carries the tail the terminal actually shows.
    expect(body.startsWith('\x1bc')).toBe(true);
    expect(body).toContain('LINE-800');
  });

  it('a client resize control frame reaches the PTY', async () => {
    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-resize', command: 'sleep 3', cwd: CWD, env: {}, cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 300));

    const server = createPtyWsServer({ pty: host });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-resize&offset=0'), sock, Buffer.alloc(0));
    expect(host.getSize('s-resize')).toEqual({ cols: 80, rows: 24 });

    // Client frames MUST be masked (RFC 6455 §5.1) or the decoder rejects them.
    const payload = Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
    const frame = Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
    sock.push(frame);

    await waitFor(() => {
      const s = host!.getSize('s-resize');
      return s?.cols === 120 && s?.rows === 40;
    });
    expect(host.getSize('s-resize')).toEqual({ cols: 120, rows: 40 });
  });

  it('a no-op resize is swallowed, but `force` bounces the winsize so the agent gets a SIGWINCH', async () => {
    // The equality guard in handleControl exists to terminate client echo
    // loops, and it is right to. But it also swallowed the ONE resize that
    // matters on attach: a browser remounting into unchanged window geometry
    // fits to exactly the size the PTY already has, so nothing reached the PTY,
    // no SIGWINCH was raised, and a full-screen agent TUI never repainted over
    // the freshly rendered replay — the "blank until I resize the window" bug.
    // `force` is the one-shot hole in that guard. Because TIOCSWINSZ only
    // signals when the winsize actually CHANGES, honouring it means bouncing a
    // row and coming straight back, which is what this asserts: two resize
    // calls, and the geometry ends where it started.
    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-force', command: 'sleep 3', cwd: CWD, env: {}, cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 300));

    const calls: Array<{ cols: number; rows: number }> = [];
    const realResize = host.resize.bind(host);
    host.resize = (id: string, cols: number, rows: number) => {
      calls.push({ cols, rows });
      realResize(id, cols, rows);
    };

    const server = createPtyWsServer({ pty: host });
    const sock = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-force&offset=0'), sock, Buffer.alloc(0));

    const send = (frame: Record<string, unknown>) => {
      const payload = Buffer.from(JSON.stringify(frame), 'utf8');
      const mask = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
      sock.push(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
    };

    // Unforced and identical: the echo-loop guard swallows it whole.
    send({ type: 'resize', cols: 80, rows: 24 });
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([]);

    // Forced and identical: bounce down one row, then back to the real size.
    send({ type: 'resize', cols: 80, rows: 24, force: true });
    await waitFor(() => calls.length >= 2);
    expect(calls).toEqual([
      { cols: 80, rows: 23 },
      { cols: 80, rows: 24 },
    ]);
    expect(host.getSize('s-force')).toEqual({ cols: 80, rows: 24 });
  });

  it('a respawn on the same sessionId replaces the PTY: old socket closes with NO exit frame, new attach gets a different epoch and only the new stream', async () => {
    // PtyHostService.spawn() is documented as "deliberately destructive for the
    // agent resume path": calling it twice on the same sessionId kills the old
    // PTY with notify=false (closeSubscribers — a plain close, no {type:'exit'}
    // text frame) and installs a fresh entry with a new epoch. This is the
    // wire-level behavior that claim rests on, observed here rather than
    // inferred from the source comment.
    host = new PtyHostService({ logger: quiet });
    host.spawn({ sessionId: 's-respawn', command: 'echo A; sleep 5', cwd: CWD, env: {} });
    await new Promise((r) => setTimeout(r, 400));

    const server = createPtyWsServer({ pty: host });
    const sockA = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-respawn&offset=0'), sockA, Buffer.alloc(0));

    const framesA1 = decodeServerFrames(sockA.written());
    const attachedA = texts(framesA1).find((c) => c.type === 'attached');
    expect(attachedA).toBeDefined();
    const epoch1 = attachedA.epoch;
    expect(typeof epoch1).toBe('string');
    expect(Buffer.concat(bins(framesA1).map((b) => b.payload)).toString('utf8')).toContain('A');

    // The destructive replace: same sessionId, a new process.
    host.spawn({ sessionId: 's-respawn', command: 'echo B; sleep 5', cwd: CWD, env: {} });
    await waitFor(() => {
      const frames = decodeServerFrames(sockA.written());
      return frames.some((f) => f.kind === 'close');
    });

    // Old socket: a CLOSE frame arrived, but NEVER a {type:'exit'} text frame —
    // that is what lets the client tell "replaced, reconnect" apart from "the
    // agent actually exited, stop reconnecting" (ptyTransport.ts's
    // _exitedSessions bookkeeping depends on this distinction).
    const framesA2 = decodeServerFrames(sockA.written());
    expect(framesA2.some((f) => f.kind === 'close')).toBe(true);
    expect(texts(framesA2).some((c) => c.type === 'exit')).toBe(false);

    // Give the NEW process time to actually produce output before attaching —
    // otherwise the replay ring is legitimately still empty and `hasReplay`
    // would be false for a timing reason, not a protocol one.
    await waitFor(() => {
      const r = host!.getReplay('s-respawn', 0);
      return !!r && r.data.toString('utf8').includes('B');
    });

    // Reconnect fresh (offset 0, as a real client would after a close with no
    // exit frame): a DIFFERENT epoch, and the replay/live output is the NEW
    // process's stream only — no stale 'A' output bleeding across the replace.
    const sockB = new FakeSocket();
    await server.handleUpgrade(upgradeReq('/v2/ws?sessionId=s-respawn&offset=0'), sockB, Buffer.alloc(0));

    const framesB = decodeServerFrames(sockB.written());
    const attachedB = texts(framesB).find((c) => c.type === 'attached');
    expect(attachedB).toBeDefined();
    expect(attachedB.epoch).not.toBe(epoch1);
    expect(attachedB.hasReplay).toBe(true);

    const bodyB = Buffer.concat(bins(framesB).map((b) => b.payload)).toString('utf8');
    expect(bodyB).toContain('B');
    expect(bodyB).not.toContain('A');
  });
});
