// Session-host wire format (design doc 01a0db5e §D4).
//
// One unix stream socket per host. Every frame, in both directions, is
//
//   u32be totalLen | u32be headerLen | header (UTF-8 JSON) | payload (raw bytes)
//
// `totalLen` counts everything after itself. The header's `t` names the frame;
// terminal and pipe bytes travel ONLY in the payload (never base64 in JSON), so
// the hot path is one JSON.parse of a ~60-byte header plus a Buffer slice.
// ONE parser for control and data alike — a frame kind that forgot to carry a
// payload is still a well-formed frame, not a second protocol.
//
// This file is imported by BOTH sides: the host process (which must load no DB,
// graph, HTTP or contract code) and the server's client. Keep it dependency-free.

export const SESSION_HOST_PROTOCOL = 1;

/** A larger frame, or one whose header does not parse, closes the connection. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export type StreamName = 'out' | 'err';

export interface ExitRecord {
  exitCode: number | null;
  signal: number | null;
  /** epoch ms the host observed the exit */
  at: number;
}

export interface StreamState {
  /** Absolute offset of the first byte the host still retains. */
  start: number;
  /** Absolute offset just past the last byte produced. */
  next: number;
  /** Highest offset the controller acknowledged (pipe `out` only; 0 otherwise). */
  acked: number;
}

/** One session as the host reports it in `hello_ok`. */
export interface HostSessionRecord {
  sid: string;
  kind: 'pty' | 'pipe';
  pid: number;
  /** Stream identity stored by the host at spawn (server-chosen for PTYs,
   *  host-minted for pipes), stable across server restarts. */
  epoch: string;
  cols?: number;
  rows?: number;
  spawnedAt: number;
  /** cgroup memory.events oom_kill counter when the session spawned, or null. */
  oomKillAtSpawn: number | null;
  out: StreamState;
  err?: StreamState;
  /** Opaque controller cursor stored by the last `ack` (pipe sessions). */
  cursor: unknown;
  /** Tag of the last tagged `write` (a chat turn id). */
  lastInputTag: string | null;
  /** Retained until `forget`: an exit that happened while nobody was connected is reported here. */
  exit: ExitRecord | null;
}

// ---------------------------------------------------------------------------
// server -> host

export type ServerFrame =
  | { t: 'hello'; token: string; serverBootId: string; protocol: number; role: 'active' | 'retired' }
  | {
      t: 'spawn_pty';
      rid: number;
      sid: string;
      /** Stream identity chosen by the server; the host stores it and reports it
       *  back in `hello_ok`, so a browser's epoch survives the server restart. */
      epoch: string;
      command: string;
      shell: string;
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    }
  | { t: 'spawn_pipe'; rid: number; sid: string; file: string; args: string[]; cwd: string; env: Record<string, string> }
  | { t: 'write'; sid: string; tag?: string }
  | { t: 'resize'; sid: string; cols: number; rows: number }
  | { t: 'signal'; rid: number; sid: string; signal: NodeJS.Signals }
  | { t: 'close_stdin'; sid: string }
  | { t: 'subscribe'; rid: number; sid: string; stream: StreamName; fromOffset: number }
  | { t: 'ack'; sid: string; stream: 'out'; offset: number; cursor?: unknown }
  | { t: 'forget'; rid: number; sid: string }
  | { t: 'ping'; rid: number };

// ---------------------------------------------------------------------------
// host -> server

export type HostFrame =
  | {
      t: 'hello_ok';
      generation: string;
      hostPid: number;
      protocol: number;
      startedAt: number;
      role: 'active' | 'retired';
      sessions: HostSessionRecord[];
    }
  | { t: 'spawned'; rid: number; sid: string; pid: number; epoch: string }
  | { t: 'data'; sid: string; stream: StreamName; off: number }
  | ({ t: 'exit'; sid: string } & ExitRecord)
  | { t: 'ok'; rid: number; base?: number; gap?: number; next?: number }
  | { t: 'err'; rid: number; code: string; message: string }
  | { t: 'superseded'; by: string };

export type AnyFrame = ServerFrame | HostFrame;

export interface DecodedFrame<F> {
  header: F;
  payload: Buffer;
}

const EMPTY = Buffer.alloc(0);

export function encodeFrame(header: AnyFrame, payload: Buffer = EMPTY): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const total = 4 + head.length + payload.length;
  if (total > MAX_FRAME_BYTES) {
    throw new RangeError(`session-host frame of ${total} bytes exceeds ${MAX_FRAME_BYTES}`);
  }
  const prefix = Buffer.allocUnsafe(8);
  prefix.writeUInt32BE(total, 0);
  prefix.writeUInt32BE(head.length, 4);
  return Buffer.concat([prefix, head, payload], 8 + head.length + payload.length);
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * Incremental decoder. `push` returns every complete frame in the chunk and
 * keeps the remainder. Throws {@link FrameError} on an oversized or malformed
 * frame; the caller closes the connection (the decoder is unusable after).
 */
export class FrameDecoder<F extends { t: string } = AnyFrame> {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  push(chunk: Buffer): Array<DecodedFrame<F>> {
    if (chunk.length > 0) {
      this.pending.push(chunk);
      this.pendingBytes += chunk.length;
    }
    const out: Array<DecodedFrame<F>> = [];
    for (;;) {
      if (this.pendingBytes < 4) return out;
      const buf = this.coalesce();
      const total = buf.readUInt32BE(0);
      if (total < 4 || total > MAX_FRAME_BYTES) {
        throw new FrameError(`invalid frame length ${total}`);
      }
      if (buf.length < 4 + total) return out;
      const headLen = buf.readUInt32BE(4);
      if (headLen > total - 4) throw new FrameError(`invalid header length ${headLen}`);
      let header: unknown;
      try {
        header = JSON.parse(buf.toString('utf8', 8, 8 + headLen));
      } catch {
        throw new FrameError('frame header is not JSON');
      }
      if (
        header === null ||
        typeof header !== 'object' ||
        typeof (header as { t?: unknown }).t !== 'string'
      ) {
        throw new FrameError('frame header has no type');
      }
      // Copy the payload out: the ring on either side retains it, and a
      // subarray would pin the whole coalesced read buffer.
      const payload = Buffer.from(buf.subarray(8 + headLen, 4 + total));
      out.push({ header: header as F, payload });
      const rest = buf.subarray(4 + total);
      this.pending = rest.length > 0 ? [rest] : [];
      this.pendingBytes = rest.length;
    }
  }

  private coalesce(): Buffer {
    if (this.pending.length === 1) return this.pending[0]!;
    const joined = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [joined];
    return joined;
  }
}
