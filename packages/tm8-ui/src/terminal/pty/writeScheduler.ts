/**
 * Coalesces PTY output into per-session buffers and flushes them into xterm on an
 * animation-frame cadence, instead of one `term.write()` per transport frame.
 *
 * Ported from old maestro's terminalWriteScheduler. Why it matters: every mounted
 * terminal otherwise VT-parses and DOM-renders every chunk of every streaming
 * session on the one main thread. With N concurrent agents that is N× parse +
 * layout work while you are looking at one terminal. Here:
 *
 *  - VISIBLE terminals flush once per animation frame (all chunks joined into a
 *    single write — imperceptible latency, far fewer parser entries);
 *  - HIDDEN terminals flush at most once per HIDDEN_FLUSH_INTERVAL_MS, so an
 *    offscreen full-screen TUI repainting many times a second costs one big
 *    write per second instead of hundreds of small ones.
 *
 * Visibility is read from the DOM (including hidden ancestors), NOT from React
 * state — the DOM is the only source of truth for what is actually on screen.
 * NO DATA IS EVER DROPPED: buffers force-flush past MAX_BUFFERED_BYTES regardless
 * of visibility.
 */

import { isElementPaintable } from './elementVisibility.js';

export interface TerminalWriteTarget {
  /** The live xterm Terminal for a session id, if mounted. */
  getTerm(id: string): { write(data: string): void; element?: HTMLElement } | undefined;
  /** Fallback sink for a not-yet-mounted terminal. */
  bufferPending(id: string, data: string): void;
}

const HIDDEN_FLUSH_INTERVAL_MS = 1000;
const SAFETY_FLUSH_INTERVAL_MS = 1000;
/** Per session; past this we force-flush rather than buffer. Never dropped. */
const MAX_BUFFERED_BYTES = 1 << 20;

interface BufferEntry {
  chunks: string[];
  bytes: number;
}

let target: TerminalWriteTarget | null = null;
const buffers = new Map<string, BufferEntry>();
const lastHiddenFlushAt = new Map<string, number>();
let rafHandle: number | null = null;
let safetyTimer: number | null = null;

export function initTerminalWriteScheduler(t: TerminalWriteTarget): void {
  target = t;
}

function isElementHidden(term: { element?: HTMLElement }): boolean {
  const el = term.element;
  if (!el || !el.isConnected) return false; // unknown → treat as visible, just write
  return !isElementPaintable(el);
}

/**
 * Returns true when the entry has been fully disposed of and its buffer may be
 * deleted.
 *
 * LOAD-BEARING: the not-mounted branch also returns true — it drains into the
 * pending sink and leaves NO residual buffer. If it returned false, a
 * flush-then-suspend would preserve a resume offset ahead of bytes the terminal
 * never received: a silent hole with no gap marker, because the server's
 * accounting stays correct and the loss is purely client-side. Maestro pins this
 * with a regression test ("flushTerminalOutput drains to pending when the
 * terminal is unmounted"); the same invariant is asserted here.
 */
function flushSession(id: string, entry: BufferEntry, now: number, force: boolean): boolean {
  if (!target) return false;
  const term = target.getTerm(id);
  if (!term) {
    for (const chunk of entry.chunks) target.bufferPending(id, chunk);
    return true;
  }
  if (!force && entry.bytes < MAX_BUFFERED_BYTES && isElementHidden(term)) {
    const last = lastHiddenFlushAt.get(id) ?? 0;
    if (now - last < HIDDEN_FLUSH_INTERVAL_MS) return false;
    lastHiddenFlushAt.set(id, now);
  }
  term.write(entry.chunks.length === 1 ? (entry.chunks[0] ?? '') : entry.chunks.join(''));
  return true;
}

function flushAll(force = false): void {
  const now = Date.now();
  for (const [id, entry] of buffers) {
    if (flushSession(id, entry, now, force)) buffers.delete(id);
  }
  if (buffers.size === 0) {
    if (safetyTimer !== null) {
      window.clearInterval(safetyTimer);
      safetyTimer = null;
    }
  } else {
    scheduleFrame();
  }
}

function onFrame(): void {
  rafHandle = null;
  flushAll();
}

function scheduleFrame(): void {
  if (rafHandle === null) rafHandle = window.requestAnimationFrame(onFrame);
  if (safetyTimer === null) {
    // rAF pauses when the window is occluded or minimized; this keeps hidden
    // buffers draining so nothing piles up unboundedly in the background.
    safetyTimer = window.setInterval(() => flushAll(), SAFETY_FLUSH_INTERVAL_MS);
  }
}

/** Queue a PTY output chunk for coalesced delivery to its terminal. */
export function queueTerminalOutput(id: string, data: string): void {
  if (!target) return;
  let entry = buffers.get(id);
  if (!entry) {
    entry = { chunks: [], bytes: 0 };
    buffers.set(id, entry);
  }
  entry.chunks.push(data);
  entry.bytes += data.length;
  if (entry.bytes >= MAX_BUFFERED_BYTES) {
    // Oversized: write through immediately (hidden or not) — trade a paint for
    // guaranteed zero data loss.
    if (flushSession(id, entry, Date.now(), true)) buffers.delete(id);
    return;
  }
  scheduleFrame();
}

/**
 * Discard buffered output for a session. Used when the transport is about to
 * replay history, so stale queued chunks must not be written after the reset.
 */
export function dropTerminalOutput(id: string): void {
  buffers.delete(id);
  lastHiddenFlushAt.delete(id);
}

/** SYNCHRONOUSLY flush a session's buffer. Must run before suspend(). */
export function flushTerminalOutput(id: string): void {
  const entry = buffers.get(id);
  if (!entry) return;
  if (flushSession(id, entry, Date.now(), true)) buffers.delete(id);
}

/** Test-only: clear all buffers, timestamps and scheduled callbacks. */
export function __resetTerminalWriteScheduler(): void {
  buffers.clear();
  lastHiddenFlushAt.clear();
  if (rafHandle !== null) {
    window.cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
  if (safetyTimer !== null) {
    window.clearInterval(safetyTimer);
    safetyTimer = null;
  }
  target = null;
}
