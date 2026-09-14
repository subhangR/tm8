/**
 * Recency heat — a bucket over `activityAt` against the caller's clock.
 *
 * Extracted from model.ts so `grouping.ts` can read it without importing the
 * model (which imports grouping back). Behavior is unchanged and model.ts
 * re-exports both names, so every existing import site still resolves.
 *
 * Heat is NOT liveness. It is a real field honestly bucketed; whether a session
 * is running comes from the seam's snapshot (R-UI-5) and never from recency.
 */
export type Heat = 'fresh' | 'warm' | 'rest';

export function heatOf(activityAt: string, now: string): Heat {
  const delta = Date.parse(now) - Date.parse(activityAt);
  if (!Number.isFinite(delta)) return 'rest';
  if (delta <= 2 * 60_000) return 'fresh';
  if (delta <= 45 * 60_000) return 'warm';
  return 'rest';
}
