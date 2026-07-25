/**
 * The PTY WebSocket — live terminal streaming for the browser session view.
 *
 * This is a port of old maestro's `PtyWebSocketServer`, deliberately kept
 * frame-for-frame identical on the wire so the two codebases run the same
 * proven protocol. The ONLY difference is the URL: maestro serves this at
 * `/pty`, while tm8's contract already grants `/v2/ws?sessionId=<id>` from
 * `execution.streams.attach`, and tm8 forbids hardcoded paths. So the PTY socket
 * shares the events path and is distinguished by the `sessionId` query param
 * (see {@link isPtyUpgrade}); events/ws-server.ts is untouched.
 *
 * PROTOCOL (one socket per session, `?sessionId=<id>&offset=<rawBytes>`):
 *   server -> client
 *     TEXT   {type:'size', cols, rows}                     (first, when known)
 *     TEXT   {type:'attached', base, gap, next, hasReplay,
 *             replayKind?, epoch?}                          (the resume handshake)
 *     BINARY the sanitized scrollback replay                (once, iff hasReplay)
 *     BINARY live raw PTY output                            (thereafter)
 *     TEXT   {type:'exit', exitCode}                        (real process exit)
 *   client -> server
 *     `?offset=` the last raw byte offset it received (0/absent = fresh attach)
 *     BINARY  keystroke bytes
 *     TEXT    {type:'resize', cols, rows}
 *
 * ALL OFFSETS ARE RAW byte positions. `next` is authoritative: the client snaps
 * its receive counter to it and must NOT compute `base + replay.length`, because
 * the replay slice is sanitized (device queries stripped) and therefore SHORTER
 * than the raw span it represents. `gap` counts evicted bytes the client must
 * surface as a truncation. `epoch` is the opaque per-spawn stream identity,
 * compared by EQUALITY ONLY — a changed epoch means a respawn and an
 * authoritative client reset.
 *
 * WHY NOT `PtyHostService.attach()`: that convenience seam composes the same
 * primitives but delivers the replay THROUGH the sink *before* returning its
 * metadata, i.e. replay-then-handshake. This protocol is handshake-then-replay,
 * and the order is load-bearing — on a `snapshot` replay the client must reset
 * its xterm (driven by the `attached` frame) BEFORE the snapshot is rendered,
 * or the repaint lands in the old buffer and is then wiped by the reset. So this
 * file drives the lower-level primitives directly, exactly as maestro does.
 * `attach()` is left alone; only packages/execution/harness/pty-harness.mjs
 * uses it.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { PtyHostService } from '@tm8/execution';

import type { WsSocket } from '../events/ws-connection.js';
import { CLOSE_CODE } from '../events/ws-frame.js';
import { computeAcceptKey } from '../events/ws-server.js';
import { PtyWsConnection } from './pty-ws-connection.js';

/** Minimal logger seam, structurally compatible with the execution block's. */
export interface PtyWsLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}

const NOOP_LOGGER: PtyWsLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface PtyWsServerOptions {
  /**
   * The SHARED PtyHostService — must be `createExecutionRuntime().pty`, the same
   * instance the spawn handlers write to. A second host would have its own
   * session map and every attach would 1011.
   */
  pty: PtyHostService;
  logger?: PtyWsLogger;
}

export interface PtyWsServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  connectionCount(): number;
  closeAll(code?: number, reason?: string): void;
}

/**
 * Does this upgrade request address the PTY socket rather than the workspace
 * event stream? The two share a path, so the discriminator is the `sessionId`
 * query param the `execution.streams.attach` grant hands the client.
 */
export function isPtyUpgrade(req: IncomingMessage): boolean {
  try {
    return new URL(req.url ?? '/', 'http://tm8.invalid').searchParams.has('sessionId');
  } catch {
    return false;
  }
}

/**
 * Plain-HTTP refusal. Deliberately not the DEV-8 JSON envelope: a failed upgrade
 * never becomes a WebSocket, so there is no socket to deliver a contract-shaped
 * error over. (Mirrors the private helper in events/ws-server.ts; duplicated
 * rather than exported so that file stays untouched by this feature.)
 */
function refuse(socket: Duplex, status: number, statusText: string, body: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      'connection: close\r\n' +
      'content-type: text/plain; charset=utf-8\r\n' +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (raw === undefined) return '';
  return Array.isArray(raw) ? (raw[0] ?? '') : raw;
}

/**
 * The raw byte offset the client last received. Absent, negative or non-numeric
 * normalizes to 0 (a fresh attach → full replay of the retained tail);
 * `getReplay` also treats an out-of-range offset as a fresh attach.
 */
