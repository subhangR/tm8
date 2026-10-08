import { describe, expect, it } from 'vitest';
import { WorkspaceEventSchema, type WorkspaceEvent } from '../src/index.js';

const envelope = {
  spaceId: '019f9896-928d-79b6-ba1c-1cdcc1d30a6f', seq: 7,
  occurredAt: '2026-10-08T12:00:00.000Z', schemaVersion: 1,
};
const taskId = '019f9896-928d-7a24-848b-4c8fdd82b761';
const criterion: WorkspaceEvent = {
  ...envelope, type: 'task.criterion_changed', taskId,
  criterionId: 'ac1', criterionText: 'Run the behavior test', isDone: true, done: 2, total: 3,
  clientMutationId: 'tick-one',
};

describe('Game task delta contracts', () => {
  it('accepts a tick and an untick, with integer committed counts and mutation correlation', () => {
    expect(WorkspaceEventSchema.parse(criterion)).toEqual(criterion);
    expect(WorkspaceEventSchema.parse({ ...criterion, isDone: false, done: 1 })).toMatchObject({
      isDone: false, done: 1, total: 3,
    });
  });

  it.each([
    { criterionId: undefined }, { criterionText: undefined }, { isDone: 1 },
    { done: -1 }, { done: 1.5 }, { total: undefined }, { taskId: 7 },
    { unexpected: true },
  ])('rejects malformed criterion detail %j', (override) => {
    expect(WorkspaceEventSchema.safeParse({ ...criterion, ...override }).success).toBe(false);
  });

  it('requires both task statuses and the durable UTC event timestamp', () => {
    const event: WorkspaceEvent = { ...envelope, type: 'task.status_changed', taskId, from: 'working', to: 'cancelled' };
    expect(WorkspaceEventSchema.parse(event)).toEqual(event);
    for (const override of [{ from: undefined }, { to: 'completed' }, { occurredAt: 'yesterday' }]) {
      expect(WorkspaceEventSchema.safeParse({ ...event, ...override }).success).toBe(false);
    }
  });
});
