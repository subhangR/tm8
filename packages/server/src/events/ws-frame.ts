/**
 * RFC 6455 frame codec — the minimum needed for a real browser `WebSocket` to
 * talk to this node.
 *
 * WHY hand-rolled instead of the `ws` package: this package is deliberately
 * dependency-light (`@tm8/contract` is its only runtime dependency) and the
 * skeleton must not move `bun.lock`. The whole socket surface is kept behind
 * `EventSink` in ws-connection.ts, so adopting `ws` later is a one-file change
 * — this codec and `WsConnection` are the only things that would be deleted.
 *
 * Scope is honest: text + binary + close + ping + pong + continuation
 * reassembly. NOT implemented, and called out where it matters: permessage
 * deflate (no extension is ever negotiated), and UTF-8 well-formedness
 * validation of text payloads (RFC 6455 §8.1 would close 1007; we hand the
 * bytes to `toString('utf8')` and let it substitute).
 */

/** Frame opcodes. 0x3–0x7 and 0xB–0xF are reserved and rejected. */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/**
 * Hard cap on a single message. Oversized frames are refused from the LENGTH
 * HEADER — we never accumulate the bytes — so a hostile client cannot make the
 * node allocate by lying about a 2^63 payload.
 */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** RFC 6455 §7.4.1 close codes we actually emit. */
export const CLOSE_CODE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  policyViolation: 1008,
  messageTooBig: 1009,
  internalError: 1011,
} as const;

/**
 * A decode failure that must terminate the connection. `closeCode` is the
 * RFC 6455 code the peer should be told before the socket is destroyed.
 */
export class FrameProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode: number = CLOSE_CODE.protocolError) {
    super(message);
    this.name = 'FrameProtocolError';
    this.closeCode = closeCode;
  }
}

/** A fully reassembled message, or a control frame. Never `continuation`. */
export interface DecodedFrame {
  opcode: Exclude<Opcode, typeof OPCODE.continuation>;
  payload: Buffer;
}

function isKnownOpcode(op: number): op is Opcode {
  return op === 0x0 || op === 0x1 || op === 0x2 || op === 0x8 || op === 0x9 || op === 0xa;
}

type ControlOpcode = typeof OPCODE.close | typeof OPCODE.ping | typeof OPCODE.pong;

/** Type predicate, not a boolean helper — the decoder narrows on it. */
function isControl(op: Opcode): op is ControlOpcode {
  return op === OPCODE.close || op === OPCODE.ping || op === OPCODE.pong;
}

/**
 * Encode a server→client frame. Server frames are UNMASKED (RFC 6455 §5.1) —
 * a masked server frame is a protocol error the browser will close on.
 */
export function encodeFrame(opcode: Opcode, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(len, 1);
  } else if (len < 0x1_0000) {
    header = Buffer.allocUnsafe(4);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(126, 1);
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload], header.length + len);
}

/** Convenience: a single unfragmented text frame. */
export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'));
}

/**
 * Convenience: a close frame. Control payloads are capped at 125 bytes
 * (RFC 6455 §5.5), so the reason is truncated rather than rejected.
 */
export function encodeCloseFrame(code: number = CLOSE_CODE.normal, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame(OPCODE.close, payload);
}

/** Read the `{code, reason}` out of a close frame payload. */
export function decodeClosePayload(payload: Buffer): { code: number; reason: string } {
  if (payload.length < 2) return { code: CLOSE_CODE.normal, reason: '' };
  return { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString('utf8') };
}

