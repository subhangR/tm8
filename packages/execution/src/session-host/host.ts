// tm8-session-host — the process that owns agent PTYs and chat pipes so they
// outlive a restart of the API server (design doc 01a0db5e §D1-D5, D8).
//
// Spawned BY the server: detached (own session, so no terminal SIGHUP), stdio
// to a log file, the 32-byte controller token on fd 3. Under the operator's
// `KillMode=process` drop-in, `systemctl restart tm8-prod` signals only the
// server's MainPID; this process and its agents stay in the cgroup and the next
// server reconnects over the unix socket and adopts every session.
//
// IMPORTS: node-pty, net, fs, crypto, and the dependency-free frame codec and
// ring. NO database, graph, HTTP or contract code — this process is the new
// single point of failure for every agent on the node, so it stays small enough
// to test frame by frame.
//
// argv: node session-host.js --socket <path> --info <path> --generation <gen>
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { OutputBuffer } from '../pty/OutputBuffer.js';
import { readOomKillCount } from '../spawn/oom-witness.js';
import { readStartTime } from './proc.js';
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  SESSION_HOST_PROTOCOL,
  type ExitRecord,
  type HostFrame,
  type HostSessionRecord,
  type ServerFrame,
  type StreamName,
} from './frames.js';

/** PTY scrollback, same cap the in-process host has always used. */
export const PTY_RING_BYTES = 1024 * 1024;
/** Chat stdout: ack-driven retention, capped (a turn must fit). */
export const PIPE_OUT_CAP_BYTES = 16 * 1024 * 1024;
export const PIPE_ERR_RING_BYTES = 64 * 1024;
/** Largest data payload per frame; a bigger replay is split. */
const DATA_FRAME_BYTES = 1024 * 1024;
/** R5: exit on our own when holding nothing and nobody has said hello. */
export const IDLE_EXIT_MS = 60_000;
/** First frame must be `hello` within this window or the connection is dropped. */
const HELLO_TIMEOUT_MS = 5_000;
const BAD_HELLO_LIMIT = 5;
const BAD_HELLO_WINDOW_MS = 10_000;
const BAD_HELLO_LOCKOUT_MS = 10_000;
const CURSOR_MAX_BYTES = 8 * 1024;
const RESTORE_KEY = 'TM8_EXEC_CLEAN_NODE_OPTIONS';

const EXEC_CLEAN = join(dirname(fileURLToPath(import.meta.url)), 'exec-clean.js');

interface Session {
  readonly sid: string;
  readonly kind: 'pty' | 'pipe';
  readonly pid: number;
  readonly epoch: string;
  readonly spawnedAt: number;
  readonly oomKillAtSpawn: number | null;
  readonly out: OutputBuffer;
  readonly err: OutputBuffer | null;
  readonly term: IPty | null;
  readonly child: ChildProcessWithoutNullStreams | null;
  cols: number;
  rows: number;
  acked: number;
  cursor: unknown;
  lastInputTag: string | null;
  exit: ExitRecord | null;
  /** Streams the current controller subscribed to; cleared when it leaves. */
  readonly live: Set<StreamName>;
}

