/**
 * THE LAUNCHING PAGE'S MODEL (task 01a182d2) — the one function that turns
 * what is known about a launch into what its page draws.
 *
 * CONTRACT
 *   in   this window's launch record (null when the window never watched the
 *        launch — a session opened from a list while it boots), and the
 *        session's own facts once a session exists (`bootingSessionOf`).
 *   out  `LaunchPageModel`, or null when there is nothing to draw: neither a
 *        record nor a session.
 *   who  the Work launch tab (record only) and the session's work view
 *        (session, plus the record when this window launched it).
 *   invariants
 *     - `state` is `live` exactly when every phase row is done — the host's
 *       cue to draw the live session in the page's place;
 *     - `failure` is non-null exactly in `failed`;
 *     - nothing is invented: a fact neither source carries is left out of the
 *       launch line rather than guessed.
 *
 * THE PAGE'S STATES, derived here and stored nowhere:
 *   starting  pressed, the node has not answered
 *   checking  the send timed out; asking whether it started
 *   booting   admitted; the session exists and is not up yet
 *   live      every step done
 *   failed    refused, timed out with no session to show, or the boot failed
 */
import { launchModel, type WorkSessionBootPhase, type WorkSessionStatus } from '@tm8/contract';
import { accessModeLabel, EFFORT_LABELS } from '../domain/launch';
import type { LaunchRecord } from './store';
import { bootPhaseOf, launchPhases, type BootStep, type LaunchWorkdirMode, type PhaseRow } from './phases';

export type LaunchPageState = 'starting' | 'checking' | 'booting' | 'live' | 'failed';

/** What a session's own entity says about its boot. */
export interface BootingSession {
  id: string;
  title: string;
  /** ISO — the clock's start when this window did not watch the press. */
  createdAt: string;
  status: WorkSessionStatus;
  bootPhase: WorkSessionBootPhase | null;
  /**
   * The agent process came up at some point (`startedAt` is set). A session
   * that fails AFTER that crashed at work; it did not fail to launch, and its
   * ending is the session view's to tell.
   */
  started: boolean;
  teammate: string | null;
  model: string | null;
  workdirMode: LaunchWorkdirMode | null;
  checkoutBranch: string | null;
  /** The node's sentence for a failed session. */
  endedReason: string | null;
}

export interface LaunchPageModel {
  state: LaunchPageState;
  title: string;
  /** The launch line: teammate · model · effort · access · lane, as known. */
  facts: readonly string[];
  phases: readonly PhaseRow[];
  /** Epoch ms the clock counts from. */
  startedAt: number;
  /** How long the node took to admit it, when this window watched the answer. */
  admittedMs: number | null;
  failure: { message: string; uncertain: boolean } | null;
  /** The launch's record id, when this window holds one — the actions' key. */
  launchId: string | null;
}

const WORKDIR_MODES: ReadonlySet<string> = new Set(['scratch', 'project', 'worktree']);
const SESSION_STATUSES: ReadonlySet<string> = new Set(['spawning', 'running', 'idle', 'exited', 'failed']);

/**
 * A work session's boot facts off its entity detail, or null for anything
 * that is not a work session. Structural, because the panel hands over its
 * detail as the generic entity it is.
 */
export function bootingSessionOf(detail: {
  id: string;
  title: string;
  createdAt: string;
  state?: unknown;
} | null | undefined): BootingSession | null {
  const state = detail?.state as Record<string, unknown> | undefined;
  if (!detail || !state || state.kind !== 'work_session') return null;
  const status = typeof state.status === 'string' && SESSION_STATUSES.has(state.status)
    ? (state.status as WorkSessionStatus)
    : null;
  if (!status) return null;
  const teammate = state.teammate as { displayName?: unknown; name?: unknown } | null | undefined;
  const teammateName = typeof teammate?.displayName === 'string'
    ? teammate.displayName
    : typeof teammate?.name === 'string' ? teammate.name : null;
  return {
    id: detail.id,
    title: detail.title,
    createdAt: detail.createdAt,
    status,
    bootPhase: bootPhaseOf(state)?.phase ?? null,
    started: typeof state.startedAt === 'string' && state.startedAt.length > 0,
    teammate: teammateName,
    model: typeof state.model === 'string' ? state.model : null,
    workdirMode: typeof state.workdirMode === 'string' && WORKDIR_MODES.has(state.workdirMode)
      ? (state.workdirMode as LaunchWorkdirMode)
      : null,
    checkoutBranch: typeof state.checkoutBranch === 'string' ? state.checkoutBranch : null,
    endedReason: typeof state.endedReason === 'string' ? state.endedReason : null,
  };
}

