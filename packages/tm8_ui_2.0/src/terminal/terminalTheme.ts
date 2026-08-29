import type { ITheme } from '@xterm/xterm';

/**
 * Fixed terminal render options. packages/ui's harvest source carries a
 * persisted, user-configurable settings store (font/theme picker) behind
 * this; tm8-ui has no such panel yet, so this is deliberately plain
 * constants rather than a speculative zustand store with no UI to drive it.
 * `cursorBlink` is not among these — LiveTerminal passes `false` straight
 * into the `Terminal` constructor (maestro main ef0dcbe: hard-disabled
 * everywhere, never a setting).
 */
export const TERMINAL_FONT_STACK =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_FONT_WEIGHT = 400;
export const TERMINAL_FONT_WEIGHT_BOLD = 700;
export const TERMINAL_LINE_HEIGHT = 1.2;
export const TERMINAL_LETTER_SPACING = 0;
export const TERMINAL_SCROLLBACK = 5000;
export const TERMINAL_CURSOR_STYLE = 'block' as const;
export const TERMINAL_CURSOR_INACTIVE_STYLE = 'outline' as const;

/**
 * Resolve xterm's ITheme from the `--pn-x-term-*` custom properties
 * (styles/canvas-extra.css) computed against `el`.
 *
 * WHY A RUNTIME READ, not constants: §14 bans a raw hex literal anywhere in
 * this directory's TS/TSX source (`no-branching.test.ts`), and xterm's
 * canvas renderer cannot resolve a bare `var(--pn-x-term-fg)` string passed
 * as `ctx.fillStyle` — canvas color parsing does not consult an element's
 * cascade the way a CSS property assignment does. So the token is read once,
 * resolved, off the DOM instead. `el` must be inside the always-dark
 * `.cv2-root[data-theme="dark"]` scope (TerminalHost renders under
 * `AlwaysDark`, which guarantees this) or the properties are undefined and
 * every value falls back to a plain CSS color keyword.
 */
export function buildTerminalTheme(el: HTMLElement): ITheme {
  const style = getComputedStyle(el);
  const v = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback;
  const background = v('--pn-x-term-live-bg', 'black');
  return {
    background,
    foreground: v('--pn-x-term-fg', 'white'),
    cursor: v('--pn-x-term-cursor', 'white'),
    cursorAccent: v('--pn-x-term-cursor-accent', background),
    selectionBackground: v('--pn-x-term-sel-bg', 'rgba(255,255,255,0.3)'),
    selectionForeground: v('--pn-x-term-sel-fg', 'white'),
    black: v('--pn-x-term-ansi-0', 'black'),
    red: v('--pn-x-term-ansi-1', 'red'),
    green: v('--pn-x-term-ansi-2', 'green'),
    yellow: v('--pn-x-term-ansi-3', 'yellow'),
    blue: v('--pn-x-term-ansi-4', 'blue'),
    magenta: v('--pn-x-term-ansi-5', 'magenta'),
    cyan: v('--pn-x-term-ansi-6', 'cyan'),
    white: v('--pn-x-term-ansi-7', 'white'),
    brightBlack: v('--pn-x-term-ansi-8', 'gray'),
    brightRed: v('--pn-x-term-ansi-9', 'red'),
    brightGreen: v('--pn-x-term-ansi-10', 'green'),
    brightYellow: v('--pn-x-term-ansi-11', 'yellow'),
    brightBlue: v('--pn-x-term-ansi-12', 'blue'),
    brightMagenta: v('--pn-x-term-ansi-13', 'magenta'),
    brightCyan: v('--pn-x-term-ansi-14', 'cyan'),
    brightWhite: v('--pn-x-term-ansi-15', 'white'),
  };
}