/** Env handed to the exec-clean shim: NODE_OPTIONS parked where node won't read it. */
export function wrapEnvForExecClean(env: Record<string, string>): Record<string, string> {
  const wrapped = { ...env };
  delete wrapped[RESTORE_KEY];
  if (wrapped['NODE_OPTIONS'] !== undefined) {
    wrapped[RESTORE_KEY] = wrapped['NODE_OPTIONS'];
    delete wrapped['NODE_OPTIONS'];
  }
  return wrapped;
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function log(message: string, meta?: Record<string, unknown>): void {
  process.stderr.write(`${new Date().toISOString()} session-host ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`);
}

export interface SessionHostOptions {
  socketPath: string;
  infoPath: string;
  generation: string;
  token: string;
  idleExitMs?: number;
  /** Test seam; production exits the process. */
  exit?: (code: number) => void;
}

export class SessionHost {
  private readonly sessions = new Map<string, Session>();
  private readonly nonce = randomUUID();
  private counter = 0;
  private readonly tokenDigest: Buffer;
  private controller: Socket | null = null;
  private controllerBootId = '';
  private retired = false;
  private everHello = false;
  private server: Server | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private socketIno = -1;
  private badHellos: number[] = [];
  private lockedUntil = 0;
  private readonly startedAt = Date.now();
  private readonly idleExitMs: number;
  private readonly exit: (code: number) => void;

  constructor(private readonly options: SessionHostOptions) {
    this.tokenDigest = digest(options.token);
    this.idleExitMs = options.idleExitMs ?? IDLE_EXIT_MS;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  async listen(): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    // 0600 socket inside the 0700 dir the server created (D5).
    const previous = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.socketPath, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(previous);
    }
    this.socketIno = statSync(this.options.socketPath).ino;
    const info = {
      pid: process.pid,
      generation: this.options.generation,
      startedAt: this.startedAt,
      starttime: readStartTime(process.pid),
      socket: this.options.socketPath,
    };
    const tmp = `${this.options.infoPath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
    renameSync(tmp, this.options.infoPath);
    this.armIdleCheck();
    log('listening', { generation: this.options.generation, socket: this.options.socketPath });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Exit when there is nothing to hold and nobody to hold it for:
   *   - no live session and no retained exit record, AND
   *   - either no valid hello has ever arrived (R5: a host whose server died
   *     before hello, or whose DB row was never written), or this host is
   *     retired (an older generation), or no controller is connected.
   * Checked after every state change and on a timer.
   */
  private armIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.sessions.size > 0) return;
    const retiredAndEmpty = this.retired && this.everHello;
    const delay = retiredAndEmpty ? 0 : this.idleExitMs;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.sessions.size > 0) return;
      if (!this.retired && this.controller !== null) {
        // The active generation with a controller stays up while it is wanted.
        this.armIdleCheck();
        return;
      }
      this.shutdown('idle and empty');
    }, delay);
    this.idleTimer.unref?.();
  }

  private shutdown(reason: string): void {
    log('exiting', { reason });
    this.server?.close();
    // Only our own files: an orphaned host exits AFTER the server that hung it
    // up has started a same-generation successor at the same paths.
    try {
      if (statSync(this.options.socketPath).ino === this.socketIno) unlinkSync(this.options.socketPath);
    } catch {
      /* already gone */
    }
    try {
      const info = JSON.parse(readFileSync(this.options.infoPath, 'utf8')) as { pid?: unknown };
      if (info.pid === process.pid) unlinkSync(this.options.infoPath);
    } catch {
      /* already gone */
    }
    this.exit(0);
  }

  /** R6: orphaned — hang up every live session, exit once they are gone. */
  hangup(): void {
    log('SIGHUP: orphaned host hanging up its sessions', { live: [...this.sessions.values()].filter((s) => !s.exit).length });
    this.retired = true;
    for (const s of this.sessions.values()) {
      if (s.exit) continue;
      try {
        if (s.term) s.term.kill('SIGHUP');
        else s.child!.kill('SIGHUP');
      } catch {
        /* already gone */
      }
    }
    const check = setInterval(() => {
      if ([...this.sessions.values()].every((s) => s.exit !== null)) {
        clearInterval(check);
        this.shutdown('orphaned; every session hung up');
      }
    }, 100);
  }

  // --------------------------------------------------------------- connection

  private accept(socket: Socket): void {
    if (Date.now() < this.lockedUntil) {
      socket.destroy();
      return;
    }
    const decoder = new FrameDecoder<ServerFrame>();
    let authed = false;
    let queue: Promise<void> = Promise.resolve();
    const helloTimer = setTimeout(() => {
      if (!authed) socket.destroy();
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        log('bad frame; closing connection', { error: (error as FrameError).message });
        socket.destroy();
        return;
      }
      for (const { header, payload } of frames) {
        if (!authed) {
          if (header.t !== 'hello' || !this.tokenMatches(header.token)) {
            this.recordBadHello();
            socket.destroy();
            return;
          }
          authed = true;
          clearTimeout(helloTimer);
          this.takeControl(socket, header);
          continue;
        }
        // Frames are handled strictly in arrival order: spawn awaits the OOM
        // counter, and a `write` sent right behind a `spawn_pty` must not run
        // before the session it targets exists.
        queue = queue.then(async () => {
          if (socket !== this.controller) return; // superseded mid-read
          try {
            await this.handle(header, payload);
          } catch (error) {
            log('frame handler failed', { t: header.t, error: (error as Error).message });
            if ('rid' in header && typeof header.rid === 'number') {
              this.send({ t: 'err', rid: header.rid, code: 'internal', message: (error as Error).message });
            }
          }
        });
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (socket === this.controller) {
        this.controller = null;
        for (const session of this.sessions.values()) session.live.clear();
        log('controller disconnected', { serverBootId: this.controllerBootId });
        this.armIdleCheck();
      }
    });
  }

  private tokenMatches(token: unknown): boolean {
    if (typeof token !== 'string') return false;
    return timingSafeEqual(digest(token), this.tokenDigest);
  }

  private recordBadHello(): void {
    const now = Date.now();
    this.badHellos = this.badHellos.filter((at) => now - at < BAD_HELLO_WINDOW_MS);
    this.badHellos.push(now);
    if (this.badHellos.length >= BAD_HELLO_LIMIT) {
      this.lockedUntil = now + BAD_HELLO_LOCKOUT_MS;
      this.badHellos = [];
      log('too many bad hellos; refusing connections', { forMs: BAD_HELLO_LOCKOUT_MS });
    }
  }

  private takeControl(socket: Socket, hello: Extract<ServerFrame, { t: 'hello' }>): void {
    const previous = this.controller;
    if (previous && previous !== socket) {
      // A4: tell the old controller who took over, then drop it.
      previous.write(encodeFrame({ t: 'superseded', by: hello.serverBootId }));
      previous.end();
      for (const session of this.sessions.values()) session.live.clear();
    }
    this.controller = socket;
    this.controllerBootId = hello.serverBootId;
    this.everHello = true;
    // Follows the CURRENT controller, never latches: a rollback to the server
    // build that owns this generation makes it the active host again.
    this.retired = hello.role === 'retired';
    log('controller attached', { serverBootId: hello.serverBootId, role: this.retired ? 'retired' : 'active' });
    this.send({
      t: 'hello_ok',
      generation: this.options.generation,
      hostPid: process.pid,
      protocol: SESSION_HOST_PROTOCOL,
      startedAt: this.startedAt,
      role: this.retired ? 'retired' : 'active',
      sessions: [...this.sessions.values()].map((s) => this.record(s)),
    });
    this.armIdleCheck();
  }

  private record(s: Session): HostSessionRecord {
    return {
      sid: s.sid,
      kind: s.kind,
      pid: s.pid,
      epoch: s.epoch,
      ...(s.kind === 'pty' ? { cols: s.cols, rows: s.rows } : {}),
      spawnedAt: s.spawnedAt,
      oomKillAtSpawn: s.oomKillAtSpawn,
      out: { start: s.out.startOffset, next: s.out.totalBytes, acked: s.acked },
      ...(s.err ? { err: { start: s.err.startOffset, next: s.err.totalBytes, acked: 0 } } : {}),
      cursor: s.cursor ?? null,
      lastInputTag: s.lastInputTag,
      exit: s.exit,
    };
  }

  private send(frame: HostFrame, payload?: Buffer): void {
    const socket = this.controller;
    if (!socket || socket.destroyed) return;
    socket.write(encodeFrame(frame, payload));
  }

  // ------------------------------------------------------------------ frames

  private async handle(frame: ServerFrame, payload: Buffer): Promise<void> {
    switch (frame.t) {
      case 'hello':
        return; // already authed; a second hello on the same socket is a no-op
      case 'ping':
        this.send({ t: 'ok', rid: frame.rid });
        return;
      case 'spawn_pty':
      case 'spawn_pipe':
        await this.spawn(frame);
        return;
      case 'write': {
        const s = this.sessions.get(frame.sid);
        if (!s || s.exit) return;
        if (typeof frame.tag === 'string') s.lastInputTag = frame.tag;
        if (s.term) s.term.write(payload as unknown as string);
        else if (s.child && !s.child.stdin.destroyed) s.child.stdin.write(payload);
        return;
      }
      case 'resize': {
        const s = this.sessions.get(frame.sid);
        if (!s?.term || s.exit) return;
        const cols = clampDim(frame.cols);
        const rows = clampDim(frame.rows);
        s.term.resize(cols, rows);
        s.cols = cols;
        s.rows = rows;
        return;
      }
      case 'signal': {
        const s = this.sessions.get(frame.sid);
        if (!s || s.exit) {
          this.send({ t: 'err', rid: frame.rid, code: 'ESRCH', message: 'no live process for session' });
          return;
        }
        try {
          if (s.term) s.term.kill(frame.signal);
          else s.child!.kill(frame.signal);
          this.send({ t: 'ok', rid: frame.rid });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? 'signal_failed';
          this.send({ t: 'err', rid: frame.rid, code, message: (error as Error).message });
        }
        return;
      }
      case 'close_stdin': {
        const s = this.sessions.get(frame.sid);
        if (s?.child && !s.child.stdin.destroyed) s.child.stdin.end();
        return;
      }
      case 'subscribe': {
        const s = this.sessions.get(frame.sid);
        const ring = s ? (frame.stream === 'err' ? s.err : s.out) : null;
        if (!s || !ring) {
          this.send({ t: 'err', rid: frame.rid, code: 'not_found', message: 'no such session stream' });
          return;
        }
        const slice = ring.replayFrom(frame.fromOffset);
        // Replay BEFORE ok: the client fires a retained exit when ok settles,
        // and every replayed byte must be in its ring by then.
        for (let at = 0; at < slice.data.length; at += DATA_FRAME_BYTES) {
          const part = slice.data.subarray(at, Math.min(at + DATA_FRAME_BYTES, slice.data.length));
          this.send({ t: 'data', sid: s.sid, stream: frame.stream, off: slice.base + at }, part);
        }
        this.send({ t: 'ok', rid: frame.rid, base: slice.base, gap: slice.gap, next: slice.next });
        s.live.add(frame.stream);
        return;
      }
      case 'ack': {
        const s = this.sessions.get(frame.sid);
        if (!s || s.kind !== 'pipe') return;
        if (frame.cursor !== undefined) {
          const size = Buffer.byteLength(JSON.stringify(frame.cursor) ?? 'null', 'utf8');
          if (size <= CURSOR_MAX_BYTES) s.cursor = frame.cursor;
          else log('cursor too large; ignored', { sid: s.sid, size });
        }
        const offset = Math.min(Math.max(0, Math.floor(frame.offset)), s.out.totalBytes);
        if (offset > s.acked) {
          s.acked = offset;
          s.out.discardBefore(offset);
        }
        return;
      }
      case 'forget': {
        const s = this.sessions.get(frame.sid);
        if (s && !s.exit) {
          this.send({ t: 'err', rid: frame.rid, code: 'alive', message: 'refusing to forget a live session' });
          return;
        }
        this.sessions.delete(frame.sid);
        this.send({ t: 'ok', rid: frame.rid });
        this.armIdleCheck();
        return;
      }
      default:
        log('unknown frame type', { t: (frame as { t: string }).t });
    }
  }

  private async spawn(frame: Extract<ServerFrame, { t: 'spawn_pty' | 'spawn_pipe' }>): Promise<void> {
    if (this.retired) {
      this.send({ t: 'err', rid: frame.rid, code: 'generation_retired', message: 'this session host serves existing sessions only' });
      return;
    }
    const existing = this.sessions.get(frame.sid);
    if (existing && !existing.exit) {
      this.send({ t: 'err', rid: frame.rid, code: 'exists', message: 'session already has a live process' });
      return;
    }
    const oomKillAtSpawn = await readOomKillCount().catch(() => null);
    const epoch =
      frame.t === 'spawn_pty' && typeof frame.epoch === 'string' && frame.epoch.length > 0
        ? frame.epoch
        : `${this.nonce}-${++this.counter}`;
    let session: Session;
    try {
      session = frame.t === 'spawn_pty' ? this.spawnPty(frame, epoch, oomKillAtSpawn) : this.spawnPipe(frame, epoch, oomKillAtSpawn);
    } catch (error) {
      this.send({ t: 'err', rid: frame.rid, code: 'spawn_failed', message: (error as Error).message });
      return;
    }
    this.sessions.set(frame.sid, session);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // The controller that asked is subscribed to live output from byte 0.
    session.live.add('out');
    if (session.err) session.live.add('err');
    this.send({ t: 'spawned', rid: frame.rid, sid: frame.sid, pid: session.pid, epoch });
    log('spawned', { sid: frame.sid, kind: session.kind, pid: session.pid });
  }

  private spawnPty(
    frame: Extract<ServerFrame, { t: 'spawn_pty' }>,
    epoch: string,
    oomKillAtSpawn: number | null,
  ): Session {
    const cols = clampDim(frame.cols);
    const rows = clampDim(frame.rows);
    const term = pty.spawn(
      process.execPath,
      ['--no-warnings', EXEC_CLEAN, frame.shell, '-c', frame.command],
      {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: frame.cwd,
        env: wrapEnvForExecClean(frame.env),
        encoding: null as unknown as undefined,
      },
    );
    const session: Session = {
      sid: frame.sid,
      kind: 'pty',
      pid: term.pid,
      epoch,
      spawnedAt: Date.now(),
      oomKillAtSpawn,
      out: new OutputBuffer(PTY_RING_BYTES),
      err: null,
      term,
      child: null,
      cols,
      rows,
      acked: 0,
      cursor: null,
      lastInputTag: null,
      exit: null,
      live: new Set(),
    };
    term.onData((data: string | Buffer) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      this.emit(session, 'out', chunk);
    });
    term.onExit(({ exitCode, signal }) => {
      this.recordExit(session, {
        exitCode: exitCode ?? null,
        signal: signal === undefined || signal === 0 ? null : signal,
        at: Date.now(),
      });
    });
    return session;
  }

  private spawnPipe(
    frame: Extract<ServerFrame, { t: 'spawn_pipe' }>,
    epoch: string,
    oomKillAtSpawn: number | null,
  ): Session {
    const child = spawnChild(process.execPath, ['--no-warnings', EXEC_CLEAN, frame.file, ...frame.args], {
      cwd: frame.cwd,
      env: wrapEnvForExecClean(frame.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid === undefined) {
      // spawn() reports ENOENT/EACCES asynchronously; with process.execPath as
      // the image that only happens if node itself vanished.
      throw new Error('spawn returned no pid');
    }
    const session: Session = {
      sid: frame.sid,
      kind: 'pipe',
      pid: child.pid,
      epoch,
      spawnedAt: Date.now(),
      oomKillAtSpawn,
      out: new OutputBuffer(PIPE_OUT_CAP_BYTES),
      err: new OutputBuffer(PIPE_ERR_RING_BYTES),
      term: null,
      child,
      cols: 0,
      rows: 0,
      acked: 0,
      cursor: null,
      lastInputTag: null,
      exit: null,
      live: new Set(),
    };
    child.stdout.on('data', (chunk: Buffer) => this.emit(session, 'out', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.emit(session, 'err', chunk));
    child.stdin.on('error', () => undefined); // EPIPE after exit; the exit record carries the fact
    child.on('error', (error) => log('pipe child error', { sid: frame.sid, error: error.message }));
    // 'close', not 'exit': every byte of stdout has been emitted by then, so the
    // exit frame is never ahead of the data it ends.
    child.once('close', (code, signal) => {
      this.recordExit(session, {
        exitCode: code,
        signal: signal ? signalNumber(signal) : null,
        at: Date.now(),
      });
    });
    return session;
  }

  private emit(session: Session, stream: StreamName, chunk: Buffer): void {
    const ring = stream === 'err' ? session.err : session.out;
    if (!ring || chunk.length === 0) return;
    const off = ring.totalBytes;
    ring.append(chunk);
    if (session.live.has(stream)) this.send({ t: 'data', sid: session.sid, stream, off }, chunk);
  }

  private recordExit(session: Session, exit: ExitRecord): void {
    if (session.exit) return;
    session.exit = exit;
    session.live.clear();
    log('session exited', { sid: session.sid, ...exit });
    this.send({ t: 'exit', sid: session.sid, ...exit });
  }
}

function clampDim(v: number | undefined): number {
  return v && v > 0 ? Math.min(Math.floor(v), 1000) : 80;
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGPIPE: 13, SIGABRT: 6, SIGSEGV: 11 };
function signalNumber(name: string): number {
  return SIGNALS[name] ?? 0;
}

/** Read the controller token from fd 3 and close it before anything else opens (R8). */
function readTokenFromFd3(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(256);
  for (;;) {
    let n: number;
    try {
      n = readSync(3, buf, 0, buf.length, null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      throw error;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  closeSync(3);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function argValue(name: string): string {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (!value) {
    process.stderr.write(`session-host: missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

export async function main(): Promise<void> {
  const token = readTokenFromFd3();
  if (token.length < 32) {
    process.stderr.write('session-host: no token on fd 3\n');
    process.exit(2);
  }
  if (typeof (process as unknown as { execve?: unknown }).execve !== 'function') {
    // Without execve the exec-clean shim cannot run, and without the shim every
    // agent would inherit every other agent's terminal. Refuse loudly.
    process.stderr.write('session-host: this node has no process.execve; refusing to start\n');
    process.exit(3);
  }
  const host = new SessionHost({
    socketPath: argValue('--socket'),
    infoPath: argValue('--info'),
    generation: argValue('--generation'),
    token,
    ...(process.argv.includes('--idle-exit-ms') ? { idleExitMs: Number(argValue('--idle-exit-ms')) } : {}),
  });
  // R6. setsid() left this process with no controlling terminal, so no
  // terminal hangup can reach it: a SIGHUP is always deliberate, and it is how
  // a server that found this host with no registry row (no controller can ever
  // authenticate again) tells it so. Hang up every agent, then exit.
  process.on('SIGHUP', () => host.hangup());
  await host.listen();
}
