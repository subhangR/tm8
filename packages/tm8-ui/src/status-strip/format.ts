/**
 * Formatting for the status strip. Every function answers `—` for a figure
 * that was not measured (T1-4 / D7.2: zero means measured-zero, a dash means
 * not-measured), and none of them rounds a real value down to a fake zero.
 */
export const DASH = '—';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** 16 GB → "16", 14.83 GB → "14.8"; below 1 GB in MB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return DASH;
  if (bytes >= GB) {
    const gb = bytes / GB;
    return `${gb >= 100 ? Math.round(gb) : Number(gb.toFixed(1))} GB`;
  }
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return DASH;
  return `${Math.round(fraction * 100)}%`;
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? DASH : String(n);
}

/** 3725 → "1h 2m", 90061 → "1d 1h". */
export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export type Tone = 'normal' | 'warn' | 'alert';

/** ≥90% alert, ≥75% warn. */
export function toneOfFraction(fraction: number | null | undefined): Tone {
  if (fraction === null || fraction === undefined) return 'normal';
  if (fraction >= 0.9) return 'alert';
  if (fraction >= 0.75) return 'warn';
  return 'normal';
}
