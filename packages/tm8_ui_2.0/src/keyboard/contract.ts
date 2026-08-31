/**
 * THE KEYBOARD CONTRACT (LLD §7, WLT §5.8 exactly) — data, not behavior.
 *
 * L9: the keyboard map is a SPECIFIED CONTRACT, not an adaptation slot. Every
 * row in these tables is a unit test; the priority chain is what makes those
 * tests deterministic (nothing depends on listener order).
 *
 * Binding philosophy (R8-3): the guaranteed core is browser-proof — plain keys
 * and `g`-chords, which no browser owns. `Mod` chords are CONVENIENCES: they
 * ship only where the per-platform receive test passes, they are hidden from
 * the UI hints elsewhere, and every function bound to one also has a
 * plain-key / `g`-chord / palette path.
 */

export type Platform = 'mac' | 'other';

/** The six-layer priority chain, highest first (WLT §5.8). */
export type KeyLayer =
  /** 1. Browser/OS — NEVER intercepted. */
  | 'browser'
  /** 2. Topmost modal / dropdown / palette. */
  | 'modal'
  /** 3. Focused terminal while contentSurface=terminal. */
  | 'terminal'
  /** 4. Text-entry control — all PLAIN-key bindings are dead here. */
  | 'text-entry'
  /** 5. Focused list / panel. */
  | 'focus'
  /** 6. Global chrome. */
  | 'global';

export const LAYER_ORDER: readonly KeyLayer[] = [
  'browser',
  'modal',
  'terminal',
  'text-entry',
  'focus',
  'global',
];

/**
 * Commands the controller EMITS. The keyboard module never navigates or acts
 * itself — the shell maps these to view/registry refs, so a menu edit can
 * never change a chord's meaning (WLT §5.8 closing rule).
 */
export type KeyCommand =
  | 'palette.open'
  | 'menu.toggle'
  | 'nav.view'
  | 'nav.kind'
  | 'list.next'
  | 'list.prev'
  | 'list.open'
  | 'list.primary'
  | 'list.create'
  | 'list.search'
  | 'board.colPrev'
  | 'board.colNext'
  | 'board.movePrev'
  | 'board.moveNext'
  | 'panel.pop'
  | 'panel.pin'
  | 'modal.close'
  | 'text.blur'
  | 'terminal.blur';

export interface Binding {
  id: string;
  layer: Exclude<KeyLayer, 'browser'>;
  /** Human-readable chord, the hint the UI shows. */
  keys: string;
  label: string;
  command: KeyCommand;
  /** A view name or kind slug — a REGISTRY/VIEW REF, never a menu position. */
  ref?: string;
  /**
   * `true` ⇒ browser-proof by construction (plain key or `g`-chord). A
   * guaranteed binding is always advertised. `false` ⇒ a `Mod` convenience,
   * advertised only where the receive test passes.
   */
  guaranteed: boolean;
  /** Matcher against a normalized key event. */
  match: KeyMatcher;
  /** Platforms where the browser owns this chord — never advertised there. */
  browserOwnedOn?: readonly Platform[];
}

