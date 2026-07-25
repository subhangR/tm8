import { useTerminalSettingsStore } from './useTerminalSettingsStore.js';

export const serverPtySizes = new Map<string, { cols: number; rows: number }>();
export const clientFittedSessions = new Set<string>();
let lastFittedSize: { cols: number; rows: number } | null = null;

export function setLastFittedSize(size: { cols: number; rows: number }): void {
  lastFittedSize = size;
}

export function measureSpawnTerminalSize(): { cols?: number; rows?: number } {
  if (lastFittedSize && lastFittedSize.cols > 0 && lastFittedSize.rows > 0) {
    return { ...lastFittedSize };
  }
  if (typeof document === 'undefined') return {};
  const pane = document.querySelector('.terminalPane');
  if (!(pane instanceof HTMLElement)) return {};
  const rect = pane.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return {};
  const settings = useTerminalSettingsStore.getState();
  const cellWidth = settings.fontSize * 0.6 + settings.letterSpacing;
  const cellHeight = settings.fontSize * settings.lineHeight;
  if (cellWidth < 1 || cellHeight < 1) return {};
  const cols = Math.max(2, Math.floor((rect.width - 10) / cellWidth));
  const rows = Math.max(2, Math.floor((rect.height - 20) / cellHeight));
  return Number.isFinite(cols) && Number.isFinite(rows) ? { cols, rows } : {};
}
