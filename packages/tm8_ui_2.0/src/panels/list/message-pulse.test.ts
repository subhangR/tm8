import { describe, expect, it } from 'vitest';

import { routeMessagePulse, type PulseTreeIndex } from './message-pulse';

/**
 *      root
 *      ├── a
 *      │   ├── a1
 *      │   └── a2
 *      └── b
 *          └── b1
 *  other (separate root)
 */
const PARENTS: Record<string, string | null> = {
  root: null,
  a: 'root',
  a1: 'a',
  a2: 'a',
  b: 'root',
  b1: 'b',
  other: null,
};

function index(hidden: readonly string[] = []): PulseTreeIndex {
  const hiddenSet = new Set(hidden);
  return {
    parentOf: (id) => (id in PARENTS ? PARENTS[id] : undefined),
    isVisible: (id) => id in PARENTS && !hiddenSet.has(id),
  };
}

describe('routeMessagePulse', () => {
  it('routes up to the common ancestor and back down, arriving last', () => {
    const route = routeMessagePulse('a1', 'b1', index());
    // a1 -> a -> root, then root -> b -> b1. The wires belong to the PARENTS:
    // a's wrapper, root's wrapper, then b's wrapper.
    expect(route.segments).toEqual([
      { ownerId: 'a', direction: 'up' },
      { ownerId: 'root', direction: 'up' },
      { ownerId: 'b', direction: 'down' },
    ]);
    expect(route.fromRowId).toBe('a1');
    expect(route.toRowId).toBe('b1');
    expect(route.absorbed).toBe(false);
  });

  it('lights a shared wire once between siblings rather than stuttering', () => {
    const route = routeMessagePulse('a1', 'a2', index());
    expect(route.segments).toEqual([{ ownerId: 'a', direction: 'up' }]);
  });

  it('absorbs a collapsed endpoint into its nearest visible ancestor', () => {
    // b1 is inside a collapsed subtree: the pulse must stop at b, not chase it.
    const route = routeMessagePulse('a1', 'b1', index(['b1']));
    expect(route.toRowId).toBe('b');
    expect(route.absorbed).toBe(true);
    expect(route.segments).toEqual([
      { ownerId: 'a', direction: 'up' },
      { ownerId: 'root', direction: 'up' },
    ]);
  });

  it('glows a single row when both ends collapse into the same ancestor', () => {
    const route = routeMessagePulse('a1', 'a2', index(['a1', 'a2']));
    expect(route.segments).toEqual([]);
    expect(route.fromRowId).toBe('a');
    expect(route.toRowId).toBe('a');
    expect(route.absorbed).toBe(true);
  });

  it('still marks the arrival when the sender is not in this tree', () => {
    const route = routeMessagePulse('elsewhere', 'b1', index());
    expect(route.segments).toEqual([]);
    expect(route.fromRowId).toBeNull();
    expect(route.toRowId).toBe('b1');
  });

  it('draws nothing when neither end is in this tree', () => {
    const route = routeMessagePulse('elsewhere', 'nowhere', index());
    expect(route.toRowId).toBeNull();
    expect(route.segments).toEqual([]);
  });

  it('refuses to draw a self-message', () => {
    expect(routeMessagePulse('a1', 'a1', index()).segments).toEqual([]);
    expect(routeMessagePulse('a1', 'a1', index()).toRowId).toBeNull();
  });

  it('routes between separate roots without inventing a shared wire', () => {
    const route = routeMessagePulse('a1', 'other', index());
    // No common ancestor: ascend a1's chain, and `other` is itself a root with
    // no parent wrapper, so the descent contributes nothing.
    expect(route.segments).toEqual([
      { ownerId: 'a', direction: 'up' },
      { ownerId: 'root', direction: 'up' },
    ]);
    expect(route.toRowId).toBe('other');
  });

  it('does not spin on a malformed parent cycle', () => {
    const cyclic: PulseTreeIndex = {
      parentOf: (id) => (id === 'x' ? 'y' : id === 'y' ? 'x' : undefined),
      isVisible: () => false,
    };
    expect(routeMessagePulse('x', 'y', cyclic)).toEqual({
      segments: [],
      fromRowId: null,
      toRowId: null,
      absorbed: false,
    });
  });
});
