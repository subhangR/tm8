import type { LoopRunStatus, LoopView } from './api';

/*
 * PRESENTATION ONLY. These format instants the server already computed
 * (`nextRunAt`, `lastRunAt`, a run's `firedAt`); none of them derives a
 * schedule fact.
 */

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** "in 3 hours", "5 minutes ago", "now". */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const delta = at - now.getTime();
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, ms] of UNITS) {
    if (Math.abs(delta) >= ms) return format.format(Math.round(delta / ms), unit);
  }
  return 'now';
}

/** The absolute instant in the viewer's zone, for a hover title. */
export function absolute(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(at);
}

export type ChipTone = 'ok' | 'bad' | 'warn' | 'live' | 'quiet';

const RUN_STATUS: Readonly<Record<LoopRunStatus, { label: string; tone: ChipTone }>> = {
  running: { label: 'Running', tone: 'live' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  skipped: { label: 'Skipped', tone: 'quiet' },
  stopped: { label: 'Stopped', tone: 'warn' },
  timed_out: { label: 'Timed out', tone: 'bad' },
};

/** A run status's chip words and tone (`.loop-chip--<tone>` in loops.css). */
export function runStatusChip(status: LoopRunStatus): { label: string; tone: ChipTone } {
  return RUN_STATUS[status] ?? { label: status, tone: 'quiet' };
}

/** "Dispatcher" for a dispatch loop; the caller names a teammate or tool from its id. */
export function runsLabelFallback(loop: Pick<LoopView, 'definition'>): string {
  const { action } = loop.definition;
  return action === 'dispatch' ? 'Dispatcher' : action === 'tool' ? 'Tool' : 'Teammate';
}
