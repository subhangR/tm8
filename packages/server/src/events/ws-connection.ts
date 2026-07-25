/**
 * One live WebSocket connection.
 *
 * `EventSink` is the seam the rest of the directory binds to — the
 * subscription registry and the publisher only ever see `EventSink`, never a
 * socket. Swapping this hand-rolled transport for the `ws` package later means
 * writing one new `EventSink` implementation and deleting this file plus
 * ws-frame.ts; nothing else in events/ moves. That is the whole reason the
 * interface exists.
 *
 * What is REAL here: framing, ping/pong, close handshake, heartbeat eviction.
 * What is NOT: backpressure policy (we write straight through and ignore the
 * `write()` false return — a slow-consumer policy is a W2 decision, not a
 * skeleton invention), and any client→server control protocol (see ws-server).
 */
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';

import type { RequestIdentity } from '../http/types.js';
import type { DecodedFrame } from './ws-frame.js';
import {
  CLOSE_CODE,
  FrameDecoder,
  FrameProtocolError,
  OPCODE,
  decodeClosePayload,
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
} from './ws-frame.js';

/**
 * The upgraded socket. Node types the `upgrade` event's socket as `Duplex`;
 * in practice it is a `net.Socket`, so `setNoDelay` is probed rather than
 * assumed.
 */
export type WsSocket = Duplex & { setNoDelay?: (noDelay?: boolean) => unknown };

/** Anything the event stream can push a JSON text frame at. */
export interface EventSink {
  readonly id: string;
  readonly identity: RequestIdentity;
  readonly isOpen: boolean;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export interface WsConnectionOptions {
  /**
   * Ping period. Injectable so tests do not sit for 30 seconds; the timer is
   * `unref()`ed so a live connection never keeps the process alive.
   */
  heartbeatMs?: number;
  /** Missed heartbeats tolerated before eviction. */
  missedPongLimit?: number;
}

export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_MISSED_PONG_LIMIT = 2;

export class WsConnection implements EventSink {
  readonly id = randomUUID();
  readonly identity: RequestIdentity;

  private readonly socket: WsSocket;
  private readonly decoder = new FrameDecoder();
  private readonly messageHandlers: ((text: string) => void)[] = [];
  private readonly closeHandlers: ((code: number, reason: string) => void)[] = [];

  private readonly heartbeatMs: number;
  private readonly missedPongLimit: number;
  private heartbeat: NodeJS.Timeout | null = null;
  private missedPongs = 0;

  /** `open` → `closing` (close frame sent) → `closed` (socket gone). */
  private state: 'open' | 'closing' | 'closed' = 'open';
  // Annotated `number`, not inferred: CLOSE_CODE is `as const`, so inference
  // would pin this to the literal 1000 and reject every other close code.
  private closeCode: number = CLOSE_CODE.normal;
  private closeReason = '';

  constructor(socket: WsSocket, identity: RequestIdentity, opts: WsConnectionOptions = {}) {
    this.socket = socket;
    this.identity = identity;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.missedPongLimit = opts.missedPongLimit ?? DEFAULT_MISSED_PONG_LIMIT;

    socket.setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.finish(CLOSE_CODE.internalError, 'socket error'));
    socket.on('close', () => this.finish(this.closeCode, this.closeReason));

    this.startHeartbeat();
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  send(text: string): void {
    if (this.state !== 'open') return;
    this.socket.write(encodeTextFrame(text));
  }

  /** Begin the closing handshake: send a close frame, then end the socket. */
  close(code: number = CLOSE_CODE.normal, reason = ''): void {
    if (this.state !== 'open') return;
    this.state = 'closing';
    this.closeCode = code;
    this.closeReason = reason;
    this.stopHeartbeat();
    this.socket.write(encodeCloseFrame(code, reason));
    this.socket.end();
  }

  /** Bytes may have arrived in the upgrade `head` before any `data` event. */
  ingest(chunk: Buffer): void {
    this.onData(chunk);
  }

  onMessage(cb: (text: string) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  private onData(chunk: Buffer): void {
    if (this.state === 'closed') return;

    let frames: DecodedFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      // A framing error is unrecoverable — the stream position is lost, so
      // there is nothing to resynchronise to.
      const code = err instanceof FrameProtocolError ? err.closeCode : CLOSE_CODE.protocolError;
      const message = err instanceof Error ? err.message : 'frame decode failed';
      this.close(code, message);
      this.destroy();
      return;
    }

    for (const frame of frames) {
      switch (frame.opcode) {
        case OPCODE.text: {
          const text = frame.payload.toString('utf8');
          for (const cb of this.messageHandlers) cb(text);
          break;
        }
        case OPCODE.binary:
          // The event stream is JSON text only. Binary is refused loudly
          // rather than silently dropped, so a mis-wired client is obvious.
          this.close(CLOSE_CODE.policyViolation, 'binary frames are not accepted');
          return;
        case OPCODE.ping:
          if (this.state === 'open') this.socket.write(encodeFrame(OPCODE.pong, frame.payload));
          break;
        case OPCODE.pong:
          this.missedPongs = 0;
          break;
        case OPCODE.close: {
          const { code, reason } = decodeClosePayload(frame.payload);
          // Echo the peer's close frame, then drop the socket. We do not wait
          // for their TCP FIN — a peer that half-closes should not pin a slot.
          if (this.state === 'open') {
            this.state = 'closing';
            this.closeCode = code;
            this.closeReason = reason;
            this.stopHeartbeat();
            this.socket.write(encodeCloseFrame(code, reason));
          }
          this.destroy();
          return;
        }
      }
    }
  }

  private startHeartbeat(): void {
    const timer = setInterval(() => {
      if (this.state !== 'open') return;
      if (this.missedPongs >= this.missedPongLimit) {
        this.close(CLOSE_CODE.goingAway, 'heartbeat timeout');
        this.destroy();
        return;
      }
      this.missedPongs += 1;
      this.socket.write(encodeFrame(OPCODE.ping, Buffer.alloc(0)));
    }, this.heartbeatMs);
    timer.unref();
    this.heartbeat = timer;
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private destroy(): void {
    this.stopHeartbeat();
    this.socket.destroy();
    this.finish(this.closeCode, this.closeReason);
  }

  /** Idempotent terminal transition — 'close' and 'error' can both fire. */
  private finish(code: number, reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.stopHeartbeat();
    for (const cb of this.closeHandlers) cb(code, reason);
  }
}
