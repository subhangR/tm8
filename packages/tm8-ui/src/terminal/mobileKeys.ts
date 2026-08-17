/**
 * THE PHONE KEYBOARD'S MISSING HALF — byte sequences, and the arithmetic that
 * decides whether this terminal is honest about its width.
 *
 * Pure on purpose. Everything decidable about the modifier bar lives here and
 * is proved without a DOM, exactly the way `mobile/shell-for.ts` splits its
 * rule from `useShellKind`. What is left in the component is the part that
 * genuinely needs a live xterm.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * An iOS soft keyboard has no Ctrl, no Esc, no Tab and no arrow keys. Those
 * are not stylistic omissions: there is no gesture on the system keyboard that
 * produces any of them, so on a phone EVERY non-printable byte a PTY
 * understands is unreachable. A terminal that can only send printable
 * characters and Return cannot interrupt a process, cannot complete a path,
 * cannot leave vim, and cannot answer a prompt that wants an arrow. That is
 * the whole reason the bar exists, and it is why the bar is not a convenience.
 */

/**
 * ESC. One byte, and the single most-needed key on this list — it is what
 * dismisses a menu, leaves insert mode, and cancels a readline search.
 */
export const ESC = '\x1b';

/** TAB. Completion. `\x09`, spelled as the escape it is rather than as a literal
    tab character, which is invisible in a diff and easy to convert to spaces. */
export const TAB = '\x09';

/**
 * ARROWS, AND THE MODE THAT CHANGES THEM.
 *
 * A terminal sends `ESC [ A` for Up in NORMAL cursor-key mode and `ESC O A` in
 * APPLICATION cursor-key mode (DECCKM, set by `ESC [ ? 1 h`). This is not a
 * detail that can be skipped by picking one: readline-driven shells sit in
 * normal mode, and vim, less, htop and most full-screen TUIs turn DECCKM ON
 * the moment they start. Send the wrong family and the arrow does nothing, or
 * — worse — the literal characters `OA` land in the buffer.
 *
 * xterm's own keyboard handler consults `term.modes.applicationCursorKeysMode`
 * for exactly this reason. The bar writes to the PTY directly rather than
 * through xterm's key path, so it has to ask the same question itself.
 */
export type ArrowName = 'up' | 'down' | 'left' | 'right';

const ARROW_FINAL: Record<ArrowName, string> = { up: 'A', down: 'B', right: 'C', left: 'D' };

export function arrowSequence(arrow: ArrowName, applicationCursorKeys: boolean): string {
  return `${ESC}${applicationCursorKeys ? 'O' : '['}${ARROW_FINAL[arrow]}`;
}

/**
 * CTRL, AS A STICKY MODIFIER — the only shape that can work here.
 *
 * A hardware Ctrl is held while another key is pressed. A phone cannot do
 * that: the modifier bar and the system keyboard are two separate surfaces and
 * a finger is on one at a time. So Ctrl ARMS, the next character consumes it,
 * and the bar disarms — the same contract as a phone keyboard's own Shift, and
 * therefore already familiar rather than invented here.
 *
 * The mapping is the ASCII one: a control character is its letter with the top
 * three bits cleared. `Ctrl+C` is 0x03, `Ctrl+D` is 0x04, `Ctrl+[` is ESC.
 * Only `?` is irregular — `Ctrl+?` is DEL (0x7f), not 0x1f — and it is spelled
 * out rather than left to the arithmetic to get wrong.
 *
 * Returns `null` for input the modifier cannot apply to, which the caller must
 * treat as "send it unmodified". Swallowing it would make the bar eat
 * keystrokes, and a terminal that silently drops input is worse than one that
 * cannot modify it.
 */
export function ctrlByte(input: string): string | null {
  if (input.length !== 1) return null;
  const ch = input.toUpperCase();
  if (ch === '?') return '\x7f';
  const code = ch.charCodeAt(0);
  /* `@` (0x40) through `_` (0x5F) is the range that has a control form; that
     covers A-Z plus `@ [ \ ] ^ _`. Everything else — digits, punctuation the
     range misses, any non-ASCII — has none. */
  if (code < 0x40 || code > 0x5f) return null;
  return String.fromCharCode(code & 0x1f);
}

