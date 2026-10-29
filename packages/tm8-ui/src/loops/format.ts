import { absTime, zonedTime } from '../kit/time';
import type { PillTone } from '../kit/Pill';
import type { LoopRunStatus } from './api';

/*
 * PRESENTATION ONLY. These format instants the server already computed
 * (`nextRunAt`, `lastRunAt`, a run's `firedAt`); none of them derives a
 * schedule fact.
 */

/** The absolute instant for a hover title: the viewer's zone, or a named zone (a loop's own). */
export function absolute(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  return timeZone ? zonedTime(iso, timeZone) : absTime(iso);
}

const RUN_STATUS: Readonly<Record<LoopRunStatus, { label: string; tone: PillTone }>> = {
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'run' },
  failed: { label: 'Failed', tone: 'block' },
  skipped: { label: 'Skipped', tone: 'idle' },
  stopped: { label: 'Stopped', tone: 'wait' },
  timed_out: { label: 'Timed out', tone: 'block' },
};

/** A run status's words and kit `Pill` tone (status is colour AND word). */
export function runStatusChip(status: LoopRunStatus): { label: string; tone: PillTone } {
  return RUN_STATUS[status] ?? { label: status, tone: 'idle' };
}
