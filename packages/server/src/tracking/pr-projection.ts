/**
 * The two forge facts, mapped from what Postgres stores to what the contract
 * promises. ONE mapper, because there are three projection sites (the events
 * projector, the entity-summary enrichment, and the project-associations read)
 * and three copies of this reasoning would drift into three different answers
 * to the same question.
 *
 * THE RULE THAT GOVERNS BOTH FIELDS, and it is a ruling rather than a
 * preference: ABSENCE IS NOT A VERDICT.
 *
 *   * `null` means this node has no verdict — nothing has observed the pull
 *     request yet, or the observer runs unauthenticated. Consumers render
 *     nothing.
 *   * `'unknown'` means GitHub SAID it did not know. It recomputes mergeability
 *     asynchronously and reports `unknown` while it works.
 *
 * Mapping absence onto `'unknown'` would collapse those two into one word and
 * tell a reader we asked and got no answer when we never asked.
 */

import type { EntityState } from '@tm8/contract';

type PullRequestState = Extract<EntityState, { kind: 'pull_request' }>;
export type CiStatus = NonNullable<PullRequestState['ciStatus']>;
export type MergeState = NonNullable<PullRequestState['mergeState']>;

const CI_STATUSES: readonly string[] = ['passing', 'failing', 'pending'];

/**
 * `pull_requests.ci_status` is already the contract's vocabulary (082 §C1
 * constrains it to the same three words), so this is a validation rather than a
 * translation — an unrecognised value is dropped to null rather than passed
 * through, because a consumer typed on the enum would otherwise receive a word
 * its own type says cannot exist.
 */
export function projectCiStatus(stored: unknown): CiStatus | null {
  return typeof stored === 'string' && CI_STATUSES.includes(stored) ? (stored as CiStatus) : null;
}

/**
 * GitHub's eight-word `mergeable_state` down to the contract's three.
 *
 * The contract's axis is narrow on purpose: "does this branch conflict with its
 * base". Only `dirty` is that conflict. `blocked` (a required review is
 * missing), `behind` (the base moved ahead), `unstable` (a non-required check
 * is red), `draft` and `has_hooks` are all reasons a PR cannot merge RIGHT NOW
 * that are NOT conflicts, and reporting them as `'conflicted'` would send an
 * agent to resolve a conflict that does not exist — the same false alarm the
 * stacked-PR suppression exists to prevent.
 *
 * They map to `'clean'`, which on this axis is the true answer: the branch does
 * not conflict. It is deliberately NOT `'unknown'` — we do know.
 */
export function projectMergeState(stored: unknown): MergeState | null {
  if (typeof stored !== 'string' || stored === '') return null;
  if (stored === 'dirty') return 'conflicted';
  if (stored === 'unknown') return 'unknown';
  if (['clean', 'blocked', 'behind', 'unstable', 'draft', 'has_hooks'].includes(stored)) {
    return 'clean';
  }
  // A word GitHub added since. We have a value and cannot interpret it, which
  // is exactly what 'unknown' means — and it is safer than asserting 'clean'
  // about a state nobody here has read the definition of.
  return 'unknown';
}

/**
 * The optional half of a `pull_request` EntityState. Spread into the projection.
 *
 * Both keys are always present (as `null` when there is no verdict) rather than
 * conditionally omitted: the contract marks them `.nullable().optional()`, and
 * an explicit null is the difference between "this node has no verdict" and
 * "this node is too old to know the field exists".
 */
export function projectForgeFacts(
  ciStatus: unknown,
  mergeableState: unknown,
): Pick<PullRequestState, 'ciStatus' | 'mergeState'> {
  return {
    ciStatus: projectCiStatus(ciStatus),
    mergeState: projectMergeState(mergeableState),
  };
}
