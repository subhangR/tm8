import { isCollabError } from '@tm8/contract';
import type { PillTone } from '../kit/Pill';
import { parseInstant } from '../kit/time';
import type { LoopRun, LoopRunSkipReason, LoopRunStatus, LoopView } from './page-port';

/*
 * Presentation rules for the loop page. Times go through kit/time for the
 * relative half; the absolute half is drawn in the LOOP's timezone, because
 * "09:00" on a cron evaluated in Europe/London means London's nine o'clock
 * whatever zone the reader's browser is in.
 */

/** 'Thu 09:00 UTC' within the coming week, 'Thu 5 Nov 09:00 UTC' past it. */
export function zonedInstant(value: string | null | undefined, timeZone: string, now: number = Date.now()): string {
  const t = parseInstant(value);
  if (t === null) return '';
  const near = Math.abs(t - now) < 6 * 24 * 60 * 60 * 1000;
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    ...(near ? {} : { day: 'numeric', month: 'short' }),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'short',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(new Date(t)).replace(',', '');
  } catch {
    // An unknown zone never blanks the label: fall back to UTC and say so.
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(new Date(t)).replace(',', '');
  }
}

/** '45s' · '3m 12s' · '1h 4m' — null in, em dash out (unknown is not zero). */
export function durationLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const RUN_STATUS: Record<LoopRunStatus, { label: string; tone: PillTone }> = {
  running: { label: 'Running', tone: 'run' },
  completed: { label: 'Completed', tone: 'info' },
  failed: { label: 'Failed', tone: 'block' },
  skipped: { label: 'Skipped', tone: 'idle' },
  stopped: { label: 'Stopped', tone: 'wait' },
  timed_out: { label: 'Timed out', tone: 'block' },
};

const SKIP_REASON: Record<LoopRunSkipReason, string> = {
  overlap: 'Skipped: the previous run was still live',
  paused: 'Skipped: the loop was paused',
  schedule_invalid: 'Skipped: the schedule did not parse',
};

/** The run's error column: the error text, else why it was skipped, else why its session ended. */
export function runNote(run: LoopRun): string {
  if (run.error) return run.error;
  if (run.status === 'skipped' && run.skipReason) return SKIP_REASON[run.skipReason];
  if (run.status === 'failed' && run.endedKind) return `Session ended: ${run.endedKind.replace(/_/g, ' ')}`;
  if (run.exitCode != null && run.exitCode !== 0) return `Exit code ${run.exitCode}`;
  return '';
}

export type LoopStatus =
  | { kind: 'disabled' }
  | { kind: 'paused'; until: string }
  | { kind: 'waiting'; runId: string }
  | { kind: 'enabled' };

/** The header pill. Disabled outranks paused: a disabled loop does not fire when its pause ends. */
export function loopStatus(view: LoopView, now: number = Date.now()): LoopStatus {
  const { state } = view;
  if (!state.enabled) return { kind: 'disabled' };
  const until = parseInstant(state.pausedUntil);
  if (state.pausedUntil && until !== null && until > now) return { kind: 'paused', until: state.pausedUntil };
  if (state.waitingOnRunId) return { kind: 'waiting', runId: state.waitingOnRunId };
  return { kind: 'enabled' };
}

/** A refusal's machine code, looking in the error and in its details (the 409 overlap rides `conflict`). */
export function refusalCode(error: unknown): string | null {
  if (!isCollabError(error)) return null;
  const detail = error.details?.code ?? error.details?.reason;
  return typeof detail === 'string' ? detail : error.code;
}

export function isOverlap(error: unknown): boolean {
  if (!isCollabError(error)) return false;
  return refusalCode(error) === 'loop_run_overlap'
    || (error.code === 'conflict' && /overlap/i.test(error.message));
}

/** The live run an overlap refusal names, when the server sent it. */
export function overlapRunId(error: unknown): string | null {
  if (!isCollabError(error)) return null;
  const d = error.details ?? {};
  const id = d.liveRunId ?? d.runId ?? d.live_run_id;
  return typeof id === 'string' ? id : null;
}

export function isNotImplemented(error: unknown): boolean {
  return isCollabError(error) && error.code === 'not_implemented';
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
