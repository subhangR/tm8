/**
 * keyboard — the global key map.
 *
 *   ⌘K / Ctrl-K   toggle the command palette (state only; the palette UI is W2)
 *   ⌫ Backspace   pop the top Z3 panel (ignored while typing)
 *   Esc           close the palette, else pop the top panel
 *   g then …      view jumps: g-h home · g-t tasks · g-d docs (+ the rest below)
 *
 * The handler is pure-ish and injectable (`now`, `store`) so tests dispatch
 * plain objects instead of driving a real DOM. `createListKeyNav` is the
 * arrow-key helper collections (L4) wire into their own rows.
 */
import { useEffect } from 'react';
import type { KeyEventLike } from '../kit/listKeyNav';
import { useNavStore, type NavState, type ViewName } from '../stores/nav';

// DEF-15: createListKeyNav lives in kit/ (L0) so subsystems/collections don't
// import upward from shell — this re-export keeps existing consumers working.
export { createListKeyNav, type KeyEventLike, type ListKeyNavOptions } from '../kit/listKeyNav';

export const DEFAULT_VIEW_JUMPS: Record<string, ViewName> = {
  h: 'home',
  t: 'tasks',
  d: 'docs',
  m: 'team',
  k: 'tracking',
  g: 'graph',
  l: 'leaderboard',
  i: 'inbox',
  s: 'settings',
};

export const CHORD_TIMEOUT_MS = 1200;

/** True for text-entry targets, where ⌫ and `g` must stay literal characters. */
export function isTypingTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null;
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const role = el.getAttribute?.('role');
  return role === 'textbox';
}

export type KeyAction =
  | 'palette.toggle' | 'palette.close' | 'panel.pop'
  | 'chord.start' | 'chord.cancel' | `view.${ViewName}`;

export interface KeyboardOptions {
  now?: () => number;
  chordTimeoutMs?: number;
  viewJumps?: Record<string, ViewName>;
  /** Defaults to the nav store; injectable for tests. */
  store?: { getState: () => NavState };
  /** Fires for every action the map performed (telemetry / tests). */
  onAction?: (action: KeyAction) => void;
}

export interface KeyboardMap {
  /** Returns true when the event was consumed. */
  handle: (e: KeyEventLike) => boolean;
  /** Exposed so tests can assert the chord state machine. */
  pendingChord: () => string | null;
}

export function createKeyboardMap(opts: KeyboardOptions = {}): KeyboardMap {
  const now = opts.now ?? (() => Date.now());
  const timeout = opts.chordTimeoutMs ?? CHORD_TIMEOUT_MS;
  const jumps = opts.viewJumps ?? DEFAULT_VIEW_JUMPS;
  const store = opts.store ?? useNavStore;
  const emit = (a: KeyAction) => opts.onAction?.(a);

  let chord: { key: string; at: number } | null = null;

  const chordAlive = () => chord !== null && now() - chord.at <= timeout;

  return {
    pendingChord: () => (chordAlive() ? chord!.key : null),
    handle: (e) => {
      const state = store.getState();
      const key = e.key;
      const mod = Boolean(e.metaKey || e.ctrlKey);
      const consume = () => e.preventDefault?.();

      // ⌘K works everywhere, including inside the composer.
      if (mod && (key === 'k' || key === 'K')) {
        chord = null;
        state.togglePalette();
        emit('palette.toggle');
        consume();
        return true;
      }
      if (mod || e.altKey) return false;

      if (key === 'Escape') {
        chord = null;
        if (state.paletteOpen) {
          state.closePalette();
          emit('palette.close');
          consume();
          return true;
        }
        if (state.stack.length > 0) {
          state.popPanel();
          emit('panel.pop');
          consume();
          return true;
        }
        return false;
      }

      if (isTypingTarget(e.target)) { chord = null; return false; }

      // Second key of a `g …` chord.
      if (chordAlive() && chord!.key === 'g') {
        const view = jumps[key.toLowerCase()];
        chord = null;
        if (view) {
          state.setView(view);
          emit(`view.${view}` as KeyAction);
          consume();
          return true;
        }
        emit('chord.cancel');
        return false;
      }
      chord = null;

      if (key === 'g' || key === 'G') {
        chord = { key: 'g', at: now() };
        emit('chord.start');
        return true;
      }

      if (key === 'Backspace') {
        if (state.stack.length === 0) return false;
        state.popPanel();
        emit('panel.pop');
        consume();
        return true;
      }

      return false;
    },
  };
}

export interface KeyboardTarget {
  addEventListener: (type: 'keydown', cb: (e: KeyboardEvent) => void) => void;
  removeEventListener: (type: 'keydown', cb: (e: KeyboardEvent) => void) => void;
}

/** Attach the map to a DOM target. Returns the teardown. */
export function installKeyboard(target: KeyboardTarget, opts: KeyboardOptions = {}): () => void {
  const map = createKeyboardMap(opts);
  const handler = (e: KeyboardEvent) => { map.handle(e as unknown as KeyEventLike); };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}

/** React binding used by `ShellLayout`. */
export function useKeyboardMap(enabled = true, opts: KeyboardOptions = {}): void {
  const { now, chordTimeoutMs, viewJumps, store, onAction } = opts;
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    return installKeyboard(window, { now, chordTimeoutMs, viewJumps, store, onAction });
  }, [enabled, now, chordTimeoutMs, viewJumps, store, onAction]);
}
