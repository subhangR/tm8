import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { OutputBuffer, type ReplaySlice } from './OutputBuffer.js';
import { TerminalStateMirror } from './TerminalStateMirror.js';
import type {
  AttachResult,
  FrameSink,
  Logger,
  PtyHostOptions,
  PtyKillOutcome,
  PtySessionStatus,
  PtySpawnParams,
} from './types.js';

/** No-op logger used when the host is constructed without one. */
const NOOP_LOGGER: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

interface PendingSubscriber {
  chunks: Buffer[];
  bytes: number;
}

interface PtyEntry {
  proc: IPty;
  /** Offset-tracked scrollback buffer: counts every raw byte the PTY has ever
   *  produced and retains a bounded tail, so a reconnecting client can resume
   *  from the exact byte offset it last saw (see {@link PtyHostService.getReplay}). */
  output: OutputBuffer;
  /** Parsed terminal state used when the raw replay ring has evicted the
   * client's resume point. */
  state: TerminalStateMirror;
  subscribers: Set<FrameSink>;
  /** Sockets waiting for an asynchronous state snapshot. */
  pendingSubscribers: Map<FrameSink, PendingSubscriber>;
  exited: boolean;
  exitCode: number | null;
  /** Current PTY dimensions, kept in sync with spawn/resize so late-joining
   *  clients can size their terminal to match the width the scrollback was
   *  authored at (otherwise replayed output wraps at the wrong column). */
  cols: number;
  rows: number;
  /** Opaque stream identity for THIS spawn (see {@link PtyHostService.newEpoch}).
   *  Minted once per spawn and never mutated, so it is stable for the life of one
   *  stream; a kill+respawn under the same sessionId installs a fresh entry with a
   *  new epoch. The client compares it by equality only (a change ⇒ authoritative
   *  reset) and never infers ordering. Echoed to clients in the `attached` frame. */
  epoch: string;
  /** Output chunks awaiting coalesced delivery to subscribers. A busy TUI emits
   *  hundreds of tiny chunks/sec; sending each as its own WebSocket frame made
   *  clients decode N×hundreds of messages/sec with many concurrent agents.
   *  Chunks are appended to the ring buffers synchronously (offset accounting
   *  and snapshots are unaffected); only the socket sends are delayed, and every
   *  attach/replay/snapshot boundary flushes first so no byte is ever seen twice. */
  sendBuf: Buffer[];
  sendBytes: number;
  sendTimer: ReturnType<typeof setTimeout> | null;
}

/** Coalescing window for live output fan-out. Well under perceptible echo
 *  latency. SCAR: this default MUST stay 16ms (commit 07d504d) — parity bar. */
const DEFAULT_SEND_COALESCE_MS = 16;
/** Force a flush when this much output accumulates inside one window. */
const DEFAULT_SEND_COALESCE_MAX_BYTES = 64 * 1024;

interface PendingPromptDelivery {
  content: string;
  mode: 'send' | 'paste';
  bytes: number;
}

