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

export { NODE_BOOT_ID, PtyHostService, stripScrollbackDeviceQueries } from './pty/PtyHostService.js';
export { OutputBuffer, type ReplaySlice } from './pty/OutputBuffer.js';
export { TerminalStateMirror } from './pty/TerminalStateMirror.js';
// Two-signal prompt-delivery completion bridge (honest delivery-saga settle —
// see PromptSettlementWaiter's own docs). Exported for the same reason
// W2MessageDeliveryAdapter is: only the server package can wire it into a real
// PtyHostService instance and a real delivery saga.
export {
  PromptSettlementWaiter,
  type PromptSettlementResult,
} from './pty/PromptSettlementWaiter.js';
// W2 B2: the pre-reserved delivery adapter. Exported (additively) because the
// server package is the only place that can supply its `authorize` guard, and
// the package `exports` map has no subpath — without this line the seam G04 cut
// for G11 is unreachable from the only code that can close it.
export {
  W2MessageDeliveryAdapter,
  type W2DeliveryAttempt,
  type W2DeliveryBinding,
  type W2DeliveryClaim,
  type W2DeliveryOutcome,
  type W2MessageDeliveryAdapterOptions,
  type W2PtyWriteAttempt,
} from './pty/w2-message-delivery.js';
export type {
  AttachResult,
  FrameSink,
  Logger,
  PtyHostOptions,
  PtyActivity,
  PtyExitInfo,
  PtyKillOutcome,
  PtySessionStatus,
  PtySpawnParams,
} from './pty/types.js';

export * from './spawn/index.js';
export * from './worktree/index.js';
// The vendor-login (Tier B credential) block. Its own barrel rather than part
// of `spawn/`, so that importing a login primitive is a deliberate act and a
// reader can see at the import site which of the two environments is in play.
export * from './credentials/index.js';
export {
  readBranchTopology,
  type BranchTopology,
  type BranchTopologyEntry,
  type BranchTopologyOptions,
} from './git/branch-topology.js';

// Agent transcript digest — reads the agent's OWN native JSONL (claude
// ~/.claude/projects, codex ~/.codex/sessions) and normalizes both dialects to
// one shape. This is the "what the agent SAID" surface; it is deliberately NOT
// the PTY ring (ANSI repaints a coordinator cannot read) and NOT the CLI
// journal (which holds no model output at all).
export {
  encodeClaudeProjectDir,
  readSessionTranscript,
  type ReadTranscriptOptions,
} from './transcript/read-transcript.js';

export const EXECUTION_PACKAGE = '@tm8/execution';
