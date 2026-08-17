/**
 * One live PTY WebSocket connection — a {@link FrameSink} the execution block
 * can write raw terminal bytes to.
 *
 * WHY THIS IS NOT `WsConnection`. The graph-events socket (events/ws-connection.ts)
 * is deliberately text-only: it `send(text: string)`s JSON and HARD-REFUSES
 * inbound binary frames (close 1008). A PTY stream is the opposite — it is
 * mostly raw bytes, with JSON only as out-of-band control. Old maestro keeps the
 * same separation for the same reason (its PtyWebSocketServer exists so terminal
 * bytes never hit the event bridge's JSON framing, batching and throttling), and
 * conflating them here would mean relaxing the events socket's binary refusal for
 * every workspace subscriber. So this is a SECOND connection class over the SAME
 * exported RFC 6455 codec (events/ws-frame.ts) — the framing is shared, the
 * semantics are not.
 *
 * FrameSink contract (packages/execution): `send(Buffer | string)`, `close()`,
 * and a NUMERIC `readyState` where 1 === OPEN. PtyHostService.safeSend drops any
 * frame when `readyState !== 1`, which is what makes a closed/closing socket
 * detach cleanly instead of throwing inside the fan-out loop.
 *
 * Wire semantics (byte-identical to maestro's /pty socket):
 *   server -> client   BINARY = raw PTY bytes (live) and the single scrollback
 *                               replay frame; TEXT = JSON control
 *                               ({type:'size'|'attached'|'exit'})
 *   client -> server   BINARY = keystrokes written straight to the PTY;
 *                               TEXT = JSON control ({type:'resize'})
 *
 * NO permessage-deflate, matching maestro (the `ws` server defaults compression
 * off and neither side ever negotiates the extension).
 *
 * HEARTBEAT: this DOES depend on protocol-level ping/pong — correcting an
 * earlier version of this comment that claimed the opposite. maestro's
 * PtyWebSocketServer gained a server-originated ping/pong reaper in maestro
 * commit f0f22ce (an `isAlive` latch: ping every 30s, terminate a subscriber
 * that hasn't ponged back since the previous sweep), landing AFTER the "no
 * heartbeat dependence" claim was written here — so that claim had drifted
 * from a decision into a stale, false statement, and a dead subscriber (a
 * killed client process, no clean close frame) was never reaped. Fixed by
 * porting the BEHAVIOR (ping cadence, dead-peer eviction, unref'd timer,
 * stop-on-shutdown), not maestro's `ws`-library isAlive flag — this file
 * hand-rolls the same frame codec `events/ws-connection.ts` does, and that
 * file already has exactly this heartbeat (`missedPongLimit`-latched,
 * `DEFAULT_HEARTBEAT_MS`/`DEFAULT_MISSED_PONG_LIMIT`), so the two sockets now
 * deliberately match each other's idiom instead of one hand-rolled socket
 * having a reaper and its sibling not. Inbound pings are still answered
 * either way — that costs nothing and keeps well-behaved intermediaries
 * happy. Browsers answer protocol-level pings automatically at the WebSocket
 * stack level, so no client-side change is required, and a client that never
 * itself reads pong frames is unaffected.
 */
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MISSED_PONG_LIMIT,
  type WsSocket,
} from '../events/ws-connection.js';
import {
  CLOSE_CODE,
  FrameDecoder,
  FrameProtocolError,
  OPCODE,
  decodeClosePayload,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
} from '../events/ws-frame.js';

/** `readyState` values, matching the browser `WebSocket` constants FrameSink assumes. */
export const PTY_SOCKET_STATE = { open: 1, closing: 2, closed: 3 } as const;

export interface PtyWsConnectionHandlers {
  /** A client BINARY frame — raw keystroke bytes destined for the PTY. */
  onInput?(data: Buffer): void;
  /** A client TEXT frame — a JSON control message (currently only `resize`). */
  onControl?(text: string): void;
  /** The socket is gone; detach it from the PTY fan-out. Fires exactly once. */
  onClose?(): void;
}

export interface PtyWsConnectionOptions {
  /**
   * Ping period. Injectable so tests do not sit for 30 seconds; the timer is
   * `unref()`ed so a live connection never keeps the process alive on its own.
   */
  heartbeatMs?: number;
  /** Missed heartbeats tolerated before the peer is presumed dead and reaped. */
  missedPongLimit?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  maxBufferedBytes?: number;
  maxInputBytes?: number;
  maxControlBytes?: number;
  maxMessagesPerWindow?: number;
  maxInboundBytesPerWindow?: number;
  messageWindowMs?: number;
  now?: () => number;
}

export const DEFAULT_PTY_IDLE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_PTY_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60_000;
export const DEFAULT_PTY_MAX_BUFFERED_BYTES = 1024 * 1024;
export const DEFAULT_PTY_MAX_INPUT_BYTES = 64 * 1024;
export const DEFAULT_PTY_MAX_CONTROL_BYTES = 4 * 1024;

export class PtyWsConnection {
  readonly id = randomUUID();