interface PendingPromptQueue {
  deliveries: PendingPromptDelivery[];
  bytes: number;
  draining: boolean;
  overflowWarned: boolean;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_PENDING_SNAPSHOT_BYTES = 4 * 1024 * 1024;
// Keep server attach handoff bounds aligned with the client-side queue.
// Overflow preserves the already-accepted FIFO prefix and rejects newer input.
const MAX_PENDING_PROMPT_SESSIONS = 64;
const MAX_PENDING_PROMPTS_PER_SESSION = 32;
const MAX_PENDING_PROMPT_BYTES_PER_SESSION = 256 * 1024;

const ESC = 0x1b;
const CSI_INTRO = 0x5b; // '['
const QUESTION = 0x3f; // '?'

/**
 * Remove terminal device-query / device-report control sequences from a chunk
 * of HISTORICAL scrollback before it is replayed to a late-joining client.
 *
 * Why: xterm answers device QUERIES it parses. When the scrollback ring is
 * replayed on (re)attach, the browser feeds these historical queries — DSR
 * cursor-position `ESC[6n`, Device Attributes `ESC[c` / `ESC[>c` — back into
 * xterm, which generates the REPLIES (`ESC[27;3R`, `ESC[?1;2c`) and forwards
 * them to the PTY as if the user typed them, corrupting the shell prompt after
 * the agent has exited. Reconnect amplification also leaves the raw reply bytes
 * (CPR `ESC[27;3R`, DA reply `ESC[?...c`) accumulated in the ring; those stale
 * artifacts are stripped too so they do not linger on replay.
 *
 * Scope is deliberately narrow — only the query/report protocol set, which has
 * no visible glyph, so stripping it from scrollback is lossless:
 *   - CSI … `c`  → Device Attributes (request or reply). `c` is DA-only.
 *   - CSI … `n`  → Device Status Report request (DSR, incl. DEC `?…n`). `n`-only.
 *   - CSI … `R`  → Cursor Position Report, but ONLY the `row;col` reply shape
 *                  (`\??\d+;\d+`) so ordinary output is never touched.
 *   - CSI `?` … `u` → kitty keyboard query/reply. Plain `CSI …u` (key encoding)
 *                     and `CSI >…u` / `CSI <…u` (mode push/pop) are preserved.
 *
 * Any other CSI (SGR colours, cursor motion, DEC private modes like `?25h`),
 * OSC, and plain text pass through untouched. This runs on the replay copy
 * only; the live output path is never sanitized, so a running program's
 * real-time queries still reach the client and get answered.
 */
export function stripScrollbackDeviceQueries(data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length);
  let w = 0;
  const len = data.length;
  let i = 0;
  while (i < len) {
    if (data[i] === ESC && i + 1 < len && data[i + 1] === CSI_INTRO) {
      // Consume CSI parameter/intermediate bytes (0x20–0x3f) up to the final
      // byte (0x40–0x7e).
      let j = i + 2;
      while (j < len && data[j]! >= 0x20 && data[j]! <= 0x3f) j++;
      if (j < len && data[j]! >= 0x40 && data[j]! <= 0x7e) {
        const final = data[j]!;
        const params = data.subarray(i + 2, j);
        if (shouldStripCsi(final, params)) {
          i = j + 1; // drop the whole sequence
          continue;
        }
        // keep the whole sequence verbatim
        data.copy(out, w, i, j + 1);
        w += j + 1 - i;
        i = j + 1;
        continue;
      }
      if (j >= len) {
        // Genuinely incomplete CSI at the tail (scanned off the end before a
        // final byte). Copy the remainder verbatim — on the concatenated ring
        // this only happens at the very end.
        data.copy(out, w, i, len);
        w += len - i;
        break;
      }
      // Malformed CSI mid-buffer: a non-parameter/non-final byte (a C0 control,
      // DEL, or a high byte) interrupted the sequence. Emit the ESC literally
      // and resume scanning at the next byte so a later well-formed device
      // query is still stripped instead of leaking through. Bytes are neither
      // dropped nor reordered.
      out[w++] = data[i++]!;
      continue;
    }
    out[w++] = data[i++]!;
  }
  return out.subarray(0, w);
}

function shouldStripCsi(finalByte: number, params: Buffer): boolean {
  switch (finalByte) {
    case 0x63: // 'c' — Device Attributes (request or reply)
      return true;
    case 0x6e: // 'n' — Device Status Report request
      return true;
    case 0x75: // 'u' — strip ONLY the kitty query/reply (`?` prefix)
      return params.length > 0 && params[0] === QUESTION;
    case 0x52: {
      // 'R' — Cursor Position Report reply, only the `row;col` numeric shape
      // (optionally DEC `?row;col`). Never strip other `…R`.
      return /^\??[0-9]+;[0-9]+$/.test(params.toString('latin1'));
    }
    default:
      return false;
  }
}

/**
 * Owns agent PTYs server-side — the ONLY spawn path in tm8 (AM-1/T-D21; what
 * was old maestro's `MAESTRO_PTY_HOST=server` mode is now the architecture).
 * Spawns processes with node-pty, keeps an offset-tracked output buffer per
 * session (for byte-accurate scrollback resume), and fans live output out to
 * subscribed sinks.
 *
 * MUST run under **node, never bun** — node-pty's onData does not fire under
 * bun, and bun strips the spawn-helper exec bit.
 *
 * The seam: this service depends on nothing from the old repo. Logging and the
 * single-writer status transition (R29) arrive as plain params
 * ({@link PtyHostOptions}); live delivery targets are structural
 * {@link FrameSink}s (a `ws` WebSocket satisfies the shape). The WS framing/
 * transport is a separate layer (old maestro's PtyWebSocketServer is the
 * behavioral reference); this service is transport-agnostic beyond writing raw
 * bytes to sinks and exposes {@link attach} as the composed offset-replay seam.
 */
