/**
 * R6's decision table (task 01a00932): where a click inside Home's centre
 * panel LANDS. `inTreeOf` answering true means the centre navigates in
 * place; false means the right panel opens. The table is exhaustive over the
 * rule's cases so the rule cannot drift silently — HomeView consults exactly
 * this function.
 */
import { describe, expect, it } from 'vitest';
import { inTreeOf } from './home-tree';

/** A tiny hierarchy: root ← child ← grandchild; `stranger` floats free. */
const PARENTS: Record<string, string | null> = {
  root: null,
  child: 'root',
  grandchild: 'child',
  sibling: 'other-root',
  'other-root': null,
  stranger: null,
};
const parentOf = (id: string) => PARENTS[id] ?? null;

describe('R6 — in the tree means the parent chain reaches the trail root', () => {
  it('the root itself is in its tree', () => {
    expect(inTreeOf('root', 'root', parentOf)).toBe(true);
  });

  it('a child and a grandchild navigate in place', () => {
    expect(inTreeOf('root', 'child', parentOf)).toBe(true);
    expect(inTreeOf('root', 'grandchild', parentOf)).toBe(true);
  });

  it('a same-kind entity OUTSIDE the tree goes right — R6d, the ruled case', () => {
    expect(inTreeOf('root', 'sibling', parentOf)).toBe(false);
  });

  it('an unrelated entity goes right', () => {
    expect(inTreeOf('root', 'stranger', parentOf)).toBe(false);
  });

  it('with no centre root, nothing is in the tree — everything lands sideways', () => {
    expect(inTreeOf(null, 'child', parentOf)).toBe(false);
  });

  it('an UNLOADED parent chain falls back to the right panel, never re-roots', () => {
    // detailOf misses answer null mid-chain: the walk stops, the click goes
    // sideways — reversible, and the panel it opens pulls the detail anyway.
    const coldCache = (id: string) => (id === 'grandchild' ? null : parentOf(id));
    expect(inTreeOf('root', 'grandchild', coldCache)).toBe(false);
  });

  it('a parent CYCLE terminates instead of hanging the click', () => {
    const cyclic = (id: string) => (id === 'a' ? 'b' : id === 'b' ? 'a' : null);
    expect(inTreeOf('root', 'a', cyclic)).toBe(false);
  });
});
