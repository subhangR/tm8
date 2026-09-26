// Process proxies over a session-host connection.
//
// RemotePty   — the IPty subset PtyHostService drives (write/resize/kill,
//               onData/onExit, pid). Everything else about a PTY session — its
//               ring, mirror, subscribers, activity and prompt queue — stays in
//               PtyHostService exactly as for an in-process PTY.
// RemoteChild — the ChildProcess subset ClaudeHeadlessAdapter drives (stdio
//               streams, kill, spawn/error/close events), plus the byte offset
//               and ack/tag calls the chat cursor needs.
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ExitRecord, HostSessionRecord, StreamName } from './frames.js';
import type { SessionBinding, SessionHostConnection } from './client.js';

/** The process surface PtyHostService needs; node-pty's IPty satisfies it. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string | Buffer) => void): unknown;
  onExit(listener: (event: { exitCode: number | null; signal?: number | null }) => void): unknown;
  /**
   * Present on host-backed processes: drop the host's retained exit record.
   * Called only after the exit's status write committed, so an exit whose write
   * failed is reported again by the next hello (D6).
   */
  release?(): void;
  /** Host-backed only: begin streaming (adopt subscribes from its own offset). */
  start?(): void;
  /**
   * Host-backed only: stop listening WITHOUT touching the process or its host
   * record — the server is shutting down and the next one adopts it (D6).
   */
  detach?(): void;
  /** True when the process lives in a session host (survives a server restart). */
  readonly remote?: boolean;
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

function toBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
}

export interface RemotePtySpawn {
  sid: string;
  epoch: string;
  command: string;
  shell: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export class RemotePty implements PtyProcess {
  readonly remote = true;
  pid = 0;
  private next: number;
  private exited = false;
  private readonly dataListeners = new Set<(data: Buffer) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number | null; signal?: number | null }) => void>();

  private constructor(
    private readonly conn: SessionHostConnection,
    readonly sid: string,
    startOffset: number,
    private readonly adoptFrom: number | null,
  ) {
    this.next = startOffset;
    conn.bind(sid, {
      onData: (stream, off, payload) => this.onFrameData(stream, off, payload),
      onExit: (exit) => this.exitOrDefer(exit),
      onReconnected: (record) => this.onReconnected(record),
      onHostLost: () => this.fireExit({ exitCode: null, signal: null }),
    });
  }

  /** Spawn a new PTY in the host. Synchronous like node-pty; pid arrives with `spawned`. */
  static spawn(conn: SessionHostConnection, params: RemotePtySpawn): RemotePty {
    const proc = new RemotePty(conn, params.sid, 0, null);
    conn
      .request({
        t: 'spawn_pty',
        sid: params.sid,
        epoch: params.epoch,
        command: params.command,
        shell: params.shell,
        cwd: params.cwd,
        env: params.env,
        cols: params.cols,
        rows: params.rows,
      })
      .then((reply) => {
        if (reply.t === 'spawned') proc.pid = reply.pid;
      })
      .catch((error: Error) => {
        conn.logger.error('session host refused a PTY spawn', error, { sessionId: params.sid });
        proc.fireExit({ exitCode: 127, signal: null });
      });
    return proc;
  }

  /**
   * Adopt a PTY the host kept alive. The server's ring must already be
   * re-based at `record.out.start` (OutputBuffer.startAt); {@link start}
   * subscribes from there, so the retained scrollback replays into the ring and
   * mirror before live bytes follow.
   */
  static adopt(conn: SessionHostConnection, record: HostSessionRecord): RemotePty {
    const proc = new RemotePty(conn, record.sid, record.out.start, record.out.start);
    proc.pid = record.pid;
    // An exit the host reported before hello (in the record) or between hello
    // and this bind (unbound) is fired once the retained tail has replayed.
    proc.adoptExit = record.exit ?? conn.takeUnboundExit(record.sid);
    return proc;
  }

  private adoptExit: ExitRecord | null = null;
  private subscribing = 0;
  private deferredExit: ExitRecord | { exitCode: number | null; signal: number | null } | null = null;

  start(): void {
    if (this.adoptFrom === null) return; // a spawn is subscribed by the host from byte 0
    this.subscribeFrom(this.next, this.adoptExit);
  }

  /** An exit frame that lands while a subscribe is replaying waits for the tail. */
  private exitOrDefer(exit: { exitCode: number | null; signal: number | null }): void {
    if (this.subscribing > 0) this.deferredExit ??= exit;
    else this.fireExit(exit);
  }

  private subscribeFrom(offset: number, exitAfter: ExitRecord | null): void {
    this.subscribing++;
    const settle = (): void => {
      this.subscribing--;
      if (exitAfter) this.deferredExit ??= exitAfter;
      if (this.subscribing === 0 && this.deferredExit) this.fireExit(this.deferredExit);
    };
    this.conn
      .request({ t: 'subscribe', sid: this.sid, stream: 'out', fromOffset: offset })
      .then(settle, (error: Error) => {
        this.conn.logger.warn('session host subscribe failed', { sessionId: this.sid, error: error.message });
        settle();
      });
  }

  write(data: string | Buffer): void {
    if (this.exited) return;
    this.conn.send({ t: 'write', sid: this.sid }, toBuffer(data));
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.conn.send({ t: 'resize', sid: this.sid, cols, rows });
  }

  /** node-pty's default is SIGHUP; so is this. A late ESRCH is the benign race kill() already treats as success. */
  kill(signal = 'SIGHUP'): void {
    if (this.exited) return;
    this.conn.request({ t: 'signal', sid: this.sid, signal: signal as NodeJS.Signals }).catch((error: Error) => {
      if ((error as { code?: string }).code === 'ESRCH') return;
      this.conn.logger.warn('session host signal failed', { sessionId: this.sid, signal, error: error.message });
    });
  }

  onData(listener: (data: string | Buffer) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number | null; signal?: number | null }) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  release(): void {
    this.conn.unbind(this.sid);
    this.conn.request({ t: 'forget', sid: this.sid }).catch((error: Error) => {
      this.conn.logger.warn('session host forget failed', { sessionId: this.sid, error: error.message });
    });
  }

  detach(): void {
    this.exited = true; // no exit will be reported by THIS server
    this.conn.unbind(this.sid);
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  // ------------------------------------------------------------- host frames

  private onFrameData(stream: StreamName, off: number, payload: Buffer): void {
    if (stream !== 'out' || this.exited) return;
    let chunk = payload;
    if (off < this.next) {
      // Overlap after a resubscribe: drop what the ring already holds.
      const skip = this.next - off;
      if (skip >= chunk.length) return;
      chunk = chunk.subarray(skip);
    } else if (off > this.next) {
      // The host evicted bytes we never saw (only possible across a long
      // reconnect). The ring cannot hold a hole; say so and carry on.
      this.conn.logger.warn('session host output gap', { sessionId: this.sid, missing: off - this.next });
    }
    this.next = Math.max(this.next, off) + chunk.length;
    for (const listener of this.dataListeners) listener(chunk);
  }

  private onReconnected(record: HostSessionRecord | null): void {
    if (this.exited) return;
    if (!record) {
      this.fireExit({ exitCode: null, signal: null });
      return;
    }
    if (record.pid) this.pid = record.pid;
    // R7: from OUR offset, never a re-adopt; a retained exit fires after the tail.
    this.subscribeFrom(this.next, record.exit);
  }

  private fireExit(event: { exitCode: number | null; signal: number | null }): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener({ exitCode: event.exitCode, signal: event.signal ?? 0 });
  }
}

