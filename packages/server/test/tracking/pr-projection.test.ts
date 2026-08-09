// The read door for the two forge facts.
//
// Lane B renders from `ciStatus` and `mergeState`, and the single rule that
// governs both is a RULING rather than a preference:
//
//   ABSENCE IS NOT A VERDICT.
//
// `null` means this node has no answer. `'unknown'` means GitHub gave one and
// the answer was "I am still computing". Collapsing those two is how a UI ends
// up telling someone we checked when we never did, so most of what follows is
// about keeping them apart.

import { describe, expect, it } from 'vitest';

import {
  projectCiStatus,
  projectForgeFacts,
  projectMergeState,
} from '../../src/tracking/pr-projection.js';

describe('ciStatus is validated, not translated', () => {
  it('passes the three words 082 constrains the column to', () => {
    expect(projectCiStatus('passing')).toBe('passing');
    expect(projectCiStatus('failing')).toBe('failing');
    expect(projectCiStatus('pending')).toBe('pending');
  });

  it('BLOCKING RULE — no verdict is null, never a green-looking default', () => {
    // A PR nobody has observed has not passed CI. Defaulting to 'passing' here
    // would put a tick next to a pull request no process has ever looked at.
    expect(projectCiStatus(null)).toBeNull();
    expect(projectCiStatus(undefined)).toBeNull();
    expect(projectCiStatus('')).toBeNull();
  });

  it('drops a word the enum does not contain rather than passing it through', () => {
    // A consumer typed on the enum would otherwise receive a value its own type
    // says cannot exist.
    expect(projectCiStatus('flaky')).toBeNull();
    expect(projectCiStatus(7)).toBeNull();
  });
});

describe('mergeState narrows GitHub eight words to the contract three', () => {
  it('only `dirty` is a conflict', () => {
    expect(projectMergeState('dirty')).toBe('conflicted');
  });

  it('BLOCKING RULE — absence is null and `unknown` is GitHub saying so', () => {
    expect(projectMergeState(null)).toBeNull();
    expect(projectMergeState(undefined)).toBeNull();
    expect(projectMergeState('')).toBeNull();
    // The DIFFERENT claim: we asked, and GitHub was still computing the merge.
    expect(projectMergeState('unknown')).toBe('unknown');
  });

  it('states that block a merge WITHOUT being conflicts map to clean', () => {
    // `blocked` is a missing review, `behind` is a base that moved, `unstable`
    // is a red non-required check. Reporting any of them as 'conflicted' sends
    // an agent to resolve a conflict that does not exist — the same false alarm
    // the stacked-PR suppression exists to prevent.
    for (const state of ['clean', 'blocked', 'behind', 'unstable', 'draft', 'has_hooks']) {
      expect(projectMergeState(state)).toBe('clean');
    }
  });

  it('a word GitHub adds later is `unknown`, not `clean`', () => {
    // We have a value and cannot interpret it. Asserting 'clean' about a state
    // nobody here has read the definition of is the one answer that could be
    // actively wrong.
    expect(projectMergeState('some_future_state')).toBe('unknown');
  });
});

describe('the projected pair', () => {
  it('always carries both keys, explicitly null when unknown', () => {
    // Explicit null, not omission: it distinguishes "this node has no verdict"
    // from "this node is too old to know the field exists".
    expect(projectForgeFacts(null, null)).toEqual({ ciStatus: null, mergeState: null });
  });

  it('carries a real verdict through', () => {
    expect(projectForgeFacts('failing', 'dirty')).toEqual({
      ciStatus: 'failing',
      mergeState: 'conflicted',
    });
  });
});
