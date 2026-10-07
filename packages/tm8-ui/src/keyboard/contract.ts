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
  /**
   * 4. Text-entry control — all PLAIN-key bindings are dead here. Also entered
   * by a surface that owns its plain keys (`surfaceOwnsKeys`, from a
   * `[data-owns-keys]` ancestor — a drawing canvas): same dead plain keys, same
   * live Mod-chords, but not this layer's own `text.blur`.
   */
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
  | 'terminal.blur'
  /** Open the keyboard-shortcut help overlay. */
  | 'help.open'
  // -- Workspace (Work) ------------------------------------------------------
  // Emitted like every other command; the shell hands them to the mounted
  // Work view (`tab-workspace/keys.ts`), which owns tabs, drafts and the browser.
  | 'work.design.toggle'
  /** Focus the Work browser; `ref` (optional) is the kind to show in it first. */
  | 'work.browser.focus'
  | 'work.tab.next'
  | 'work.tab.prev'
  /** `ref` is the 1-based position; `9` is the LAST tab, as in every browser. */
  | 'work.tab.nth'
  | 'work.tab.close'
  /** `ref` is the kind to draft. */
  | 'work.create'
  | 'work.chat.focus'
  /** Launch a session on the open tab's entity (the list's own `r` does the selected row). */
  | 'work.launch'
  /** `ref` is the tab section: `entity`, `connections` or `messages`. */
  | 'work.tab.section'
  | 'work.tab.chat'
  | 'work.tab.fullscreen'
  /** Out of a focused terminal, or back into the visible one. */
  | 'terminal.toggle'
  // -- Launch card (the New session screen) -----------------------------------
  // Never emitted by the controller: the card handles its own keys
  // (`new-session/launch-keys.ts`); these name its rows in the help overlay.
  | 'launch.card'
  | 'launch.model'
  | 'launch.effort'
  | 'launch.permission'
  | 'launch.teammate'
  | 'launch.workdir'
  | 'launch.worktree'
  | 'launch.options'
  | 'launch.prompt'
  | 'launch.submit'
  | 'launch.menu.next'
  | 'launch.menu.prev';

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
  /**
   * `true` ⇒ the row is DOCUMENTATION of a key a surface handles itself (the
   * tab strip's Mod+Alt chords, the Work browser's own row cursor). The
   * controller never matches it; the help overlay still lists it, so the one
   * table stays the one place a shortcut is discoverable from.
   */
  surfaceOwned?: boolean;
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
  if (!input.ctrlKey) return false;
  if (input.code === 'Backquote') return true;
  return isTerminalToggleChord(input);
}

