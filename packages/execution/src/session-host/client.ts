// Server side of the session host (design doc 01a0db5e §D2-D6, §4 amendments).
//
// SessionHostConnection — one authenticated unix-socket controller connection.
// SessionHostPool       — boot-time discovery: registry rows -> live/dead hosts,
//                         orphan handling (R6), spawning this build's own host
//                         (R5), and the dead-host list the server retires.
// RemotePty / RemoteChild live in remote.ts and ride on a connection.
import { spawn as spawnChild } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../pty/types.js';
import {
  encodeFrame,
  FrameDecoder,
  SESSION_HOST_PROTOCOL,
  type DecodedFrame,
  type ExitRecord,
  type HostFrame,
  type HostSessionRecord,
  type ServerFrame,
  type StreamName,
} from './frames.js';
import { readStartTime } from './proc.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The compiled files whose bytes define a generation: change any, get a new host. */
const GENERATION_FILES = [
  'bin.js',
  'host.js',
  'frames.js',
  'exec-clean.js',
  'proc.js',
  '../pty/OutputBuffer.js',
  '../spawn/oom-witness.js',
];
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000; // A3
const DEFAULT_SPAWN_TIMEOUT_MS = 10_000;
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 250;

const NOOP_LOGGER: Logger = { error() {}, warn() {}, info() {}, debug() {} };

/** One row of `internal.session_hosts` as the server's registry exposes it. */
export interface SessionHostRow {
  generation: string;
  socketPath: string;
  token: string;
  pid: number | null;
}

/**
 * The durable token store (R5). The server implements it over node-admin RPCs;
 * tests use an in-memory map. Rows are scoped to THIS node by the implementation.
 */
export interface SessionHostRegistry {
  list(): Promise<SessionHostRow[]>;
  insert(row: SessionHostRow): Promise<void>;
  setPid(generation: string, pid: number): Promise<void>;
  remove(generation: string): Promise<void>;
  /** Node id owning `generation` on this data dir, or null. R6 uses it to spot a foreign host. */
  ownerOf(generation: string): Promise<string | null>;
  readonly nodeId: string;
}

export function computeGeneration(dir = HERE, nodeVersion = process.version): string {
  const hash = createHash('sha256');
  for (const rel of GENERATION_FILES) {
    hash.update(rel);
    hash.update(readFileSync(join(dir, rel)));
  }
  hash.update(nodeVersion);
  return hash.digest('hex').slice(0, 16);
}

export class SessionHostError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'SessionHostError';
  }
}

/** Per-session receiver bound on a connection. */
export interface SessionBinding {
  onData(stream: StreamName, off: number, payload: Buffer): void;
  onExit(exit: ExitRecord): void;
  /** The controller reconnected; `record` is the host's view, or null if the host no longer knows the sid. */
  onReconnected(record: HostSessionRecord | null): void;
  /** The host is gone for good (reconnect failed): every session it held is dead. */
  onHostLost(): void;
  /** H4: the host stopped streaming this stream at its send high water; resubscribe from your own offset. */
  onResync?(stream: StreamName): void;
}

type HelloOk = Extract<HostFrame, { t: 'hello_ok' }>;
interface Handshake {
  socket: Socket;
  hello: HelloOk;
  decoder: FrameDecoder<HostFrame>;
  /** Frames that arrived in the same read as hello_ok. */
  extra: Array<DecodedFrame<HostFrame>>;
}
type Reply = Extract<HostFrame, { t: 'ok' | 'spawned' }>;
/** H10: a request with no answer by then means the controller link is broken. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Every rid-bearing server frame, minus the rid `request` assigns. */
type RequestFrame = ServerFrame extends infer F ? (F extends { rid: number } ? Omit<F, 'rid'> : never) : never;

interface ConnectOptions {
  socketPath: string;
  token: string;
  serverBootId: string;
  role: 'active' | 'retired';
  helloTimeoutMs?: number;
  /** Test seam; defaults to {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  logger?: Logger;
}

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** R4: liveness is "does the socket accept", never kill(pid, 0). */
export function isDeadSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOENT';
}