/**
 * THE COLUMN COUNT A GIVEN WIDTH BUYS — the number this lane exists to stop
 * hiding.
 *
 * `cellWidth` must be xterm's MEASURED cell, not an estimate: the estimate
 * (`fontSize * 0.6`) that `pty/terminalSize.ts` uses for its pre-mount guess is
 * off by enough at these widths to move the answer by several columns, and
 * several columns is the difference between a wrapped line and a clean one.
 */
export function columnsFor(pixelWidth: number, cellWidth: number): number {
  if (!(pixelWidth > 0) || !(cellWidth > 0)) return 0;
  return Math.max(1, Math.floor(pixelWidth / cellWidth));
}

/**
 * WHAT A WIDTH IS GOOD FOR, said in words rather than left to be discovered
 * through garbled output.
 *
 * The thresholds are not aesthetic. 80 is the column count essentially every
 * CLI tool on earth formats to — `git log`, `--help` output, compiler
 * diagnostics, box-drawing TUIs — and it is the number their authors tested at.
 * 60 is roughly where prose-shaped output (a log line, an agent's reply) still
 * reads without wrapping mid-thought. Below that, a full-screen TUI is not
 * "cramped", it is misaligned: its own box-drawing wraps and the frame breaks.
 *
 * A phone at 390px gets somewhere in the forties. Saying so is the point.
 */
export type WidthVerdict = 'full' | 'narrow' | 'cramped';

export function widthVerdict(cols: number): WidthVerdict {
  if (cols >= 80) return 'full';
  if (cols >= 60) return 'narrow';
  return 'cramped';
}

/**
 * The sentence shown beside the column readout. One per verdict, authored, and
 * deliberately about CONSEQUENCE rather than about the number — the number is
 * already on screen next to it.
 */
export const WIDTH_NOTE: Record<WidthVerdict, string> = {
  full: 'Wide enough for tools that assume 80 columns.',
  narrow: 'Under 80 columns — some tool output will wrap.',
  cramped: 'Full-screen tools (vim, htop) will wrap and misalign at this width.',
};

/**
 * FONT SIZES THE PHONE OFFERS, and why a free-form number field would be worse.
 *
 * Each step is a real column count at 390px, so the control is a choice
 * between legibility and width rather than a slider onto a continuum the user
 * has to sample. 13 is `TERMINAL_FONT_SIZE`, the shared default, and is kept in
 * the list so a phone can always return to what every other surface uses.
 */
export const MOBILE_FONT_SIZES = [9, 10, 11, 12, 13, 15] as const;
export type MobileFontSize = (typeof MOBILE_FONT_SIZES)[number];

/** Device-scoped, like the shell override: a phone's legible size is a property
    of the phone and the eyes holding it, never of the account. */
export const TERMINAL_FONT_SIZE_KEY = 'tm8.terminal-font-size';

/** Clamp an arbitrary stored/incoming value onto the offered ladder. Storage is
    user-writable and a stale key must never produce an unrenderable terminal. */
export function nearestFontSize(value: unknown, fallback: number): MobileFontSize | number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return MOBILE_FONT_SIZES.reduce<number>(
    (best, size) => (Math.abs(size - n) < Math.abs(best - n) ? size : best),
    MOBILE_FONT_SIZES[0],
  );
}

/** Step along the ladder. Returns the same size at either end — the caller
    disables the control there rather than wrapping around, because a font
    control that jumps from largest to smallest reads as a bug. */
export function stepFontSize(current: number, direction: 1 | -1): number {
  const i = MOBILE_FONT_SIZES.indexOf(nearestFontSize(current, current) as MobileFontSize);
  if (i < 0) return current;
  const next = i + direction;
  return next < 0 || next >= MOBILE_FONT_SIZES.length ? current : MOBILE_FONT_SIZES[next]!;
}
