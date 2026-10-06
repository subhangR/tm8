// Points-weighted progress (migration 307, task 01a111b4, spec doc 01a111ba).
//
// One calculation for tasks and stories, computed on read by
// `internal.progress_tally` and carried on list rows, the story page and every
// `entity.upsert`. Over a set of tasks:
//
//   w(t)    = pointsEstimate if > 0, else 1 (a "surveyor tent": no estimate)
//   own(t)  = 1 if done, else ticked/total criteria, else 0 (a task without
//             criteria is counted, with no progress until done — form 01a111fd)
//   earned  = Σ w·own, total = Σ w
//   percent = floor(100 · earned / total); null when total is 0 (no work)
//
// Cancelled tasks and their subtrees are out; done ones keep counting.
import { z } from 'zod';

export interface WeightedProgress {
  /** floor(100 · earned / total); null when nothing is countable. */
  percent: number | null;
  /** Σ weight · own completion, rounded to 2 places. */
  earned: number;
  /** Σ weight over the counted tasks. */
  total: number;
  /** The building size: Σ weight, today equal to `total` (kept apart for the map). */
  size: number;
  /** Counted tasks. */
  tasks: number;
  /** Counted tasks not done. */
  open: number;
  /** Counted tasks without an estimate (weight defaulted to 1). */
  tents: number;
}

/** A task's progress: over its subtree (itself included), own completion apart (D3). */
export interface TaskProgress extends WeightedProgress {
  /** The task's own completion, 0..1: 1 once done; null only for a cancelled task. */
  own: number | null;
  /** This task has no estimate. */
  tent: boolean;
  /** Live, not-done tasks below it. A done task with openSubtasks > 0 shows "subtasks open". */
  openSubtasks: number;
}

const weightedShape = {
  percent: z.number().int().min(0).max(100).nullable(),
  earned: z.number().nonnegative(),
  total: z.number().nonnegative(),
  size: z.number().nonnegative(),
  tasks: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  tents: z.number().int().nonnegative(),
};

export const WeightedProgressSchema: z.ZodType<WeightedProgress> = z.object(weightedShape).strict();

export const TaskProgressSchema: z.ZodType<TaskProgress> = z.object({
  ...weightedShape,
  own: z.number().min(0).max(1).nullable(),
  tent: z.boolean(),
  openSubtasks: z.number().int().nonnegative(),
}).strict();
