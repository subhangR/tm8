import { describe, expect, it } from 'vitest';
import { TaskCancellationObservationsInputSchema, TaskCancellationObservationsSchema } from '../src/task-cancellation-observations.js';
const TASK = '00000000-0000-7000-8000-000000000001';
describe('bounded cancellation observation contract', () => {
  it('accepts 500 IDs and denies overflow and caller identity fields', () => {
    expect(TaskCancellationObservationsInputSchema.safeParse({ taskIds: Array(500).fill(TASK) }).success).toBe(true);
    expect(TaskCancellationObservationsInputSchema.safeParse({ taskIds: Array(501).fill(TASK) }).success).toBe(false);
    expect(TaskCancellationObservationsInputSchema.safeParse({ taskIds: [TASK], viewerId: TASK }).success).toBe(false);
  });
  it('requires explicit space identity, complete facts and valid observation times', () => {
    const response = { schemaVersion: 'tm8.task-cancellation-observations.v1', spaceId: TASK, complete: true,
      facts: [{ taskId: TASK, statusChangedNotAfter: '2026-10-08T12:00:00.000Z' }] };
    expect(TaskCancellationObservationsSchema.safeParse(response).success).toBe(true);
    expect(TaskCancellationObservationsSchema.safeParse({ ...response, complete: false }).success).toBe(false);
    expect(TaskCancellationObservationsSchema.safeParse({ ...response, facts: [{ taskId: TASK, statusChangedNotAfter: 'unknown' }] }).success).toBe(false);
  });
});
