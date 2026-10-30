import { absTime, zonedTime } from '@tm8/client-core/time';
import type { PillTone } from '../kit/Pill';
import type { LoopRunStatus } from './api';
import { RUN_STATUS } from './page-format';

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

/** A run status's words and kit `Pill` tone (status is colour AND word) — the page's table. */
export function runStatusChip(status: LoopRunStatus): { label: string; tone: PillTone } {
  return RUN_STATUS[status] ?? { label: status, tone: 'idle' };
}