/**
 * Streaming decoder. Socket `data` events have NO relationship to frame
 * boundaries: one chunk may carry half a frame, three frames, or a frame
 * header split across two TCP segments. So this is written as
 * accumulate-then-parse-loop and never assumes a chunk is a frame — the naive
 * per-chunk implementation is the classic bug here.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /** Opcode of the message currently being reassembled, if any. */
  private fragmentOpcode: typeof OPCODE.text | typeof OPCODE.binary | null = null;
  private fragments: Buffer[] = [];
  private fragmentLength = 0;

  /**
   * Feed bytes; returns every complete message/control frame now available.
   * Throws `FrameProtocolError` on a malformed or oversized stream — the
   * caller is expected to close the connection with `err.closeCode`.
   */
  push(chunk: Buffer): DecodedFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    const out: DecodedFrame[] = [];
    for (;;) {
      const frame = this.parseOne();
      if (frame === null) break;
      if (frame !== undefined) out.push(frame);
    }
    return out;
  }

  /**
   * Parse a single frame off the front of the buffer.
   * `null` = need more bytes; `undefined` = frame consumed but not a complete
   * message yet (a non-final fragment).
   */
  private parseOne(): DecodedFrame | null | undefined {
    const buf = this.buf;
    if (buf.length < 2) return null;

    const b0 = buf.readUInt8(0);
    const b1 = buf.readUInt8(1);

    const fin = (b0 & 0x80) !== 0;
    // RSV1-3 must be zero: we never negotiate an extension, so a set bit means
    // the peer assumed permessage-deflate and everything after is garbage.
    if ((b0 & 0x70) !== 0) throw new FrameProtocolError('RSV bits set but no extension negotiated');

    const rawOpcode = b0 & 0x0f;
    if (!isKnownOpcode(rawOpcode)) throw new FrameProtocolError(`reserved opcode 0x${rawOpcode.toString(16)}`);
    const opcode: Opcode = rawOpcode;

    const masked = (b1 & 0x80) !== 0;
    const len7 = b1 & 0x7f;

    let offset = 2;
    let length: number;

    if (len7 < 126) {
      length = len7;
    } else if (len7 === 126) {
      if (buf.length < 4) return null;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else {
      if (buf.length < 10) return null;
      const big = buf.readBigUInt64BE(2);
      // Refuse from the header. Do not wait for, or allocate, the bytes.
      if (big > BigInt(MAX_PAYLOAD_BYTES)) {
        throw new FrameProtocolError(`frame payload ${big} exceeds ${MAX_PAYLOAD_BYTES}`, CLOSE_CODE.messageTooBig);
      }
      length = Number(big);
      offset = 10;
    }

    if (length > MAX_PAYLOAD_BYTES) {
      throw new FrameProtocolError(`frame payload ${length} exceeds ${MAX_PAYLOAD_BYTES}`, CLOSE_CODE.messageTooBig);
    }

    if (isControl(opcode)) {
      // RFC 6455 §5.5: control frames are never fragmented and never > 125B.
      if (!fin) throw new FrameProtocolError('fragmented control frame');
      if (length > 125) throw new FrameProtocolError('control frame payload > 125 bytes');
    }

    // RFC 6455 §5.1: every client→server frame MUST be masked. An unmasked one
    // is either a broken client or a proxy rewriting our stream; both are fatal.
    if (!masked) throw new FrameProtocolError('client frame is not masked');
    if (buf.length < offset + 4) return null;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;

    const end = offset + length;
    if (buf.length < end) return null;

    const payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) {
      // readUInt8 rather than `[i]` — `noUncheckedIndexedAccess` makes indexed
      // Buffer reads `number | undefined`, and `!` here would be a lie we'd
      // rather not tell in a byte loop.
      payload.writeUInt8(buf.readUInt8(offset + i) ^ maskKey.readUInt8(i % 4), i);
    }

    this.buf = buf.subarray(end);

    if (isControl(opcode)) {
      // Control frames may be interleaved into a fragmented message; they are
      // delivered immediately and do not disturb the reassembly state.
      return { opcode, payload };
    }

    if (opcode === OPCODE.continuation) {
      if (this.fragmentOpcode === null) throw new FrameProtocolError('continuation frame with no message in progress');
      this.appendFragment(payload);
      if (!fin) return undefined;
      const complete = { opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments, this.fragmentLength) };
      this.resetFragments();
      return complete;
    }

    // opcode is text or binary here.
    if (this.fragmentOpcode !== null) throw new FrameProtocolError('new data frame while a message is still fragmented');
    if (fin) return { opcode, payload };

    this.fragmentOpcode = opcode;
    this.appendFragment(payload);
    return undefined;
  }

  private appendFragment(payload: Buffer): void {
    if (this.fragmentLength + payload.length > MAX_PAYLOAD_BYTES) {
      this.resetFragments();
      throw new FrameProtocolError(`reassembled message exceeds ${MAX_PAYLOAD_BYTES}`, CLOSE_CODE.messageTooBig);
    }
    this.fragments.push(payload);
    this.fragmentLength += payload.length;
  }

  private resetFragments(): void {
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentLength = 0;
  }
}