export class PtyHostService {
  private readonly sessions = new Map<string, PtyEntry>();
  private readonly pendingPrompts = new Map<string, PendingPromptQueue>();
  /** Spawn/resume events pause draining until the PTY lifecycle decision is
   * finished by spawn, spawnIfAbsent, or explicit reuse completion. */
  private readonly promptHandoffs = new Set<string>();

  private readonly logger: Logger;
  private readonly onSessionStatus?: (
    sessionId: string,
    status: PtySessionStatus,
  ) => void | Promise<void>;
  private readonly coalesceMs: number;
  private readonly coalesceMaxBytes: number;
  private readonly outputCapBytes: number;
  private readonly defaultShell?: string;

  /**
   * Per-INSTANCE boot nonce for stream epochs (#151). Minted once when the
   * service is constructed, so every PTY spawned by this process shares this
   * prefix, and a NEW process (server restart) — a new PtyHostService instance —
   * gets a fresh nonce. That is what makes two service instances mint disjoint
   * epochs even for the very first spawn (where a bare per-instance counter would
   * collide at the same value). Combined with {@link epochCounter}, the full
   * epoch is unique per spawn AND across restarts.
   */
  private readonly bootNonce = randomUUID();
  /** Monotonic per-spawn counter; makes each respawn within THIS process
   *  distinct even under the same sessionId. */
  private epochCounter = 0;