export class SessionHostConnection extends EventEmitter {
  private socket: Socket;
  private decoder = new FrameDecoder<HostFrame>();
  private nextRid = 1;
  private readonly pending = new Map<number, { resolve(f: Reply): void; reject(e: Error): void }>();
  private readonly bindings = new Map<string, SessionBinding>();
  /** Exits for sids nobody bound yet (e.g. arriving between hello and adopt). */
  private readonly unboundExits = new Map<string, ExitRecord>();
  private closedByUs = false;
  private superseded = false;
  hello: HelloOk;
  readonly logger: Logger;

  private constructor(
    private readonly options: ConnectOptions,
    { socket, hello, decoder, extra }: Handshake,
  ) {
    super();
    this.socket = socket;
    this.hello = hello;
    this.decoder = decoder;
    this.logger = options.logger ?? NOOP_LOGGER;
    for (const { header, payload } of extra) this.dispatch(header, payload);
    this.wire(socket);
  }

  get socketPath(): string {
    return this.options.socketPath;
  }
  get generation(): string {
    return this.hello.generation;
  }
  get role(): 'active' | 'retired' {
    return this.options.role;
  }
  get connected(): boolean {
    return !this.socket.destroyed;
  }
  /** Reconnect gave up: the host is gone and every session it held has been reported dead. */
  get lost(): boolean {
    return this.lostForGood;
  }
  private lostForGood = false;

  /** Connect and authenticate. Rejects with the raw socket error (see isDeadSocketError) or a hello timeout. */
  static async connect(options: ConnectOptions): Promise<SessionHostConnection> {
    return new SessionHostConnection(options, await SessionHostConnection.handshake(options));
  }

