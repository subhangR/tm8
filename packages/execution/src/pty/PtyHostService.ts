import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { randomUUID } from 'node:crypto';
import { OutputBuffer, type ReplaySlice } from './OutputBuffer.js';
import { TerminalStateMirror } from './TerminalStateMirror.js';
import type {
  AttachResult,
  FrameSink,
  Logger,
  PtyExitInfo,
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
  /** Wall-clock ms of the LAST byte this PTY produced (updated in onData). The
   *  prompt-injection readiness gate watches this to wait for output quiescence
   *  before writing/submitting — an agent's TUI drains buffered input the instant
   *  the PTY exists, deep inside its 11–15s composer-boot window, so "the stream
   *  went quiet" is our best process-agnostic proxy for "the composer settled". */
  lastOutputAt: number;
  /** Whether this PTY has EVER been observed quiet for {@link PROMPT_COLD_IDLE_MS}.
   *  False means the agent is still booting, so the first prompt waits for real
   *  quiescence; once true the agent is up and later prompts use the short warm
   *  gate so messaging a busy agent is never stalled. Latches true, never back. */
  bootSettled: boolean;
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
  /** Correlation id for the two-signal completion callback (see
   *  {@link PtyHostOptions.onPromptSettled}). Undefined admits the delivery exactly
   *  as before — no completion signal fires for it. */
  deliveryId?: string;
}

/** Outcome `writePromptToEntry`'s closed loop concluded with, reported through
 *  {@link PtyHostOptions.onPromptSettled} for deliveries that carry a deliveryId. */
