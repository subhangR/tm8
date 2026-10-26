import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { taskGuideLines } from '../../fixtures';
import { mergeSummary } from './reducers';

/**
 * Task 01a14b92: `childCount` rides list reads only. An event's summary has
 * none, and must not erase the count a read gave — or a tile's child subscript
 * shrinks to whatever rows happen to be loaded after any update to the row.
 */
describe('mergeSummary keeps a read child count across events', () => {
  const read = { ...taskGuideLines, childCount: 4 } as EntitySummary;
  const { childCount: _none, ...eventShape } = read;
  const event = { ...eventShape, title: 'renamed' } as EntitySummary;

  it('an event without a count keeps the one the read gave', () => {
    const merged = mergeSummary({ entities: { [read.id]: read }, details: {} }, event);
    expect(merged.entities[read.id]).toMatchObject({ title: 'renamed', childCount: 4 });
  });

  it('a later read replaces it', () => {
    const merged = mergeSummary({ entities: { [read.id]: read }, details: {} }, { ...read, childCount: 1 });
    expect(merged.entities[read.id]!.childCount).toBe(1);
  });
});