const modelName = (model: string) => launchModel(model)?.label ?? model;

function effortName(effort: string): string {
  return (EFFORT_LABELS as Readonly<Record<string, string>>)[effort] ?? effort;
}

const ACCESS_MODES: ReadonlySet<string> = new Set(['safe', 'acceptEdits', 'auto', 'plan', 'fullAccess']);
function accessName(access: string): string {
  return ACCESS_MODES.has(access) ? accessModeLabel(access as Parameters<typeof accessModeLabel>[0]) : access;
}

function recordFacts(record: LaunchRecord): string[] {
  const { teammate, model, effort, accessMode, workdir } = record.launch;
  const lane = workdir.kind === 'scratch'
    ? 'Scratch directory'
    : workdir.mode === 'worktree'
      ? workdir.baseRef ? `Worktree from ${workdir.baseRef}` : 'Worktree'
      : 'Project checkout';
  return [
    teammate?.name ?? null,
    model ? modelName(model) : null,
    effort ? effortName(effort) : null,
    accessMode ? accessName(accessMode) : null,
    lane,
  ].filter((fact): fact is string => fact !== null && fact.length > 0);
}

function sessionFacts(session: BootingSession): string[] {
  const lane = session.workdirMode === 'worktree'
    ? session.checkoutBranch ? `Worktree · ${session.checkoutBranch}` : 'Worktree'
    : session.workdirMode === 'scratch' ? 'Scratch directory' : session.workdirMode === 'project' ? 'Project checkout' : null;
  return [session.teammate, session.model ? modelName(session.model) : null, lane]
    .filter((fact): fact is string => fact !== null && fact.length > 0);
}

function workdirOf(record: LaunchRecord | null, session: BootingSession | null): LaunchWorkdirMode {
  if (record) return record.launch.workdir.kind === 'scratch' ? 'scratch' : record.launch.workdir.mode;
  return session?.workdirMode ?? 'project';
}

const BOOT_FAILED = 'The session failed while it was starting, and the node gave no reason.';

export function launchPageModel(
  record: LaunchRecord | null,
  session: BootingSession | null,
  /** The last step a recorded boot reached, kept by the page across a `failed` overwrite. */
  lastStep: BootStep | null = null,
): LaunchPageModel | null {
  if (!record && !session) return null;
  const bootPhase = session?.bootPhase ?? null;
  /* A session that failed after it started ended at work, not at launch:
     for the boot it is as done as an exited one. */
  const status = session?.status === 'failed' && session.started && bootPhase !== 'failed'
    ? 'exited'
    : session?.status ?? null;
  const sessionFailed = status === 'failed' || bootPhase === 'failed';
  const recordFailed = record?.state === 'failed';
  const failed = sessionFailed || (recordFailed && !session);

  const phases = launchPhases({
    admitted: record?.state === 'admitted' || session !== null,
    status,
    bootPhase,
    failed,
    lastStep,
    workdir: workdirOf(record, session),
  });
  const live = phases.every((row) => row.mark === 'done');

  const state: LaunchPageState = live
    ? 'live'
    : failed
      ? 'failed'
      : session
        ? 'booting'
        : record!.state === 'checking'
          ? 'checking'
          : record!.state === 'admitted' ? 'booting' : 'starting';

  const failure = state !== 'failed'
    ? null
    : sessionFailed
      ? { message: session?.endedReason?.trim() || BOOT_FAILED, uncertain: false }
      : { message: record!.failure?.message ?? BOOT_FAILED, uncertain: record!.failure?.uncertain ?? false };

  const createdAt = session ? Date.parse(session.createdAt) : Number.NaN;
  return {
    state,
    title: record?.launch.title || session?.title || 'New session',
    facts: record ? recordFacts(record) : sessionFacts(session!),
    phases,
    startedAt: record?.startedAt ?? (Number.isFinite(createdAt) ? createdAt : Date.now()),
    admittedMs: record?.admittedAt != null ? Math.max(0, record.admittedAt - record.startedAt) : null,
    failure,
    launchId: record?.id ?? null,
  };
}

