/**
 * CodeBrain — deriving the phase spine from the graph.
 *
 * WHY THIS IS DATA AND NOT A CONSTANT. The pipeline's phases are the CHILDREN
 * of a CodeBrain root `team_member`: adding a review lens or renaming a stage
 * is an edit to the roster, not a release. A hard-coded stage list here would
 * be a second copy of that roster, and the two would part company the first
 * time anyone added a member — the same two-unjoined-twins shape the default
 * menu spine exists to prevent.
 *
 * These functions are pure and exported separately from the component so the
 * ordering rules below can be pinned by tests without a DOM.
 */
import type { EntitySummary } from '@tm8/contract';

/** A phase of the pipeline: one roster member plus what it is doing now. */
export interface CodeBrainPhase {
  readonly id: string;
  readonly name: string;
  /** Sessions currently open against this member. */
  readonly live: number;
  /** This member has posted a report for the current run. */
  readonly reported: boolean;
}

export type PhaseState = 'reported' | 'running' | 'idle';

/**
 * REPORTED OUTRANKS RUNNING, and the order matters.
 *
 * The conductor releases a session AFTER its report lands, so for a few seconds
 * a finished phase is both `reported` and still `live`. Ranking `live` first
 * would flicker a completed phase back to "running" at the moment it finished —
 * the one moment a watcher is looking at it. A report is a durable fact; a live
 * session is a transient one, and the durable fact wins.
 */
export function phaseState(p: CodeBrainPhase): PhaseState {
  if (p.reported) return 'reported';
  return p.live > 0 ? 'running' : 'idle';
}

/**
 * The spine, in roster order.
 *
 * Order comes from the graph's own `position`, NOT from the order the query
 * happened to return: a collection read is not required to be stable, and a
 * pipeline drawn in a shuffled order would be actively misleading about which
 * phase precedes which. `position` is a required field on `EntitySummary`, so
 * there is no absent case to handle; equal positions fall back to title so the
 * order is still total rather than left to sort stability.
 */
export function deriveSpine(
  members: readonly EntitySummary[],
  liveByMember: ReadonlyMap<string, number>,
  reportedMemberIds: ReadonlySet<string>,
): CodeBrainPhase[] {
  const rows = members.map((m) => ({
    id: m.id as string,
    /* `title` is the summary's display field — there is no `name`. A phase
       whose title is empty renders a placeholder rather than a blank row, so a
       misconfigured member is visible instead of invisible. */
    name: m.title && m.title.length > 0 ? m.title : '(unnamed)',
    position: m.position,
    live: liveByMember.get(m.id as string) ?? 0,
    reported: reportedMemberIds.has(m.id as string),
  }));
  rows.sort((a, b) => (a.position === b.position ? a.name.localeCompare(b.name) : a.position - b.position));
  return rows.map(({ id, name, live, reported }) => ({ id, name, live, reported }));
}

/** How far the run has got: reported phases over total. Empty roster is 0/0. */
export function runProgress(spine: readonly CodeBrainPhase[]): {
  done: number;
  total: number;
  running: number;
} {
  let done = 0;
  let running = 0;
  for (const p of spine) {
    const s = phaseState(p);
    if (s === 'reported') done += 1;
    else if (s === 'running') running += 1;
  }
  return { done, total: spine.length, running };
}
