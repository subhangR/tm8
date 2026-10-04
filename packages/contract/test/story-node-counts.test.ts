import { describe, expect, it } from 'vitest';
import { StoryNodeCountsSchema, type StoryNode } from '../src/story.js';

const node: StoryNode = {
  id: 'n', kind: 'task', title: 't', status: 'open', statusCategory: 'to_do', blocked: false,
  depth: 0, rootIds: ['n'], activityAt: null, createdAt: '2026-10-04T00:00:00.000Z',
};

describe('StoryNode.counts', () => {
  it('is optional: a node from an older server or a fixture carries none', () => {
    expect(node.counts).toBeUndefined();
  });

  it('accepts non-negative integer tallies', () => {
    expect(StoryNodeCountsSchema.parse({ messages: 0, pendingAttention: 3 })).toEqual({ messages: 0, pendingAttention: 3 });
  });

  it.each([
    { messages: -1, pendingAttention: 0 },
    { messages: 1.5, pendingAttention: 0 },
    { messages: 1 },
    { messages: 1, pendingAttention: 0, extra: 1 },
  ])('rejects %j', (bad) => {
    expect(StoryNodeCountsSchema.safeParse(bad).success).toBe(false);
  });
});
