// @vitest-environment jsdom
/**
 * The session's git GRAPH FACTS — the half of the rail that never needed a
 * worktree. Driven through a delegating seam whose `connections` is scripted
 * per entity, because the facts block's whole claim is that it reads the
 * GRAPH (created_in / in_worktree / working_on→tracks), not the checkout.
 *
 * CHIP CONSUMPTION IS PINNED HERE exactly as in TaskGitSection.test: the PR
 * rows must render through Lane B's `linked-pr-chips` testids.
 *
 * The integration half — the facts render UNDER the no-worktree reason card,
 * not instead of it — lives in SessionGitBody.test.tsx.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActorSummary, EdgeView, EntityId, EntitySummary } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture.js';
import {
  commitFoundation,
  forge,
  prTransplant,
  sessionStale,
  taskGuideLines,
} from '../fixtures/index.js';
import type { Seam } from '../data/seam.js';
import { SessionGitFacts } from './SessionGitFacts.js';

const SESSION = sessionStale.id as EntityId;

const laneEntity: EntitySummary = {
  ...commitFoundation,
  id: 'wt-lane-1',
  kind: 'worktree',
  title: 'lane wt-lane-1',
  state: {
    kind: 'worktree',
    status: 'active',
    branch: 'tm8/lane-1',
  } as unknown as EntitySummary['state'],
};

function mkEdge(id: string, type: string, source: EntitySummary, target: EntitySummary): EdgeView {
  return {
    id,
    type,
    source,
    target,
    props: {},
    createdBy: forge as ActorSummary,
    createdAt: '2026-08-13T00:00:00Z',
    updatedAt: '2026-08-13T00:00:00Z',
  };
}

/** Fixture seam with `connections` scripted per anchor id — graph-only truth. */
function seamWith(edgesByAnchor: Record<string, EdgeView[]>): Seam {
  const base = createFixtureSeam();
  return {
    ...base,
    async connections(id, opts) {
      const rows = (edgesByAnchor[id] ?? []).filter(
        (e) => !opts?.types || opts.types.length === 0 || opts.types.includes(e.type),
      );
      return { items: rows, nextCursor: null };
    },
  };
}

const FULL_GRAPH: Record<string, EdgeView[]> = {
  [SESSION]: [
    // Recorder provenance: commit → created_in → session.
    mkEdge('e-ci-1', 'created_in', commitFoundation, sessionStale),
    // The lane entity.
    mkEdge('e-wt-1', 'in_worktree', sessionStale, laneEntity),
    // The task whose tracks carry the PR.
    mkEdge('e-wo-1', 'working_on', sessionStale, taskGuideLines),
  ],
  [taskGuideLines.id]: [mkEdge('e-tr-1', 'tracks', taskGuideLines, prTransplant)],
};

describe('graph facts, independent of any checkout', () => {
  it('renders commits (created_in), the lane, and PRs through Lane B chips', async () => {
    render(<SessionGitFacts seam={seamWith(FULL_GRAPH)} sessionId={SESSION} />);
    const facts = await screen.findByTestId('session-git-facts');

    // Commits this session produced: sha prefix + message.
    const commits = screen.getByTestId('session-git-commits');
    const sha = (commitFoundation.state as unknown as { sha: string }).sha;
    expect(commits.textContent).toContain(sha.slice(0, 10));

    // The lane entity, with its branch and status pill.
    const lane = screen.getByTestId('session-git-lane');
    expect(lane.textContent).toContain('tm8/lane-1');
    expect(lane.textContent).toContain('active');

    // PR rows are Lane B's component — consumed, not forked.
    const chips = screen.getByTestId('linked-pr-chips');
    expect(chips.getAttribute('data-placement')).toBe('detail');
    expect(facts.contains(chips)).toBe(true);
  });

  it('renders NOTHING when the graph knows nothing — no empty frame', async () => {
    const { container } = render(<SessionGitFacts seam={seamWith({})} sessionId={SESSION} />);
    await waitFor(() => {
      // Loading resolved; the block chose silence over an empty claim.
      expect(container.querySelector('[data-testid="session-git-facts"]')).toBeNull();
    });
    expect(container.textContent).toBe('');
  });

  it('one task with a failing tracks read does not hide the session commits', async () => {
    const seam = seamWith({
      [SESSION]: [
        mkEdge('e-ci-1', 'created_in', commitFoundation, sessionStale),
        mkEdge('e-wo-1', 'working_on', sessionStale, taskGuideLines),
      ],
      // taskGuideLines missing from the script — its connections read still
      // answers (empty) through the stub; simulate the FAILURE instead:
    });
    const failing: Seam = {
      ...seam,
      async connections(id, opts) {
        if (id === (taskGuideLines.id as EntityId)) throw new Error('tracks read down');
        return seam.connections(id, opts);
      },
    };
    render(<SessionGitFacts seam={failing} sessionId={SESSION} />);
    const commits = await screen.findByTestId('session-git-commits');
    expect(commits.textContent).toContain(
      (commitFoundation.state as unknown as { sha: string }).sha.slice(0, 10),
    );
    // No PR row, no error banner — an absent claim, not a wrong one.
    expect(screen.queryByTestId('linked-pr-chips')).toBeNull();
    expect(screen.queryByTestId('session-git-facts-error')).toBeNull();
  });

  it('a failed session read states the failure, quietly', async () => {
    const base = createFixtureSeam();
    const broken: Seam = {
      ...base,
      async connections() {
        throw new Error('graph offline');
      },
    };
    render(<SessionGitFacts seam={broken} sessionId={SESSION} />);
    const err = await screen.findByTestId('session-git-facts-error');
    expect(err.textContent).toContain('graph offline');
  });
});