  private static async handshake(
    options: ConnectOptions,
  ): Promise<Handshake> {
    const socket = await openSocket(options.socketPath);
    const decoder = new FrameDecoder<HostFrame>();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error: Error | null, hello?: HelloOk, extra: Array<DecodedFrame<HostFrame>> = []): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('close', onClose);
        socket.off('error', onError);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          socket.pause();
          resolve({ socket, hello: hello!, decoder, extra });
        }
      };
      const onData = (chunk: Buffer): void => {
        try {
          const frames = decoder.push(chunk);
          const first = frames[0];
          if (!first) return;
          if (first.header.t !== 'hello_ok') {
            finish(new SessionHostError(`expected hello_ok, got ${first.header.t}`, 'protocol'));
            return;
          }
          if (first.header.protocol !== SESSION_HOST_PROTOCOL) {
            finish(new SessionHostError(`host speaks protocol ${first.header.protocol}`, 'protocol'));
            return;
          }
          finish(null, first.header, frames.slice(1));
        } catch (error) {
          finish(error as Error);
        }
      };
      const onClose = (): void => finish(new SessionHostError('host closed the connection during hello', 'hello_refused'));
      const onError = (error: Error): void => finish(error);
      const timer = setTimeout(
        () => finish(new SessionHostError('host did not answer hello in time', 'hello_timeout')),
        options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
      );
      socket.on('data', onData);
      socket.once('close', onClose);
      socket.once('error', onError);
      socket.write(
        encodeFrame({
          t: 'hello',
          token: options.token,
          serverBootId: options.serverBootId,
          protocol: SESSION_HOST_PROTOCOL,
          role: options.role,
        }),
      );
    });
  }

  private wire(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (error) {
        this.logger.error('session host sent a malformed frame; dropping connection', error as Error, {
          generation: this.generation,
        });
        socket.destroy();
        return;
      }
      for (const { header, payload } of frames) this.dispatch(header, payload);
    });
    socket.on('error', () => undefined);
    socket.once('close', () => void this.onSocketClose(socket));
    socket.resume();
  }

  private dispatch(frame: HostFrame, payload: Buffer): void {
    switch (frame.t) {
      case 'ok':
      case 'spawned': {
        const waiter = this.pending.get(frame.rid);
        if (waiter) {
          this.pending.delete(frame.rid);
          waiter.resolve(frame);
        }
        return;
      }
      case 'err': {
        const waiter = this.pending.get(frame.rid);
        if (waiter) {
          this.pending.delete(frame.rid);
          waiter.reject(new SessionHostError(frame.message, frame.code));
        }
        return;
      }
      case 'data':
        this.bindings.get(frame.sid)?.onData(frame.stream, frame.off, payload);
        return;
      case 'exit': {
        const exit: ExitRecord = { exitCode: frame.exitCode, signal: frame.signal, at: frame.at };
        const binding = this.bindings.get(frame.sid);
        if (binding) binding.onExit(exit);
        else this.unboundExits.set(frame.sid, exit);
        return;
      }
      case 'superseded':
        this.superseded = true;
        this.logger.warn('session host was taken over by another server', {
          generation: this.generation,
          by: frame.by,
        });
        this.emit('superseded', frame.by);
        return;
      case 'resync':
        this.bindings.get(frame.sid)?.onResync?.(frame.stream);
        return;
      case 'input_dropped':
        this.logger.error('session host dropped input: the agent is not reading its terminal', undefined, {
          sessionId: frame.sid,
          bytes: frame.bytes,
          tag: frame.tag,
        });
        return;
      case 'hello_ok':
        return;
    }
  }

  private async onSocketClose(socket: Socket): Promise<void> {
    if (socket !== this.socket) return;
    for (const waiter of this.pending.values()) {
      waiter.reject(new SessionHostError('session host connection closed', 'disconnected'));
    }
    this.pending.clear();
    if (this.closedByUs || this.superseded) {
      this.emit('closed');
      return;
    }
    this.logger.warn('session host connection dropped; reconnecting', { generation: this.generation });
    // R7: resubscribe from OUR offsets and drain retained exits; never re-adopt.
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS * attempt));
      if (this.closedByUs) return;
      try {
        const { socket: next, hello, decoder, extra } = await SessionHostConnection.handshake(this.options);
        this.socket = next;
        this.decoder = decoder;
        this.hello = hello;
        const records = new Map(hello.sessions.map((s) => [s.sid, s]));
        for (const [sid, binding] of this.bindings) binding.onReconnected(records.get(sid) ?? null);
        for (const { header, payload } of extra) this.dispatch(header, payload);
        this.wire(next);
        this.logger.info('session host reconnected', { generation: this.generation, attempt });
        this.emit('reconnected');
        return;
      } catch (error) {
        if (!isDeadSocketError(error) && attempt === RECONNECT_ATTEMPTS) {
          this.logger.error('session host reconnect failed', error as Error, { generation: this.generation });
        }
      }
    }
    this.logger.error('session host is gone; its sessions are dead', undefined, { generation: this.generation });
    this.lostForGood = true;
    for (const binding of [...this.bindings.values()]) binding.onHostLost();
    this.bindings.clear();
    this.emit('lost');
  }

  /**
   * Route a sid's frames to `binding`. Replays nothing (H5/H8): an exit that
   * arrived before the bind stays in {@link takeUnboundExit} for the caller to
   * claim — adopt fires it after the retained tail; a fresh spawn discards it.
   */
  bind(sid: string, binding: SessionBinding): void {
    this.bindings.set(sid, binding);
  }

  unbind(sid: string): void {
    this.bindings.delete(sid);
  }

  /** The exit the host reported for an unbound sid since hello, if any. */
  takeUnboundExit(sid: string): ExitRecord | null {
    const exit = this.unboundExits.get(sid) ?? null;
    this.unboundExits.delete(sid);
    return exit;
  }

  send(frame: ServerFrame, payload?: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeFrame(frame, payload));
  }

  /** Send a rid-bearing frame and resolve with its ok/spawned reply. */
  request(frame: RequestFrame): Promise<Reply> {
    if (this.socket.destroyed) {
      return Promise.reject(new SessionHostError('session host connection closed', 'disconnected'));
    }
    const rid = this.nextRid++;
    const socket = this.socket;
    const timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      // H10: a stalled host must not park a subscribe (and the exits it
      // defers) forever. No answer in time is a broken link: drop the socket
      // and let the reconnect path decide whether the host is still there.
      const timer = setTimeout(() => {
        if (!this.pending.delete(rid)) return;
        reject(new SessionHostError(`session host did not answer ${frame.t} in ${timeoutMs}ms`, 'request_timeout'));
        this.logger.error('session host request timed out; dropping the connection', undefined, {
          generation: this.generation,
          frame: frame.t,
        });
        socket.destroy();
      }, timeoutMs);
      timer.unref?.();
      const settle = <T>(fn: (v: T) => void) => (v: T): void => {
        clearTimeout(timer);
        fn(v);
      };
      this.pending.set(rid, { resolve: settle(resolve), reject: settle(reject) });
      socket.write(encodeFrame({ ...frame, rid } as unknown as ServerFrame));
    });
  }

  /**
   * Leave the host running with everything it holds. The graceful-shutdown
   * path: a server that is stopping hands its agents to the next one.
   */
  detach(): void {
    this.closedByUs = true;
    this.socket.end();
  }
}

