/**
 * The `action='tool'` firing (design of record 01a182d4 §3.4 "tool"; the seam
 * ruled on research task 01a182ca and built by Tools PR-C, migration 379).
 *
 * A tool firing is NOT a spawn: no task is derived (there is nothing for a
 * tool to be assigned), and the loop side writes NO `triggered_by` edge.
 * `ToolRuntime.runScheduled` → `start_tool_session(..., p_triggered_by_loop_id)`
 * writes the run's provenance-marked edge inside the run's own transaction, and
 * that marked edge is both the run history the overlap guard reads and the
 * authority the run's tm8 bearer is minted on. A second, loop-side edge would
 * be an unmarked duplicate that proves nothing and double-counts the run.
 *
 * Everything else about the run is the runtime's: inputs validated against the
 * CURRENT tool definition (a renamed, removed, newly required or invalid stored
 * input is an `invalid_input` naming every offender BEFORE any row exists),
 * `p_tool_version` pinned, keep-open off, cwd the acting identity's scratch
 * dir, a kind-agent token acting as the loop's runs-as persona when the tool
 * has tm8 access. The runtime's refusals propagate UNCHANGED so the executor
 * records their text as the run's launch error and the loop's `last_error`:
 * `invalid_input`, `forbidden` (credential unavailable / mint refused),
 * `limit_exceeded`, `version_conflict`, `upstream_unavailable` 'Tool launch failed'.
 */
import { CollabError } from '@tm8/contract';
import type { DbClaims } from '../db/types.js';
import type { DueLoop } from '../scheduler/jobs/loops.js';
import type { ToolRuntime } from '../tools/runtime.js';

export interface ToolFiringDeps {
  /** PR-C's seam; absent on a node with no execution block. */
  readonly tools?: Pick<ToolRuntime, 'runScheduled'> | undefined;
}

/** The due-loop columns a tool firing reads (§2.1: the claim read carries them). */
export type ToolFiringLoop = Pick<DueLoop, 'entityId' | 'title' | 'teamMemberId' | 'toolId' | 'toolInputs'>;

/**
 * Exactly one call: `runScheduled(claims, { toolId, inputs, firingKey,
 * triggeredByLoopId, runAsTeamMemberId?, title })`, under the firing's own
 * `claimsForLoop` claims (375) and nothing else. `firingKey` is the same key
 * the spawn path mints its `loop-fire:` id from (`firingKeyFor`), so the
 * runtime's `tool-fire:<key>` replays a transport retry and never a next firing.
 */
export async function fireTool(
  deps: ToolFiringDeps,
  loop: ToolFiringLoop,
  claims: DbClaims,
  firingKey: string,
): Promise<{ taskId: null; sessionId: string }> {
  if (!deps.tools) {
    throw new CollabError('not_implemented', `loop "${loop.title}" runs a tool, but this node has no tool runtime`);
  }
  if (!loop.toolId) {
    // The door refuses this shape (378 assert_loop_runner); reaching it means a
    // row was written around the door. Loud, and recorded on the loop.
    throw new CollabError('invariant_violation', `tool loop ${loop.entityId} names no tool`);
  }
  const run = await deps.tools.runScheduled(claims, {
    toolId: loop.toolId,
    inputs: loop.toolInputs,
    firingKey,
    triggeredByLoopId: loop.entityId,
    // For a tool loop `team_member_id` is the runs-as persona (§2.1): required
    // by the runtime when the tool has tm8 access, meaningless otherwise.
    ...(loop.teamMemberId ? { runAsTeamMemberId: loop.teamMemberId } : {}),
    // Printed in the run's header; the session keeps the tool's name.
    title: loop.title,
  });
  return { taskId: null, sessionId: run.sessionId };
}
