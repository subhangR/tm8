import { isCollabError } from '@tm8/contract';
import type { PillTone } from '../kit/Pill';
import { parseInstant, zonedTime } from '../kit/time';
import { formatDuration } from '../transcript/session-stats';
import type { LoopRun, LoopRunSkipReason, LoopRunStatus, LoopView } from './page-port';

/*
 * Presentation rules for the loop page. Times go through kit/time for the
 * relative half; the absolute half is drawn in the LOOP's timezone, because
 * "09:00" on a cron evaluated in Europe/London means London's nine o'clock
 * whatever zone the reader's browser is in.
 */

/**
 * An instant in the LOOP's zone ('Thu 29 Oct 09:00 UTC'), through the app's
 * one formatter, which draws a zone it cannot read in UTC, labelled.
 */
export function zonedInstant(value: string | null | undefined, timeZone: string): string {
  return zonedTime(value, timeZone);
}

/** '45s' · '3m 12s' · '1h 4m' (the session stats' formatter) — null in, em dash out (unknown is not zero). */
export function durationLabel(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  return formatDuration(ms);
}

/** A run status's words and kit `Pill` tone — one table for the page and the list. */
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