  /**
   * Whether this connection has already spent its one forced repaint.
   *
   * The `force` flag on a resize is a deliberate hole in the echo-loop equality
   * guard, and it costs a full-screen redraw from the agent every time it is
   * honoured. "The client sends it at most once per attach" is a client
   * CONVENTION, and the protocol must not depend on one: a buggy or hostile
   * peer that sends it in a loop would otherwise drive an unbounded stream of
   * forced repaints. The budget lives on the connection because that is the
   * scope the guarantee is stated in — a genuine reattach opens a new socket
   * and legitimately earns a new one.
   */
  forcedRepaintSpent = false;

  private readonly socket: WsSocket;
  private readonly decoder: FrameDecoder;
  private readonly handlers: PtyWsConnectionHandlers;

  private readonly heartbeatMs: number;
  private readonly missedPongLimit: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private absoluteTimer: NodeJS.Timeout | null = null;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly maxInputBytes: number;
  private readonly maxControlBytes: number;
  private readonly maxMessagesPerWindow: number;
  private readonly maxInboundBytesPerWindow: number;
  private readonly messageWindowMs: number;
  private readonly now: () => number;
  private rateWindowStartedAt: number;
  private rateMessages = 0;
  private rateBytes = 0;

  private state: number = PTY_SOCKET_STATE.open;
  private closeFired = false;

  constructor(
    socket: WsSocket,
    handlers: PtyWsConnectionHandlers = {},
    opts: PtyWsConnectionOptions = {},
  ) {
    this.socket = socket;
    this.handlers = handlers;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.missedPongLimit = opts.missedPongLimit ?? DEFAULT_MISSED_PONG_LIMIT;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_PTY_IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = opts.absoluteTimeoutMs ?? DEFAULT_PTY_ABSOLUTE_TIMEOUT_MS;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_PTY_MAX_BUFFERED_BYTES;
    this.maxInputBytes = opts.maxInputBytes ?? DEFAULT_PTY_MAX_INPUT_BYTES;
    this.maxControlBytes = opts.maxControlBytes ?? DEFAULT_PTY_MAX_CONTROL_BYTES;
    this.decoder = new FrameDecoder(Math.max(this.maxInputBytes, this.maxControlBytes));
    this.maxMessagesPerWindow = opts.maxMessagesPerWindow ?? 256;
    this.maxInboundBytesPerWindow = opts.maxInboundBytesPerWindow ?? 512 * 1024;
    this.messageWindowMs = opts.messageWindowMs ?? 1_000;
    this.now = opts.now ?? Date.now;
    this.rateWindowStartedAt = this.now();

    // PTY output is latency-sensitive and already coalesced into 16ms frames by
    // PtyHostService, so Nagle would only add delay to frames that are
    // deliberately batched upstream.
    socket.setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());

