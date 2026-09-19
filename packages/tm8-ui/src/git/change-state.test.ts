/**
 * THE XY PREDICATES, PINNED.
 *
 * `change-state.ts` is forty lines of string indexing, which is exactly the
 * kind of code that gets "simplified" into a partition by someone who has not
 * met `MM`. These cases exist to make that edit fail loudly:
 *
 *  · a path can be staged AND unstaged, and both predicates must say yes;
 *  · untracked is NOT unstaged — `git diff` cannot see a file with no index
 *    entry, so counting it as unstaged would make a chip's count disagree with
 *    the diff that chip opens;
 *  · each filter names a git COMPARISON, and the caption says which.
 */
import { describe, expect, it } from 'vitest';
import type { SessionGitFile } from '@tm8/contract';
import {
  CHANGE_FILTERS,
  CHANGE_FILTER_LABEL,
  FILTER_SCOPE,
  SCOPE_CAPTION,
  isPartlyStaged,
  isStaged,
  isUnstaged,
  isUntracked,
  matchesFilter,
  statusTitle,
} from './change-state.js';

const f = (status: string, path = 'x.ts'): SessionGitFile => ({ status, path });

describe('the XY columns, read one at a time', () => {
  it.each([
    // status, staged, unstaged, untracked
    ['M ', true, false, false], // staged edit only
    [' M', false, true, false], // working-tree edit only
    ['MM', true, true, false], // BOTH — the case a partition cannot hold
    ['A ', true, false, false], // newly tracked, staged
    ['AM', true, true, false], // added, then edited again
    ['D ', true, false, false], // staged deletion
    [' D', false, true, false], // deleted on disk, not staged
    ['R ', true, false, false], // staged rename
    ['??', false, false, true], // untracked — and NOT unstaged
  ])('%s → staged %s, unstaged %s, untracked %s', (status, staged, unstaged, untracked) => {
    const file = f(status as string);
    expect(isStaged(file)).toBe(staged);
    expect(isUnstaged(file)).toBe(unstaged);
    expect(isUntracked(file)).toBe(untracked);
  });

  it('only the both-halves case is partly staged', () => {
    expect(isPartlyStaged(f('MM'))).toBe(true);
    expect(isPartlyStaged(f('AM'))).toBe(true);
    expect(isPartlyStaged(f('M '))).toBe(false);
    expect(isPartlyStaged(f(' M'))).toBe(false);
    expect(isPartlyStaged(f('??'))).toBe(false);
  });

  /**
   * THE LINE THAT PAYS FOR THIS FILE. `??` is two characters and its second
   * one is `?`, so a naive `status[1] !== ' '` reads every untracked file as
   * unstaged — a chip that counts it and then opens a diff git cannot produce.
   */
  it('untracked is its own state, never unstaged', () => {
    expect(isUnstaged(f('??'))).toBe(false);
    expect(matchesFilter(f('??'), 'unstaged')).toBe(false);
    expect(matchesFilter(f('??'), 'untracked')).toBe(true);
  });
});

describe('a filter is a git comparison, not a label', () => {
  it('puts the both-halves file under staged AND unstaged', () => {
    expect(matchesFilter(f('MM'), 'staged')).toBe(true);
    expect(matchesFilter(f('MM'), 'unstaged')).toBe(true);
    expect(matchesFilter(f('MM'), 'untracked')).toBe(false);
    expect(matchesFilter(f('MM'), 'all')).toBe(true);
  });

  it('every filter has a scope, a label and a caption naming the comparison', () => {
    for (const filter of CHANGE_FILTERS) {
      expect(CHANGE_FILTER_LABEL[filter]).toBeTruthy();
      const scope = FILTER_SCOPE[filter];
      expect(SCOPE_CAPTION[scope]).toBeTruthy();
    }
    // Staged is `git diff --cached`, unstaged is `git diff`. Swapping these
    // shows a reviewer bytes that are not in the commit they are making.
    expect(FILTER_SCOPE.staged).toBe('staged');
    expect(FILTER_SCOPE.unstaged).toBe('unstaged');
    // Untracked has no index entry to compare against, so it rides the
    // session scope and the server answers it with `--no-index`.
    expect(FILTER_SCOPE.untracked).toBe('session');
    expect(FILTER_SCOPE.all).toBe('session');
    expect(SCOPE_CAPTION.staged).toContain('exactly what a commit would write');
  });
});

describe('the row title says both halves in words', () => {
  it.each([
    ['M ', 'staged (M)'],
    [' M', 'unstaged (M)'],
    ['??', 'untracked — git has no record of this file yet'],
  ])('%s reads as %s', (status, expected) => {
    expect(statusTitle(f(status as string))).toContain(expected as string);
  });

  it('names BOTH pending changes for a split file, with the right letter each', () => {
    expect(statusTitle(f('AM'))).toBe('staged (A) · unstaged (M)');
  });
});