// ---------------------------------------------------------------------------
// Pool

export interface SessionHostPoolOptions {
  dataDir: string;
  registry: SessionHostRegistry;
  serverBootId: string;
  logger?: Logger;
  /** Directory holding the compiled session-host files; defaults to this module's. */
  hostDir?: string;
  nodeExecPath?: string;
  helloTimeoutMs?: number;
  spawnTimeoutMs?: number;
  /** Idle-exit override passed to a spawned host (tests). */
  hostIdleExitMs?: number;
  /**
   * NC2 ONLY: behave like the server before session hosts existed — send
   * every host a previous server left a `hangup` instead of reattaching.
   * A test-fixture option, never an env read (H9).
   */
  noAdoptForTest?: boolean;
  /**
   * H12 negative twin ONLY: the spawned host starts children WITHOUT the
   * exec-clean shim, so the fd assertions are proven able to see a leak.
   * A test-fixture option, never an env read.
   */
  bypassExecCleanForTest?: boolean;
}

export interface DeadHost {
  row: SessionHostRow;
  reason: string;
}

export class SessionHostPool {
  /** Connected hosts, the active generation first. */
  readonly hosts: SessionHostConnection[] = [];
  /** Hosts that were registered but are gone: their sessions are dead (A6). */
  readonly dead: DeadHost[] = [];
  active: SessionHostConnection | null = null;
  readonly generation: string;

  private constructor(
    private readonly options: SessionHostPoolOptions,
    readonly dir: string,
  ) {
    this.generation = computeGeneration(options.hostDir ?? HERE);
  }

  private get logger(): Logger {
    return this.options.logger ?? NOOP_LOGGER;
  }

  static async open(options: SessionHostPoolOptions): Promise<SessionHostPool> {
    const dir = join(options.dataDir, 'session-host');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const pool = new SessionHostPool(options, dir);
    await pool.discover();
    return pool;
  }

  private socketPathFor(generation: string): string {
    return join(this.dir, `${generation}.sock`);
  }
  private infoPathFor(generation: string): string {
    return join(this.dir, `${generation}.json`);
  }

