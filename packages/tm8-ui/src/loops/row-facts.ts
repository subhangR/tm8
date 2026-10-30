import type { EntitySummary } from '@tm8/contract';
import { relTime } from '@tm8/client-core/time';

/*
 * A LOOP ROW'S FACTS IN THE GENERIC LISTS — the Work browser's and the
 * phone's. Those lists have no columns (design 01a182d4 §6: "row facts go
 * through the summary's `state` arm"), so a loop row carries its schedule and
 * next run as its second line. Every fact is the server's: the expression as
 * stored, `nextRunAt` as the doors wrote it. Nothing here reads a schedule.
 */

export type LoopRowState = Extract<EntitySummary['state'], { kind: 'loop' }>;
export type LoopRowStatus = 'disabled' | 'paused' | 'enabled';

export function loopStateOf(row: EntitySummary): LoopRowState | null {
  return row.state.kind === 'loop' ? row.state : null;
}

/** Disabled, paused (only before `pausedUntil`: an expired pause reads as enabled), or enabled. */
export function loopRowStatus(state: LoopRowState, now: number = Date.now()): LoopRowStatus {
  if (!state.enabled) return 'disabled';
  return state.pausedUntil && Date.parse(state.pausedUntil) > now ? 'paused' : 'enabled';
}

/** "every 1d · UTC · next in 3h" — the phone row's one meta line. */
export function loopRowWords(row: EntitySummary, now: number = Date.now()): string | null {
  const state = loopStateOf(row);
  if (!state) return null;
  const status = loopRowStatus(state, now);
  const when = status === 'disabled' ? 'disabled'
    : status === 'paused' ? `paused, resumes ${relTime(state.pausedUntil, now)}`
      : state.nextRunAt ? `next ${relTime(state.nextRunAt, now)}` : 'not scheduled';
  return `${state.schedule} · ${state.timezone} · ${when}`;
}