function parseOffset(url: URL): number {
  const raw = url.searchParams.get('offset');
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function createPtyWsServer(opts: PtyWsServerOptions): PtyWsServer {
  const { pty } = opts;
  const logger = opts.logger ?? NOOP_LOGGER;
  const connections = new Set<PtyWsConnection>();

  function handleControl(sessionId: string, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const frame = msg as { type?: unknown; cols?: unknown; rows?: unknown };
    if (frame.type !== 'resize') return;
    const cols = Number(frame.cols);
    const rows = Number(frame.rows);
    if (Number.isFinite(cols) && Number.isFinite(rows)) {
      pty.resize(sessionId, cols, rows);
    }
  }

  /**
   * The gap>0 path: an evicted raw prefix is not a valid terminal program (it can
   * begin mid-CSI and omit the alt-screen/mode setup an agent TUI relies on), so
   * the client is given a coherent serialized terminal state instead. Live output
   * produced while the mirror serializes is buffered by the pending-subscriber
   * backlog and flushed on activation, so nothing is lost across the await.
   */
  async function finishSnapshotAttach(
    conn: PtyWsConnection,
    sessionId: string,
    offset: number,
    gap: number,
    epoch: string | null,
    snapshotPromise: Promise<{ next: number; data: Buffer; cols: number; rows: number }>,
  ): Promise<void> {
    try {
      const snapshot = await snapshotPromise;
      conn.send(JSON.stringify({ type: 'size', cols: snapshot.cols, rows: snapshot.rows }));
      const attachedFrame: Record<string, unknown> = {
        type: 'attached',
        base: snapshot.next,
        gap,
        next: snapshot.next,
        hasReplay: snapshot.data.length > 0,
        replayKind: 'snapshot',
      };
      if (epoch) attachedFrame.epoch = epoch;
      conn.send(JSON.stringify(attachedFrame));
      if (snapshot.data.length > 0) conn.send(snapshot.data);

      if (!pty.activatePendingSubscriber(sessionId, conn)) {
        conn.close(CLOSE_CODE.internalError, 'PTY ended during terminal-state replay');
        return;
      }
      logger.warn('PtyWsServer: replay gap restored from terminal-state snapshot', {
        sessionId,
        gap,
      });
      logger.info('PtyWsServer: client attached', { sessionId, offset });
    } catch (error) {
      pty.removeSubscriber(sessionId, conn);
      logger.error(
        'PtyWsServer: failed to serialize terminal-state replay',
        error instanceof Error ? error : new Error(String(error)),
        { sessionId },
      );
      conn.close(CLOSE_CODE.internalError, 'failed to restore terminal state');
    }
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      refuse(socket, 400, 'Bad Request', 'missing sessionId');
      return;
    }
    if (headerValue(req, 'upgrade').toLowerCase() !== 'websocket') {
      refuse(socket, 400, 'Bad Request', 'expected Upgrade: websocket');
      return;
    }
    if (headerValue(req, 'sec-websocket-version') !== '13') {
      refuse(socket, 400, 'Bad Request', 'only Sec-WebSocket-Version: 13 is supported');
      return;
    }
    const key = headerValue(req, 'sec-websocket-key');
    if (key === '') {
      refuse(socket, 400, 'Bad Request', 'missing Sec-WebSocket-Key');
      return;
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${computeAcceptKey(key)}\r\n\r\n`,
    );

    // Register inbound/cleanup handlers BEFORE resolving the replay: the gap
    // path awaits the headless mirror, and input and socket-close events must
    // stay observable during that window.
    const conn = new PtyWsConnection(socket as WsSocket, {
      onInput: (data) => pty.write(sessionId, data),
      onControl: (text) => handleControl(sessionId, text),
      onClose: () => {
        connections.delete(conn);
        pty.removeSubscriber(sessionId, conn);
        logger.info('PtyWsServer: client detached', { sessionId });
      },
    });
    connections.add(conn);
    if (head.length > 0) conn.ingest(head);

    const offset = parseOffset(url);

    // Resolve the resume point FIRST. getReplay both proves the PTY still exists
    // (null → nothing to attach to) and computes exactly the delta to replay, so
    // a ghost session is closed before it is ever subscribed.
    const replay = pty.getReplay(sessionId, offset);
    if (!replay) {
      conn.close(CLOSE_CODE.internalError, 'no live PTY for session');
      return;
    }

    if (replay.gap > 0) {
      if (!pty.addPendingSubscriber(sessionId, conn)) {
        conn.close(CLOSE_CODE.internalError, 'no live PTY for session');
        return;
      }
      const snapshotPromise = pty.getStateSnapshot(sessionId);
      if (!snapshotPromise) {
        pty.removeSubscriber(sessionId, conn);
        conn.close(CLOSE_CODE.internalError, 'no live PTY for session');
        return;
      }
      await finishSnapshotAttach(
        conn,
        sessionId,
        offset,
        replay.gap,
        pty.getEpoch(sessionId),
        snapshotPromise,
      );
      return;
    }

    // Tell the client the PTY's dimensions BEFORE the replay so it can size its
    // grid to the width the buffered output was authored at — otherwise the
    // replay wraps at the wrong column and the history renders garbled.
    const size = pty.getSize(sessionId);
    if (size) conn.send(JSON.stringify({ type: 'size', cols: size.cols, rows: size.rows }));

    const hasReplay = replay.data.length > 0;
    const epoch = pty.getEpoch(sessionId);
    const attachedFrame: Record<string, unknown> = {
      type: 'attached',
      base: replay.base,
      gap: replay.gap,
      next: replay.next,
      hasReplay,
    };
    if (epoch) attachedFrame.epoch = epoch;
    conn.send(JSON.stringify(attachedFrame));

    if (hasReplay) conn.send(replay.data);

    // ORDERING INVARIANT — DO NOT insert an `await` anywhere between the
    // getReplay boundary above and this addSubscriber join. getReplay froze the
    // stream at `next`; node-pty output arrives on a SEPARATE event-loop task, so
    // as long as this whole sequence (replay → size/attached/replay frames →
    // join) runs synchronously, no live chunk can interleave: every byte < next
    // is in the replay, every byte >= next is delivered live, and the two
    // partitions cover the stream with no overlap and no hole. Yielding here
    // reopens that window and a chunk emitted in it would be lost or duplicated.
    if (!pty.addSubscriber(sessionId, conn)) {
      conn.close(CLOSE_CODE.internalError, 'no live PTY for session');
      return;
    }

    logger.info('PtyWsServer: client attached', { sessionId, offset });
  }

  return {
    handleUpgrade,
    connectionCount: () => connections.size,
    closeAll: (code = CLOSE_CODE.goingAway, reason = 'server shutting down') => {
      for (const conn of connections) conn.close(code, reason);
    },
  };
}
