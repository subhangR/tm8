// @tm8/execution — server-side PTY host (the ONLY spawn path, AM-1/T-D21).
//
// LIFTED from old maestro's maestro-server/src (PtyHostService, OutputBuffer,
// TerminalStateMirror) with the operational scars preserved verbatim:
//   - runs under NODE, never bun (node-pty onData never fires under bun; bun
//     strips the spawn-helper exec bit)
//   - 16ms live-output frame coalescing (commit 07d504d) — the perf-parity bar
//   - 1 MiB offset-tracked scrollback ring + bounded pending/prompt buffers
//   - attach-with-offset-replay (delta or terminal-state snapshot on eviction)
//   - single-writer status transition on exit (R29)
//
// The old repo/file-store couplings (ILogger, SessionService, the `ws`
// WebSocket type) are stripped at the seam: logging + the exit-status sink
// arrive as plain params, and live delivery targets are structural FrameSinks.
// SpawnService + the server WS layer wire the real implementations later.
//
// The spawn block (G1A) sits on top: SpawnService composes the manifest
// IN-PROCESS — no CLI subprocess, no shared-disk handshake, unlike the old
// route it re-authors — and drives PtyHostService. It reaches the graph only
// through `GraphPort`, because this package has no database driver and must
// never gain one; the port is implemented over `Db` in the server package at
// src/facade/execution-handlers.ts.

export { PtyHostService, stripScrollbackDeviceQueries } from './pty/PtyHostService.js';
export { OutputBuffer, type ReplaySlice } from './pty/OutputBuffer.js';
export { TerminalStateMirror } from './pty/TerminalStateMirror.js';
export type {
  AttachResult,
  FrameSink,
  Logger,
  PtyHostOptions,
  PtyKillOutcome,
  PtySessionStatus,
  PtySpawnParams,
} from './pty/types.js';

export * from './spawn/index.js';

export const EXECUTION_PACKAGE = '@tm8/execution';
