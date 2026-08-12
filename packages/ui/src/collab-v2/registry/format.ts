/** Tiny shared formatters for L1 (registry renderers + entity components). */

/**
 * Time formatting is NOT defined here. It lives in `kit/time` (L0) so the
 * ticking `<Timestamp>` component and every plain-string caller share one
 * implementation; this is a compat re-export of that exact function, the same
 * arrangement `shell/keyboard` has with `createListKeyNav`.
 *
 * Prefer `<Timestamp at={…} />` in markup — it ticks and carries the absolute
 * time on inspect. Reach for `relTime` only where a string is required (an
 * aria-label, a title, a toast).
 */
export { absTime, relTime, shortDate } from '../kit/time';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do { v /= 1024; u += 1; } while (v >= 1024 && u < units.length - 1);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function truncate(text: string, max = 80): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
