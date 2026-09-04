/**
 * The terminal runtime — the single place the transport, the write scheduler and
 * the visibility driver are joined.
 *
 * Kept out of the React component on purpose: all three are module-level
 * singletons whose lifetime spans every mounted terminal, so wiring them inside
 * a component would re-register handlers on every mount (and, under StrictMode's
 * double-invoke, immediately duplicate them). `ensureTerminalRuntime()` is
 * idempotent and is the only initialization path.
 *
 * DATA FLOW
 *   ws binary frame
 *     → ptyTransport (decodes, advances the raw offset)
 *     → queueTerminalOutput (coalesces into an animation frame)
 *     → term.write
 *
 * The registry is what lets the scheduler and the visibility driver find a
 * session's xterm and its DOM element without React state — the DOM is the only
 * honest source of truth for what is on screen.
 */
import type { Terminal } from '@xterm/xterm';

import { markTerminalActivity } from '../activity.js';
import { ptyTransport } from './ptyTransport.js';
import {
  dropTerminalOutput,
  flushTerminalOutput,
  initTerminalWriteScheduler,
  queueTerminalOutput,
} from './writeScheduler.js';
import { forgetTerminalVisibility, startTerminalVisibilityDriver } from './visibilityDriver.js';

interface RegistryEntry {
  term: Terminal;
  hydrateReplay(data: string): void;
}

const registry = new Map<string, RegistryEntry>();
/**
 * Output that arrived before a session's terminal mounted. Bounded: a terminal
 * that never mounts would otherwise accumulate its whole stream here.
 */
interface PendingOutput {
  chunks: string[];
  bytes: number;
}
const pending = new Map<string, PendingOutput>();
/** Pending buffers whose next drain must use hidden replay hydration. */
const pendingReplayHydrations = new Set<string>();
const MAX_PENDING_CHUNKS = 256;
export const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function appendPending(id: string, data: string): void {
  const encoded = encoder.encode(data);
  let chunk = data;
  let chunkBytes = encoded.byteLength;
  if (encoded.byteLength > MAX_PENDING_BYTES) {
    // Start on a UTF-8 code-point boundary. Decoding from a continuation byte
    // would insert a replacement character and could make the retained string
    // slightly larger than the byte ceiling it is meant to enforce.
    let start = encoded.byteLength - MAX_PENDING_BYTES;
    while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
    chunk = decoder.decode(encoded.slice(start));
    chunkBytes = encoded.byteLength - start;
  }
  const value = pending.get(id) ?? { chunks: [], bytes: 0 };
  value.chunks.push(chunk);
  value.bytes += chunkBytes;
  while (
    value.chunks.length > 1
    && (value.chunks.length > MAX_PENDING_CHUNKS || value.bytes > MAX_PENDING_BYTES)
  ) {
    const removed = value.chunks.shift();
    if (removed !== undefined) value.bytes -= encoder.encode(removed).byteLength;
  }
  pending.set(id, value);
}

let started = false;

export function ensureTerminalRuntime(): void {
  if (started) return;
  started = true;

  initTerminalWriteScheduler({
    getTerm: (id) => {
      const entry = registry.get(id);
      if (!entry) return undefined;
      // `element` is undefined until term.open() has run; the scheduler treats
      // an unknown element as visible and simply writes, which is correct.
      return { write: (data: string) => entry.term.write(data), element: entry.term.element };
    },
    bufferPending: (id, data) => {
      appendPending(id, data);
    },
  });

  startTerminalVisibilityDriver({
    listTerminals: () =>
      Array.from(registry.entries()).map(([id, entry]) => ({ id, element: entry.term.element })),
    flush: flushTerminalOutput,
    suspend: (id) => ptyTransport.suspend(id),
    resume: (id) => ptyTransport.resume(id),
  });

  ptyTransport.onOutput((id, data) => {
    markTerminalActivity(id);
    queueTerminalOutput(id, data);
  });

  // The single display-only replay frame. It is NOT counted toward the resume
  // offset (attached.next already accounts for it) and it arrives AFTER any
  // reattach reset, so it simply paints like ordinary output.
  ptyTransport.onReplay((id, data) => {
    const entry = registry.get(id);
    if (entry) {
      // Flush already-arrived live output before the replay replaces/hydrates
      // the terminal. Protocol order is attached → replay → live.
      flushTerminalOutput(id);
      entry.hydrateReplay(data);
      return;
    }
    appendPending(id, data);
    pendingReplayHydrations.add(id);
  });

  // The stream identity changed (respawn, ring eviction, or a legacy rewind), so
  // what is on screen is no longer a prefix of the incoming stream. Clear the
  // terminal AND discard anything the scheduler still holds from the old stream —
  // writing those stale chunks after the reset would corrupt the repaint.
  ptyTransport.onReattach((id) => {
    dropTerminalOutput(id);
    pending.delete(id);
    pendingReplayHydrations.delete(id);
    registry.get(id)?.term.reset();
  });
}

/** Mount a session's terminal; returns the unregister function. */
export function registerTerminal(
  id: string,
  term: Terminal,
  hydrateReplay: (data: string) => void,
): () => void {
  ensureTerminalRuntime();
  registry.set(id, { term, hydrateReplay });
  // Drain anything that streamed in before this terminal existed.
  const buffered = pending.get(id);
  if (buffered) {
    pending.delete(id);
    if (pendingReplayHydrations.delete(id)) {
      hydrateReplay(buffered.chunks.join(''));
    } else {
      for (const chunk of buffered.chunks) term.write(chunk);
    }
  }
  return () => {
    // Only remove OUR entry: under StrictMode a remount can register the
    // replacement before this cleanup runs, and deleting unconditionally would
    // unregister the live terminal.
    if (registry.get(id)?.term === term) {
      registry.delete(id);
      // Single-mount teardown must be airtight: no disposed xterm or stale bytes
      // may remain reachable through module-level state when sessions switch.
      dropTerminalOutput(id);
      pending.delete(id);
      pendingReplayHydrations.delete(id);
      forgetTerminalVisibility(id);
    }
  };
}