interface PromptDeliveryOutcome {
  outcome: 'delivered' | 'unknown';
  /** Present only for 'unknown' — always free text, never a code. */
  reason?: string;
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
//
// INTERACTION WITH THE CLOSED-LOOP SUBMIT (see writePromptToEntry): drainPendingPrompts
// is strictly serial per session, and one delivery can now legitimately hold the FIFO
// head for tens of seconds on a pathological cold spawn (a 45s readiness gate plus up
// to ~36s of bounded Enter-retry backoff, worst case ~82s) instead of the old fixed
// 200ms. That makes these count/byte bounds reachable during a single stuck delivery
// where they previously were not. This is accepted, not a bug to chase: overflow here
// is an HONEST refusal the caller can see and surface, which is strictly better than the
// pre-fix failure mode it replaces — a prompt silently stranded in the composer with a
// 'delivered' receipt. Do not add a mitigation for this without re-deriving why maestro
// main (the fix's origin) ships the same tradeoff unmitigated.
const MAX_PENDING_PROMPT_SESSIONS = 64;
const MAX_PENDING_PROMPTS_PER_SESSION = 32;
const MAX_PENDING_PROMPT_BYTES_PER_SESSION = 256 * 1024;

// --- Prompt-injection closed-loop tunables --------------------------------
// A server-owned prompt lands in the agent's composer but the trailing Enter can
// be swallowed: the agent's TUI drains queued input the instant the PTY exists,
// 11–15s before the composer can accept a submit, so an open-loop "write then
// press Enter after 200ms" often deposits the text and drops the newline. These
// constants drive a closed loop — gate on output quiescence, submit, verify the
// text left the cursor, and retry Enter (never the body) a bounded number of
// times — instead of that fixed blind delay.

// Measured against real agents (2026-07-27), injecting at spawn time exactly as
// drainPendingPrompts does. Claude Code's composer is not submit-capable until
// 11–15s after spawn; codex DISCARDS input written before it is ready. A gate of
// (300ms idle, 5s cap) released mid-boot and submitted 0/4 — indistinguishable
// from no fix at all. Waiting for genuine quiescence submitted 3/3 on claude-code
// and 2/2 on codex. Do not "tidy" these numbers without re-running that test.

/** Treat the stream as "settled" once it has been idle at least this long. */
const PROMPT_IDLE_MS = 300;
/** COLD gate: a PTY that has never been observed quiet is still booting its agent.
 *  1500ms of silence distinguishes "the composer settled" from the sub-second
 *  lulls a booting TUI has between redraws (300ms fires during boot). */
const PROMPT_COLD_IDLE_MS = 1500;
/** COLD cap, generous enough to cover the slowest measured agent boot. Only a
 *  never-yet-settled PTY can wait this long, so a stuck agent delays its own first
 *  prompt and nothing else. */
const PROMPT_COLD_READY_TIMEOUT_MS = 45000;
/** WARM cap. Once a PTY has been observed quiet its agent is up, so later prompts
 *  use the old short gate. This is what keeps "message an agent that is actively
 *  working" responsive: its output never falls quiet, so the gate must give up
 *  fast and let the agent queue the prompt itself, exactly as it did before. */
const PROMPT_WARM_READY_TIMEOUT_MS = 1000;
/** Cap on the shorter output-idle wait taken between writing the body and
 *  pressing Enter (let the composer echo the paste before we commit it). */
const PROMPT_PRE_SUBMIT_IDLE_TIMEOUT_MS = 1000;
/** UNCONDITIONAL floor between the last body byte and the submit Enter.
 *
 *  The idle wait above is NOT this: it measures silence since the last byte the
 *  PTY *produced*, and we reach it having just waited for exactly that silence —
 *  so at the instant we write the body the stream still looks idle and the wait
 *  returns immediately, putting the Enter microseconds behind the paste. A TUI
 *  mid-paste absorbs that Enter: the text stays in the composer, unsent, and the
 *  delivery looks like a silent no-op. Agent Orchestrator's tmux writer pauses
 *  the same ~300ms after the body and before the trailing Enter for the same
 *  reason. This floor RUNS FIRST; the idle wait may still extend it. */
const PROMPT_PRE_SUBMIT_MIN_MS = 300;
/** Largest single write handed to the PTY. One huge write can be truncated or
 *  reordered by the tty line discipline, so the body is paced in bounded pieces
 *  (same 16 KiB bound as the prior-art tmux writer). Split only on UTF-8
 *  code-point boundaries — a halved multi-byte char is corruption. */
const PROMPT_WRITE_CHUNK_BYTES = 16 * 1024;
/** Delay after the FIRST Enter before the first submit verification. Also the
 *  first entry of {@link PROMPT_SUBMIT_BACKOFF_MS}. */
const PROMPT_VERIFY_MS = 750;
/** Total number of Enter presses (initial + retries) before giving up. Sized so
 *  the retry window outlives a slow composer even when the readiness gate hit its
 *  cap and released early — a 3-press window expired ~2s before Claude Code became
 *  submit-capable, which is precisely how the first cut of this fix failed. */
const PROMPT_SUBMIT_ATTEMPTS = 10;
/** Wait before each verification, indexed by attempt. Backoff grows because a
 *  genuinely slow composer may simply need more time, and we must not machine-gun
 *  Enter; it then plateaus so the tail of the window stays long without the delay
 *  running away. */
const PROMPT_SUBMIT_BACKOFF_MS = [
  PROMPT_VERIFY_MS, 1200, 2000, 3000, 4000, 5000, 5000, 5000, 5000, 5000,
];
/** Longest run of trailing visible characters used as the "did our text leave the
 *  cursor?" anchor. Short enough to survive composer wrapping, long enough to be
 *  distinctive. */
const PROMPT_TAIL_TOKEN_MAX = 24;

/** Bracketed-paste framing the agent asked for when {@link TerminalStateMirror.bracketedPaste}. */
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
/** A pasted-content placeholder still sitting on screen (`[Pasted text #1 …]`,
 *  `[Pasted Content …]`) is POSITIVE evidence the prompt was not submitted. */
const PASTE_PLACEHOLDER_RE = /\[Pasted (text|Content)/i;

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
/**
 * A21: stable for the life of THIS process, rotated by restart. Minted at
 * module load so every reader in the process reports the same boot — a client
 * comparing it across `execution.liveness` reads distinguishes "same node,
 * session genuinely gone" from "node restarted, recorded statuses stale".
 */
export const NODE_BOOT_ID: string = randomUUID();

export class PtyHostService {
  private readonly sessions = new Map<string, PtyEntry>();
  private readonly bootWaiters = new Map<string, Set<(exit: PtyExitInfo) => void>>();
  private readonly pendingPrompts = new Map<string, PendingPromptQueue>();
  /** Spawn/resume events pause draining until the PTY lifecycle decision is
   * finished by spawn, spawnIfAbsent, or explicit reuse completion. */
  private readonly promptHandoffs = new Set<string>();

  private readonly logger: Logger;
  private readonly onSessionStatus?: (
    sessionId: string,
    status: PtySessionStatus,
    exitInfo: PtyExitInfo,
  ) => void | Promise<void>;
  private readonly onPromptSettled?: (
    sessionId: string,
    deliveryId: string,
    outcome: 'delivered' | 'unknown',
    reason?: string,
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
    // Enforce the node-not-bun invariant documented above at the moment it can
    // still be enforced. Under bun the failure is a PTY that spawns and emits
    // NOTHING — no error on either side, just an agent that never speaks —
    // which costs far more to diagnose than a refused boot.
    if ((process as { versions?: { bun?: string } }).versions?.bun !== undefined) {
      throw new Error(
        'PtyHostService requires node — under bun, node-pty onData never fires and ' +
          'the spawn-helper exec bit is stripped, so every PTY would be silently dead. ' +
          'Start the server with node.',
      );
    }
    this.logger = options.logger ?? NOOP_LOGGER;
    this.onSessionStatus = options.onSessionStatus;
    this.onPromptSettled = options.onPromptSettled;
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
      // The caller supplies the COMPLETE allowlisted child environment. Never
      // merge process.env here: that would leak database URLs and unrelated
      // operator secrets while the manifest audits only the curated names.
      env,
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
      lastOutputAt: Date.now(),
      bootSettled: false,
    };
    this.sessions.set(sessionId, entry);

    proc.onData((data: string | Buffer) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      // Ring buffers MUST stay synchronous — offset accounting, replay, and
      // snapshot boundaries all read them in the same turn as onData. Only the
      // socket fan-out below is coalesced.
      entry.output.append(chunk);
      entry.state.append(chunk);
      // Timestamp the stream so the prompt readiness gate can wait for it to fall
      // quiet before injecting a prompt/Enter.
      entry.lastOutputAt = Date.now();
      entry.sendBuf.push(chunk);
      entry.sendBytes += chunk.length;
      if (entry.sendBytes >= this.coalesceMaxBytes) {
        this.flushOutput(entry, sessionId);
      } else if (entry.sendTimer === null) {
        entry.sendTimer = setTimeout(() => this.flushOutput(entry, sessionId), this.coalesceMs);
      }
    });

    proc.onExit(({ exitCode, signal }) => {
      // node-pty fires onExit ASYNCHRONOUSLY, and killing a PTY still produces
      // this event later. If this session's slot was already replaced (respawn
      // installs a new entry) or removed (explicit kill), this is the OLD
      // process's late exit — it must not delete the freshly-installed entry or
      // stomp a status the stop path already set. Identity-check the live entry
      // before touching any shared state.
      if (this.sessions.get(sessionId) !== entry) return;
      entry.exited = true;
      entry.exitCode = exitCode;
      this.logger.info('PtyHostService: session PTY exited', { sessionId, exitCode, signal });
      const status: PtySessionStatus = exitCode === 0 ? 'completed' : 'failed';
      // The evidence, carried past this callback rather than collapsed here —
      // see PtyExitInfo. `signal` is `undefined`, not absent-by-omission, when
      // the process ended by return rather than by signal; normalised to
      // `null` so every consumer sees an explicit tri-state instead of two
      // different spellings of "no signal."
      const exitInfo: PtyExitInfo = { exitCode: exitCode ?? null, signal: signal ?? null };
      const waiters = this.bootWaiters.get(sessionId);
      if (waiters) {
        this.bootWaiters.delete(sessionId);
        for (const resolve of waiters) resolve(exitInfo);
      }
      // Single-writer status transition (R29): the host is the sole writer on
      // the exit path; the injected sink decides where it lands (tm8 → a graph
      // work-command; old maestro → the session file store).
      try {
        const result = this.onSessionStatus?.(sessionId, status, exitInfo);
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
      const queuedAtExit = this.pendingPrompts.get(sessionId);
      if (queuedAtExit) this.abandonQueuedPrompts(sessionId, queuedAtExit, 'session_exited_with_prompt_queued');
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

  /**
   * Hold spawn acknowledgement for a short boot window. `null` means the same
   * PTY stayed live for the whole window; an exit result means the process died
   * before the caller should claim that launch succeeded.
   */
  waitForBootSettlement(sessionId: string, settleMs: number): Promise<PtyExitInfo | null> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.exited) {
      return Promise.resolve({ exitCode: entry?.exitCode ?? null, signal: null });
    }
    if (settleMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const onExit = (exit: PtyExitInfo) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(exit);
      };
      const waiters = this.bootWaiters.get(sessionId) ?? new Set<(exit: PtyExitInfo) => void>();
      waiters.add(onExit);
      this.bootWaiters.set(sessionId, waiters);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        waiters.delete(onExit);
        if (waiters.size === 0) this.bootWaiters.delete(sessionId);
        const current = this.sessions.get(sessionId);
        resolve(current === entry && !entry.exited
          ? null
          : { exitCode: entry.exitCode, signal: null });
      }, settleMs);
    });
  }

  /** Whether a live PTY exists for the session. */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * A21 liveness seam: the session ids with a genuinely live PTY right now.
   *
   * `exited` entries are excluded — a PTY that has exited but not yet been
   * cleaned up is not a live terminal, and reporting it live is the exact
   * ghost `execution.liveness` exists to dispel.
   */
  liveSessionIds(): string[] {
    return [...this.sessions.entries()]
      .filter(([, entry]) => !entry.exited)
      .map(([sessionId]) => sessionId);
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
   * The returned promise resolves on ADMISSION only (accepted into the FIFO or
   * bound-rejected) — it does NOT wait for the closed loop to actually write or
   * verify anything, which can legitimately take from milliseconds to tens of
   * seconds. A caller that needs the REAL outcome (did the text actually leave
   * the composer) must pass `deliveryId` and read {@link PtyHostOptions.onPromptSettled}
   * instead of inferring it from this boolean — admitted=true means "queued",
   * not "delivered".
   *
   * @param deliveryId Correlation id for the two-signal completion callback.
   *   Omit to admit the delivery exactly as before with no completion signal.
   * @returns false only when a queue bound rejects the new delivery.
   */
  async deliverPrompt(
    sessionId: string,
    content: string,
    mode: 'send' | 'paste',
    deliveryId?: string,
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

    queue.deliveries.push({ content, mode, bytes, deliveryId });
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
          const result = await this.writePromptToEntry(sessionId, entry, delivery);
          // Completion signal (second of the two signals; admission already
          // resolved deliverPrompt's own promise). Only fires when the caller
          // supplied a deliveryId — omitting one keeps a delivery exactly as
          // fire-and-forget as before this change.
          if (delivery.deliveryId !== undefined) {
            this.reportPromptSettled(sessionId, delivery.deliveryId, result);
          }
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

  /**
   * Fire the two-signal completion callback, as 'unknown', for every delivery
   * STILL SITTING in a session's queue — never dequeued, so `writePromptToEntry`
   * never ran and never had a chance to report its own outcome.
   *
   * Every caller of `pendingPrompts.delete()`/`.clear()` in this class removes a
   * queue outright rather than draining it (explicit kill, natural exit,
   * shutdownAll) — and unlike those paths, a caller awaiting
   * {@link PtyHostOptions.onPromptSettled} for a still-queued deliveryId has no
   * other way to ever learn the delivery is not happening. Without this, that
   * caller's own completion-wait would hang forever instead of resolving to a
   * reported, honest 'unknown'.
   */
  private abandonQueuedPrompts(sessionId: string, queue: PendingPromptQueue, reason: string): void {
    for (const delivery of queue.deliveries) {
      if (delivery.deliveryId !== undefined) {
        this.reportPromptSettled(sessionId, delivery.deliveryId, { outcome: 'unknown', reason });
      }
    }
  }

  /**
   * Fire the two-signal completion callback for one delivery. Mirrors the
   * onSessionStatus dispatch in `spawn()`'s onExit handler exactly (try/catch a
   * sync throw, `.catch` an async rejection) so an injected consumer's own
   * failure can never take down the drain loop or duplicate a write — this is
   * report-only, there is nothing left to retry or undo from here.
   */
  private reportPromptSettled(
    sessionId: string,
    deliveryId: string,
    result: PromptDeliveryOutcome,
  ): void {
    try {
      const returned = this.onPromptSettled?.(sessionId, deliveryId, result.outcome, result.reason);
      if (returned && typeof (returned as Promise<void>).catch === 'function') {
        void (returned as Promise<void>).catch((err: unknown) =>
          this.logger.error(
            'PtyHostService: onPromptSettled handler failed',
            err instanceof Error ? err : new Error(String(err)),
            { sessionId, deliveryId },
          ),
        );
      }
    } catch (err) {
      this.logger.error(
        'PtyHostService: onPromptSettled handler failed',
        err instanceof Error ? err : new Error(String(err)),
        { sessionId, deliveryId },
      );
    }
  }

  /**
   * Deliver one prompt into a live PTY as a CLOSED LOOP.
   *
   * The old implementation was open-loop: write the body, wait a fixed 200ms,
   * press Enter once, done. That drops the newline whenever the agent's TUI is
   * still booting (it enables bracketed paste and drains queued input in its first
   * few hundred bytes, but cannot accept a submit until its composer is drawn
   * 11–15s later) — the text lands, the Enter is eaten, the prompt is silently
   * stranded in the input box. The loop below closes that gap:
   *   1. gate on output quiescence so we write into a settled composer,
   *   2. frame the body (bracketed paste when the agent asked for it) safely,
   *   3. for send mode, submit and then VERIFY the text left the cursor, retrying
   *      Enter — and ONLY Enter — a bounded number of times on positive evidence.
   *
   * Every `await` is followed by a liveness re-check (`this.sessions.get(...) ===
   * entry && !entry.exited`) so a resume/replace mid-delivery can never spill a
   * body or an Enter into a freshly-installed PTY, exactly as the old code guarded
   * its single pre-Enter check.
   *
   * Returns the {@link PromptDeliveryOutcome} the two-signal completion callback
   * reports (see {@link reportPromptSettled}) — 'delivered' only where the loop has
   * positive-or-by-design confidence the write landed (paste mode; a verified-gone
   * send), 'unknown' everywhere it does not (liveness lost mid-delivery; retries
   * exhausted with the text still verified present).
   */
  private async writePromptToEntry(
    sessionId: string,
    entry: PtyEntry,
    delivery: PendingPromptDelivery,
  ): Promise<PromptDeliveryOutcome> {
    // Strip a trailing newline the caller may have appended: the submit Enter
    // below is what commits a `send`, and a stray newline inside a bracketed-paste
    // block would break the framing. Then neutralize any embedded paste-END so the
    // payload can never terminate its own bracketed-paste block and hand the rest
    // of the bytes to the shell as keystrokes (lossless for real prompt text).
    const body = delivery.content
      .replace(/[\r\n]+$/, '')
      .split(BRACKETED_PASTE_END)
      .join('');

    // 1) Readiness gate. A PTY whose agent has never been seen quiet is still
    //    booting: wait for GENUINE quiescence, because writing early is what both
    //    strands the prompt (claude-code accepts the text but ignores the Enter)
    //    and loses it outright (codex discards pre-ready input). Once the agent has
    //    settled once, fall back to the short gate so a prompt sent to an actively
    //    working agent is not held behind the long cap.
    const cold = !entry.bootSettled;
    await this.waitForOutputIdle(
      entry,
      cold ? PROMPT_COLD_IDLE_MS : PROMPT_IDLE_MS,
      cold ? PROMPT_COLD_READY_TIMEOUT_MS : PROMPT_WARM_READY_TIMEOUT_MS,
    );
    if (this.sessions.get(sessionId) !== entry || entry.exited) {
      return { outcome: 'unknown', reason: 'session_replaced_or_exited' };
    }

    // 2) Content framing. Wrap in bracketed paste iff the agent turned it on.
    const framed = this.frameBody(entry, body);
    if (framed) this.writeChunked(entry, framed);

    // Paste mode never submits — the human presses Enter — so writing the body
    // IS this delivery's whole job; nothing further to verify.
    if (delivery.mode === 'paste') return { outcome: 'delivered' };

    // 3) Submit + verify + bounded Enter-only retry (send mode).
    return this.submitWithVerify(sessionId, entry, body);
  }

  /** Wrap `body` in bracketed-paste markers when the mirrored agent enabled that
   *  mode, otherwise write it raw. Empty bodies frame to nothing so a send with an
   *  empty body still falls through to a bare Enter (old behavior). */
  private frameBody(entry: PtyEntry, body: string): string {
    if (!body) return '';
    if (entry.state.bracketedPaste) {
      return BRACKETED_PASTE_START + body + BRACKETED_PASTE_END;
    }
    return body;
  }

  /** Hand `text` to the PTY in writes of at most {@link PROMPT_WRITE_CHUNK_BYTES},
   *  splitting only between UTF-8 code points so no multi-byte character is cut
   *  in half. Bodies under the bound take the single write they always did. */
  private writeChunked(entry: PtyEntry, text: string): void {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= PROMPT_WRITE_CHUNK_BYTES) {
      entry.proc.write(text);
      return;
    }
    for (let start = 0; start < buf.length; ) {
      let end = Math.min(start + PROMPT_WRITE_CHUNK_BYTES, buf.length);
      // Walk back off any UTF-8 continuation byte (0b10xxxxxx) so the split
      // lands on a character boundary.
      while (end > start + 1 && end < buf.length && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1;
      entry.proc.write(buf.subarray(start, end).toString('utf8'));
      start = end;
    }
  }

  /**
   * Resolve once the PTY has produced no output for at least `idleMs`, or once
   * `timeoutMs` has elapsed since the call — whichever comes first. Returns early
   * if the process exits. Polls rather than hooking onData: this runs off the hot
   * output path, the windows are coarse (hundreds of ms), and polling keeps the
   * check trivially exit-safe. Never wedges — the timeout is a hard ceiling.
   */
  private async waitForOutputIdle(
    entry: PtyEntry,
    idleMs: number,
    timeoutMs: number,
  ): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (entry.exited) return;
      const idle = Date.now() - entry.lastOutputAt;
      // Latch boot completion on any genuinely long quiet stretch, whichever gate
      // observed it: a PTY this quiet has finished starting its agent.
      if (idle >= PROMPT_COLD_IDLE_MS) entry.bootSettled = true;
      if (idle >= idleMs) return;
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) return;
      // Sleep just long enough to reach idleMs for the current quiet stretch, but
      // never past the overall ceiling. New output resets lastOutputAt and the
      // next iteration recomputes a fresh (larger) wait.
      const wait = Math.max(1, Math.min(idleMs - idle, remaining));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  /**
   * Press Enter, then confirm the prompt actually left the composer, retrying
   * Enter — and ONLY Enter, never the body — up to {@link PROMPT_SUBMIT_ATTEMPTS}
   * times on POSITIVE evidence the text is still parked at the cursor.
   *
   * SAFETY: a stray Enter into an agent that has already accepted the prompt can
   * confirm a highlighted permission-dialog option. So we retry ONLY when the
   * cursor band still contains our own text (or a live paste placeholder). If the
   * band is empty, unreadable, or simply no longer holds our token, we treat the
   * submit as done and STOP — inconclusive is never a reason to press Enter again.
   *
   * Returns the {@link PromptDeliveryOutcome} `writePromptToEntry` passes through
   * unchanged. The exhausted-retries case is the ONE outcome the whole two-signal
   * change exists for: reason is the literal string `'submit_unverified'` — the
   * exact word already used in the `logger.error` call below, so a durable settle
   * record and this service's own log agree on what happened.
   */
  private async submitWithVerify(
    sessionId: string,
    entry: PtyEntry,
    body: string,
  ): Promise<PromptDeliveryOutcome> {
    const isLive = (): boolean =>
      this.sessions.get(sessionId) === entry && !entry.exited;

    // The anchor we look for at the cursor: the last run of visible characters of
    // the body, ANSI/control-stripped and whitespace-collapsed. An empty token
    // (e.g. a body of pure control chars) means we cannot verify — we then submit
    // exactly once and never guess with a second blind Enter.
    const tailToken = this.computeTailToken(body);

    // Let the composer START echoing the paste before we commit it. The floor is
    // unconditional because the idle wait below cannot supply one: we arrive here
    // having just waited for output silence, so it observes that same silence and
    // returns instantly, landing the Enter on top of the paste (see
    // PROMPT_PRE_SUBMIT_MIN_MS). Only the floor is guaranteed; the idle wait then
    // extends it while the composer is still redrawing.
    if (body) await new Promise((resolve) => setTimeout(resolve, PROMPT_PRE_SUBMIT_MIN_MS));
    await this.waitForOutputIdle(entry, PROMPT_IDLE_MS, PROMPT_PRE_SUBMIT_IDLE_TIMEOUT_MS);
    if (!isLive()) return { outcome: 'unknown', reason: 'session_replaced_or_exited' };

    entry.proc.write('\r');
    // No anchor to verify against: this is the pre-existing blind-submit shape
    // (a body of pure control chars), unchanged from before this change — we
    // submit once and call it 'delivered', exactly as the old open-loop always
    // assumed, rather than inventing a new ambiguous case nothing measured.
    if (!tailToken) return { outcome: 'delivered' };

    for (let attempt = 1; attempt <= PROMPT_SUBMIT_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, PROMPT_SUBMIT_BACKOFF_MS[attempt - 1] ?? PROMPT_VERIFY_MS),
      );
      if (!isLive()) return { outcome: 'unknown', reason: 'session_replaced_or_exited' };

      const stillPresent = await this.promptStillAtCursor(entry, tailToken);
      if (!isLive()) return { outcome: 'unknown', reason: 'session_replaced_or_exited' };
      // Verified gone (or inconclusive/unreadable): stop — do NOT press again.
      if (!stillPresent) return { outcome: 'delivered' };

      // Still parked at the cursor: resend Enter, unless this was the last attempt.
      if (attempt < PROMPT_SUBMIT_ATTEMPTS) entry.proc.write('\r');
    }

    // Exhausted every attempt and our text is STILL sitting unsubmitted. Surface it
    // loudly instead of letting a swallowed prompt vanish — but do NOT resend the
    // body (a duplicated agent message is worse than a reported miss).
    this.logger.error(
      'PtyHostService: prompt not submitted after retries (text still at cursor)',
      new Error('prompt_delivery_failed'),
      { sessionId, reason: 'submit_unverified', attempts: PROMPT_SUBMIT_ATTEMPTS },
    );
    return { outcome: 'unknown', reason: 'submit_unverified' };
  }

  /** Last up-to-{@link PROMPT_TAIL_TOKEN_MAX} visible chars of the body, with ANSI
   *  escapes removed, other control chars flattened to spaces, and whitespace
   *  collapsed. '' when nothing printable remains. */
  private computeTailToken(body: string): string {
    const cleaned = body
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // strip CSI escape sequences
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, ' ') // flatten remaining control chars
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned ? cleaned.slice(-PROMPT_TAIL_TOKEN_MAX) : '';
  }

  /**
   * Whether our just-injected text is still parked at the cursor — i.e. NOT
   * submitted. True ONLY on positive evidence: the cursor band still contains the
   * tail token, or shows a live paste placeholder. Any inconclusive case (band
   * empty, unreadable, or no longer holding the token) returns false so the caller
   * never blind-retries an Enter.
   */
  private async promptStillAtCursor(entry: PtyEntry, tailToken: string): Promise<boolean> {
    let region: string;
    try {
      region = await entry.state.readCursorRegion();
    } catch {
      return false; // unreadable ⇒ inconclusive ⇒ do not retry
    }
    const normalized = region.replace(/\s+/g, ' ').trim();
    if (!normalized) return false;
    if (PASTE_PLACEHOLDER_RE.test(normalized)) return true;
    const token = tailToken.replace(/\s+/g, ' ').trim();
    if (!token) return false;
    return normalized.includes(token);
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
        const queuedNoEntry = this.pendingPrompts.get(sessionId);
        if (queuedNoEntry) this.abandonQueuedPrompts(sessionId, queuedNoEntry, 'session_killed_with_prompt_queued');
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
      const queuedAtKill = this.pendingPrompts.get(sessionId);
      if (queuedAtKill) this.abandonQueuedPrompts(sessionId, queuedAtKill, 'session_killed_with_prompt_queued');
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
   * ⚠ NOT the seam for a browser PTY WebSocket — use the primitives directly as
   * `packages/server/src/pty/pty-ws-server.ts` does. This method delivers the
   * replay THROUGH the sink BEFORE returning its metadata (replay-then-handshake).
   * The tm8 wire protocol is handshake-then-replay: the client must receive the
   * `attached` control frame and reset its xterm BEFORE a snapshot replay paints,
   * or the repaint lands in the old buffer and is then wiped by the reset. Reach
   * for this only for an in-process consumer that needs no separate handshake
   * (today: `harness/pty-harness.mjs`). Fixing the ordering here would change
   * behaviour the harness depends on, so it is left as-is with this warning.
   *
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
    // kill() above already abandons queues for sessions that had a live entry.
    // What is LEFT here is queued-before-any-spawn deliveries — a session id
    // that was never in `this.sessions` at all — which kill()'s loop never
    // touches, so they still need abandoning before this blanket clear.
    for (const [sessionId, queue] of this.pendingPrompts) {
      this.abandonQueuedPrompts(sessionId, queue, 'host_shutdown_with_prompt_queued');
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
