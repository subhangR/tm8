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
  LINKED_PULL_REQUEST_BADGE_CAP,
  loadLinkedPullRequestBadges,
  projectCiStatus,
  projectForgeFacts,
  projectMergeState,
} from '../../src/tracking/pr-projection.js';

import type { Querier } from '../../src/db/types.js';

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

describe('the projected facts', () => {
  it('always carries every key, explicitly null when unknown', () => {
    // Explicit null, not omission: it distinguishes "this node has no verdict"
    // from "this node is too old to know the field exists". headRef (107)
    // joins the pair under the same law.
    expect(projectForgeFacts(null, null)).toEqual({
      ciStatus: null,
      mergeState: null,
      headRef: null,
    });
  });

  it('carries a real verdict through', () => {
    expect(projectForgeFacts('failing', 'dirty', 'feat/session-lane-facts')).toEqual({
      ciStatus: 'failing',
      mergeState: 'conflicted',
      headRef: 'feat/session-lane-facts',
    });
  });

  it('drops an empty-string headRef to null — an empty branch name is no claim', () => {
    expect(projectForgeFacts(null, null, '').headRef).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// badges.pullRequests — the loader BOTH assemblers call
// ---------------------------------------------------------------------------

/**
 * A Querier that answers one canned result set and records what it was asked.
 *
 * The SQL is exercised against a live database by the pg suites; what matters
 * here is the shaping around it — the task gate, the cap, and the truncation
 * signal — none of which Postgres decides.
 */
function stubQuerier(rows: Record<string, unknown>[]): Querier & { calls: number } {
  const q = {
    calls: 0,
    async query<R>(): Promise<R[]> {
      q.calls += 1;
      return rows as R[];
    },
    async rpc<T>(): Promise<T> {
      throw new Error('the badge loader is a READ — it must never call an RPC');
    },
  };
  return q;
}

function prRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: 'task-1',
    entity_id: 'pr-1',
    repo: 'acme/tm8',
    number: 42,
    title: 'Ship linked PR chips',
    state: 'open',
    url: 'https://github.com/acme/tm8/pull/42',
    ci_status: null,
    mergeable_state: null,
    head_ref: null,
    ...over,
  };
}

describe('loadLinkedPullRequestBadges', () => {
  it('never touches the database when the page holds no task', async () => {
    // Not merely an optimisation: `tracks` is written task→PR, so a page of
    // docs and messages could not match anyway. Saying so keeps the query off
    // the read path rather than relying on it returning zero rows.
    const q = stubQuerier([]);
    const out = await loadLinkedPullRequestBadges(q, [
      { id: 'doc-1', kind: 'doc' },
      { id: 'msg-1', kind: 'message' },
    ]);
    expect(out.size).toBe(0);
    expect(q.calls).toBe(0);
  });

  it('projects the row into a badge, keeping absence absent', async () => {
    const q = stubQuerier([prRow()]);
    const badges = (await loadLinkedPullRequestBadges(q, [{ id: 'task-1', kind: 'task' }])).get('task-1');
    expect(badges?.truncated).toBe(false);
    expect(badges?.items).toEqual([{
      entityId: 'pr-1',
      repository: 'acme/tm8',
      number: 42,
      title: 'Ship linked PR chips',
      state: 'open',
      url: 'https://github.com/acme/tm8/pull/42',
      // Nothing observed it. NOT a green verdict — the ruling at the top of
      // this file, carried onto the badge.
      ciStatus: null,
      mergeState: null,
      headRef: null,
    }]);
  });

  it('maps the forge facts through the same two mappers the state arm uses', async () => {
    const q = stubQuerier([prRow({ ci_status: 'failing', mergeable_state: 'dirty', head_ref: 'feat/x' })]);
    const badges = (await loadLinkedPullRequestBadges(q, [{ id: 'task-1', kind: 'task' }])).get('task-1');
    expect(badges?.items[0]).toMatchObject({
      ciStatus: 'failing',
      mergeState: 'conflicted',
      headRef: 'feat/x',
    });
  });

  it('falls back to repo#number for a PR whose title was never mirrored', async () => {
    // Never an id, never empty — the same fallback both assemblers' titleOf use.
    for (const title of [null, '']) {
      const q = stubQuerier([prRow({ title })]);
      const badges = (await loadLinkedPullRequestBadges(q, [{ id: 'task-1', kind: 'task' }])).get('task-1');
      expect(badges?.items[0]?.title).toBe('acme/tm8#42');
    }
  });

  it('caps the list and says so — the cap+1 row proves the truncation, and is never emitted', async () => {
    const over = Array.from({ length: LINKED_PULL_REQUEST_BADGE_CAP + 1 }, (_, i) =>
      prRow({ entity_id: `pr-${String(i)}`, number: i + 1 }));
    const q = stubQuerier(over);
    const badges = (await loadLinkedPullRequestBadges(q, [{ id: 'task-1', kind: 'task' }])).get('task-1');
    expect(badges?.items).toHaveLength(LINKED_PULL_REQUEST_BADGE_CAP);
    expect(badges?.truncated).toBe(true);
    expect(badges?.items.map((i) => i.entityId)).not.toContain(`pr-${String(LINKED_PULL_REQUEST_BADGE_CAP)}`);
  });

  it('a task exactly at the cap is NOT truncated', () => {
    const at = Array.from({ length: LINKED_PULL_REQUEST_BADGE_CAP }, (_, i) =>
      prRow({ entity_id: `pr-${String(i)}` }));
    return loadLinkedPullRequestBadges(stubQuerier(at), [{ id: 'task-1', kind: 'task' }])
      .then((out) => {
        expect(out.get('task-1')?.items).toHaveLength(LINKED_PULL_REQUEST_BADGE_CAP);
        expect(out.get('task-1')?.truncated).toBe(false);
      });
  });

  it('keys by task, so one page carries several tasks\' links independently', async () => {
    const q = stubQuerier([
      prRow({ task_id: 'task-1', entity_id: 'pr-1' }),
      prRow({ task_id: 'task-2', entity_id: 'pr-2' }),
      prRow({ task_id: 'task-2', entity_id: 'pr-3' }),
    ]);
    const out = await loadLinkedPullRequestBadges(q, [
      { id: 'task-1', kind: 'task' },
      { id: 'task-2', kind: 'task' },
    ]);
    expect(out.get('task-1')?.items.map((i) => i.entityId)).toEqual(['pr-1']);
    expect(out.get('task-2')?.items.map((i) => i.entityId)).toEqual(['pr-2', 'pr-3']);
  });

  it('a task with no linked PR gets NO entry — absent, never an empty array', async () => {
    // Consumed by `badgesOf`, which only emits the field when non-empty: an
    // absent badge is "no claim", and an empty array would assert "no links".
    const out = await loadLinkedPullRequestBadges(stubQuerier([]), [{ id: 'task-1', kind: 'task' }]);
    expect(out.get('task-1')).toBeUndefined();
  });
});
