/**
 * THE KEYBOARD CONTROLLER (LLD §7).
 *
 * ONE controller installed at the app root implements the 6-layer priority
 * chain. Each layer CONSUMES what it handles (`preventDefault` +
 * `stopPropagation`); NOTHING depends on listener order — which is exactly why
 * every row of the contract table is a deterministic unit test.
 *
 * The controller neither navigates nor mutates: it emits a `KeyCommand`. The
 * shell maps commands to view/registry refs, so a menu edit can never change
 * what a chord means.
 */
import {
  BINDINGS,
  CHORD_LEAD,
  CHORD_WINDOW_MS,
  hasMod,
  isBrowserReserved,
  isTerminalBlurChord,
  type Binding,
  type KeyCommand,
  type KeyInput,
  type KeyLayer,
  type Platform,
} from './contract';

export interface KeyboardContext {
  platform: Platform;
  /** Open modal / dropdown / palette surfaces. Only the topmost sees Esc. */
  modalDepth: number;
  /** A focused terminal owns the keyboard — but only while it is the surface. */
  terminalFocused: boolean;
  terminalSurface: 'terminal' | 'chat';
  /** Focus sits in an input / textarea / contenteditable / inline editor. */
  textEntry: boolean;
  /** A list or panel scope holds focus. */
  focusScope: boolean;
}

export type KeyRefusal =
  | 'browser-reserved'
  | 'terminal-owns'
  | 'dead-in-text-entry'
  | 'chord-open'
  | 'chord-cancelled'
  | 'no-binding';

export interface KeyResult {
  handled: boolean;
  /** `preventDefault` + `stopPropagation` — the layer consumed the event. */
  consumed: boolean;
  layer: KeyLayer | null;
  bindingId?: string;
  command?: KeyCommand;
  ref?: string;
  reason?: KeyRefusal;
}

export interface KeyboardControllerOptions {
  platform?: Platform;
  onCommand?: (command: KeyCommand, ref?: string) => void;
  /** Injected clock so the chord window is deterministic under test. */
  now?: () => number;
  chordWindowMs?: number;
}

export interface KeyboardController {
  handle(input: KeyInput): KeyResult;
  setContext(patch: Partial<KeyboardContext>): void;
  getContext(): KeyboardContext;
  /** The open chord lead, for the visible hint. `null` when no chord is open. */
  chordLead(): string | null;
  install(win?: Window): () => void;
}

const DEFAULT_CONTEXT: Omit<KeyboardContext, 'platform'> = {
  modalDepth: 0,
  terminalFocused: false,
  terminalSurface: 'terminal',
  textEntry: false,
  focusScope: false,
};

function matches(binding: Binding, input: KeyInput, platform: Platform, chordOpen: boolean): boolean {
  const m = binding.match;
  switch (m.type) {
    case 'plain':
      // A plain key is only a plain key when no modifier rides along.
      return (
        !chordOpen &&
        input.key === m.key &&
        !input.ctrlKey &&
        !input.metaKey &&
        !input.altKey
      );
    case 'chord':
      return chordOpen && input.key === m.key && !input.ctrlKey && !input.metaKey && !input.altKey;
    case 'mod':
      return (
        !chordOpen &&
        hasMod(input, platform) &&
        input.key.toLowerCase() === m.key.toLowerCase() &&
        (m.shift ?? false) === input.shiftKey
      );
    case 'code':
      return !chordOpen && input.code === m.code && input.ctrlKey;
  }
}

function findBinding(
  layer: KeyLayer,
  input: KeyInput,
  platform: Platform,
  chordOpen: boolean,
): Binding | null {
  return (
    BINDINGS.find((b) => b.layer === layer && matches(b, input, platform, chordOpen)) ?? null
  );
}