  constructor(options: PtyHostOptions = {}) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.onSessionStatus = options.onSessionStatus;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_SEND_COALESCE_MS;
    this.coalesceMaxBytes = options.coalesceMaxBytes ?? DEFAULT_SEND_COALESCE_MAX_BYTES;
    this.outputCapBytes = options.outputCapBytes ?? 1024 * 1024;
    this.defaultShell = options.defaultShell;
  }

  /** Mint the next opaque stream epoch: a per-instance boot nonce (restart
   *  distinctness) plus a monotonic counter (per-spawn distinctness). Opaque and
   *  equality-only on the wire — the client never parses these parts. */
  private newEpoch(): string {
    return `${this.bootNonce}-${++this.epochCounter}`;
  }

  /**
   * Spawn a PTY for a session. If one already exists it is killed first.
   */
  spawn(params: PtySpawnParams): void {
    const { sessionId, command, cwd, env, cols, rows } = params;

    if (this.sessions.has(sessionId)) {
      this.logger.warn('PtyHostService: replacing existing PTY for session', { sessionId });
      // Replace, don't stop: close the old subscribers' sockets WITHOUT sending a
      // terminal exit frame (notify=false). The new PTY restarts output at
      // offset 0, so an attached web client must reconnect and resume onto the
      // fresh stream — sending an exit frame here would make it finalize the
      // terminal and never come back, stranding the new process.
      this.kill(sessionId, false);
    }

    const shell = env.SHELL || process.env.SHELL || this.defaultShell || '/bin/bash';
    const clampDim = (v: number | undefined, fallback: number): number =>
      v && v > 0 ? Math.min(v, 1000) : fallback;
    const initialCols = clampDim(cols, DEFAULT_COLS);
    const initialRows = clampDim(rows, DEFAULT_ROWS);
    const proc = pty.spawn(shell, ['-c', command], {
      name: 'xterm-256color',
      cols: initialCols,
      rows: initialRows,
      cwd,
      // node-pty requires a string-keyed env; merge over the process env so the
      // child still sees HOME, etc., with caller overrides winning.
      env: { ...process.env, ...env } as Record<string, string>,
      encoding: null as unknown as undefined, // emit raw Buffers, not decoded strings
    });

    const entry: PtyEntry = {
      proc,
      output: new OutputBuffer(this.outputCapBytes),
      state: new TerminalStateMirror(initialCols, initialRows),
      subscribers: new Set(),
      pendingSubscribers: new Map(),
      exited: false,
      exitCode: null,
      cols: initialCols,
      rows: initialRows,
      epoch: this.newEpoch(),
      sendBuf: [],
      sendBytes: 0,
      sendTimer: null,
    };
    this.sessions.set(sessionId, entry);

    proc.onData((data: string | Buffer) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      // Ring buffers MUST stay synchronous — offset accounting, replay, and
      // snapshot boundaries all read them in the same turn as onData. Only the
      // socket fan-out below is coalesced.
      entry.output.append(chunk);
      entry.state.append(chunk);
      entry.sendBuf.push(chunk);
      entry.sendBytes += chunk.length;
      if (entry.sendBytes >= this.coalesceMaxBytes) {
        this.flushOutput(entry, sessionId);
      } else if (entry.sendTimer === null) {
        entry.sendTimer = setTimeout(() => this.flushOutput(entry, sessionId), this.coalesceMs);
      }
    });

    proc.onExit(({ exitCode }) => {
      // node-pty fires onExit ASYNCHRONOUSLY, and killing a PTY still produces
      // this event later. If this session's slot was already replaced (respawn
      // installs a new entry) or removed (explicit kill), this is the OLD
      // process's late exit — it must not delete the freshly-installed entry or
      // stomp a status the stop path already set. Identity-check the live entry
      // before touching any shared state.
      if (this.sessions.get(sessionId) !== entry) return;
      entry.exited = true;
      entry.exitCode = exitCode;
      this.logger.info('PtyHostService: session PTY exited', { sessionId, exitCode });
      const status: PtySessionStatus = exitCode === 0 ? 'completed' : 'failed';
      // Single-writer status transition (R29): the host is the sole writer on
      // the exit path; the injected sink decides where it lands (tm8 → a graph
      // work-command; old maestro → the session file store).
      try {
        const result = this.onSessionStatus?.(sessionId, status);
        if (result && typeof (result as Promise<void>).catch === 'function') {
          void (result as Promise<void>).catch((err: unknown) =>
            this.logger.error(
              'PtyHostService: failed to update session status on exit',
              err instanceof Error ? err : new Error(String(err)),
              { sessionId },
            ),
          );
        }
      } catch (err) {
        this.logger.error(
          'PtyHostService: failed to update session status on exit',
          err instanceof Error ? err : new Error(String(err)),
          { sessionId },
        );
      }
      // Signal a REAL process exit to subscribers before closing their sockets,
      // so clients can distinguish "the agent finished/crashed" from a plain
      // socket drop (tab close, reload, network blip — those only detach). The
      // web adapter listens for this {type:'exit'} text frame.
      this.notifyExit(entry, exitCode ?? null);
      entry.state.dispose();
      this.sessions.delete(sessionId);
      this.pendingPrompts.delete(sessionId);
      this.promptHandoffs.delete(sessionId);
    });

    this.completePromptHandoff(sessionId);
    this.logger.info('PtyHostService: spawned session PTY', { sessionId, pid: proc.pid, cwd });
  }

  /**
   * Spawn a PTY only if the session has no live one, otherwise reattach to the
   * existing process untouched.
   *
   * This is the reattach-safe counterpart to {@link spawn}: on a browser reload
   * the UI re-creates its persisted standalone terminals, each re-requesting a
   * spawn. Those must NOT tear down and respawn a still-running shell (that
   * would kill the user's process and drop its scrollback) — they reattach to
   * the live PTY by session identity. A PTY that has already exited is no longer
   * tracked (onExit removes it), so it is recreated.
   *
   * `spawn()` stays deliberately destructive for the agent resume path, which
   * intends to replace the process.
   *
   * @returns `{ reused: true }` when a live PTY was reattached, `{ reused:
   *   false }` when a new PTY was spawned.
   */
  spawnIfAbsent(params: PtySpawnParams): { reused: boolean } {
    if (this.sessions.has(params.sessionId)) {
      this.logger.info('PtyHostService: reattaching to existing PTY', {
        sessionId: params.sessionId,
      });
      this.completePromptHandoff(params.sessionId);
      return { reused: true };
    }
    this.spawn(params);
    return { reused: false };
  }

  /** Whether a live PTY exists for the session. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Current dimensions of a session's PTY, or null if no such session. */
  getSize(sessionId: string): { cols: number; rows: number } | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return { cols: entry.cols, rows: entry.rows };
  }

  /**
   * The opaque stream epoch for a session's LIVE PTY, or null if none exists
   * (#151). Stable for the life of one stream and distinct across respawns and
   * server restarts. The transport layer echoes it in the `attached` frame so
   * a reconnecting client can tell "same stream, resume" from "new stream, reset"
   * by equality alone — no offset/byte-count inference.
   */
  getEpoch(sessionId: string): string | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    return entry.epoch;
  }

  /** Write input (keystrokes) to the PTY. */
  write(sessionId: string, data: string | Buffer): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.exited) return;
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    entry.proc.write(text);
  }

  /** Pause prompt draining while a spawn/resume event hands off to the server
   * PTY lifecycle. Prompts accepted in the gap remain in the bounded FIFO. */
  beginPromptHandoff(sessionId: string): void {
    this.promptHandoffs.add(sessionId);
  }

  /** Finish an attach/reuse decision and drain the accepted FIFO into the live
   * PTY, if one exists. Idempotent so spawn paths may call it defensively. */
  completePromptHandoff(sessionId: string): void {
    this.promptHandoffs.delete(sessionId);
    this.drainPendingPrompts(sessionId);
  }

  /**
   * Accept one server-owned prompt into a bounded per-session FIFO.
   *
   * Every delivery, including steady-state delivery, passes through the same
   * queue. That prevents rapid send-mode prompts from interleaving their
   * body/Enter pairs. If no PTY exists yet (spawn/resume attach gap), the prompt
   * stays queued and spawn/spawnIfAbsent flushes it deterministically.
   *
   * This is the PTY-delivery half of `execution.prompt` (R17): text injected
   * INTO a live session's PTY, not an inert anchored message.
   *
   * @returns false only when a queue bound rejects the new delivery.
   */
  async deliverPrompt(
    sessionId: string,
    content: string,
    mode: 'send' | 'paste',
  ): Promise<boolean> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_PENDING_PROMPT_BYTES_PER_SESSION) {
      this.logger.warn('PtyHostService: dropping oversized pending prompt', {
        sessionId,
        bytes,
      });
      return false;
    }

    let queue = this.pendingPrompts.get(sessionId);
    if (!queue) {
      if (this.pendingPrompts.size >= MAX_PENDING_PROMPT_SESSIONS) {
        this.logger.warn('PtyHostService: pending prompt session limit reached', {
          sessionId,
        });
        return false;
      }
      queue = {
        deliveries: [],
        bytes: 0,
        draining: false,
        overflowWarned: false,
      };
      this.pendingPrompts.set(sessionId, queue);
    }

    if (
      queue.deliveries.length >= MAX_PENDING_PROMPTS_PER_SESSION ||
      queue.bytes + bytes > MAX_PENDING_PROMPT_BYTES_PER_SESSION
    ) {
      if (!queue.overflowWarned) {
        queue.overflowWarned = true;
        this.logger.warn('PtyHostService: pending prompt queue overflowed', {
          sessionId,
          prompts: queue.deliveries.length,
          bytes: queue.bytes,
        });
      }
      return false;
    }

    queue.deliveries.push({ content, mode, bytes });
    queue.bytes += bytes;
    this.drainPendingPrompts(sessionId);
    return true;
  }

  private drainPendingPrompts(sessionId: string): void {
    const queue = this.pendingPrompts.get(sessionId);
    if (
      !queue ||
      queue.draining ||
      this.promptHandoffs.has(sessionId) ||
      !this.sessions.has(sessionId)
    ) {
      return;
    }

    queue.draining = true;
    void (async () => {
      try {
        while (queue.deliveries.length > 0) {
          // Explicit stop may discard the queue while an earlier send waits.
          if (this.pendingPrompts.get(sessionId) !== queue) return;
          // A resume event pauses the remaining FIFO before replacing/reusing.
          if (this.promptHandoffs.has(sessionId)) return;
          const entry = this.sessions.get(sessionId);
          if (!entry || entry.exited) return;

          const delivery = queue.deliveries.shift();
          if (!delivery) return;
          queue.bytes -= delivery.bytes;
          await this.writePromptToEntry(sessionId, entry, delivery);
        }
      } catch (error) {
        this.logger.error(
          'PtyHostService: pending prompt delivery failed',
          error instanceof Error ? error : new Error(String(error)),
          { sessionId },
        );
      } finally {
        queue.draining = false;
        if (this.pendingPrompts.get(sessionId) !== queue) return;
        if (queue.deliveries.length === 0) {
          this.pendingPrompts.delete(sessionId);
        } else if (
          !this.promptHandoffs.has(sessionId) &&
          this.sessions.has(sessionId)
        ) {
          this.drainPendingPrompts(sessionId);
        }
      }
    })();
  }

  private async writePromptToEntry(
    sessionId: string,
    entry: PtyEntry,
    delivery: PendingPromptDelivery,
  ): Promise<void> {
    const text = delivery.content.replace(/[\r\n]+$/, '');
    if (delivery.mode === 'paste') {
      entry.proc.write(text);
      return;
    }

    if (text) {
      entry.proc.write(text);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Resume/replace can happen during the send delay. Keep the complete prompt
    // targeted to one process rather than pressing Enter in a fresh PTY.
    if (this.sessions.get(sessionId) !== entry || entry.exited) return;
    entry.proc.write('\r');
  }

  /** Resize the PTY. */
  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.exited) return;
    if (!cols || !rows || cols < 1 || rows < 1) return;
    if (cols > 1000 || rows > 1000) return;
    try {
      entry.proc.resize(cols, rows);
      entry.cols = cols;
      entry.rows = rows;
      entry.state.resize(cols, rows);
    } catch (err) {
      this.logger.warn('PtyHostService: resize failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Kill the PTY for a session.
   *
   * @param notify When true (the default, an explicit user stop), send a
   *   terminal {type:'exit'} frame so the client finalizes the terminal. When
   *   false (an internal replace/respawn), only close the sockets — the client
   *   reconnects and resumes onto the new PTY instead of finalizing.
   * @returns a {@link PtyKillOutcome} the explicit terminate caller uses to
   *   distinguish a clean kill from "nothing to kill" and from a genuine kill
   *   failure. Finalization (notify/close + delete) is UNCONDITIONAL regardless
   *   of the outcome, so internal callers can keep ignoring the return.
   */
  kill(sessionId: string, notify = true): PtyKillOutcome {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      if (notify) {
        this.pendingPrompts.delete(sessionId);
        this.promptHandoffs.delete(sessionId);
      }
      return 'not_found';
    }
    let outcome: PtyKillOutcome = 'killed';
    try {
      entry.proc.kill();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ESRCH') {
        // ESRCH ("no such process"): the PTY had already exited between our map
        // lookup and this signal (its async onExit had not fired yet to remove the
        // entry). Signalling an already-dead process reaches the exact end-state a
        // kill intends, so this is IDEMPOTENT SUCCESS — keep the 'killed' outcome
        // and log it as a benign race, NOT a warning. Finalization below is
        // unconditional either way.
        this.logger.debug('PtyHostService: PTY already exited before kill (ESRCH)', {
          sessionId,
        });
      } else {
        // A GENUINE kill-signal failure (e.g. EPERM). Cleanup below still runs, but
        // the signal really failed, so report 'error' — the explicit terminate
        // caller surfaces it as a distinguishable non-2xx (internal callers ignore
        // the outcome).
        this.logger.warn('PtyHostService: kill failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        outcome = 'error';
      }
    }
    if (notify) {
      this.notifyExit(entry, null);
      this.pendingPrompts.delete(sessionId);
      this.promptHandoffs.delete(sessionId);
    } else {
      this.closeSubscribers(entry);
    }
    entry.state.dispose();
    this.sessions.delete(sessionId);
    return outcome;
  }

  /**
   * Compute the scrollback to replay to a client resuming from raw byte
   * `fromOffset`, or null if there is no live PTY for the session (the caller
   * uses null as the "no such session, close 1011" signal).
   *
   * The returned slice's `base`, `gap`, and `next` are RAW byte offsets — the
   * same coordinate space as the live stream and the client's receive counter.
   * Only `data` is sanitized here: device QUERY/REPORT sequences are stripped so
   * replaying historical `ESC[6n`/`ESC[c` cannot make the client's xterm answer
   * them and post the replies back to the PTY as fake keystrokes. Stripping
   * SHORTENS `data` but MUST NOT move the offsets — the client snaps its receive
   * counter to `next` (raw), never to `base + data.length`, so sanitizing can
   * neither duplicate nor skip bytes on the next reconnect. The live stream
   * (proc.onData → safeSend) is never sanitized, so a running program's
   * real-time queries still reach the client and get answered.
   */
  getReplay(sessionId: string, fromOffset: number): ReplaySlice | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    // The ring already contains any coalesced-but-unsent bytes; flush them to
    // existing subscribers now so the slice boundary and the live stream agree.
    this.flushOutput(entry, sessionId);
    const slice = entry.output.replayFrom(fromOffset);
    return { ...slice, data: stripScrollbackDeviceQueries(slice.data) };
  }

  /**
   * Capture a coherent terminal-state snapshot at the current raw output
   * boundary. `next` and the mirror promise boundary are captured in the same
   * synchronous turn, so later output belongs exclusively to pending/live
   * delivery and cannot be duplicated in the snapshot.
   */
  getStateSnapshot(
    sessionId: string,
  ): Promise<{ next: number; data: Buffer; cols: number; rows: number }> | null {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    const next = entry.output.totalBytes;
    const cols = entry.cols;
    const rows = entry.rows;
    return entry.state.snapshot().then((data) => ({ next, data, cols, rows }));
  }

  /**
   * Subscribe a sink to a session's LIVE output. Join-only: scrollback replay is
   * handled separately by {@link getReplay} + the {@link attach} handshake,
   * which keeps offset accounting outside the live fan-out. Returns false if no
   * such session exists.
   */
  addSubscriber(sessionId: string, sink: FrameSink): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    // Flush before attaching: this sink's replay already covers everything in
    // the ring (incl. coalesced bytes), so it must not receive them again live.
    this.flushOutput(entry, sessionId);
    entry.subscribers.add(sink);
    return true;
  }

  /**
   * Join in buffering mode before awaiting a state snapshot. Every output chunk
   * produced after the snapshot boundary is retained until activation.
   */
  addPendingSubscriber(sessionId: string, sink: FrameSink): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    // Flush so the pending backlog starts exactly at the snapshot boundary —
    // coalesced pre-registration bytes belong to the snapshot, not the backlog.
    this.flushOutput(entry, sessionId);
    entry.pendingSubscribers.set(sink, { chunks: [], bytes: 0 });
    return true;
  }

  /**
   * Flush output accumulated during snapshot generation and atomically promote
   * the sink to the ordinary live fan-out set.
   */
  activatePendingSubscriber(sessionId: string, sink: FrameSink): boolean {
    const entry = this.sessions.get(sessionId);
    const pending = entry?.pendingSubscribers.get(sink);
    if (!entry || !pending || sink.readyState !== 1) return false;
    for (const chunk of pending.chunks) this.safeSend(sink, chunk);
    entry.pendingSubscribers.delete(sink);
    entry.subscribers.add(sink);
    return true;
  }

  /** Remove a sink subscriber. */
  removeSubscriber(sessionId: string, sink: FrameSink): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.subscribers.delete(sink);
    entry.pendingSubscribers.delete(sink);
  }

  /**
   * High-level attach seam: resolve the resume point for a (re)connecting sink
   * at raw byte `fromOffset`, deliver the sanitized scrollback THROUGH the sink,
   * and join it to the live fan-out — returning the resume-handshake metadata.
   * Returns null when there is no live PTY (the transport closes 1011).
   *
   * This composes the exactly-once accounting old maestro's PtyWebSocketServer
   * proved (getReplay → optional snapshot → subscribe). ORDERING INVARIANT
   * (#150): on the no-gap path there is NO await between the getReplay boundary
   * and the addSubscriber join — node-pty output arrives on a separate loop
   * task, so keeping this sequence synchronous guarantees every byte < next is
   * in the replay and every byte >= next is delivered live, with no overlap and
   * no hole. Do not introduce an await into that branch.
   */
  async attach(
    sessionId: string,
    sink: FrameSink,
    fromOffset: number,
  ): Promise<AttachResult | null> {
    // getReplay both proves the PTY still exists (null → nothing to attach to)
    // and computes the exact delta to replay.
    const replay = this.getReplay(sessionId, fromOffset);
    if (!replay) return null;

    // An evicted raw prefix is not a valid terminal program (it can begin mid
    // CSI and omit the alt-screen/mode setup). Buffer live output, capture the
    // headless mirror at this boundary, replay that complete state, flush.
    if (replay.gap > 0) {
      if (!this.addPendingSubscriber(sessionId, sink)) return null;
      const snapshotPromise = this.getStateSnapshot(sessionId);
      if (!snapshotPromise) {
        this.removeSubscriber(sessionId, sink);
        return null;
      }
      const epoch = this.getEpoch(sessionId) ?? '';
      let snapshot: { next: number; data: Buffer; cols: number; rows: number };
      try {
        snapshot = await snapshotPromise;
      } catch (error) {
        this.removeSubscriber(sessionId, sink);
        this.logger.error(
          'PtyHostService: failed to serialize terminal-state replay',
          error instanceof Error ? error : new Error(String(error)),
          { sessionId },
        );
        return null;
      }
      if (snapshot.data.length > 0) this.safeSend(sink, snapshot.data);
      if (!this.activatePendingSubscriber(sessionId, sink)) return null;
      this.logger.warn('PtyHostService: replay gap restored from terminal-state snapshot', {
        sessionId,
        gap: replay.gap,
      });
      return {
        base: snapshot.next,
        gap: replay.gap,
        next: snapshot.next,
        replay: snapshot.data,
        replayKind: 'snapshot',
        epoch,
        cols: snapshot.cols,
        rows: snapshot.rows,
      };
    }

    // No-gap path — SYNCHRONOUS from here to the join (see ordering invariant).
    const size = this.getSize(sessionId);
    const epoch = this.getEpoch(sessionId) ?? '';
    if (replay.data.length > 0) this.safeSend(sink, replay.data); // scrollback first
    const attached = this.addSubscriber(sessionId, sink); // then live
    if (!attached) return null;
    return {
      base: replay.base,
      gap: replay.gap,
      next: replay.next,
      replay: replay.data,
      replayKind: 'delta',
      epoch,
      cols: size?.cols ?? DEFAULT_COLS,
      rows: size?.rows ?? DEFAULT_ROWS,
    };
  }

  /**
   * Convenience live-only subscription: adapt an `onFrame` callback into a
   * {@link FrameSink} joined to the live fan-out, returning an unsubscribe fn
   * (or null if no live session). Each coalesced live frame — and the terminal
   * `{type:'exit'}` frame on process exit — is delivered to `onFrame`.
   * Scrollback replay is a separate concern; use {@link attach} for that.
   */
  onFrames(sessionId: string, onFrame: (frame: Buffer) => void): (() => void) | null {
    const sink: FrameSink = {
      send: (data) => onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')),
      close: () => {},
      readyState: 1,
    };
    if (!this.addSubscriber(sessionId, sink)) return null;
    return () => this.removeSubscriber(sessionId, sink);
  }

  /** Kill all PTYs (graceful shutdown). */
  shutdownAll(): void {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.kill(sessionId);
    }
    this.pendingPrompts.clear();
    this.promptHandoffs.clear();
  }

  /**
   * Send a terminal {type:'exit'} frame to every subscriber, then close and
   * detach them. Used by the natural-exit path and by an explicit kill(); the
   * replace/respawn path calls {@link closeSubscribers} directly so the client
   * only sees a socket close and reconnects onto the new PTY.
   */
  private notifyExit(entry: PtyEntry, exitCode: number | null): void {
    // Deliver any coalesced tail output before the exit frame — the client
    // treats {type:'exit'} as stream end and must have seen every byte first.
    this.flushOutput(entry);
    for (const sink of entry.subscribers) {
      this.safeSend(sink, JSON.stringify({ type: 'exit', exitCode }));
    }
    this.closeSubscribers(entry);
  }

  /** Close every subscriber socket and clear the set (no exit frame). */
  private closeSubscribers(entry: PtyEntry): void {
    this.flushOutput(entry);
    for (const sink of entry.subscribers) {
      try {
        sink.close();
      } catch {
        // ignore
      }
    }
    entry.subscribers.clear();
    for (const sink of entry.pendingSubscribers.keys()) {
      try {
        sink.close();
      } catch {
        // ignore
      }
    }
    entry.pendingSubscribers.clear();
  }

  /**
   * Deliver all coalesced output as one frame to live subscribers and append it
   * to pending-subscriber backlogs. MUST run before any attach/replay/snapshot
   * boundary and before exit frames — a boundary taken while bytes sit in
   * sendBuf would replay those bytes AND deliver them again on the next flush.
   */
  private flushOutput(entry: PtyEntry, sessionId?: string): void {
    if (entry.sendTimer !== null) {
      clearTimeout(entry.sendTimer);
      entry.sendTimer = null;
    }
    if (entry.sendBuf.length === 0) return;
    const frame = entry.sendBuf.length === 1 ? entry.sendBuf[0]! : Buffer.concat(entry.sendBuf);
    entry.sendBuf = [];
    entry.sendBytes = 0;
    for (const sink of entry.subscribers) {
      this.safeSend(sink, frame);
    }
    for (const [sink, pending] of entry.pendingSubscribers) {
      pending.chunks.push(frame);
      pending.bytes += frame.length;
      if (pending.bytes > MAX_PENDING_SNAPSHOT_BYTES) {
        entry.pendingSubscribers.delete(sink);
        this.logger.warn('PtyHostService: terminal snapshot backlog exceeded', {
          sessionId,
          bytes: pending.bytes,
        });
        try {
          sink.close(1013, 'terminal replay backlog exceeded');
        } catch {
          // ignore
        }
      }
    }
  }

  private safeSend(sink: FrameSink, data: string | Buffer): void {
    // 1 === WebSocket.OPEN
    if (sink.readyState !== 1) return;
    try {
      sink.send(data);
    } catch {
      // best effort; the sink's own close handler will detach it
    }
  }
}