  private async discover(): Promise<void> {
    const rows = await this.options.registry.list();
    const known = new Set<string>();
    for (const row of rows) {
      known.add(row.generation);
      if (this.options.noAdoptForTest === true) {
        await this.hangUpForTest(row);
        continue;
      }
      const role = row.generation === this.generation ? 'active' : 'retired';
      try {
        const conn = await SessionHostConnection.connect({
          socketPath: row.socketPath,
          token: row.token,
          serverBootId: this.options.serverBootId,
          role,
          helloTimeoutMs: this.options.helloTimeoutMs,
          logger: this.logger,
        });
        this.hosts.push(conn);
        this.watch(conn);
        if (role === 'active') this.active = conn;
        this.logger.info('session host reattached', {
          generation: row.generation,
          role,
          sessions: conn.hello.sessions.length,
        });
      } catch (error) {
        let reason = isDeadSocketError(error) ? 'socket refused' : String((error as Error).message);
        if (!isDeadSocketError(error)) {
          // A3/H6: a host that is alive but will not complete a handshake —
          // timeout, refusal, wrong protocol — is killed BEFORE its row and
          // files go, or it would keep its agents with nothing able to find it.
          const killed = this.killVerified(row.generation, 'SIGKILL');
          reason = `${reason}; ${killed ? `host pid ${killed} SIGKILLed` : 'host process already gone'}`;
        }
        this.logger.warn('session host is dead; retiring its registration', { generation: row.generation, reason });
        this.dead.push({ row, reason });
        await this.options.registry.remove(row.generation).catch((e: unknown) =>
          this.logger.error('failed to remove dead session host row', e as Error, { generation: row.generation }),
        );
        this.unlinkQuiet(row.socketPath);
        this.unlinkQuiet(this.infoPathFor(row.generation));
      }
    }
    await this.sweepOrphans(known);
    if (!this.active) {
      try {
        this.active = await this.spawnOwn();
        this.hosts.unshift(this.active);
        this.watch(this.active);
      } catch (error) {
        this.logger.error('could not start the session host; agents started now will not survive a restart', error as Error, {
          generation: this.generation,
        });
      }
    } else {
      // keep the active host first
      this.hosts.splice(this.hosts.indexOf(this.active), 1);
      this.hosts.unshift(this.active);
    }
  }