export function createKeyboardController(
  options: KeyboardControllerOptions = {},
): KeyboardController {
  const platform: Platform =
    options.platform ??
    (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? 'mac' : 'other');
  const now = options.now ?? (() => Date.now());
  const chordWindowMs = options.chordWindowMs ?? CHORD_WINDOW_MS;

  let context: KeyboardContext = { platform, ...DEFAULT_CONTEXT };
  let chordOpenedAt: number | null = null;

  const chordOpen = (): boolean => {
    if (chordOpenedAt === null) return false;
    if (now() - chordOpenedAt > chordWindowMs) {
      chordOpenedAt = null;
      return false;
    }
    return true;
  };

  const fire = (layer: KeyLayer, binding: Binding): KeyResult => {
    options.onCommand?.(binding.command, binding.ref);
    return {
      handled: true,
      consumed: true,
      layer,
      bindingId: binding.id,
      command: binding.command,
      ref: binding.ref,
    };
  };

  const handle = (input: KeyInput): KeyResult => {
    // -- Layer 1: browser/OS. Never intercepted, never consumed. -------------
    if (isBrowserReserved(input, context.platform)) {
      chordOpenedAt = null;
      return { handled: false, consumed: false, layer: 'browser', reason: 'browser-reserved' };
    }

    const open = chordOpen();

    // -- Layer 2: topmost modal / dropdown / palette. ------------------------
    // Esc closes ONLY that surface — it never also pops the panel stack.
    if (context.modalDepth > 0) {
      const binding = findBinding('modal', input, context.platform, open);
      if (binding) {
        chordOpenedAt = null;
        return fire('modal', binding);
      }
      // Anything else falls through: a palette has a text input of its own.
    }

    // -- Layer 3: focused terminal while contentSurface=terminal. ------------
    // A hidden pool lease grants NO keyboard authority — hence terminalFocused
    // AND the surface check, never one of them.
    if (context.terminalFocused && context.terminalSurface === 'terminal') {
      if (isTerminalBlurChord(input)) {
        const binding = findBinding('terminal', input, context.platform, false);
        chordOpenedAt = null;
        if (binding) return fire('terminal', binding);
      }
      // The terminal owns everything else: the app does nothing and does NOT
      // consume, so the keystroke reaches xterm and the PTY.
      chordOpenedAt = null;
      return { handled: false, consumed: false, layer: 'terminal', reason: 'terminal-owns' };
    }

    // -- Layer 4: text-entry controls. ---------------------------------------
    if (context.textEntry) {
      chordOpenedAt = null;
      const binding =
        findBinding('text-entry', input, context.platform, false) ??
        // Mod-chords stay live where receivable; plain keys do not.
        BINDINGS.find(
          (b) =>
            b.match.type === 'mod' &&
            b.layer !== 'text-entry' &&
            matches(b, input, context.platform, false),
        ) ??
        null;
      if (binding) return fire(binding.layer, binding);
      return { handled: false, consumed: false, layer: 'text-entry', reason: 'dead-in-text-entry' };
    }

    // -- The `g` chord machine (layers 5–6 only). ----------------------------
    if (open) {
      chordOpenedAt = null;
      const binding =
        findBinding('global', input, context.platform, true) ??
        findBinding('focus', input, context.platform, true);
      if (binding) return fire(binding.layer, binding);
      // Any non-mapped second key CANCELS the chord — and is consumed, so a
      // mistyped chord can never fall through and fire a plain-key binding.
      return { handled: false, consumed: true, layer: 'global', reason: 'chord-cancelled' };
    }

    if (
      input.key === CHORD_LEAD &&
      !input.ctrlKey &&
      !input.metaKey &&
      !input.altKey
    ) {
      chordOpenedAt = now();
      return { handled: true, consumed: true, layer: 'global', reason: 'chord-open' };
    }

    // -- Layer 5: focused list / panel. --------------------------------------
    if (context.focusScope) {
      const binding = findBinding('focus', input, context.platform, false);
      if (binding) return fire('focus', binding);
    }

    // -- Layer 6: global chrome. ---------------------------------------------
    const binding = findBinding('global', input, context.platform, false);
    if (binding) return fire('global', binding);

    return { handled: false, consumed: false, layer: null, reason: 'no-binding' };
  };

  return {
    handle,
    setContext(patch) {
      context = { ...context, ...patch };
    },
    getContext: () => context,
    chordLead: () => (chordOpen() ? CHORD_LEAD : null),
    install(win = window) {
      const listener = (event: KeyboardEvent) => {
        const result = handle({
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        });
        if (result.consumed) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      win.addEventListener('keydown', listener, true);
      return () => win.removeEventListener('keydown', listener, true);
    },
  };
}
