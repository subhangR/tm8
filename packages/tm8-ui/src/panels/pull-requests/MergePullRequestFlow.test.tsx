// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FIXTURE_SPACE_ID, fixtureDetails, prTransplant } from '../../fixtures';
import { createFixtureSeam } from '../../data/fixtures/seam-fixture';
import type { FixturePrMergeGuard } from '../../data/seam';
import { PREDATES_MERGE_DOOR, resolveAction, type ActionContext } from '../../domain';
import { mergePrPortFor } from '../../views/mergePrPort';
import { EntityDetailPanel } from '../EntityDetailPanel';
import { MergePullRequestFlow } from './MergePullRequestFlow';

/**
 * B10 — the merge confirm, driven through the REAL fixture seam rather than a
 * hand-written promise.
 *
 * WHY THE SEAM AND NOT A STUB. The claim under test is that this surface reads
 * the op's refusal vocabulary — a wire contract with a tail of codes that carry
 * no `details.reason` at all. A stub that resolves and rejects on cue proves
 * only that the component renders whatever it is handed; it cannot catch a
 * refusal whose SHAPE the component misreads, which is exactly how the four
 * reason-less codes would have rendered as an empty alert. So every case here
 * goes `setPrMergeGuard` → `mergePrPortFor` → `seam.commands.mergePullRequest`
 * → the rejection this surface actually receives.
 *
 * The `fixtureControls` knob exists because the fixture holds no
 * `mergeable_state` or `ci_status` for a PR row: deriving refusals from fixture
 * facts would mean building a second model of a record only the server owns,
 * and it would drift.
 */

const PR = { repository: 'subhang/tm8', number: 212 };
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

/** A flow wired to the fixture seam with one guard armed. */
function mount(guard: FixturePrMergeGuard) {
  const seam = createFixtureSeam();
  seam.fixtureControls.setPrMergeGuard(guard);
  const port = mergePrPortFor(seam);
  if (!port) throw new Error('a seam was supplied, so the port must exist');
  const view = render(
    <MergePullRequestFlow pr={PR} onMerge={(input) => port.onMerge(prTransplant.id, input)} />,
  );
  return { seam, view };
}

async function pressMerge(guard: FixturePrMergeGuard) {
  mount(guard);
  fireEvent.click(screen.getByTestId('pr-merge-go'));
  return await screen.findByTestId('pr-merge-refusal');
}

describe('B10 — the confirm names what will happen', () => {
  it('names repo#n, and says WHICH head when no read has told us one', () => {
    render(<MergePullRequestFlow pr={PR} onMerge={async () => { throw new Error('unused'); }} />);
    const text = screen.getByTestId('pr-merge-confirm-text').textContent ?? '';
    expect(text).toContain('subhang/tm8#212');
    /*
     * NO CLIENT READ PROJECTS A PR'S HEAD SHA today, so this is the sentence
     * the shipped screen shows. It must still say the merge is PINNED — the
     * server pins the head it stored — without printing a sha nobody observed.
     */
    expect(text).toContain('at the head this node last observed');
    expect(text).toContain('as your GitHub account');
  });

  it('prints the short sha when a read HAS told us one, and pins it in the input', async () => {
    const seen: { headSha?: string }[] = [];
    render(
      <MergePullRequestFlow
        pr={PR}
        headSha="3f9a1c7e0d4b2a58"
        githubLogin="subhang"
        onMerge={async (input) => {
          seen.push(input);
          return { entityId: prTransplant.id, repo: PR.repository, number: PR.number, merged: true, mergeSha: 'abc12345' };
        }}
      />,
    );
    expect(screen.getByTestId('pr-merge-confirm-text').textContent).toContain('at 3f9a1c7e');
    expect(screen.getByTestId('pr-merge-confirm-text').textContent).toContain('as subhang');

    fireEvent.click(screen.getByTestId('pr-merge-go'));
    await screen.findByTestId('pr-merge-receipt');
    // The head the human was SHOWN is the head that travels — that is what
    // makes `head_moved` a refusal rather than a blind merge.
    expect(seen).toEqual([{ headSha: '3f9a1c7e0d4b2a58' }]);
  });

  it('R5 #9: no executor is disabled-with-reason, never an enabled button', () => {
    render(<MergePullRequestFlow pr={PR} />);
    expect(screen.queryByTestId('pr-merge-go')).toBeNull();
    expect(document.body.textContent).toContain('Merging isn’t connected yet');
  });
});

describe('B10 — the receipt, and the chip that must NOT flip', () => {
  it('shows the forge’s mergeSha and says the lifecycle word arrives elsewhere', async () => {
    mount('available');
    fireEvent.click(screen.getByTestId('pr-merge-go'));
    const receipt = await screen.findByTestId('pr-merge-receipt');
    const text = receipt.textContent ?? '';

    expect(text).toContain('Merged tm8/tm8#42');
    // A sha, from the seam's own result — not a word this screen authored.
    expect(text).toMatch(/as [0-9a-f]{8}\./);

    /*
     * THE LOAD-BEARING SENTENCE. Success does not repaint the state chip,
     * because only the observer can confirm the lifecycle moved. Without this
     * line the unchanged chip reads as a merge that silently failed — so the
     * absence of the flip has to be SAID, not merely done.
     */
    expect(text).toContain('git.pr_state_changed');
    expect(text).toContain('still reads open');

    // And the confirm is gone: there is nothing left to press twice.
    expect(screen.queryByTestId('pr-merge-go')).toBeNull();
  });

  it('the surface carries no state-flip channel at all', () => {
    /*
     * An optimistic flip could only arrive through a prop. Asserting the prop
     * does not exist is what keeps a later "just repaint it locally" from
     * being added quietly — the rule is structural, not a matter of this
     * render happening not to call one.
     */
    render(<MergePullRequestFlow pr={PR} />);
    const props = Object.keys({ pr: 0, headSha: 0, githubLogin: 0, onMerge: 0, onDismiss: 0, boundsRef: 0 });
    expect(props.some((p) => /state|chip|status|merged/i.test(p))).toBe(false);
  });
});

