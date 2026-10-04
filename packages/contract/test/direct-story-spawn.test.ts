import { describe, expect, it } from 'vitest';
import { ExecutionSpawnInputSchema } from '../src/schemas.js';

const id = '11111111-1111-4111-8111-111111111111';
const direct = { clientMutationId: 'story-spawn', spaceId: id, teamMemberId: id, storyId: id };
describe('direct story spawn input', () => {
  it('accepts a direct story with an optional parent', () => {
    expect(ExecutionSpawnInputSchema.parse({ ...direct, parentSessionId: id })).toMatchObject(direct);
  });
  it.each([
    { taskIds: [] }, { taskIds: [id] }, { newTask: { title: 'Work' } },
    { forceNewTask: false }, { forceNewTask: true },
  ])('rejects explicit task options alongside a story: %j', conflict => {
    expect(ExecutionSpawnInputSchema.safeParse({ ...direct, ...conflict }).success).toBe(false);
  });
  it('rejects client-provided inheritance provenance', () => {
    expect(ExecutionSpawnInputSchema.safeParse({ ...direct, sourceWorkSessionId: id }).success).toBe(false);
  });
});