// ---------------------------------------------------------------------------

export interface RemoteChildSpawn {
  sid: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/**
 * The ChildProcess subset ClaudeHeadlessAdapter drives. Events: 'spawn',
 * 'error', 'exit' (code, signal), 'close' (code, signal) — 'close' only after
 * stdout and stderr have ended, like a real child.
 */
export class RemoteChild extends EventEmitter {
  readonly remote = true;
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** Absolute offset of the first stdout byte this object emits. */
  readonly stdoutBase: number;
  private outNext: number;
  private errNext: number;
  private exited = false;
  private pendingTag: string | null = null;
  readonly binding: SessionBinding;

  private constructor(
    private readonly conn: SessionHostConnection,
    readonly sid: string,
    outFrom: number,
    errFrom: number,
  ) {
    super();
    this.stdoutBase = outFrom;
    this.outNext = outFrom;
    this.errNext = errFrom;
    const self = this;
    this.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (self.exited) {
          callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
          return;
        }
        const tag = self.pendingTag;
        self.pendingTag = null;
        self.conn.send({ t: 'write', sid: self.sid, ...(tag ? { tag } : {}) }, chunk);
        callback();
      },
      final(callback) {
        self.conn.send({ t: 'close_stdin', sid: self.sid });
        callback();
      },
    });
    this.binding = {
      onData: (stream, off, payload) => this.onFrameData(stream, off, payload),
      onExit: (exit) => {
        if (this.subscribing > 0) this.deferredExit ??= exit;
        else this.finish(exit);
      },
      onReconnected: (record) => {
        if (this.exited) return;
        if (!record) {
          this.finish({ exitCode: null, signal: null, at: Date.now() });
          return;
        }
        this.subscribe('out', this.outNext);
        this.subscribe('err', this.errNext, record.exit);
      },
      onHostLost: () => this.finish({ exitCode: null, signal: null, at: Date.now() }),
    };
    conn.bind(sid, this.binding);
  }

  static spawn(conn: SessionHostConnection, params: RemoteChildSpawn): RemoteChild {
    const child = new RemoteChild(conn, params.sid, 0, 0);
    conn
      .request({ t: 'spawn_pipe', sid: params.sid, file: params.file, args: params.args, cwd: params.cwd, env: params.env })
      .then((reply) => {
        if (reply.t === 'spawned') child.pid = reply.pid;
        child.emit('spawn');
      })
      .catch((error: Error) => {
        child.exited = true;
        child.emit('error', error);
        child.stdout.end();
        child.stderr.end();
      });
    return child;
  }

  /**
   * Adopt a pipe session. stdout replays from `fromOffset` (the chat cursor's
   * turn start, or the acked offset); stderr from what the host retains.
   * Call {@link start} after wiring listeners.
   */
  static adopt(conn: SessionHostConnection, record: HostSessionRecord, fromOffset: number): RemoteChild {
    const outFrom = Math.max(fromOffset, record.out.start);
    const child = new RemoteChild(conn, record.sid, outFrom, record.err?.next ?? 0);
    child.pid = record.pid;
    child.adoptExit = record.exit ?? conn.takeUnboundExit(record.sid);
    return child;
  }

  private adoptExit: ExitRecord | null = null;

  start(): void {
    this.subscribe('out', this.outNext);
    this.subscribe('err', this.errNext, this.adoptExit);
  }

  private subscribing = 0;
  private deferredExit: ExitRecord | null = null;

  /** Exits (retained or live) wait until every in-flight replay has landed. */
  private subscribe(stream: StreamName, fromOffset: number, exitAfter: ExitRecord | null = null): void {
    this.subscribing++;
    const settle = (): void => {
      this.subscribing--;
      if (exitAfter) this.deferredExit ??= exitAfter;
      if (this.subscribing === 0 && this.deferredExit) this.finish(this.deferredExit);
    };
    this.conn.request({ t: 'subscribe', sid: this.sid, stream, fromOffset }).then(settle, (error: Error) => {
      this.conn.logger.warn('session host subscribe failed', { sessionId: this.sid, stream, error: error.message });
      settle();
    });
  }

  private onFrameData(stream: StreamName, off: number, payload: Buffer): void {
    if (this.exited) return;
    const next = stream === 'out' ? this.outNext : this.errNext;
    let chunk = payload;
    if (off < next) {
      const skip = next - off;
      if (skip >= chunk.length) return;
      chunk = chunk.subarray(skip);
    } else if (off > next && stream === 'out') {
      this.conn.logger.error('session host dropped chat output the server never read', undefined, {
        sessionId: this.sid,
        missing: off - next,
      });
    }
    const end = Math.max(next, off) + chunk.length;
    if (stream === 'out') {
      this.outNext = end;
      this.stdout.write(chunk);
    } else {
      this.errNext = end;
      this.stderr.write(chunk);
    }
  }

  /** Tag the next stdin write (the chat turn id), so a restart can tell which input the child last got. */
  tagNextWrite(tag: string): void {
    this.pendingTag = tag;
  }

  /** Commit point: the host may drop stdout below `offset` and stores `cursor` for the next server. */
  ack(offset: number, cursor: unknown): void {
    this.conn.send({ t: 'ack', sid: this.sid, stream: 'out', offset, cursor });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exited) return false;
    this.conn.request({ t: 'signal', sid: this.sid, signal }).catch((error: Error) => {
      if ((error as { code?: string }).code === 'ESRCH') return;
      this.conn.logger.warn('session host signal failed', { sessionId: this.sid, signal, error: error.message });
    });
    return true;
  }

  /** Drop the host's exit record once the server has recorded the exit. */
  release(): void {
    this.conn.unbind(this.sid);
    this.conn.request({ t: 'forget', sid: this.sid }).catch(() => undefined);
  }

  /** Stop listening without touching the process (server shutting down). */
  detach(): void {
    this.conn.unbind(this.sid);
  }

  private finish(exit: ExitRecord): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = exit.signal ? null : exit.exitCode;
    const signalName = exit.signal
      ? ((Object.entries(SIGNAL_NUMBERS).find(([, n]) => n === exit.signal)?.[0] ?? 'SIGKILL') as NodeJS.Signals)
      : null;
    this.signalCode = signalName;
    this.emit('exit', this.exitCode, signalName);
    let pending = 2;
    const done = (): void => {
      if (--pending > 0) return;
      clearTimeout(fallback);
      this.emit('close', this.exitCode, signalName);
    };
    const fallback = setTimeout(() => {
      pending = 1;
      done();
    }, 1_000);
    this.stdout.once('end', done);
    this.stderr.once('end', done);
    this.stdout.end();
    this.stderr.end();
    // A stream nobody reads never emits 'end'; resume() drains it to nowhere.
    if (this.stdout.listenerCount('data') === 0 && !this.stdout.readableFlowing) this.stdout.resume();
    if (this.stderr.listenerCount('data') === 0 && !this.stderr.readableFlowing) this.stderr.resume();
  }
}
