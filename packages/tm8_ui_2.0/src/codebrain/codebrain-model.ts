/**
 * codebrain-model — pure functions over `EntitySummary` rows: which team
 * members are the six CodeBrain phases, what state each is in for a given
 * run, and which tasks count as a run at all (SPEC §6).
 *
 * PURE AND TOTAL — no React, no store, no fetch, the `nav-targets.ts`
 * posture. `CODEBRAIN_ROOT_ID` is the ONLY hardcoded CodeBrain fact (AC3):
 * the six phases, their names, models, tools and ids are all read off the
 * rows the caller passes in, never assumed.
 */
import type { EdgeView, EntityId, EntitySummary } from '@tm8/contract';

export const CODEBRAIN_ROOT_ID = '01a05662-e721-78a4-a68d-673d1ba964eb' as EntityId;

export interface Phase {
  id: EntityId;
  position: number;
  title: string;
  model: string | null;
  agentTool: string | null;
}

function idOrd(a: EntityId, b: EntityId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The six phases, in `position` order. Total: a tie on `position` falls
 * through to `id` (A6) so the order is never ambiguous. Positions 7-10 are
 * the specialists this slice does not render (SPEC §0).
 */
export function phases(rows: readonly EntitySummary[]): Phase[] {
  return rows
    .filter(
      (r) => r.kind === 'team_member' && r.parentId === CODEBRAIN_ROOT_ID && r.deletedAt === null,
    )
    .sort((a, b) => a.position - b.position || idOrd(a.id, b.id))
    .filter((r) => r.position <= 6)
    .map((r) => {
      const state = r.state.kind === 'team_member' ? r.state : null;
      return {
        id: r.id,
        position: r.position,
        title: r.title,
        model: state?.model ?? null,
        agentTool: state?.agentTool ?? null,
      };
    });
}

/**
 * A run is a task a CodeBrain phase has touched, checked three independent
 * ways (SPEC §6.2). The third disjunct is the one a summary alone cannot
 * answer: it walks `working_on` edges to find a session, spawned as one of
 * the phases, whose sessions have since all exited — the summary's own
 * `assignees`/`workingActors` go stale the moment the last session does.
 *
 * Over-inclusive by design (a task a phase merely touched also counts) —
 * flagged in SPEC §2 A2. Under-inclusion would hide a real run, which is
 * worse.
 */
export function isRun(
  task: EntitySummary,
  phaseIds: ReadonlySet<EntityId>,
  edges: readonly EdgeView[],
): boolean {
  if (task.state.kind !== 'task') return false;
  if (task.state.assignees.some((a) => phaseIds.has(a.id as EntityId))) return true;
  if (task.badges.workingActors?.some((w) => phaseIds.has(w.actor.id as EntityId))) return true;
  return hasWorkingOnFromPhaseSession(task.id, phaseIds, edges);
}

function hasWorkingOnFromPhaseSession(
  taskId: EntityId,
  phaseIds: ReadonlySet<EntityId>,
  edges: readonly EdgeView[],
): boolean {
  return edges.some((edge) => {
    if (edge.type !== 'working_on' || edge.target.id !== taskId) return false;
    if (edge.source.state.kind !== 'work_session') return false;
    const teammateId = edge.source.state.teammate?.id;
    return teammateId != null && phaseIds.has(teammateId as EntityId);
  });
}

/** Closed vocabulary, SPEC §6.3. `idle` is deliberately not folded into
 *  `running` — an idle session is not work in progress. */
export type PhaseState = 'done' | 'running' | 'queued' | 'waiting' | 'failed';

/** Sessions for one phase on one run — a `working_on` edge whose source is a
 *  `work_session` naming that phase as its teammate, targeting this run. */
export function sessionsFor(
  runId: EntityId,
  phaseId: EntityId,
  edges: readonly EdgeView[],
): EntitySummary[] {
  return edges
    .filter(
      (edge) =>
        edge.type === 'working_on' &&
        edge.target.id === runId &&
        edge.source.state.kind === 'work_session' &&
        edge.source.state.teammate?.id === phaseId,
    )
    .map((edge) => edge.source);
}

/** Rules 2-5 of SPEC §6.3, independent of `waiting` — see `phaseStatesOf` for
 *  why `waiting` cannot be decided per phase in isolation. */
function baseStateFor(
  phase: Phase,
  run: EntitySummary,
  sessions: readonly EntitySummary[],
): Exclude<PhaseState, 'waiting'> {
  const statusOf = (s: EntitySummary): string | null =>
    s.state.kind === 'work_session' ? s.state.status : null;

  if (sessions.some((s) => statusOf(s) === 'failed')) return 'failed';

  const namedByWorkingActors = (run.badges.workingActors ?? []).some(
    (w) => w.actor.id === phase.id,
  );
  const hasLiveSession = sessions.some((s) => {
    const status = statusOf(s);
    return status === 'spawning' || status === 'running';
  });
  if (namedByWorkingActors || hasLiveSession) return 'running';

  const hasExited = sessions.some((s) => {
    if (s.state.kind !== 'work_session') return false;
    return s.state.exitedAt !== null && s.state.status === 'exited';
  });
  if (hasExited) return 'done';

  return 'queued';
}

/**
 * Every phase's state for one run, in one pass (SPEC §6.3).
 *
 * WHY THIS IS NOT A PER-PHASE FUNCTION. `waiting` fires only on "the frontier
 * phase" — the lowest-position phase not `done` — and a phase cannot know
 * whether it IS the frontier without knowing every earlier phase's state
 * too. So this computes each phase's base state (rules 2-5, order-
 * independent) first, finds the one frontier from that, and only then
 * decides whether the run's pending attention promotes it to `waiting`.
 */
export function phaseStatesOf(
  run: EntitySummary,
  orderedPhases: readonly Phase[],
  edges: readonly EdgeView[],
): Map<EntityId, PhaseState> {
  const base = new Map<EntityId, Exclude<PhaseState, 'waiting'>>();
  for (const phase of orderedPhases) {
    base.set(phase.id, baseStateFor(phase, run, sessionsFor(run.id, phase.id, edges)));
  }

  const frontier = orderedPhases.find((p) => base.get(p.id) !== 'done') ?? null;
  const pending = (run.badges.attention?.pendingCount ?? 0) > 0;

  const result = new Map<EntityId, PhaseState>();
  for (const phase of orderedPhases) {
    result.set(
      phase.id,
      pending && frontier?.id === phase.id ? 'waiting' : base.get(phase.id)!,
    );
  }
  return result;
}
