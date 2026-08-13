// @vitest-environment jsdom
/**
 * THE RELOAD BUG, REPRODUCED — not described.
 *
 * `seam.graph({ limit: 150 })` is what the shell re-hydrates its edge
 * projection from after a hard reload, and it is BOUNDED. In a space several
 * times that size a freshly linked PR needs its `tracks` edge AND its
 * `pull_request` summary to both win a seat on that page before any tile can
 * render a chip; measured 2026-08-13, they routinely did not, and the chips
 * appeared only once the task detail was opened and fetched the edge directly.
 *
 * The fixture space is small enough that everything fits, so this suite
 * MANUFACTURES the loss: it takes the real page and then removes the PR node
 * and the `tracks` edge from it. What is left is exactly what a task tile has
 * on the losing side of that lottery — and `badges.pullRequests`, which rides
 * on the task row itself, is the only thing that can still answer.
 *
 * NO TASK DETAIL IS EVER OPENED HERE. `seam.entity()` and `seam.connections()`
 * are never called; the assertions run against the graph page alone.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { EntitySummary, GraphResult } from '@tm8/contract';
import { FIXTURE_SPACE_ID, prTransplant, sessionLive, taskGuideLines } from '../fixtures';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { LinkedPullRequestChips } from './LinkedPullRequestChips';
import { indexLinkedPullRequests } from './linked-pull-requests';

async function boundedGraphPage(): Promise<GraphResult> {
  const seam = createFixtureSeam();
  await seam.openSpace(FIXTURE_SPACE_ID);
  // The SAME call the shell makes on boot, limit included.
  return seam.graph({ spaceId: FIXTURE_SPACE_ID, layout: 'graph', limit: 150 });
}

/** The page as it arrives when the PR node and its `tracks` edge lost their seats. */
function withoutTheLinkedPullRequest(page: GraphResult): GraphResult {
  return {
    ...page,
    nodes: page.nodes.filter((node) => node.id !== prTransplant.id),
    edges: page.edges.filter(
      (edge) => !(edge.type === 'tracks' && edge.target.id === prTransplant.id),
    ),
  };
}

/** The same page with the badge ALSO gone — the world before this projection. */
function withoutTheBadge(page: GraphResult): GraphResult {
  return {
    ...page,
    nodes: page.nodes.map((node): EntitySummary => {
      const { pullRequests: _dropped, ...rest } = node.badges;
      return { ...node, badges: rest };
    }),
  };
}

describe('PR chips survive a bounded graph page that dropped the PR node and its edge', () => {
  it('the fixture page really does carry both, so the pruning below is a real loss', async () => {
    const page = await boundedGraphPage();
    expect(page.nodes.some((n) => n.id === prTransplant.id)).toBe(true);
    expect(page.edges.some((e) => e.type === 'tracks' && e.target.id === prTransplant.id)).toBe(true);
  });

  it('WITHOUT the badge the task tile renders nothing — this is the bug', async () => {
    const pruned = withoutTheBadge(withoutTheLinkedPullRequest(await boundedGraphPage()));
    const index = indexLinkedPullRequests(pruned.nodes, pruned.edges);
    expect(index.get(taskGuideLines.id)).toBeUndefined();
    expect(index.get(sessionLive.id)).toBeUndefined();
  });

  it('WITH the badge the task still carries its PR, off the row alone', async () => {
    const pruned = withoutTheLinkedPullRequest(await boundedGraphPage());
    const linked = indexLinkedPullRequests(pruned.nodes, pruned.edges).get(taskGuideLines.id);
    expect(linked?.map((f) => f.id)).toEqual([prTransplant.id]);
    expect(linked?.[0]).toMatchObject({
      repository: 'subhang/tm8',
      number: 212,
      lifecycle: 'open',
      // Nothing observed this PR's checks. Absence must stay absence.
      ciStatus: null,
      mergeState: null,
    });
  });

  it('and so does the SESSION working it, through the task\'s workingActors badge', async () => {
    // The `working_on` edge is on this page, but the session must not depend on
    // it: `via.sessionId` on the task's own badge names the same session, which
    // is what survives when that edge misses the page too.
    const pruned = withoutTheLinkedPullRequest(await boundedGraphPage());
    const index = indexLinkedPullRequests(
      pruned.nodes,
      pruned.edges.filter((e) => e.type !== 'working_on'),
    );
    expect(index.get(sessionLive.id)?.map((f) => f.id)).toEqual([prTransplant.id]);
  });

  it('and a session on the PR\'s BRANCH resolves it, with no task path at all', async () => {
    // The fourth pass (107) matches `headRef == checkoutBranch`, which is how a
    // worktree lane gets its chips without anyone running `link-pr`. It reads
    // the branch off PR NODES — so on a page that dropped the PR node it had
    // nothing to match, the same lottery again. The badge carries `headRef`,
    // and this asserts the pass now seeds from it.
    //
    // Every other route to the session is severed here on purpose: no PR node,
    // no `tracks` edge, no `working_on` edge, and the task's `workingActors`
    // badge stripped. The branch match is the ONLY thing left that can answer.
    const page = withoutTheLinkedPullRequest(await boundedGraphPage());
    const BRANCH = 'tm8/abc12345';
    const nodes = page.nodes.map((node): EntitySummary => {
      if (node.id === taskGuideLines.id) {
        const { workingActors: _severed, ...badges } = node.badges;
        return {
          ...node,
          badges: {
            ...badges,
            pullRequests: (node.badges.pullRequests ?? []).map((pr) => ({ ...pr, headRef: BRANCH })),
          },
        };
      }
      if (node.id === sessionLive.id) {
        return { ...node, state: { ...node.state, checkoutBranch: BRANCH } as EntitySummary['state'] };
      }
      return node;
    });
    const edges = page.edges.filter((e) => e.type !== 'working_on');

    expect(indexLinkedPullRequests(nodes, edges).get(sessionLive.id)?.map((f) => f.id))
      .toEqual([prTransplant.id]);

    // And the match is the BRANCH, not a coincidence: a session parked on a
    // different branch inherits nothing.
    const elsewhere = nodes.map((node): EntitySummary =>
      node.id === sessionLive.id
        ? { ...node, state: { ...node.state, checkoutBranch: 'main' } as EntitySummary['state'] }
        : node);
    expect(indexLinkedPullRequests(elsewhere, edges).get(sessionLive.id)).toBeUndefined();
  });

  it('renders the chip — the thing the user reported missing', async () => {
    const pruned = withoutTheLinkedPullRequest(await boundedGraphPage());
    const index = indexLinkedPullRequests(pruned.nodes, pruned.edges);

    for (const entityId of [taskGuideLines.id, sessionLive.id]) {
      const view = render(
        <LinkedPullRequestChips pullRequests={index.get(entityId) ?? []} placement="tile" />,
      );
      const chips = view.getAllByTestId('pr-state-chip');
      expect(chips.map((c) => c.getAttribute('data-pr-state')), entityId).toEqual(['open']);
      expect(view.getByTestId('linked-pr').getAttribute('data-pr-number')).toBe('212');
      view.unmount();
    }
  });
});
