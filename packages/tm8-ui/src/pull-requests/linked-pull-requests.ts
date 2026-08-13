import type { EdgeView, EntitySummary } from '@tm8/contract';
import type { PillTone } from '../kit';

/** The lifecycle words stored on a pull-request entity. */
export type PullRequestLifecycle = 'open' | 'draft' | 'merged' | 'closed';

/**
 * The observer facts the task surfaces need, projected from an enriched
 * pull-request summary. `ciStatus` and `mergeState` are optional on purpose:
 * rolling nodes predating the additive read-door fields must render no claim,
 * rather than treating an absent fact as success.
 */
export interface LinkedPullRequestFacts {
  id: string;
  title: string;
  repository: string;
  number: number;
  lifecycle: PullRequestLifecycle;
  url: string | null;
  ciStatus: 'passing' | 'failing' | 'pending' | null;
  mergeState: 'clean' | 'conflicted' | 'unknown' | null;
}
export type PullRequestChipState =
  | PullRequestLifecycle
  | 'conflict'
  | 'ci-red'
  | 'ci-green';

export interface PullRequestChip {
  state: PullRequestChipState;
  label: string;
  tone: PillTone;
}

const LIFECYCLE = new Set<PullRequestLifecycle>(['open', 'draft', 'merged', 'closed']);
const CI_STATUS = new Set<NonNullable<LinkedPullRequestFacts['ciStatus']>>([
  'passing',
  'failing',
  'pending',
]);
const MERGE_STATE = new Set<NonNullable<LinkedPullRequestFacts['mergeState']>>([
  'clean',
  'conflicted',
  'unknown',
]);

const LIFECYCLE_TONE: Record<PullRequestLifecycle, PillTone> = {
  open: 'run',
  draft: 'idle',
  merged: 'brand',
  closed: 'idle',
};

function optionalEnum<T extends string>(
  value: unknown,
  values: ReadonlySet<T>,
): T | null {
  return typeof value === 'string' && values.has(value as T) ? (value as T) : null;
}

/**
 * Read the PR state structurally. This deliberately does not branch on an
 * entity kind: the `tracks` edge may also target commits, and the numeric PR
 * number plus lifecycle vocabulary distinguish the summary without teaching
 * a component a kind literal.
 */
export function pullRequestFactsOf(row: EntitySummary): LinkedPullRequestFacts | null {
  const state = row.state as unknown as Record<string, unknown>;
  const lifecycle = optionalEnum(state.state, LIFECYCLE);
  if (
    lifecycle === null
    || typeof state.repository !== 'string'
    || typeof state.number !== 'number'
  ) {
    return null;
  }

  return {
    id: row.id,
    title: row.title,
    repository: state.repository,
    number: state.number,
    lifecycle,
    url: typeof state.url === 'string' ? state.url : null,
    // Exact additive read-door names. Missing/null/unknown values stay null.
    ciStatus: optionalEnum(state.ciStatus, CI_STATUS),
    mergeState: optionalEnum(state.mergeState, MERGE_STATE),
  };
}

/**
 * One PR may carry up to three independent facts. Conflict and CI do not
 * replace lifecycle: an open PR with a merge conflict and failing checks is
 * truthfully all three at once.
 */
export function chipsForPullRequest(facts: LinkedPullRequestFacts): PullRequestChip[] {
  const chips: PullRequestChip[] = [
    {
      state: facts.lifecycle,
      label: facts.lifecycle,
      tone: LIFECYCLE_TONE[facts.lifecycle],
    },
  ];

  if (facts.mergeState === 'conflicted') {
    chips.push({ state: 'conflict', label: 'conflict', tone: 'block' });
  }
  if (facts.ciStatus === 'failing') {
    chips.push({ state: 'ci-red', label: 'CI red', tone: 'block' });
  } else if (facts.ciStatus === 'passing') {
    chips.push({ state: 'ci-green', label: 'CI green', tone: 'run' });
  }

  return chips;
}

export type LinkedPullRequestsByEntity = ReadonlyMap<string, readonly LinkedPullRequestFacts[]>;

/**
 * Index task → tracked PRs from the graph read the shell already hydrates.
 *
 * Edge endpoint summaries are snapshots. A later observer event updates the
 * normalized entity table but does not rewrite every stored edge, so endpoints
 * are resolved through `nodes` first. That is the detail that makes the chips
 * flip from a live `entity.upsert` instead of staying pinned to boot state.
 */
export function indexLinkedPullRequests(
  nodes: readonly EntitySummary[],
  edges: readonly EdgeView[],
): LinkedPullRequestsByEntity {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const mutable = new Map<string, Map<string, LinkedPullRequestFacts>>();

  const add = (entityId: string, facts: LinkedPullRequestFacts): void => {
    const linked = mutable.get(entityId) ?? new Map<string, LinkedPullRequestFacts>();
    linked.set(facts.id, facts);
    mutable.set(entityId, linked);
  };

  for (const edge of edges) {
    if (edge.type !== 'tracks') continue;
    const source = nodeById.get(edge.source.id) ?? edge.source;
    const target = nodeById.get(edge.target.id) ?? edge.target;
    const sourceFacts = pullRequestFactsOf(source);
    const targetFacts = pullRequestFactsOf(target);

    if (targetFacts !== null && sourceFacts === null) add(source.id, targetFacts);
    if (sourceFacts !== null && targetFacts === null) add(target.id, sourceFacts);
  }

  return new Map(
    [...mutable].map(([entityId, linked]) => [
      entityId,
      [...linked.values()].sort((a, b) =>
        a.repository.localeCompare(b.repository)
        || a.number - b.number
        || a.id.localeCompare(b.id)),
    ]),
  );
}
