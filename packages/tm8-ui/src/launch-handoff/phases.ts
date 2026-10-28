/**
 * THE BOOT PHASES (task 01a182d2) — what the launching page ticks off, in order:
 * Admitted (the node took the launch) → Lane (checkout ready) → Briefing
 * (prompt composed) → Agent (process started) → Live.
 *
 * CONTRACT: pure functions, no state. `launchPhases(inputs)` → the five rows,
 * each `done | active | pending | failed`; `bootPhaseOf(state)` reads the
 * node's recorded phase off a session; `formatElapsed(ms)` the timer's text.
 * Called by the page model (`page.ts`). Invariants: rows are always the five
 * steps in order; at most one row is `active` or `failed`, and every row
 * before it is `done`.
 *
 * TWO SOURCES, ONE LIST. A node that records the boot (lane C: `bootPhase` /
 * `bootPhaseAt` on the work session) is read as it is. A node that does not is
 * DERIVED from what this window can actually observe — the spawn's answer and
 * the session's status — and nothing more: before the answer only Admitted is
 * in progress; after it, the session's `spawning` says the boot is somewhere
 * between Lane and Agent, so Lane is the open row; `running` means every row
 * is done. No row is ever ticked on a guess.
 */
import type { WorkSessionBootPhase, WorkSessionStatus } from '@tm8/contract';

/** A step of the boot — the contract's phase minus its failure. */
export type BootStep = Exclude<WorkSessionBootPhase, 'failed'>;

/** The steps in the order a boot passes them. */
export const BOOT_PHASES: readonly BootStep[] = ['admitted', 'lane', 'briefing', 'agent', 'live'];

const BOOT_PHASE_SET: ReadonlySet<string> = new Set<string>([...BOOT_PHASES, 'failed']);

/**
 * `bootPhase` / `bootPhaseAt` off a work session's state, VALIDATED: both are
 * optional (a node that records no boot omits them) and the value crossed the
 * wire, so a missing or unknown phase reads as null — which the derivation
 * below handles — never as a step.
 */
export function bootPhaseOf(state: unknown): { phase: WorkSessionBootPhase; at: string | null } | null {
  if (typeof state !== 'object' || state === null) return null;
  const { bootPhase, bootPhaseAt } = state as { bootPhase?: unknown; bootPhaseAt?: unknown };
  if (typeof bootPhase !== 'string' || !BOOT_PHASE_SET.has(bootPhase)) return null;
  return { phase: bootPhase as WorkSessionBootPhase, at: typeof bootPhaseAt === 'string' ? bootPhaseAt : null };
}

export type PhaseMark = 'done' | 'active' | 'pending' | 'failed';

export interface PhaseRow {
  id: BootStep;
  label: string;
  /** The fact the row stands for, in words. */
  detail: string;
  mark: PhaseMark;
}

export type LaunchWorkdirMode = 'scratch' | 'project' | 'worktree';

export interface PhaseInputs {
  /** The node answered the spawn with a session id. */
  admitted: boolean;
  /** The session's own status, once the session exists in this window. */
  status: WorkSessionStatus | null;
  /** The node's recorded phase; null when it records none. */
  bootPhase: WorkSessionBootPhase | null;
  /**
   * The launch failed on this window's side (refused, or timed out with no
   * session found). A `failed` status or phase says the same from the node's.
   */
  failed: boolean;
  /**
   * The last step a recorded boot reached before it failed — `bootPhase` is
   * overwritten by 'failed', so the page remembers what it last saw and the
   * failure lands on the row AFTER it, not on Admitted.
   */
  lastStep?: BootStep | null;
  workdir: LaunchWorkdirMode;
}

const LANE_DETAIL: Record<LaunchWorkdirMode, string> = {
  worktree: 'Worktree checked out',
  project: 'Project checkout ready',
  scratch: 'Scratch directory ready',
};

function labelled(id: BootStep, workdir: LaunchWorkdirMode): Omit<PhaseRow, 'mark'> {
  switch (id) {
    case 'admitted':
      return { id, label: 'Admitted', detail: 'The node took the launch' };
    case 'lane':
      return { id, label: 'Lane', detail: LANE_DETAIL[workdir] };
    case 'briefing':
      return { id, label: 'Briefing', detail: 'Prompt composed' };
    case 'agent':
      return { id, label: 'Agent', detail: 'Process started' };
    case 'live':
      return { id, label: 'Live', detail: 'Session running' };
  }
}

/** How many steps are DONE: the count of rows ticked, 0…5. */
export function stepsDone(inputs: Pick<PhaseInputs, 'admitted' | 'status' | 'bootPhase' | 'lastStep'>): number {
  const { admitted, status, bootPhase } = inputs;
  /* The session past its boot settles it whatever the phase field says: a
     `running` session with a stale `agent` phase is live. */
  if (status === 'running' || status === 'idle' || status === 'exited') return BOOT_PHASES.length;
  if (bootPhase && bootPhase !== 'failed') {
    /* A recorded step names the fact REACHED, so it is done and the next is open. */
    return BOOT_PHASES.indexOf(bootPhase) + 1;
  }
  if (bootPhase === 'failed' && inputs.lastStep) return BOOT_PHASES.indexOf(inputs.lastStep) + 1;
  return admitted || status === 'spawning' ? 1 : 0;
}

export function launchPhases(inputs: PhaseInputs): PhaseRow[] {
  const done = stepsDone(inputs);
  const failed = inputs.failed || inputs.status === 'failed' || inputs.bootPhase === 'failed';
  return BOOT_PHASES.map((id, index) => {
    const mark: PhaseMark = index < done ? 'done' : index === done ? (failed ? 'failed' : 'active') : 'pending';
    return { ...labelled(id, inputs.workdir), mark };
  });
}

/**
 * "0.4 s", "12 s", "1 m 05 s" — an elapsed figure that reads calmly: tenths
 * while a launch is fast enough for them to matter, whole seconds after.
 */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return `${(Math.floor(safe / 100) / 10).toFixed(1)} s`;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes)} m ${String(seconds % 60).padStart(2, '0')} s`;
}