  /** R6: info files with no registry row. */
  private async sweepOrphans(known: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const generation = name.slice(0, -'.json'.length);
      if (known.has(generation)) continue;
      const info = this.readInfo(generation);
      const alive = info !== null && info.starttime !== null && readStartTime(info.pid) === info.starttime;
      if (!alive) {
        this.unlinkQuiet(join(this.dir, name));
        this.unlinkQuiet(this.socketPathFor(generation));
        continue;
      }
      const owner = await this.options.registry.ownerOf(generation).catch(() => null);
      if (owner !== null && owner !== this.options.registry.nodeId) {
        this.logger.error('session host in this data dir belongs to another node; leaving it alone', undefined, {
          generation,
          owner,
          nodeId: this.options.registry.nodeId,
          pid: info!.pid,
        });
        continue;
      }
      // No row: no server can ever authenticate to it again, so no frame can
      // reach it (H1: the host ignores signals it cannot authenticate). Kill
      // it; closing its masters HUPs every PTY session and its pipe children
      // read EOF. The rows those agents held are retired by ghost
      // reconciliation, which names this host from `dead`.
      const killed = this.killVerified(generation, 'SIGKILL');
      this.logger.warn('orphaned session host (no registry row); SIGKILLed', { generation, pid: info!.pid });
      if (killed) {
        this.dead.push({
          row: { generation, socketPath: this.socketPathFor(generation), token: '', pid: killed },
          reason: `orphaned (no registry row); host pid ${killed} SIGKILLed`,
        });
      }
      this.unlinkQuiet(join(this.dir, name));
      this.unlinkQuiet(this.socketPathFor(generation));
    }
  }

  private readInfo(generation: string): { pid: number; starttime: string | null } | null {
    try {
      const info = JSON.parse(readFileSync(this.infoPathFor(generation), 'utf8')) as {
        pid?: unknown;
        starttime?: unknown;
      };
      if (typeof info.pid !== 'number') return null;
      return { pid: info.pid, starttime: typeof info.starttime === 'string' ? info.starttime : null };
    } catch {
      return null;
    }
  }

  /**
   * Signal the host named by an info file, only if /proc still shows the same
   * process (R4). Returns the pid signalled, or null.
   */
  private killVerified(generation: string, signal: NodeJS.Signals): number | null {
    const info = this.readInfo(generation);
    if (!info || info.starttime === null || readStartTime(info.pid) !== info.starttime) return null;
    try {
      process.kill(info.pid, signal);
      return info.pid;
    } catch {
      return null;
    }
  }

  /** NC2: authenticate, send `hangup`, and retire the row — the pre-session-host behaviour. */
  private async hangUpForTest(row: SessionHostRow): Promise<void> {
    this.logger.error('noAdoptForTest: hanging up a session host instead of reattaching', undefined, {
      generation: row.generation,
    });
    try {
      const conn = await SessionHostConnection.connect({
        socketPath: row.socketPath,
        token: row.token,
        serverBootId: this.options.serverBootId,
        role: 'retired',
        helloTimeoutMs: this.options.helloTimeoutMs,
        logger: this.logger,
      });
      await conn.request({ t: 'hangup' }).catch(() => undefined);
      conn.detach();
    } catch {
      /* already gone */
    }
    this.dead.push({ row, reason: 'noAdoptForTest' });
    await this.options.registry.remove(row.generation).catch(() => undefined);
  }

  private unlinkQuiet(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      /* absent */
    }
  }

  /** R5: mint token -> insert row -> spawn with token on fd 3 -> delete row on failure. */
  private async spawnOwn(): Promise<SessionHostConnection> {
    const generation = this.generation;
    const socketPath = this.socketPathFor(generation);
    const infoPath = this.infoPathFor(generation);
    const lockPath = join(this.dir, `${generation}.lock`);
    const lock = this.acquireLock(lockPath);
    try {
      this.unlinkQuiet(socketPath); // a stale socket file from a dead host
      const token = randomBytes(32).toString('base64url');
      await this.options.registry.insert({ generation, socketPath, token, pid: null });
      let child;
      try {
        const logFd = openSync(join(this.dir, `${generation}.log`), 'a', 0o600);
        try {
          child = spawnChild(
            this.options.nodeExecPath ?? process.execPath,
            [
              '--no-warnings',
              join(this.options.hostDir ?? HERE, 'bin.js'),
              '--socket',
              socketPath,
              '--info',
              infoPath,
              '--generation',
              generation,
              ...(this.options.hostIdleExitMs !== undefined ? ['--idle-exit-ms', String(this.options.hostIdleExitMs)] : []),
              ...(this.options.bypassExecCleanForTest === true ? ['--bypass-exec-clean-for-test'] : []),
            ],
            {
              detached: true, // setsid(): own session, no controlling terminal
              stdio: ['ignore', logFd, logFd, 'pipe'],
              env: scrubbedHostEnv(process.env),
              cwd: this.dir,
            },
          );
        } finally {
          closeSync(logFd);
        }
        const tokenPipe = child.stdio[3] as NodeJS.WritableStream | null;
        if (!tokenPipe) throw new Error('no fd 3 pipe to the session host');
        tokenPipe.end(token);
        child.unref();
        (child.stdio[3] as unknown as { unref?: () => void }).unref?.();
        const pid = child.pid;
        if (pid === undefined) throw new Error('session host spawn returned no pid');
        const conn = await this.waitForHost(socketPath, token, child);
        await this.options.registry.setPid(generation, pid).catch(() => undefined);
        this.logger.info('session host started', { generation, pid });
        return conn;
      } catch (error) {
        try {
          if (child?.pid !== undefined && child.exitCode === null) child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        await this.options.registry.remove(generation).catch(() => undefined);
        throw error;
      }
    } finally {
      releaseLock(lock, lockPath);
    }
  }

  private async waitForHost(
    socketPath: string,
    token: string,
    child: ReturnType<typeof spawnChild>,
  ): Promise<SessionHostConnection> {
    const deadline = Date.now() + (this.options.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS);
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`session host exited during start (code ${child.exitCode}, signal ${child.signalCode})`);
      }
      try {
        return await SessionHostConnection.connect({
          socketPath,
          token,
          serverBootId: this.options.serverBootId,
          role: 'active',
          helloTimeoutMs: this.options.helloTimeoutMs,
          logger: this.logger,
        });
      } catch (error) {
        lastError = error;
        if (!isDeadSocketError(error)) throw error;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`session host did not start listening: ${(lastError as Error | null)?.message ?? 'timeout'}`);
  }

  /**
   * One server starts a generation's host at a time. The loser throws, and its
   * spawns fall back in-process (A9, out of scope by agreement): two servers
   * on one data dir already share a node id and every lease, and joining the
   * winner's host would mean reading a token row the loser could race.
   */
  private acquireLock(lockPath: string): number {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        writeSync(fd, `${process.pid}\n`);
        return fd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
        let alive = false;
        try {
          if (Number.isInteger(holder) && holder > 0) {
            process.kill(holder, 0);
            alive = true;
          }
        } catch {
          alive = false;
        }
        if (alive && holder !== process.pid) {
          throw new Error(`another server (pid ${holder}) is starting this session host`);
        }
        this.unlinkQuiet(lockPath);
      }
    }
    throw new Error('could not take the session host lock');
  }

  /**
   * The host a new session spawns into, or null: the caller then spawns it
   * in-process, where it will NOT survive a restart (H7, accepted fallback).
   *   - active and connected: that host.
   *   - active and reconnecting: null for now; the host may come back.
   *   - lost, or never started: null, and a replacement host is started in
   *     the background. Every later call retries until one starts, so the
   *     degradation lasts only as long as the failure does.
   */
  hostForSpawn(): SessionHostConnection | null {
    const active = this.active;
    if (active && active.connected) return active;
    if (active && !active.lost) return null;
    this.startReplacement();
    return null;
  }

  private replacing: Promise<void> | null = null;

  private startReplacement(): void {
    if (this.replacing) return;
    this.replacing = this.spawnOwn()
      .then((conn) => {
        this.active = conn;
        this.hosts.unshift(conn);
        this.watch(conn);
        this.logger.info('session host replaced; new sessions survive restarts again', { generation: conn.generation });
      })
      .catch((error: unknown) => {
        this.logger.error('could not start a replacement session host; spawning in-process', error as Error, {
          generation: this.generation,
        });
      })
      .finally(() => {
        this.replacing = null;
      });
  }

  /** Waits for an in-flight replacement (tests). */
  async settled(): Promise<void> {
    await this.replacing;
  }

  /**
   * H7: a host whose reconnect gave up is finished. Its sessions have already
   * exited through their bindings (D8); here it is killed if it somehow still
   * runs (an unresponsive host would otherwise keep agents nobody can reach),
   * its row retired, and — if it was the active host — replaced lazily.
   */
  private watch(conn: SessionHostConnection): void {
    conn.once('lost', () => {
      const generation = conn.generation;
      const killed = this.killVerified(generation, 'SIGKILL');
      const at = this.hosts.indexOf(conn);
      if (at >= 0) this.hosts.splice(at, 1);
      const row = { generation, socketPath: conn.socketPath, token: '', pid: conn.hello.hostPid };
      this.dead.push({ row, reason: `connection lost${killed ? `; host pid ${killed} SIGKILLed` : ''}` });
      void this.options.registry.remove(generation).catch((e: unknown) =>
        this.logger.error('failed to remove lost session host row', e as Error, { generation }),
      );
      if (this.active === conn) {
        this.logger.error('the active session host is lost; new sessions spawn in-process until it is replaced', undefined, {
          generation,
        });
        this.startReplacement();
      }
    });
  }

  /** Every session any connected host holds, with the connection that holds it. */
  sessions(): Array<{ conn: SessionHostConnection; record: HostSessionRecord }> {
    return this.hosts.flatMap((conn) => conn.hello.sessions.map((record) => ({ conn, record })));
  }

  /** Graceful shutdown: leave every host and agent running. */
  detachAll(): void {
    for (const conn of this.hosts) conn.detach();
  }
}

function releaseLock(fd: number, path: string): void {
  try {
    closeSync(fd);
  } catch {
    /* closed */
  }
  try {
    unlinkSync(path);
  } catch {
    /* gone */
  }
}

/**
 * R8: the host needs nothing from the server's environment — every agent's
 * environment arrives whole in its spawn frame. Pass only what node itself and
 * the log timestamps use; never a database URL or a TM8_* secret.
 */
export function scrubbedHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR']) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
