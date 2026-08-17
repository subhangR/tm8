import { TERMINAL_FONT_SIZE, TERMINAL_LETTER_SPACING, TERMINAL_LINE_HEIGHT } from '../terminalTheme.js';

export const serverPtySizes = new Map<string, { cols: number; rows: number }>();
export const clientFittedSessions = new Set<string>();
let lastFittedSize: { cols: number; rows: number } | null = null;

export function setLastFittedSize(size: { cols: number; rows: number }): void {
  lastFittedSize = size;
}

/**
 * Measure a spawn-time terminal size from the reserved host box before any
 * xterm has mounted. `.term-host` is tm8-ui's TerminalHost (T0-2's black box)
 * — the equivalent of old maestro/tm8-ui's `.terminalPane`.
 *
 * THE NAME OVERSELLS IT. This is "last fitted size, else measure, else give up",
 * in that order, and only the middle branch is a measurement:
 *
 *  1. `lastFittedSize` — a MODULE GLOBAL with no session scoping, set by
 *     whichever terminal last completed a real fit anywhere on the page. It is
 *     preferred because a real fit beats the cell-size estimate below, but it
 *     means a spawn can inherit the geometry of an unrelated pane.
 *  2. the first `.term-host` in the document — not necessarily the one this
 *     session will occupy.
 *  3. `{}` — every caller must treat this as "no opinion". Downstream that
 *     becomes the PTY's 80x24 default.
 *
 * So a caller with NO terminal mounted (a create flow: compose, press Enter,
 * spawn) gets a stale size on a warm page and nothing on a cold load, and
 * neither is visible at the call site. Such callers should pass explicit
 * geometry to `buildSpawnInput` instead of relying on this; an explicit
 * `cols`/`rows` on the spawn input beats this measurement in the ops layer.
 */
export function measureSpawnTerminalSize(): { cols?: number; rows?: number } {
  if (lastFittedSize && lastFittedSize.cols > 0 && lastFittedSize.rows > 0) {
    return { ...lastFittedSize };
  }
  if (typeof document === 'undefined') return {};
  const pane = document.querySelector('.term-host');
  if (!(pane instanceof HTMLElement)) return {};
  const rect = pane.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return {};
  const cellWidth = TERMINAL_FONT_SIZE * 0.6 + TERMINAL_LETTER_SPACING;
  const cellHeight = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
  if (cellWidth < 1 || cellHeight < 1) return {};
  const cols = Math.max(2, Math.floor((rect.width - 10) / cellWidth));
  const rows = Math.max(2, Math.floor((rect.height - 20) / cellHeight));
  return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows } : {};
}
