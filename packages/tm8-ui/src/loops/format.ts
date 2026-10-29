import { absTime, relTime, zonedTime } from '../kit/time';
import type { LoopRunStatus, LoopView } from './api';

/*
 * PRESENTATION ONLY. These format instants the server already computed
 * (`nextRunAt`, `lastRunAt`, a run's `firedAt`); none of them derives a
 * schedule fact.
 */

/** "in 3h", "5m ago" — the app's one relative label (kit/time). */
export function relativeTime(iso: string | null | undefined): string {
  return iso ? relTime(iso) || '—' : '—';
}

/** The absolute instant for a hover title: the viewer's zone, or a named zone (a loop's own). */
export function absolute(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  return timeZone ? zonedTime(iso, timeZone) : absTime(iso);
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
