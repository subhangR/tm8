import { z } from 'zod';

export const MAX_TASK_CANCELLATION_OBSERVATION_IDS = 500;

export interface TaskCancellationObservationsInput {
  taskIds: string[];
}

/** A cancellation was observed by this date; its actual instant is unknown. */
export interface TaskCancellationObservation {
  taskId: string;
  statusChangedNotAfter: string;
}

export interface TaskCancellationObservations {
  schemaVersion: 'tm8.task-cancellation-observations.v1';
  spaceId: string;
  /** All eligible readable facts for the requested ids, without truncation. */
  complete: true;
  /** Missing ids are unknown, ineligible, deleted or unreadable; never infer why. */
  facts: TaskCancellationObservation[];
}

export const TaskCancellationObservationsInputSchema: z.ZodType<TaskCancellationObservationsInput> = z.object({
  taskIds: z.array(z.string().uuid()).max(MAX_TASK_CANCELLATION_OBSERVATION_IDS),
}).strict();

export const TaskCancellationObservationsSchema: z.ZodType<TaskCancellationObservations> = z.object({
  schemaVersion: z.literal('tm8.task-cancellation-observations.v1'),
  spaceId: z.string().uuid(),
  complete: z.literal(true),
  facts: z.array(z.object({
    taskId: z.string().uuid(),
    statusChangedNotAfter: z.string().datetime(),
  }).strict()).max(MAX_TASK_CANCELLATION_OBSERVATION_IDS),
}).strict();
