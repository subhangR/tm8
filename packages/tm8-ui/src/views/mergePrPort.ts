/**
 * B10 — THE MERGE PORT, composed ONCE for every host that mounts an
 * `EntityDetailPanel`. Same shape and same reason as `gitSurface.tsx` and
 * `debugSurface.tsx`: the verb is registry data every host's action bar
 * already draws, but the EXECUTOR is a prop the host hands down, and
 * hand-wiring five hosts leaves the same trap armed for the sixth.
 *
 * `useLaunchPort`'s docblock records what the inline version cost: the prop
 * was passed on two screens and not on a third, and the screen that missed it
 * fell through to absent-source defaults that read as flaky data rather than
 * as unwired code. `Merge…` has the same exposure and a louder failure — a
 * host that omits this leaves a verb that opens a confirm which cannot commit
 * — so `panel-primaries-wired.test.tsx` asserts every mount passes it.
 *
 * A HOST WITHOUT A SEAM STILL GETS AN HONEST ANSWER: `null` here makes the
 * confirm render its not-wired refusal (R5 #9) rather than a live button.
 *
 * WHAT THIS PORT DELIBERATELY DOES NOT SUPPLY, and why that is a measurement
 * and not an omission.
 *
 *   `headShaFor` — NO CLIENT READ PROJECTS A PR'S HEAD SHA. The server stores
 *   `head_sha` and `tracking.pr.merge` pins it, but neither `EntityDetail`'s
 *   `pull_request` state arm nor `LinkedPullRequestBadge` carries it over the
 *   wire. Supplying one here would mean showing a sha nobody observed, so this
 *   omits the resolver, the flow omits `headSha` from the input, and the
 *   server pins the head IT stored — the row the human reviewed. The merge is
 *   still pinned; it is pinned server-side, and the confirm sentence says so.
 *
 *   `githubLogin` — the same shape of absence: no read tells this client which
 *   GitHub identity the node's stored credential belongs to, so the flow says
 *   "as your GitHub account" rather than naming a login it does not have.
 *
 * Both become one line each the day a read projects them. That is what the
 * resolver shape on `MergePrSources` is for.
 */
import { nextMutationId } from '../authoring';
import type { MergePrSources } from '../panels';
import type { Seam } from '../data/seam';

export function mergePrPortFor(seam: Seam | undefined): MergePrSources | null {
  if (!seam) return null;
  return {
    /*
     * THE MUTATION ID IS MINTED HERE, and it is not optional garnish:
     * `TrackingPrMergeInput` requires `clientMutationId`, and on a
     * default-configured node (`TM8_IDEMPOTENCY_ENABLED` is true) an omitted
     * one arrives as a plain `invalid_input` — a merge that refuses for a
     * reason having nothing to do with the PR. `nextMutationId` is the SAME
     * minter the authoring lane and `useRowLifecycle` use, deliberately: ids
     * carrying only a counter collide across principals and the second
     * human's write is refused as a replay.
     *
     * NOTHING IS CAUGHT HERE. Every refusal in the op's vocabulary — and the
     * 501 from a node predating the merge door — is a sentence the confirm
     * surface renders in place, so the rejection has to reach it intact. A
     * `.catch` at this seam would turn the one act that lands code on someone
     * else's base branch into a silent no-op.
     */
    onMerge: (entityId, input) =>
      seam.commands.mergePullRequest(entityId, { ...input, clientMutationId: nextMutationId() }),
  };
}
