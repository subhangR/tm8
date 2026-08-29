/**
 * THE ROSTER ORDER. The defect this pins is that there was no ordering rule at
 * all — the roster arrived in the domain store's key-insertion order, which is
 * a by-product rather than a sort and reshuffles between boots.
 *
 * So the cases below are about DETERMINISM as much as about recency: a rule
 * that ranks recents but leaves the tail arbitrary would still hand a viewer
 * with no launch history exactly the picker they complained about.
 */
import { describe, expect, it } from 'vitest';
import { orderTeammatesByRecency } from './launch';

const t = (id: string, name: string) => ({ id, name });
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe('recents come first, in the order they were last launched', () => {
  it('ranks by position in the recents list', () => {
    const roster = [t('a', 'Ann'), t('b', 'Bob'), t('c', 'Cy')];
    expect(ids(orderTeammatesByRecency(roster, ['c', 'a']))).toEqual(['c', 'a', 'b']);
  });

  it('puts every recent ahead of every non-recent, whatever the names say', () => {
    // 'Zoe' sorts last alphabetically and must still lead: recency outranks
    // the tail rule, or the feature does nothing for the person it is for.
    const roster = [t('a', 'Ann'), t('z', 'Zoe')];
    expect(ids(orderTeammatesByRecency(roster, ['z']))).toEqual(['z', 'a']);
  });

  it('ignores a recent id that is no longer on the roster', () => {
    // A deleted persona must not be resurrected into the picker by having once
    // been launched — only ids are stored, so there is no row to resurrect.
    const roster = [t('a', 'Ann'), t('b', 'Bob')];
    expect(ids(orderTeammatesByRecency(roster, ['gone', 'b']))).toEqual(['b', 'a']);
  });

  it('ranks a duplicated id by its FIRST position only', () => {
    const roster = [t('a', 'Ann'), t('b', 'Bob'), t('c', 'Cy')];
    expect(ids(orderTeammatesByRecency(roster, ['c', 'a', 'c']))).toEqual(['c', 'a', 'b']);
  });
});

describe('the tail is alphabetical, which is the half that fixes a cold browser', () => {
  it('orders un-launched teammates by name, not by arrival', () => {
    // Deliberately reverse-alphabetical input: this is what insertion order
    // looked like, and the whole point is that it stops mattering.
    const roster = [t('c', 'Cy'), t('a', 'Ann'), t('b', 'Bob')];
    expect(ids(orderTeammatesByRecency(roster, []))).toEqual(['a', 'b', 'c']);
  });

  it('collates numerically, so "Worker 2" precedes "Worker 10"', () => {
    const roster = [t('x', 'Worker 10'), t('y', 'Worker 2')];
    expect(ids(orderTeammatesByRecency(roster, []))).toEqual(['y', 'x']);
  });

  it('is case-insensitive, so casing does not split the alphabet in two', () => {
    const roster = [t('u', 'bob'), t('v', 'Ann')];
    expect(ids(orderTeammatesByRecency(roster, []))).toEqual(['v', 'u']);
  });

  it('breaks a NAME tie on id, so two same-named personas cannot reshuffle', () => {
    // Same name is realistic — personas are seeded per model with shared
    // prefixes. Without the id tiebreak these two would compare equal and the
    // engine would leave them in insertion order: the original defect, at the
    // rows most likely to collide.
    const forwards = [t('b', 'Twin'), t('a', 'Twin')];
    const backwards = [t('a', 'Twin'), t('b', 'Twin')];
    expect(ids(orderTeammatesByRecency(forwards, []))).toEqual(['a', 'b']);
    expect(ids(orderTeammatesByRecency(backwards, []))).toEqual(['a', 'b']);
  });

  it('gives the SAME answer for any input permutation — the determinism claim', () => {
    const roster = [t('a', 'Ann'), t('b', 'Bob'), t('c', 'Cy'), t('d', 'Dee')];
    const expected = ['c', 'a', 'b', 'd'];
    const permutations = [
      [roster[0], roster[1], roster[2], roster[3]],
      [roster[3], roster[2], roster[1], roster[0]],
      [roster[2], roster[0], roster[3], roster[1]],
      [roster[1], roster[3], roster[0], roster[2]],
    ] as const;
    for (const p of permutations) {
      expect(ids(orderTeammatesByRecency(p, ['c']))).toEqual(expected);
    }
  });
});

describe('it is pure', () => {
  it('does not mutate the roster it was given', () => {
    // The input is a memo's output that other consumers already hold; sorting
    // it in place would reorder their copy too.
    const roster = [t('c', 'Cy'), t('a', 'Ann')];
    orderTeammatesByRecency(roster, ['a']);
    expect(ids(roster)).toEqual(['c', 'a']);
  });

  it('handles an empty roster and empty recents', () => {
    expect(orderTeammatesByRecency([], [])).toEqual([]);
    expect(orderTeammatesByRecency([], ['a'])).toEqual([]);
  });
});
