import type { ResolvedStyle } from '@tm8/contract';
import type { ITheme } from '@xterm/xterm';

/**
 * The constants left after the style took over (spec §1.7): the style's
 * built-ins carry today's font stack, weights, scrollback and cursor. These
 * three stay for the pre-mount size estimate in `pty/terminalSize.ts` and the
 * no-device font size; `cursorInactiveStyle` is not a style key. `cursorBlink`
 * is not here either — LiveTerminal passes `false` straight into the
 * `Terminal` constructor (maestro main ef0dcbe: hard-disabled everywhere,
 * never a setting).
 */
export const TERMINAL_FONT_SIZE = 13;
/* The pre-style terminal, kept as the record the built-ins are checked
   against (`styles/builtins-parity.test.ts`): `--pn-term-*` in both built-ins
   must equal these, so moving LiveTerminal onto the resolved style moved no
   pixel. Nothing renders from them any more. */
export const TERMINAL_FONT_STACK =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
export const TERMINAL_FONT_WEIGHT = 400;
export const TERMINAL_SCROLLBACK = 5000;
export const TERMINAL_CURSOR_STYLE = 'block' as const;
export const TERMINAL_LINE_HEIGHT = 1.2;
export const TERMINAL_LETTER_SPACING = 0;
export const TERMINAL_CURSOR_INACTIVE_STYLE = 'outline' as const;

/** The xterm part of a resolved style (`resolveStyle(...).xterm`, spec §1.7). */
export type ResolvedXterm = ResolvedStyle['xterm'];

/**
 * Everything a style drives on a live `Terminal`, in xterm's own option names,
 * so it can be spread into the constructor and diffed key by key afterwards.
 * Padding is not here: it is not an xterm option, so LiveTerminal puts
 * `xterm.options.padding` on the `.xterm` element, which FitAddon subtracts.
 */
export interface TerminalStyleOptions {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontWeightBold: number;
  lineHeight: number;
  letterSpacing: number;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
}

/**
 * Where a theme slot falls back when the resolved table has no value for it.
 * Unreachable with a full registry (every built-in carries every key); kept so
 * a malformed table paints a readable terminal rather than an empty canvas,
 * exactly as the computed-style read it replaces did.
 */
const THEME_FALLBACK: Record<keyof ResolvedXterm['theme'], string> = {
  background: 'black',
  foreground: 'white',
  cursor: 'white',
  cursorAccent: 'black',
  selectionBackground: 'rgba(255,255,255,0.3)',
  selectionForeground: 'white',
  black: 'black',
  red: 'red',
  green: 'green',
  yellow: 'yellow',
  blue: 'blue',
  magenta: 'magenta',
  cyan: 'cyan',
  white: 'white',
  brightBlack: 'gray',
  brightRed: 'red',
  brightGreen: 'green',
  brightYellow: 'yellow',
  brightBlue: 'blue',
  brightMagenta: 'magenta',
  brightCyan: 'cyan',
  brightWhite: 'white',
};

/**
 * xterm's `ITheme` from the RESOLVED TABLE, not from computed style.
 *
 * WHY NOT `getComputedStyle` any more: it was read once at mount, so a style
 * change never reached an open terminal, and it depended on `el` sitting in
 * the right scope. The store resolves the same `--pn-x-term-*` values (from
 * the always-dark ramp when `--pn-term-chrome` is `dark`, the main one when it
 * is `follow`), so reading them from `ResolvedStyle.xterm` gives every open
 * terminal the new colours in the same tick as the UI repaint (spec §1.7).
 * Values are concrete colours: `resolveStyle` already resolved any one-hop
 * `var()` alias, which a canvas `fillStyle` could not.
 */
export function buildTerminalTheme(xterm: ResolvedXterm): ITheme {
  const theme = {} as Record<keyof ResolvedXterm['theme'], string>;
  for (const slot of Object.keys(THEME_FALLBACK) as (keyof ResolvedXterm['theme'])[]) {
    theme[slot] = xterm.theme[slot] || (slot === 'cursorAccent' ? theme.background : THEME_FALLBACK[slot]);
  }
  return theme;
}

/**
 * `--pn-term-font-size`: `auto` = the device decides (the phone's
 * `tm8.terminal-font-size`, arriving as the `fontSize` prop) and 13 where no
 * device says anything; a number = the style wins over the device.
 */
export function terminalFontSize(styleSize: number | 'auto', deviceFontSize?: number): number {
  return styleSize === 'auto' ? (deviceFontSize ?? TERMINAL_FONT_SIZE) : styleSize;
}

export function terminalStyleOptions(xterm: ResolvedXterm, deviceFontSize?: number): TerminalStyleOptions {
  const o = xterm.options;
  return {
    theme: buildTerminalTheme(xterm),
    fontFamily: o.fontFamily,
    fontSize: terminalFontSize(o.fontSize, deviceFontSize),
    fontWeight: o.fontWeight,
    fontWeightBold: o.fontWeightBold,
    lineHeight: o.lineHeight,
    letterSpacing: o.letterSpacing,
    scrollback: o.scrollback,
    cursorStyle: o.cursorStyle,
  };
}

function sameTheme(a: ITheme, b: ITheme): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ITheme)[]);
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/**
 * Only the options whose value differs. Assigning an unchanged option is not
 * free in xterm — `fontFamily`/`fontSize`/`lineHeight`/`letterSpacing` each
 * clear the glyph atlas and re-measure, and `theme` repaints every row — so a
 * style change that touches one colour must not re-measure the font.
 */
export function changedTerminalOptions(
  current: TerminalStyleOptions,
  next: TerminalStyleOptions,
): Partial<TerminalStyleOptions> {
  const out: Partial<TerminalStyleOptions> = {};
  for (const key of Object.keys(next) as (keyof TerminalStyleOptions)[]) {
    const same = key === 'theme' ? sameTheme(current.theme, next.theme) : current[key] === next[key];
    if (!same) (out as Record<string, unknown>)[key] = next[key];
  }
  return out;
}
