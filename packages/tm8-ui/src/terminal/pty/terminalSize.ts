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
