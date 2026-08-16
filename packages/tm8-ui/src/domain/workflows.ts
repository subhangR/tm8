/**
 * W4 — TASK WORKFLOWS, the client half of migration 132.
 *
 * A space narrows the status vocabulary per `type` axis value
 * (`task_workflows`, one row per (space, type value)). The DATABASE is the
 * gate — a trigger on `public.tasks` refuses a status outside the vocabulary
 * with `workflow_forbids_status` — and the client narrows only for usability:
 * the same rule, stated BEFORE the click, in the same words everywhere it is
 * stated. This module is that one place, so the strip's disabled option, the
 * board's pre-flight refusal and the fixture's trigger mirror cannot drift
 * apart.
 *
 * These are STATUS words and an AXIS name — not entity kinds — so §15.2 (no
 * kind literals outside `domain/` and `fixtures/`) does not bite; they live
 * here anyway because three call sites each spelling `'type'` is how a rename
 * becomes a silent miss.
 */
import type { TaskWorkflow } from '@tm8/contract';

/**
 * The axis workflows key on — STRICTLY `type`, by owner ruling (task-types
 * wave, 2026-08-16). The trigger reads `new.axes ->> 'type'`; this is the
 * same string, once.
 */
export const WORKFLOW_AXIS = 'type';

/**
 * The three statuses EVERY vocabulary must contain — 132's check constraint
 * `task_workflows_structural_statuses`. Each maps to a writer a vocabulary
 * must not be able to break: creation writes `open`, the spawn door writes
 * `working`, `complete_task` alone writes `done`. The narrowable set is
 * therefore exactly {pulled, in_review, blocked, cancelled}.
 */
export const STRUCTURAL_STATUSES: readonly string[] = ['open', 'working', 'done'];

/**
 * The row's `type` value, read structurally off the state envelope the way
 * every control in `EntityControls.tsx` reads state — no kind is named, and a
 * row whose state carries no `axes` record answers null.
 */
export function workflowTypeOf(state: unknown): string | null {
  const record = (state as Record<string, unknown> | null | undefined)?.axes;
  if (typeof record !== 'object' || record === null) return null;
  const value = (record as Record<string, unknown>)[WORKFLOW_AXIS];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The vocabulary governing a row, or null when nothing narrows it — no `type`
 * value, no rule for the value, or no rules at all. Null means "today's
 * behaviour exactly", which is the trigger's own answer for the same cases.
 */
export function workflowVocabularyOf(
  workflows: readonly TaskWorkflow[] | undefined,
  state: unknown,
): readonly string[] | null {
  const typeValue = workflowTypeOf(state);
  if (typeValue === null) return null;
  const rule = (workflows ?? []).find((w) => w.typeValue === typeValue);
  return rule ? rule.statuses : null;
}

/**
 * The one refusal sentence, used verbatim by the strip's disabled option, the
 * board's pre-flight refusal and the off-workflow caption — the user-copy
 * rendering of the trigger's `workflow_forbids_status` detail.
 */
export function workflowRefusalText(typeValue: string, status: string): string {
  return `type ${typeValue} does not allow ${status.replace(/_/g, ' ')}`;
}

/**
 * OFF-WORKFLOW is a DERIVED fact (owner ruling): a task whose CURRENT status
 * is outside its type's vocabulary — reachable by re-typing — is flagged,
 * never stored, never rewritten, never refused. Answers the type value when
 * the row is off-workflow, else null.
 */
export function offWorkflowType(
  workflows: readonly TaskWorkflow[] | undefined,
  state: unknown,
  currentStatus: string,
): string | null {
  if (currentStatus === '') return null;
  const vocabulary = workflowVocabularyOf(workflows, state);
  if (vocabulary === null || vocabulary.includes(currentStatus)) return null;
  return workflowTypeOf(state);
}
