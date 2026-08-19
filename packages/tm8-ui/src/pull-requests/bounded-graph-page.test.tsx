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
import type { EdgeView, EntitySummary } from '@tm8/contract';
import { FIXTURE_SPACE_ID, prTransplant, sessionLive, taskGuideLines } from '../fixtures';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { resolveGraphEdges } from '../data/project/graph-edges';
import { LinkedPullRequestChips } from './LinkedPullRequestChips';
import { indexLinkedPullRequests } from './linked-pull-requests';

/**
 * The page AS THE SHELL HOLDS IT, which is what `indexLinkedPullRequests`
 * reads. `graph.query` puts endpoint ids on the wire; `loadGraph` resolves
 * them against the same response's nodes before anything reaches the store, so
 * this suite runs on the far side of that step — the same normalized `EdgeView`
 * family the event feed and `entities.connections` fill.
 */
interface ShellGraphPage { nodes: EntitySummary[]; edges: EdgeView[] }

async function boundedGraphPage(): Promise<ShellGraphPage> {
  const seam = createFixtureSeam();
  await seam.openSpace(FIXTURE_SPACE_ID);
  // The SAME call the shell makes on boot, limit included.
  const page = await seam.graph({ spaceId: FIXTURE_SPACE_ID, layout: 'graph', limit: 150 });
  const resolved = resolveGraphEdges(page.nodes, page.edges);
  // Every endpoint of every edge is in the page by construction; a fixture
  // that ever stopped honouring that would make this suite meaningless.
  expect(resolved.unresolved).toEqual([]);
  return { nodes: page.nodes, edges: resolved.edges };
}

/** The page as it arrives when the PR node and its `tracks` edge lost their seats. */
function withoutTheLinkedPullRequest(page: ShellGraphPage): ShellGraphPage {
  return {
    ...page,
    nodes: page.nodes.filter((node) => node.id !== prTransplant.id),
    edges: page.edges.filter(
      (edge) => !(edge.type === 'tracks' && edge.target.id === prTransplant.id),
    ),
  };
}

/** The same page with the badge ALSO gone — the world before this projection. */
function withoutTheBadge(page: ShellGraphPage): ShellGraphPage {
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

  it('and a session that AUTHORED the PR resolves it through created_in alone', async () => {
    // TIER 1 on the losing side of the lottery. Every other route to the
    // session is severed on purpose: no PR node, no `tracks` edge, no
    // `working_on` edge, and the task's `workingActors` badge stripped. A
    // `created_in` edge is the only thing left that can answer — and it is
    // the one the client never read, which is the whole reported bug.
    //
    // The PR facts come off the edge's own ENDPOINT SNAPSHOT here, because
    // the PR node is exactly what this page lost.
    const page = withoutTheLinkedPullRequest(await boundedGraphPage());
    const nodes = page.nodes.map((node): EntitySummary => {
      if (node.id !== taskGuideLines.id) return node;
      const { workingActors: _severed, ...badges } = node.badges;
      return { ...node, badges };
    });
    const edges = page.edges.filter((e) => e.type !== 'working_on');
    const createdIn = {
      ...page.edges[0]!,
      id: 'edge-created-in',
      type: 'created_in' as const,
      source: prTransplant,
      target: sessionLive,
    };

    const index = indexLinkedPullRequests(nodes, [...edges, createdIn]);
    expect(index.get(sessionLive.id)?.map((f) => f.id)).toEqual([prTransplant.id]);
    expect(index.get(sessionLive.id)?.[0]).toMatchObject({ attribution: 'authored' });

    // NEGATIVE CONTROL: without that one edge, the same page says NOTHING.
    // This is the honest degradation D4 chose over a branch-name guess.
    expect(indexLinkedPullRequests(nodes, edges).get(sessionLive.id)).toBeUndefined();
  });

  it('a session\'s own branch fact resolves NOTHING, in any workdir mode', async () => {
    // The deleted pass, asserted absent on the real page. Before D4 this
    // returned the PR for `workdirMode: 'worktree'`; #350 had already
    // narrowed it from "all modes" after eleven sessions on one shared
    // checkout each drew the same four PRs.
    const page = withoutTheLinkedPullRequest(await boundedGraphPage());
    const BRANCH = 'tm8/abc12345';
    const edges = page.edges.filter((e) => e.type !== 'working_on');

    for (const mode of ['worktree', 'project', 'scratch'] as const) {
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
          return {
            ...node,
            state: {
              ...node.state, checkoutBranch: BRANCH, workdirMode: mode,
            } as EntitySummary['state'],
          };
        }
        return node;
      });
      expect(indexLinkedPullRequests(nodes, edges).get(sessionLive.id), mode).toBeUndefined();
    }
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

/**
 * 4d — the chip has to SHOW the difference between "this session wrote this"
 * and "a task this session touched is linked to this".
 *
 * Asserted on the DOM hook, not on colour: jsdom loads no stylesheets, so no
 * vitest in this repo can see the opacity/weight the CSS actually applies.
 * `data-pr-attribution` is the contract between the two, and pinning it here
 * is what keeps the stylesheet's selector from silently going dead.
 */
describe('an inherited chip is marked as a weaker claim than an authored one', () => {
  const facts = {
    id: 'pr-1',
    title: 'Ship it',
    repository: 'acme/tm8',
    number: 42,
    lifecycle: 'open' as const,
    url: null,
    ciStatus: null,
    mergeState: null,
    headRef: null,
  };

  it('marks each attribution on the chip, and says which in the tooltip', () => {
    for (const attribution of ['authored', 'tracked', 'inherited'] as const) {
      const view = render(
        <LinkedPullRequestChips pullRequests={[{ ...facts, attribution }]} placement="tile" />,
      );
      const chip = view.getByTestId('linked-pr');
      expect(chip.getAttribute('data-pr-attribution'), attribution).toBe(attribution);
      expect(chip.className, attribution).toContain(`pr-chips__request--${attribution}`);
      view.unmount();
    }
  });

  it('NEGATIVE CONTROL — authored and inherited do not render identically', () => {
    // If the marking is ever dropped, this is the assertion that fails: the
    // two claims would collapse into one indistinguishable chip, which is the
    // state 4d exists to end.
    const draw = (attribution: 'authored' | 'inherited'): string => {
      const view = render(
        <LinkedPullRequestChips pullRequests={[{ ...facts, attribution }]} placement="tile" />,
      );
      const html = view.getByTestId('linked-pr').outerHTML;
      view.unmount();
      return html;
    };
    expect(draw('authored')).not.toEqual(draw('inherited'));
  });

  it('the tooltip names the provenance, because the visual alone cannot say WHY', () => {
    const view = render(
      <LinkedPullRequestChips
        pullRequests={[{ ...facts, attribution: 'inherited' }]}
        placement="tile"
      />,
    );
    expect(view.getByTestId('linked-pr').getAttribute('title'))
      .toContain('not necessarily its own work');
  });
});
