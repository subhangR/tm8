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

import type { EntityState, LinkedPullRequestBadge } from '@tm8/contract';

import type { Querier } from '../db/types.js';

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
 * All keys are always present (as `null` when there is no verdict) rather than
 * conditionally omitted: the contract marks them `.nullable().optional()`, and
 * an explicit null is the difference between "this node has no verdict" and
 * "this node is too old to know the field exists".
 *
 * `headRef` (103's `head_ref`, projected by 107) rides with the verdicts and
 * under the same law — `null` means the observer never told us. It is the
 * mechanical PR↔session association key: a summary that carries it lets a
 * client match it against a session's `checkoutBranch` without a second read.
 */
export function projectForgeFacts(
  ciStatus: unknown,
  mergeableState: unknown,
  headRef?: unknown,
): Pick<PullRequestState, 'ciStatus' | 'mergeState' | 'headRef'> {
  return {
    ciStatus: projectCiStatus(ciStatus),
    mergeState: projectMergeState(mergeableState),
    headRef: typeof headRef === 'string' && headRef !== '' ? headRef : null,
  };
}

/**
 * How many linked PRs a task summary carries. A cap rather than a page,
 * because this rides on EVERY loaded task row: it is a badge, not a list
 * surface, and the detail panel's connections read is where an unbounded
 * answer belongs. Eight is well past what any real task links and still cheap
 * to carry on a hundred rows at once.
 */
export const LINKED_PULL_REQUEST_BADGE_CAP = 8;

export interface LinkedPullRequestBadges {
  /** Newest-linked first, at most `LINKED_PULL_REQUEST_BADGE_CAP`. */
  items: LinkedPullRequestBadge[];
  /** True only when the cap actually dropped something. */
  truncated: boolean;
}

/**
 * `badges.pullRequests` for a page of rows — THE loader, called by both
 * assemblers.
 *
 * ## ONE FUNCTION, DELIBERATELY
 *
 * `facade/entity-read.ts` and `events/projector.ts` are twins that have drifted
 * before (see the projector's `titleOf` header for the scars). A badge that
 * exists over REST and not over the event feed is worse than one that exists
 * nowhere: the chip appears on load and vanishes on the next live update, which
 * reads as a PR being unlinked. So neither side owns this — both call here, and
 * `rows` is structural for exactly the reason `loadUnreadCounts` is.
 *
 * TASK-GATED, so a page of docs and messages pays nothing. That is not just an
 * optimisation: `tracks` is written task→PR (082's completion gate joins it the
 * same way), so a non-task row could not match anyway, and saying so here keeps
 * the query off the read path instead of relying on it returning zero rows.
 *
 * The lateral is bounded at `cap + 1` per task: one extra row is the cheapest
 * possible way to know whether the cap LIED, and `truncated` is the difference
 * between "these are the links" and "these are some of the links".
 */
export async function loadLinkedPullRequestBadges(
  q: Querier,
  // Structural, not `EntityRow`: the projector assembles from its own row type
  // and must resolve this from the same place, or the two paths diverge.
  rows: readonly { id: string; kind: string }[],
): Promise<Map<string, LinkedPullRequestBadges>> {
  const out = new Map<string, LinkedPullRequestBadges>();
  const taskIds = [...new Set(rows.filter((r) => r.kind === 'task').map((r) => r.id))];
  if (taskIds.length === 0) return out;

  const linked = await q.query<{
    task_id: string;
    entity_id: string;
    repo: string;
    number: number;
    title: string | null;
    state: string;
    url: string | null;
    ci_status: string | null;
    mergeable_state: string | null;
    head_ref: string | null;
  }>(
    // NEWEST-FIRST BY LINK RECENCY, not by PR number or update time: the fact
    // this projection exists to deliver is "the PR I just linked", and a task
    // that links a long-open PR after a fresh one still means the newest LINK
    // first. `id desc` breaks ties so the cap is deterministic rather than
    // whatever the planner returns.
    `select t.id as task_id, pr.*
       from unnest($1::uuid[]) as t(id)
       cross join lateral (
         select p.entity_id, p.repo, p.number, p.title, p.state, p.url,
                p.ci_status, p.mergeable_state, p.head_ref
           from public.edges g
           join public.pull_requests p on p.entity_id = g.dst_id
           join public.entities pe on pe.id = p.entity_id and pe.deleted_at is null
          where g.type = 'tracks' and g.src_id = t.id
          order by g.created_at desc, g.id desc
          limit $2
       ) pr`,
    [taskIds, LINKED_PULL_REQUEST_BADGE_CAP + 1],
  );

  for (const row of linked) {
    const badges = out.get(row.task_id) ?? { items: [], truncated: false };
    if (badges.items.length === LINKED_PULL_REQUEST_BADGE_CAP) {
      // The cap+1'th row. It is never emitted — it exists only to prove the
      // cap dropped something.
      badges.truncated = true;
    } else {
      const repository = row.repo;
      const number = Number(row.number);
      badges.items.push({
        entityId: row.entity_id,
        repository,
        number,
        // Same fallback both assemblers' titleOf use for a pull_request with
        // no mirrored title — never an id, never empty.
        title: row.title !== null && row.title !== '' ? row.title : `${repository}#${String(number)}`,
        state: row.state,
        url: row.url,
        // The two granular mappers rather than `projectForgeFacts`: that
        // helper spreads the EntityState arm's OPTIONAL keys, and on a badge
        // whose whole object is already the optional thing, an explicit null
        // is the only honest encoding of "no verdict".
        ciStatus: projectCiStatus(row.ci_status),
        mergeState: projectMergeState(row.mergeable_state),
        headRef: row.head_ref,
      });
    }
    out.set(row.task_id, badges);
  }

  return out;
}
