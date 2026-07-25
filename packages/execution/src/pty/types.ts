// @tm8/execution — PTY host seam types.
//
// These interfaces are the clean seam that replaces old maestro's concrete
// couplings (ILogger, SessionService, and the `ws` WebSocket type) so the PTY
// host core carries none of the old repo/file-store imports. tm8's SpawnService
// + the server's WS layer wire the real implementations in through params.

/**
 * Outcome of {@link PtyHostService.kill}, so an EXPLICIT caller (the terminate
 * path) can distinguish the three cases it must report differently:
 *   - `killed`    a tracked PTY entry existed and the process is now gone; entry
 *                 finalized. Covers both proc.kill() succeeding AND the
 *                 already-exited race (ESRCH) — both reach the same end-state.
 *   - `not_found` no tracked PTY entry for the id; nothing to kill (a no-op).
 *   - `error`     a tracked entry existed but proc.kill() threw a GENUINE
 *                 failure (e.g. EPERM). The entry is STILL finalized.
 */
export type PtyKillOutcome = 'killed' | 'not_found' | 'error';

/** Terminal work-session status derived from PTY exit code (single-writer, R29). */
export type PtySessionStatus = 'completed' | 'failed';

/**
 * Minimal structured logger seam (shape-compatible with old maestro's ILogger).
 * Defaults to a no-op inside the host when omitted.
 */
export interface Logger {
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * A live-output delivery target. Structurally satisfied by a `ws` WebSocket
 * (send/close/readyState), so the server WS layer passes real sockets; the
 * harness (and any in-process consumer) passes a plain object. `readyState`
 * follows the WebSocket convention: `1` === OPEN.
 */
export interface FrameSink {
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** Parameters for spawning a server-hosted PTY. */
export interface PtySpawnParams {
  sessionId: string;
  /** Full command line, run via `shell -c <command>`. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/**
 * Host construction options — ALL config arrives as plain params (no Config
 * object, no repo). The tunables default to the operational scars carried
 * verbatim from old maestro (16ms coalescing, 1 MiB output ring); override only
 * with a reason.
 */
export interface PtyHostOptions {
  logger?: Logger;
  /**
   * Single-writer status sink (R29). Called once when a PTY exits, with the
   * status derived from its exit code. tm8's SpawnService wires this to a graph
   * work-command; old maestro wrote it straight to the session file store.
   */
  onSessionStatus?: (sessionId: string, status: PtySessionStatus) => void | Promise<void>;
  /** Live output fan-out coalescing window (ms). SCAR: default 16. */
  coalesceMs?: number;
  /** Force a flush when this many bytes accumulate inside one window. Default 64 KiB. */
  coalesceMaxBytes?: number;
  /** Offset-tracked scrollback ring capacity (bytes). Default 1 MiB. */
  outputCapBytes?: number;
  /** Default shell when neither the spawn env nor process env sets SHELL. */
  defaultShell?: string;
}

/**
 * Result of {@link PtyHostService.attach}: the resume handshake metadata plus
 * the sanitized scrollback that was already delivered through the sink. All
 * offsets are RAW byte positions in the same coordinate space as the live
 * stream — `next` is the authoritative offset the client snaps its receive
 * counter to (NOT `base + replay.length`, which may be sanitized shorter).
 */
export interface AttachResult {
  base: number;
  gap: number;
  next: number;
  /** Sanitized scrollback bytes delivered to the sink before live frames (may be empty). */
  replay: Buffer;
  /** `delta` = raw offset replay; `snapshot` = an evicted prefix restored from serialized terminal state. */
  replayKind: 'delta' | 'snapshot';
  /** Opaque per-spawn stream identity (#151); equality-only on the wire. */
  epoch: string;
  cols: number;
  rows: number;
}