    this.startHeartbeat();
    this.startLifetimeTimers();
  }

  /**
   * FrameSink: 1 === OPEN. PtyHostService.safeSend gates every write on this,
   * so a half-closed socket silently stops receiving instead of throwing.
   */
  get readyState(): number {
    return this.state;
  }

  /**
   * FrameSink.send — a Buffer goes out as a BINARY frame (raw PTY bytes, never
   * re-encoded), a string as a TEXT frame (JSON control). PtyHostService relies
   * on exactly this split: it sends output as Buffers and `{type:'exit'}` as a
   * JSON string through the same sink.
   *
   * KNOWN-UNBOUNDED (shared TODO with maestro): there is NO backpressure policy
   * here. We write straight through and ignore `socket.write()`'s false return,
   * matching maestro, which has no `bufferedAmount` check either. What bounds
   * things today is upstream: 16ms coalescing bounds frame RATE, the 64KB
   * force-flush bounds frame SIZE, the 1MiB ring bounds REPLAY size, and the
   * client's visibility driver suspends offscreen sockets so a backgrounded
   * fleet stops sending at all. NOT bounded: an active-but-wedged tab holding
   * many live streams. The agreed fix for both repos is the appliedOffset
   * ACK/credit-window; it must land in maestro and here together, so this is
   * left deliberately identical rather than forked early.
   */
  send(data: Buffer | string): void {
    if (this.state !== PTY_SOCKET_STATE.open) return;
    const frame =
      typeof data === 'string' ? encodeTextFrame(data) : encodeFrame(OPCODE.binary, data);
    if (this.writeBounded(frame)) this.touchIdle();
  }

  /** FrameSink.close — send a close frame, then let the socket teardown finish. */
  close(code: number = CLOSE_CODE.normal, reason = ''): void {
    if (this.state !== PTY_SOCKET_STATE.open) return;
    this.state = PTY_SOCKET_STATE.closing;
    this.stopHeartbeat();
    this.stopLifetimeTimers();
    try {
      this.socket.write(encodeCloseFrame(code, reason));
      this.socket.end();
    } catch {
      this.socket.destroy();
    }
  }

  /** Feed the bytes the HTTP parser had already buffered past the request headers. */
  ingest(chunk: Buffer): void {
    this.onData(chunk);
  }

  private onData(chunk: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      const code =
        err instanceof FrameProtocolError ? err.closeCode : CLOSE_CODE.protocolError;
      this.close(code, 'frame error');
      this.socket.destroy();
      return;
    }

    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.binary:
          if (
            frame.payload.length > this.maxInputBytes ||
            !this.consumeRate(frame.payload.length)
          ) {
            this.close(
              frame.payload.length > this.maxInputBytes
                ? CLOSE_CODE.messageTooBig
                : CLOSE_CODE.policyViolation,
              'input limit exceeded',
            );
            this.socket.destroy();
            this.finish();
            return;
          }
          this.touchIdle();
          // Keystrokes. Straight to the PTY — never parsed, never transcoded.
          this.handlers.onInput?.(frame.payload);
          break;
        case OPCODE.text:
          if (
            frame.payload.length > this.maxControlBytes ||
            !this.consumeRate(frame.payload.length)
          ) {
            this.close(
              frame.payload.length > this.maxControlBytes
                ? CLOSE_CODE.messageTooBig
                : CLOSE_CODE.policyViolation,
              'control limit exceeded',
            );
            this.socket.destroy();
            this.finish();
            return;
          }
          this.touchIdle();
          this.handlers.onControl?.(frame.payload.toString('utf8'));
          break;
        case OPCODE.ping:
          if (this.state === PTY_SOCKET_STATE.open) {
            try {
              this.socket.write(encodeFrame(OPCODE.pong, frame.payload));
            } catch {
              // ignore
            }
          }
          break;
        case OPCODE.pong:
          // Answers our own heartbeat ping (see the header note): the peer is
          // alive, so the miss counter resets before the next sweep.
          this.missedPongs = 0;
          break;
        case OPCODE.close: {
          const { code, reason } = decodeClosePayload(frame.payload);
          if (this.state === PTY_SOCKET_STATE.open) {
            // Echo the peer's close, completing the handshake, then tear down.
            this.state = PTY_SOCKET_STATE.closing;
            try {
              this.socket.write(encodeCloseFrame(code, reason));
            } catch {
              // ignore
            }
          }
          this.socket.end();
          this.finish();
          break;
        }
      }
    }
  }

  /**
   * Server-originated ping/pong reaper (see the header note). Mirrors
   * `events/ws-connection.ts`'s `startHeartbeat` exactly: a peer that misses
   * `missedPongLimit` consecutive sweeps is presumed dead — no clean close
   * frame is coming — and is force-closed rather than left as a phantom
   * subscriber until TCP eventually notices.
   */
  private startHeartbeat(): void {
    const timer = setInterval(() => {
      if (this.state !== PTY_SOCKET_STATE.open) return;
      if (this.missedPongs >= this.missedPongLimit) {
        this.close(CLOSE_CODE.goingAway, 'heartbeat timeout');
        this.socket.destroy();
        this.finish();
        return;
      }
      this.missedPongs += 1;
      try {
        this.socket.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)));
      } catch {
        // Best effort: the socket's own close/error handler detaches this sink.
      }
    }, this.heartbeatMs);
    timer.unref?.();
    this.heartbeat = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private writeBounded(frame: Buffer): boolean {
    if ((this.socket.writableLength ?? 0) + frame.length > this.maxBufferedBytes) {
      this.close(CLOSE_CODE.policyViolation, 'slow consumer');
      this.socket.destroy();
      this.finish();
      return false;
    }
    try {
      if (this.socket.write(frame) === false) {
        this.close(CLOSE_CODE.policyViolation, 'slow consumer');
        this.socket.destroy();
        this.finish();
        return false;
      }
      return true;
    } catch {
      this.socket.destroy();
      this.finish();
      return false;
    }
  }

  private consumeRate(bytes: number): boolean {
    const now = this.now();
    if (now - this.rateWindowStartedAt >= this.messageWindowMs) {
      this.rateWindowStartedAt = now;
      this.rateMessages = 0;
      this.rateBytes = 0;
    }
    this.rateMessages += 1;
    this.rateBytes += bytes;
    return this.rateMessages <= this.maxMessagesPerWindow
      && this.rateBytes <= this.maxInboundBytesPerWindow;
  }

  private startLifetimeTimers(): void {
    this.touchIdle();
    const absolute = setTimeout(() => {
      this.close(CLOSE_CODE.goingAway, 'absolute timeout');
      this.socket.destroy();
      this.finish();
    }, this.absoluteTimeoutMs);
    absolute.unref?.();
    this.absoluteTimer = absolute;
  }

  private touchIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    const timer = setTimeout(() => {
      this.close(CLOSE_CODE.goingAway, 'idle timeout');
      this.socket.destroy();
      this.finish();
    }, this.idleTimeoutMs);
    timer.unref?.();
    this.idleTimer = timer;
  }

  private stopLifetimeTimers(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.absoluteTimer !== null) clearTimeout(this.absoluteTimer);
    this.idleTimer = null;
    this.absoluteTimer = null;
  }

  /** Terminal state transition; `onClose` fires at most once. */
  private finish(): void {
    this.state = PTY_SOCKET_STATE.closed;
    this.stopHeartbeat();
    this.stopLifetimeTimers();
    if (this.closeFired) return;
    this.closeFired = true;
    this.handlers.onClose?.();
  }
}