/** `Ctrl+]` — physical Ctrl, no other modifier. Leaves a terminal, or returns to one. */
export function isTerminalToggleChord(input: KeyInput): boolean {
  return input.code === 'BracketRight' && input.ctrlKey && !input.metaKey && !input.altKey && !input.shiftKey;
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

/** The `g` chord lead — GO somewhere. */
export const CHORD_LEAD = 'g';

/** The `n` chord lead — NEW: a creation draft of the named kind. */
export const CREATE_LEAD = 'n';

/** The `l` chord lead — LIST: show a kind in the Work browser and focus it. */
export const LIST_LEAD = 'l';

/** The `t` chord lead — TAB: an action on the open Work tab. */
export const TAB_LEAD = 't';

/** Every chord lead the controller opens a window for. */
export const CHORD_LEADS: readonly string[] = [CHORD_LEAD, CREATE_LEAD, LIST_LEAD, TAB_LEAD];

/**
 * D16: the `g`-chord window. The LLD leaves the duration to build time; 1500ms
 * is long enough to be typed deliberately and short enough that a forgotten
 * lead does not swallow a later keystroke. The window is visible while open.
 */
export const CHORD_WINDOW_MS = 1500;

const chord = (key: string): KeyMatcher => ({ type: 'chord', lead: CHORD_LEAD, key });
const createChord = (key: string): KeyMatcher => ({ type: 'chord', lead: CREATE_LEAD, key });
const listChord = (key: string): KeyMatcher => ({ type: 'chord', lead: LIST_LEAD, key });
const tabChord = (key: string): KeyMatcher => ({ type: 'chord', lead: TAB_LEAD, key });
const plain = (key: string): KeyMatcher => ({ type: 'plain', key });

/**
 * `l` + a kind letter shows that kind in the Work browser and moves focus into
 * it; `l l` focuses the browser as it is. Same letters as `n`.
 */
const LIST_CHORDS: readonly Binding[] = (
  [
    ['l', undefined, 'Focus the list'],
    ['t', 'task', 'List tasks'],
    ['d', 'doc', 'List docs'],
    ['s', 'work_session', 'List sessions'],
    ['c', 'chat', 'List chats'],
    ['f', 'form', 'List forms'],
    ['p', 'project', 'List projects'],
    ['x', 'drawing', 'List drawings'],
    ['m', 'team_member', 'List teammates'],
  ] as const
).map(([key, kind, label]) => ({
  id: `l.${kind ?? 'focus'}`,
  layer: 'global' as const,
  keys: `l ${key}`,
  label,
  command: 'work.browser.focus' as const,
  ...(kind ? { ref: kind } : {}),
  guaranteed: true,
  match: listChord(key),
}));

/** The `ref` prefix `l 1`…`l 9` send: the Nth kind in the icon rail's Pinned group. */
export const PIN_REF_PREFIX = 'pin:';

/**
 * `l 1`…`l 9` (user ruling, task 01a1156f): the Nth PINNED kind on the Work
 * icon rail, top to bottom — the same as clicking it, then focus the list. The
 * pins are the user's, so the label names the position, not a kind.
 */
const LIST_PIN_CHORDS: readonly Binding[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => ({
  id: `l.pin.${n}`,
  layer: 'global' as const,
  keys: `l ${n}`,
  label: `List pinned kind ${n}`,
  command: 'work.browser.focus' as const,
  ref: `${PIN_REF_PREFIX}${n}`,
  guaranteed: true,
  match: listChord(n),
}));

/**
 * `1`…`9` jump to a Work tab by position. Plain digits, not Mod+digit: Mod+1…9
 * is the browser's own tab switcher everywhere, so it is never bound.
 */
const TAB_NTH: readonly Binding[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => ({
  id: `work.tab.${n}`,
  layer: 'global' as const,
  keys: n,
  label: n === '9' ? 'Go to last tab' : `Go to tab ${n}`,
  command: 'work.tab.nth' as const,
  ref: n,
  guaranteed: true,
  match: plain(n),
}));

/**
 * `n` + a kind letter opens that kind's creation draft. The letters echo the
 * `g` chords where a kind has one (`g t` Tasks, `n t` New task), so one
 * mnemonic serves both. Mod+N is the browser's new window — never bound.
 */
const CREATE_CHORDS: readonly Binding[] = (
  [
    ['t', 'task', 'New task'],
    ['d', 'doc', 'New doc'],
    ['s', 'work_session', 'New session'],
    ['c', 'chat', 'New chat'],
    ['f', 'form', 'New form'],
    // No `n p`: projects have no Work creation draft (`canCreateKind`).
    ['x', 'drawing', 'New drawing'],
  ] as const
).map(([key, kind, label]) => ({
  id: `n.${kind}`,
  layer: 'global' as const,
  keys: `n ${key}`,
  label,
  command: 'work.create' as const,
  ref: kind,
  guaranteed: true,
  match: createChord(key),
}));

/**
 * THE LAUNCH CARD'S KEYS — one letter per control, live while focus is on the
 * card but NOT in its prompt or title (Esc gets you there, `i` goes back). The
 * card matches on these, and the help rows below are built from them, so the
 * overlay cannot name a letter the card does not answer to.
 */
export const LAUNCH_KEYS = {
  model: 'm',
  effort: 'e',
  permission: 'p',
  teammate: 'a',
  workdir: 'o',
  worktree: 'b',
  options: '.',
  prompt: 'i',
} as const;

export type LaunchKeyAction = keyof typeof LAUNCH_KEYS;

const LAUNCH_ROWS: readonly Binding[] = (
  [
    ['launch.card', 'Escape', 'Esc', 'Leave the prompt for the card (again: close the menu, then the card)'],
    ['launch.model', LAUNCH_KEYS.model, LAUNCH_KEYS.model, 'Model'],
    ['launch.effort', LAUNCH_KEYS.effort, LAUNCH_KEYS.effort, 'Cycle reasoning effort'],
    ['launch.permission', LAUNCH_KEYS.permission, LAUNCH_KEYS.permission, 'Permission mode'],
    ['launch.teammate', LAUNCH_KEYS.teammate, LAUNCH_KEYS.teammate, 'Teammate (agent)'],
    ['launch.workdir', LAUNCH_KEYS.workdir, LAUNCH_KEYS.workdir, 'Working directory'],
    ['launch.worktree', LAUNCH_KEYS.worktree, LAUNCH_KEYS.worktree, 'Worktree ⇄ current branch'],
    ['launch.options', LAUNCH_KEYS.options, LAUNCH_KEYS.options, 'More options (···)'],
    ['launch.prompt', LAUNCH_KEYS.prompt, LAUNCH_KEYS.prompt, 'Back into the prompt'],
    ['launch.submit', 'Enter', 'Enter', 'Launch'],
    ['launch.menu.next', 'ArrowDown', '↓', 'Next option in the open menu'],
    ['launch.menu.prev', 'ArrowUp', '↑', 'Previous option in the open menu'],
  ] as const
).map(([command, key, keys, label]) => ({
  id: command,
  layer: 'focus' as const,
  keys,
  label,
  command,
  guaranteed: true,
  surfaceOwned: true,
  match: plain(key),
}));

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
  {
    id: 'help.open',
    layer: 'global',
    keys: '?',
    label: 'Keyboard shortcuts',
    command: 'help.open',
    guaranteed: true,
    match: plain('?'),
  },
  // `g ,` is the GUARANTEED Settings path: Mod+, is browser Settings on
  // Chrome/macOS and Safari/macOS, so it is not bound at all.
  { id: 'g.settings', layer: 'global', keys: 'g ,', label: 'Settings', command: 'nav.view', ref: 'settings', guaranteed: true, match: chord(',') },

  // -- Workspace (Work) -------------------------------------------------------
  // Plain keys and chords only — browser-proof by construction, and dead while
  // typing (layer 4). Every one also has a pointer path in the Work view.
  { id: 'work.design', layer: 'global', keys: 'd', label: 'Toggle Design mode', command: 'work.design.toggle', guaranteed: true, match: plain('d') },
  ...LIST_CHORDS,
  ...LIST_PIN_CHORDS,
  { id: 'work.tab.next', layer: 'global', keys: ']', label: 'Next tab', command: 'work.tab.next', guaranteed: true, match: plain(']') },
  { id: 'work.tab.prev', layer: 'global', keys: '[', label: 'Previous tab', command: 'work.tab.prev', guaranteed: true, match: plain('[') },
  ...TAB_NTH,
  // Plain `w`, never Mod+W (browser-reserved: closes the browser tab).
  { id: 'work.tab.close', layer: 'global', keys: 'w', label: 'Close tab', command: 'work.tab.close', guaranteed: true, match: plain('w') },
  { id: 'work.chat', layer: 'global', keys: 'm', label: 'Focus chat', command: 'work.chat.focus', guaranteed: true, match: plain('m') },
  { id: 'work.launch', layer: 'global', keys: 'r', label: 'Launch a session on this', command: 'work.launch', guaranteed: true, match: plain('r') },
  // `t` + a letter: the open tab's own controls (the action strip's buttons).
  { id: 't.entity', layer: 'global', keys: 't e', label: 'Tab: details', command: 'work.tab.section', ref: 'entity', guaranteed: true, match: tabChord('e') },
  { id: 't.links', layer: 'global', keys: 't l', label: 'Tab: links', command: 'work.tab.section', ref: 'connections', guaranteed: true, match: tabChord('l') },
  { id: 't.messages', layer: 'global', keys: 't m', label: 'Tab: messages', command: 'work.tab.section', ref: 'messages', guaranteed: true, match: tabChord('m') },
  { id: 't.chat', layer: 'global', keys: 't c', label: 'Tab: open / close chat', command: 'work.tab.chat', guaranteed: true, match: tabChord('c') },
  { id: 't.fullscreen', layer: 'global', keys: 't f', label: 'Tab: full screen', command: 'work.tab.fullscreen', guaranteed: true, match: tabChord('f') },
  { id: 't.launch', layer: 'global', keys: 't r', label: 'Tab: launch a session', command: 'work.launch', guaranteed: true, match: tabChord('r') },
  // `c` creates in the browser's current kind (the `list.create` meaning,
  // promoted to chrome so it works without a focused list).
  { id: 'work.create.here', layer: 'global', keys: 'c', label: 'New in the current list', command: 'list.create', guaranteed: true, match: plain('c') },
  ...CREATE_CHORDS,
  /* The tab strip handles these itself (it matches on `event.code`, which an
     Option-modified key on macOS needs). Listed so they are discoverable. */
  { id: 'work.tab.next.mod', layer: 'global', keys: 'Mod+Alt+→', label: 'Next tab', command: 'work.tab.next', guaranteed: false, surfaceOwned: true, match: { type: 'mod', key: 'ArrowRight' } },
  { id: 'work.tab.prev.mod', layer: 'global', keys: 'Mod+Alt+←', label: 'Previous tab', command: 'work.tab.prev', guaranteed: false, surfaceOwned: true, match: { type: 'mod', key: 'ArrowLeft' } },
  { id: 'work.tab.close.mod', layer: 'global', keys: 'Mod+Alt+W', label: 'Close tab', command: 'work.tab.close', guaranteed: false, surfaceOwned: true, match: { type: 'mod', key: 'w' } },

  // -- Lists ----------------------------------------------------------------
  { id: 'list.next.j', layer: 'focus', keys: 'j', label: 'Next item', command: 'list.next', guaranteed: true, match: { type: 'plain', key: 'j' } },
  { id: 'list.prev.k', layer: 'focus', keys: 'k', label: 'Previous item', command: 'list.prev', guaranteed: true, match: { type: 'plain', key: 'k' } },
  { id: 'list.next.arrow', layer: 'focus', keys: '↓', label: 'Next item', command: 'list.next', guaranteed: true, match: { type: 'plain', key: 'ArrowDown' } },
  { id: 'list.prev.arrow', layer: 'focus', keys: '↑', label: 'Previous item', command: 'list.prev', guaranteed: true, match: { type: 'plain', key: 'ArrowUp' } },
  { id: 'list.open', layer: 'focus', keys: 'Enter', label: 'Open', command: 'list.open', guaranteed: true, match: { type: 'plain', key: 'Enter' } },
  { id: 'list.primary', layer: 'focus', keys: 'Mod+Enter', label: 'Primary action', command: 'list.primary', guaranteed: false, match: { type: 'mod', key: 'Enter' } },
  { id: 'list.launch', layer: 'focus', keys: 'r', label: 'Launch a session on the selected item', command: 'work.launch', guaranteed: true, surfaceOwned: true, match: { type: 'plain', key: 'r' } },
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
  /**
   * `Ctrl+]` — the easy terminal chord, BOTH ways (user ruling, task 01a113aa).
   * Inside a focused terminal the terminal itself intercepts it (zero bytes to
   * the PTY, like Ctrl+`); anywhere else it is a global chord that puts focus
   * back in the visible terminal. Physical `Ctrl` on every platform, matched on
   * `event.code` so layout cannot break it. Live while typing: it carries a
   * modifier, so no text field ever wanted it.
   */
  {
    id: 'terminal.toggle',
    layer: 'global',
    keys: 'Ctrl+]',
    label: 'Leave / return to the terminal',
    command: 'terminal.toggle',
    guaranteed: true,
    match: { type: 'code', code: 'BracketRight', ctrl: true },
  },

  // -- Launch card ----------------------------------------------------------
  ...LAUNCH_ROWS,
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

/** Help-overlay sections, in display order. */
export type BindingGroup = 'Focus' | 'Workspace' | 'Create' | 'Launch' | 'Navigate' | 'Lists' | 'General';

/**
 * `Focus` leads: leaving a text field or a terminal is what makes every other
 * shortcut reachable, so it is the first thing the help overlay teaches.
 */
export const BINDING_GROUPS: readonly BindingGroup[] = ['Focus', 'Lists', 'Workspace', 'Create', 'Launch', 'Navigate', 'General'];

/** Which help section a binding belongs to — derived, so no row can forget one. */
export function bindingGroup(binding: Binding): BindingGroup {
  if (binding.command.startsWith('launch.')) return 'Launch';
  if (binding.command === 'text.blur' || binding.command.startsWith('terminal.')) return 'Focus';
  if (binding.command === 'work.create' || binding.command === 'list.create') return 'Create';
  if (binding.command === 'work.browser.focus' || binding.layer === 'focus') return 'Lists';
  if (binding.command.startsWith('work.')) return 'Workspace';
  if (binding.command === 'nav.view' || binding.command === 'nav.kind') return 'Navigate';
  return 'General';
}

/**
 * The FIRST advertised hint for a command (and ref), for UI that names a
 * shortcut next to the thing it does — palette rows, tooltips. `null` when
 * the command has no advertised binding on this platform.
 */
export function hintFor(command: KeyCommand, ref: string | undefined, platform: Platform): string | null {
  const hit = BINDINGS.find(
    (b) => b.command === command && (ref === undefined || b.ref === ref) && isAdvertised(b, platform),
  );
  return hit ? hit.keys : null;
}
