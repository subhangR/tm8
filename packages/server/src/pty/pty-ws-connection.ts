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
 * NO permessage-deflate and NO heartbeat dependence: maestro's PTY socket
 * negotiates neither (the `ws` server defaults compression off, and reconnect is
 * driven by onclose + offset resume rather than by pings), so matching it means
 * implementing neither. Inbound pings are still answered — that costs nothing and
 * keeps well-behaved intermediaries happy — but nothing here DEPENDS on them.
 */
import { randomUUID } from 'node:crypto';

import type { WsSocket } from '../events/ws-connection.js';
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

export class PtyWsConnection {
  readonly id = randomUUID();

  private readonly socket: WsSocket;
  private readonly decoder = new FrameDecoder();
  private readonly handlers: PtyWsConnectionHandlers;

  private state: number = PTY_SOCKET_STATE.open;
  private closeFired = false;

  constructor(socket: WsSocket, handlers: PtyWsConnectionHandlers = {}) {
    this.socket = socket;
    this.handlers = handlers;

    // PTY output is latency-sensitive and already coalesced into 16ms frames by
    // PtyHostService, so Nagle would only add delay to frames that are
    // deliberately batched upstream.
    socket.setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', () => this.finish());
    socket.on('close', () => this.finish());
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
    try {
      this.socket.write(frame);
    } catch {
      // Best effort: the socket's own close handler detaches this sink.
    }
  }

  /** FrameSink.close — send a close frame, then let the socket teardown finish. */
  close(code: number = CLOSE_CODE.normal, reason = ''): void {
    if (this.state !== PTY_SOCKET_STATE.open) return;
    this.state = PTY_SOCKET_STATE.closing;
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
          // Keystrokes. Straight to the PTY — never parsed, never transcoded.
          this.handlers.onInput?.(frame.payload);
          break;
        case OPCODE.text:
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
          // Nothing depends on pongs here (see the header note on heartbeats).
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

  /** Terminal state transition; `onClose` fires at most once. */
  private finish(): void {
    this.state = PTY_SOCKET_STATE.closed;
    if (this.closeFired) return;
    this.closeFired = true;
    this.handlers.onClose?.();
  }
}