describe('B10 — every refusal in the vocabulary renders, verbatim', () => {
  /**
   * The six the server names in `details.reason`. The assertion is the
   * SERVER'S OWN SENTENCE — the one that names the fact it measured — because
   * re-authoring it here would replace a measurement with a guess and let the
   * two drift.
   */
  const NAMED: readonly [FixturePrMergeGuard, string][] = [
    ['not_open', 'is closed, not open'],
    ['conflicted', 'observed mergeable_state=dirty'],
    ['ci_red', 'observed ci_status=failing'],
    ['no_github_credential', 'no GitHub credential stored for this account'],
    ['forge_blocked', 'required review is missing'],
    ['head_moved', 'head is no longer the reviewed sha'],
  ];

  for (const [guard, sentence] of NAMED) {
    it(`${guard}: shows the server's sentence and labels it with the vocabulary word`, async () => {
      const refusal = await pressMerge(guard);
      expect(refusal.textContent).toContain(sentence);
      // The word rides along so this stays greppable against the server's own
      // switch, without ever becoming the thing a human has to read.
      expect(refusal.textContent).toContain(guard);
      // mb1: the facts must change before this can be pressed again.
      expect(screen.queryByTestId('pr-merge-go')).toBeNull();
    });
  }

  /**
   * THE TAIL — the class a naive renderer breaks on. These four carry NO
   * `details.reason`, so anything keyed on `reason` alone shows an EMPTY
   * refusal: the user clicks Merge, nothing merges, and nothing says why.
   */
  const TAIL: readonly [FixturePrMergeGuard, string][] = [
    ['not_found', 'no pull_request entity'],
    ['unauthorized', 'token lacks repo scope'],
    ['rate_limited', 'secondary rate limit'],
    ['upstream_unavailable', 'GitHub is unreachable'],
  ];

  for (const [guard, sentence] of TAIL) {
    it(`${guard}: carries no reason word, and still says why`, async () => {
      const refusal = await pressMerge(guard);
      expect(refusal.textContent).toContain(sentence);
      expect(screen.queryByTestId('pr-merge-go')).toBeNull();
    });
  }
});

describe('B10 — the 501 is a STATE, not an error path', () => {
  /**
   * The node this control ships into until the restart task runs. No op lets a
   * client ask a node which operations it serves, so the verb renders enabled
   * and learns otherwise on the first attempt — a correction that is honest
   * but reads as flakiness unless the copy says so.
   */
  it('renders the predates-the-door copy, not the raw not_implemented message', async () => {
    const refusal = await pressMerge('not_implemented');
    expect(refusal.textContent).toContain(PREDATES_MERGE_DOOR);
    // Labelled as a node fact rather than as a merge that was judged and lost.
    expect(refusal.textContent).toContain('Not on this node');
    // It names the remedy the user has TODAY, and the one that ends the state.
    expect(refusal.textContent).toContain('once the node restarts');
    expect(refusal.textContent).toContain('merge on the forge until then');
    expect(screen.queryByTestId('pr-merge-go')).toBeNull();
  });
});

describe('B10 — the verb reaches the panel, and opens a confirm rather than merging', () => {
  const detail = fixtureDetails[prTransplant.id];
  if (!detail) throw new Error('the fixtures must carry a pull_request detail for this test');

  it('the registry’s verb is live and promises a confirm', () => {
    const merge = resolveAction('merge-pr');
    expect(merge.availability({ ...ctx, entityId: prTransplant.id }).kind).toBe('available');
    expect(merge.label).toBe('Merge…');
  });

  it('clicking Merge… opens the confirm; nothing is sent until Confirm merge', async () => {
    const seam = createFixtureSeam();
    const port = mergePrPortFor(seam);
    if (!port) throw new Error('a seam was supplied, so the port must exist');
    const calls: string[] = [];

    render(
      <EntityDetailPanel
        detail={detail}
        reasons={{}}
        ctx={{ ...ctx, entityId: prTransplant.id }}
        mergePr={{
          onMerge: (entityId, input) => {
            calls.push(entityId);
            return port.onMerge(entityId, input);
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Merge…/ }));
    const flow = await screen.findByTestId('pr-merge-flow');
    // mb2: TWO STEPS, never one. The bar's verb opened a surface and sent
    // nothing — the second press is the one that lands code on a base branch.
    expect(calls).toEqual([]);
    expect(flow.textContent).toContain('subhang/tm8#212');

    fireEvent.click(screen.getByTestId('pr-merge-go'));
    await waitFor(() => { expect(calls).toEqual([prTransplant.id]); });
    await screen.findByTestId('pr-merge-receipt');
  });
});
