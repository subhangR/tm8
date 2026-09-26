import type { IDisposable, Terminal } from '@xterm/xterm';

import { copyToClipboardOrWarn } from './domUtils.js';

/**
 * OSC 52 — "set the clipboard" — for the web terminal.
 *
 * Why this exists: Claude Code (2.1.x) runs full-screen in the alt screen and
 * turns on mouse tracking (`?1000h ?1002h ?1003h ?1006h`), so a drag inside the
 * terminal goes to the AGENT, not to xterm.js's own selection. The agent draws
 * its own selection and copies it in one of two ways: through the OS
 * clipboard of the machine it runs on, or by emitting OSC 52
 * (`ESC ] 52 ; c ; <base64> BEL`) so the terminal emulator puts the text in
 * the clipboard. When tm8 runs on your laptop the first path works, because
 * the agent's machine and your browser's machine are the same one. On a
 * server that path writes a headless box's clipboard, which leaves only OSC 52,
 * and xterm.js ignores OSC 52 unless someone registers a handler for it. That
 * is the "copy works locally, not on the server" report.
 *
 * WRITE ONLY. A `?` payload asks the terminal to REPORT the clipboard back to
 * the program, which would let anything running in the PTY read the viewer's
 * clipboard. That request is swallowed and never answered.
 *
 * Only a copy the viewer asked for. Any program in the PTY can emit OSC 52, so
 * a write is honoured only when:
 *   - the terminal is interactive (a read-only viewer watching someone else
 *     drive never has its clipboard overwritten),
 *   - the bytes are LIVE output, not replayed scrollback (a reconnect replays
 *     the ring, and an old copy must not land in the clipboard again), and
 *   - the viewer pressed a key or a pointer in THIS terminal within
 *     {@link OSC52_GESTURE_WINDOW_MS}. The Clipboard API wants recent user
 *     activation anyway, and background sessions get no say.
 */
export const OSC52_GESTURE_WINDOW_MS = 5_000;

/**
 * Decode the `Pc;Pd` body of an OSC 52 sequence into the text to copy.
 * Returns null for a clipboard READ request (`?`), a clear request (empty
 * `Pd`), and anything that is not valid base64 of UTF-8.
 */
export function decodeOsc52(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const payload = data.slice(separator + 1).trim();
  if (payload === '' || payload === '?') return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface Osc52Options {
  /** Where the viewer's gestures for this terminal land (its host element). */
  readonly element: HTMLElement;
  /** True while the terminal must not act for the viewer (view-only mode). */
  readonly isReadOnly: () => boolean;
  /** True while the bytes being parsed are replayed scrollback. */
  readonly isReplaying: () => boolean;
  readonly now?: () => number;
  readonly copy?: (text: string) => unknown;
}

/** Attach the OSC 52 handler to a terminal. */
export function attachOsc52Clipboard(term: Terminal, options: Osc52Options): IDisposable {
  const now = options.now ?? (() => Date.now());
  const copy = options.copy ?? ((text: string) => copyToClipboardOrWarn(text, 'Selection'));
  const { element } = options;

  let lastGestureAt = Number.NEGATIVE_INFINITY;
  // A drag that starts in this terminal may end outside it; the release is
  // the gesture the agent copies on, so it counts too.
  let pointerHeld = false;
  const markGesture = () => {
    lastGestureAt = now();
  };
  const onPointerDown = () => {
    pointerHeld = true;
    markGesture();
  };
  const onPointerUp = () => {
    if (!pointerHeld) return;
    pointerHeld = false;
    markGesture();
  };
  // A cancelled press (touch scroll, pointer lost) never gets its pointerup;
  // without this, the next pointerup ANYWHERE on the page — a click in another
  // panel — would count as a gesture for this terminal.
  const onPointerCancel = () => {
    pointerHeld = false;
  };
  element.addEventListener('pointerdown', onPointerDown, true);
  element.addEventListener('keydown', markGesture, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);

  const handler = term.parser.registerOscHandler(52, (data) => {
    // Always claim the sequence: xterm has nothing else to do with it.
    if (options.isReadOnly() || options.isReplaying()) return true;
    if (now() - lastGestureAt > OSC52_GESTURE_WINDOW_MS) return true;
    const text = decodeOsc52(data);
    if (text) void copy(text);
    return true;
  });

  return {
    dispose: () => {
      handler.dispose();
      element.removeEventListener('pointerdown', onPointerDown, true);
      element.removeEventListener('keydown', markGesture, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
    },
  };
}