/** A normalized key event — no DOM required, so every row is unit-testable. */
export interface KeyInput {
  key: string;
  /** Physical key. The terminal blur chord matches on THIS, layout-independent. */
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type KeyMatcher =
  | { type: 'plain'; key: string }
  | { type: 'chord'; lead: string; key: string }
  | { type: 'mod'; key: string; shift?: boolean }
  | { type: 'code'; code: string; ctrl: true };

/** `Mod` = Meta on macOS, Ctrl elsewhere. */
export function hasMod(input: KeyInput, platform: Platform): boolean {
  return platform === 'mac' ? input.metaKey : input.ctrlKey;
}

/**
 * HARD EXCLUSION LIST (WLT §5.8): the browser keeps these regardless of
 * `preventDefault`. No binding may use them, and the controller never
 * intercepts them — layer 1 wins by refusing to look.
 */
export function isBrowserReserved(input: KeyInput, platform: Platform): boolean {
  if (input.key === 'F11') return true;
  if (input.ctrlKey && input.key === 'Tab') return true;
  const mod = hasMod(input, platform);
  if (!mod) return false;
  const key = input.key.toLowerCase();
  if (key === 'w' || key === 't' || key === 'n' || key === 'l') return true;
  if (platform === 'mac' && key === 'q') return true;
  return false;
}

/**
 * The terminal escape contract (R5-5): physical `Ctrl+Backquote` on ALL
 * platforms — deliberately not `Mod`. Matched on `event.code` so keyboard
 * layout and IME cannot break it. Intercepted inside xterm's
 * `attachCustomKeyEventHandler`, so ZERO bytes reach the PTY.
 */
export function isTerminalBlurChord(input: KeyInput): boolean {
  return input.code === 'Backquote' && input.ctrlKey;
}

/**
 * The terminal PASTE chord — `Ctrl+V` / `Cmd+V`, plus the terminal-native
 * `Ctrl+Shift+V`.
 *
 * This one is NOT handled by us and NOT sent to the PTY: the caller returns
 * `false` from xterm's `attachCustomKeyEventHandler`, which bails out of
 * `_keyDown` BEFORE xterm calls `preventDefault`, so the BROWSER performs its
 * own paste and the resulting `paste` event reaches the terminal's existing
 * clipboard handler.
 *
 * Why it must work this way, and not via `navigator.clipboard.readText()`:
 * without this, xterm's default keymap turns `Ctrl+V` into `^H`-style control
 * output (`0x16`) and cancels the event, so no `paste` event is ever emitted.
 * The obvious repair — read the clipboard ourselves — fails in exactly the
 * situation that reported this bug: the UI is served over plain HTTP on a
 * LAN/tailnet address, which is NOT a secure context, so the async Clipboard
 * API is `undefined` there. Letting the browser's native paste through needs
 * no Clipboard API and therefore works on http:// as well as https://.
 *
 * `Alt` is excluded so `Ctrl+Alt+V` still reaches the PTY. The cost is that a
 * literal `^V` (readline quoted-insert) can no longer be typed with `Ctrl+V`;
 * that is the same trade every browser terminal makes, and `Ctrl+Q` remains.
 */
export function isTerminalPasteChord(input: KeyInput): boolean {
  if (input.altKey) return false;
  if (input.key.toLowerCase() !== 'v') return false;
  return input.ctrlKey || input.metaKey;
}

/** The `g` chord lead. */
export const CHORD_LEAD = 'g';

/**
 * D16: the `g`-chord window. The LLD leaves the duration to build time; 1500ms
 * is long enough to be typed deliberately and short enough that a forgotten
 * lead does not swallow a later keystroke. The window is visible while open.
 */
export const CHORD_WINDOW_MS = 1500;

const chord = (key: string): KeyMatcher => ({ type: 'chord', lead: CHORD_LEAD, key });

/**
 * THE TABLE. Order within the array is irrelevant — the LAYER decides
 * precedence, never registration order.
 */
export const BINDINGS: readonly Binding[] = [
  // -- Global ---------------------------------------------------------------
  {
    id: 'palette.slash',
    layer: 'global',
    keys: '/',
    label: 'Command palette',
    command: 'palette.open',
    guaranteed: true,
    match: { type: 'plain', key: '/' },
  },
  {
    id: 'palette.mod-k',
    layer: 'global',
    keys: 'Mod+K',
    label: 'Command palette',
    command: 'palette.open',
    guaranteed: false,
    // Chrome on Windows/Linux and Firefox everywhere own Mod+K (browser search).
    browserOwnedOn: ['other'],
    match: { type: 'mod', key: 'k' },
  },
  {
    id: 'menu.toggle',
    layer: 'global',
    keys: 'Mod+\\',
    label: 'Toggle menu rail',
    command: 'menu.toggle',
    guaranteed: false,
    match: { type: 'mod', key: '\\' },
  },
  { id: 'g.home', layer: 'global', keys: 'g h', label: 'Home', command: 'nav.view', ref: 'home', guaranteed: true, match: chord('h') },
  { id: 'g.tasks', layer: 'global', keys: 'g t', label: 'Tasks', command: 'nav.kind', ref: 'tasks', guaranteed: true, match: chord('t') },
  { id: 'g.sessions', layer: 'global', keys: 'g s', label: 'Sessions', command: 'nav.kind', ref: 'sessions', guaranteed: true, match: chord('s') },
  { id: 'g.docs', layer: 'global', keys: 'g d', label: 'Docs', command: 'nav.kind', ref: 'docs', guaranteed: true, match: chord('d') },
  { id: 'g.teammates', layer: 'global', keys: 'g m', label: 'Teammates', command: 'nav.kind', ref: 'teammates', guaranteed: true, match: chord('m') },
  { id: 'g.projects', layer: 'global', keys: 'g p', label: 'Projects', command: 'nav.kind', ref: 'projects', guaranteed: true, match: chord('p') },
  { id: 'g.channels', layer: 'global', keys: 'g c', label: 'Channels', command: 'nav.view', ref: 'channels', guaranteed: true, match: chord('c') },
  { id: 'g.inbox', layer: 'global', keys: 'g i', label: 'Inbox', command: 'nav.view', ref: 'inbox', guaranteed: true, match: chord('i') },
  // `g r` for CodeBrain (SPEC §5.4) — `r` for *run*. `g b` reads as Board and
  // `g c` is taken by Channels.
  { id: 'g.codebrain', layer: 'global', keys: 'g r', label: 'CodeBrain', command: 'nav.view', ref: 'codebrain', guaranteed: true, match: chord('r') },
  // `g ,` is the GUARANTEED Settings path: Mod+, is browser Settings on
  // Chrome/macOS and Safari/macOS, so it is not bound at all.
  { id: 'g.settings', layer: 'global', keys: 'g ,', label: 'Settings', command: 'nav.view', ref: 'settings', guaranteed: true, match: chord(',') },

  // -- Lists ----------------------------------------------------------------
  { id: 'list.next.j', layer: 'focus', keys: 'j', label: 'Next item', command: 'list.next', guaranteed: true, match: { type: 'plain', key: 'j' } },
  { id: 'list.prev.k', layer: 'focus', keys: 'k', label: 'Previous item', command: 'list.prev', guaranteed: true, match: { type: 'plain', key: 'k' } },
  { id: 'list.next.arrow', layer: 'focus', keys: '↓', label: 'Next item', command: 'list.next', guaranteed: true, match: { type: 'plain', key: 'ArrowDown' } },
  { id: 'list.prev.arrow', layer: 'focus', keys: '↑', label: 'Previous item', command: 'list.prev', guaranteed: true, match: { type: 'plain', key: 'ArrowUp' } },
  { id: 'list.open', layer: 'focus', keys: 'Enter', label: 'Open', command: 'list.open', guaranteed: true, match: { type: 'plain', key: 'Enter' } },
  { id: 'list.primary', layer: 'focus', keys: 'Mod+Enter', label: 'Primary action', command: 'list.primary', guaranteed: false, match: { type: 'mod', key: 'Enter' } },
  { id: 'list.create', layer: 'focus', keys: 'c', label: 'Create in this kind', command: 'list.create', guaranteed: true, match: { type: 'plain', key: 'c' } },
  /**
   * D36 — in-panel list search is `f`, NOT `/`.
   *
   * T0-3 draws slash-focus on the panel's search field, and the obvious
   * reading is that layer 5 consumes `/` before layer 6's palette. That
   * reading breaks C6's load-bearing guarantee: WLT §5.8 publishes `/` as the
   * palette's GUARANTEED path precisely because ⌘K is browser-owned on Chrome
   * Windows/Linux and on Firefox everywhere. A focused list is the workspace's
   * most common focus state, so consuming `/` there would leave the palette
   * with NO reachable binding on half the supported matrix, in the state users
   * are in most of the time — and Esc does not rescue it, because at layer 5
   * Esc pops the panel stack rather than blurring to chrome.
   *
   * `f` (find) is a free, browser-proof plain key. The published contract stays
   * literally true, search gets a guaranteed path of its own, and the canvas
   * pixel is superseded the way D1 superseded the tab-bar toggle.
   *
   * Deliberately NOT bound: Mod+F. It is not on WLT's hard-exclusion list, but
   * every browser opens its own find bar on it — the contract never advertises
   * a chord the browser owns (R8-3).
   */
  { id: 'list.search', layer: 'focus', keys: 'f', label: 'Search this list', command: 'list.search', guaranteed: true, match: { type: 'plain', key: 'f' } },

  // -- Board (§8.1) — drag is never the only path -----------------------------
  // Column focus moves on plain ←/→ (aliases h/l); `list.next`/`list.prev`
  // keep working WITHIN the focused column. Card MOVES are Mod chords and
  // dispatch the SAME `set-state` routing as a drop — one command path for
  // pointer and keyboard, including `via:'complete'` into the Done sink.
  { id: 'board.colPrev.arrow', layer: 'focus', keys: '←', label: 'Previous column', command: 'board.colPrev', guaranteed: true, match: { type: 'plain', key: 'ArrowLeft' } },
  { id: 'board.colNext.arrow', layer: 'focus', keys: '→', label: 'Next column', command: 'board.colNext', guaranteed: true, match: { type: 'plain', key: 'ArrowRight' } },
  { id: 'board.colPrev.h', layer: 'focus', keys: 'h', label: 'Previous column', command: 'board.colPrev', guaranteed: true, match: { type: 'plain', key: 'h' } },
  { id: 'board.colNext.l', layer: 'focus', keys: 'l', label: 'Next column', command: 'board.colNext', guaranteed: true, match: { type: 'plain', key: 'l' } },
  { id: 'board.movePrev', layer: 'focus', keys: 'Mod+←', label: 'Move card left', command: 'board.movePrev', guaranteed: false, match: { type: 'mod', key: 'ArrowLeft' } },
  { id: 'board.moveNext', layer: 'focus', keys: 'Mod+→', label: 'Move card right', command: 'board.moveNext', guaranteed: false, match: { type: 'mod', key: 'ArrowRight' } },

  // -- Panels ---------------------------------------------------------------
  { id: 'panel.pop', layer: 'focus', keys: 'Esc', label: 'Close panel', command: 'panel.pop', guaranteed: true, match: { type: 'plain', key: 'Escape' } },
  // Plain `p` — the withdrawn ⌘. binding's replacement (⌘. is Stop on Firefox/macOS).
  { id: 'panel.pin', layer: 'focus', keys: 'p', label: 'Pin / unpin panel', command: 'panel.pin', guaranteed: true, match: { type: 'plain', key: 'p' } },

  // -- Modal ----------------------------------------------------------------
  // Esc closes ONLY the topmost surface; it never also pops the panel stack.
  { id: 'modal.close', layer: 'modal', keys: 'Esc', label: 'Close', command: 'modal.close', guaranteed: true, match: { type: 'plain', key: 'Escape' } },

  // -- Text entry -----------------------------------------------------------
  // The ONLY plain key alive inside a text-entry control: Esc blurs, consumed.
  { id: 'text.blur', layer: 'text-entry', keys: 'Esc', label: 'Leave this field', command: 'text.blur', guaranteed: true, match: { type: 'plain', key: 'Escape' } },
  { id: 'text.palette', layer: 'text-entry', keys: 'Mod+K', label: 'Command palette', command: 'palette.open', guaranteed: false, browserOwnedOn: ['other'], match: { type: 'mod', key: 'k' } },

  // -- Terminal -------------------------------------------------------------
  {
    id: 'terminal.blur',
    layer: 'terminal',
    keys: 'Ctrl+`',
    label: 'Exit terminal',
    command: 'terminal.blur',
    guaranteed: true,
    match: { type: 'code', code: 'Backquote', ctrl: true },
  },
];

/**
 * Whether a binding's hint may be SHOWN on this platform. The contract never
 * advertises a chord the browser owns (R8-3) — the guaranteed plain-key or
 * `g`-chord path is what the UI shows instead.
 */
export function isAdvertised(binding: Binding, platform: Platform): boolean {
  if (binding.guaranteed) return true;
  return !(binding.browserOwnedOn ?? []).includes(platform);
}
