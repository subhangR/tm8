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
  /** The PR's source branch (observer head_ref, 107). Null: unobserved.
   *
   *  It is a JOIN KEY ONLY against a WORKTREE's own `branch` — see
   *  `attribution` and the `in_worktree` pass. It is deliberately NOT matched
   *  against a session's own branch fact: that names a directory in a shared
   *  checkout, and matching on it is the defect this module was repaired for. */
  headRef: string | null;
  /**
   * HOW THIS PR REACHED THIS ENTITY. Two different claims wear the same chip
   * today, and they are not the same claim:
   *
   *   `authored`  — provenance. A `created_in` edge (the PR's birth session,
   *                 which Postgres enforces as unique per entity,
   *                 `066:82-83`), or the PR's branch matching the branch of a
   *                 worktree this session is `in_worktree` of. This session
   *                 MADE this PR.
   *   `tracked`   — a `tracks` edge, or the server's own `badges.pullRequests`
   *                 projection of one. The TASK is linked to this PR. This is
   *                 what a task tile shows and it is authoritative FOR A TASK.
   *   `inherited` — copied onto a session from a task it worked on. 155 tasks
   *                 have more than one session (up to 10), so this says only
   *                 "a sibling of mine may have written this", never "I did".
   *
   * Strongest wins when one PR arrives by several routes; see `indexLinkedPullRequests`.
   */
  attribution: PullRequestAttribution;
}

/** See `LinkedPullRequestFacts.attribution`. Ordered weakest-last by RANK. */
export type PullRequestAttribution = 'authored' | 'tracked' | 'inherited';

/** Higher wins. A PR reached by several routes settles on its strongest claim. */
const ATTRIBUTION_RANK: Record<PullRequestAttribution, number> = {
  authored: 3,
  tracked: 2,
  inherited: 1,
};
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
    headRef:
      typeof state.headRef === 'string' && state.headRef !== '' ? state.headRef : null,
    // The default is the claim a bare PR summary actually supports; every
    // pass in the index restates it explicitly for the route it took.
    attribution: 'tracked',
  };
}

/**
 * The same facts, read off the row's OWN badge instead of out of the graph.
 *
 * `badges.pullRequests` is the server projecting each tracked PR onto the
 * tracking task's summary, so these arrive with the tile rather than having to
 * win a seat on the bounded graph page. The mapping is nearly an identity —
 * the server shaped them for this consumer — with one real check: `state` is
 * a free string on the wire and only the four lifecycle words render a chip.
 *
 * An ABSENT `badges.pullRequests` yields nothing rather than an empty claim: a
 * node predating this field says nothing about links, and the edge passes below
 * are what answers for it.
 *
 * `headRef` rides along because the `in_worktree` tier keys on it: a
 * badge-carried PR can therefore reach a session through the WORKTREE's branch
 * with no PR node on the page at all. `''` normalises to null exactly as
 * `pullRequestFactsOf` does — an empty branch name is not a key, and must not
 * bucket with other blanks.
 */
export function badgePullRequestFactsOf(row: EntitySummary): LinkedPullRequestFacts[] {
  const facts: LinkedPullRequestFacts[] = [];
  for (const badge of row.badges.pullRequests ?? []) {
    const lifecycle = optionalEnum(badge.state, LIFECYCLE);
    if (lifecycle === null) continue;
    facts.push({
      id: badge.entityId,
      title: badge.title,
      repository: badge.repository,
      number: badge.number,
      lifecycle,
      url: badge.url,
      ciStatus: badge.ciStatus,
      mergeState: badge.mergeState,
      headRef: badge.headRef !== null && badge.headRef !== '' ? badge.headRef : null,
      // The badge IS the server's projection of the task's `tracks` edge.
      attribution: 'tracked',
    });
  }
  return facts;
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
 * Index entity → linked PRs from the graph read the shell already hydrates.
 *
 * Edge endpoint summaries are snapshots. A later observer event updates the
 * normalized entity table but does not rewrite every stored edge, so endpoints
 * are resolved through `nodes` first. That is the detail that makes the chips
 * flip from a live `entity.upsert` instead of staying pinned to boot state.
 *
 * ## TWO INDEPENDENT ORDERINGS, AND THEY ARE NOT THE SAME QUESTION
 *
 * Every pass writes into one map keyed by PR id, so a PR reached twice is
 * enriched, never duplicated. But "which write wins" splits in two:
 *
 * ### 1. FRESHNESS — which copy of the FACTS (lifecycle, CI, conflict) wins
 *
 *   a. A LIVE node summary resolved through `nodes`, or a server-computed
 *      `badges.pullRequests` entry. Both are read-time fresh.
 *   b. A stored EDGE ENDPOINT SNAPSHOT, frozen when the edge was written. It
 *      fills a gap (`weak`) and never overwrites (a).
 *
 * ### 2. ATTRIBUTION — how strong the CLAIM that this PR belongs to this entity
 *
 *   1. `created_in` (PR → work_session). PROVENANCE, and the only exact answer
 *      in the building: `edges_created_in_source_idx` (`066:82-83`) is a
 *      partial unique index on `src_id where type = 'created_in'`, so
 *      **Postgres enforces one birth session per entity**. -> `authored`
 *   2. `in_worktree` (work_session → worktree), joined on the WORKTREE's own
 *      `branch` fact against the PR's `headRef`. A worktree is an allocated
 *      lane, not a shared directory, so its branch does identify work.
 *      -> `authored`
 *   3. `tracks` / `badges.pullRequests` (task ↔ PR). Authoritative FOR A TASK.
 *      -> `tracked`
 *   4. Task-inherited onto a session (`working_on`, or the task row's own
 *      `badges.workingActors[].actor.via.sessionId`). -> `inherited`
 *
 * These two orderings are applied INDEPENDENTLY: `add` takes the freshest
 * facts and, separately, the strongest attribution ever seen for that pair.
 * A PR that arrives `inherited`-then-`authored` settles on `authored`
 * regardless of edge order, and a stale snapshot that happens to carry the
 * stronger claim still loses its FACTS to the live copy. Getting this wrong
 * is how an ordering-dependent index quietly reports the wrong thing.
 *
 * ## WHAT IS DELIBERATELY ABSENT: matching a PR's branch to a SESSION's branch
 *
 * There used to be a bottom rung that matched a PR's `headRef` against the
 * session's own checked-out-branch fact. It is deleted, not demoted, and this
 * module reads no branch fact off a work_session at all any more — by name or
 * otherwise. Only a WORKTREE's branch is a join key here.
 *
 * That fact identifies a session only when the session owns its checkout; in
 * `workdirMode: 'project'` it names a DIRECTORY that every session spawned
 * into that project shares. Measured 2026-08-17: eleven
 * sessions on one shared checkout each rendered the SAME four PRs
 * (#324/#335/#340/#345, all head `tm8/01a00bbd`) while the graph already held
 * correct 1:1 `created_in` edges naming four DIFFERENT sessions.
 *
 * Narrowing it to worktree lanes (PR #350) stopped the symptom but kept the
 * mistake: dedupe-by-PR-id means it "cannot outrank" the passes above only
 * when another pass fired at all, and on a session whose task carries no
 * `tracks` edge it was the ONLY pass. A branch name is not an identity —
 * `tm8/xxxxxxxx` is the first 8 hex of a uuidv7, i.e. the top 32 bits of a
 * 48-bit millisecond clock, so the names repeat about every 65 seconds.
 *
 * A PR with no provenance edge must therefore show NOTHING on a session tile,
 * because tm8 genuinely does not know. Historical backfill is ruled out by
 * `066:39-45` (forward capture only), so this degrades honestly rather than
 * guessing — and guessing is what produced the bug.
 */
export function indexLinkedPullRequests(
  nodes: readonly EntitySummary[],
  edges: readonly EdgeView[],
): LinkedPullRequestsByEntity {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const mutable = new Map<string, Map<string, LinkedPullRequestFacts>>();

  /**
   * The two orderings above, in one place.
   *
   * `weak` marks a stale endpoint snapshot: it fills a gap without overwriting
   * fresher facts. `attribution` climbs monotonically and NEVER falls, so a
   * weak write still upgrades the claim even when its facts are discarded —
   * a stale `created_in` endpoint proves authorship just as well as a live one.
   */
  const add = (
    entityId: string,
    facts: LinkedPullRequestFacts,
    { weak = false, attribution = facts.attribution }: {
      weak?: boolean;
      attribution?: PullRequestAttribution;
    } = {},
  ): void => {
    const linked = mutable.get(entityId) ?? new Map<string, LinkedPullRequestFacts>();
    const prior = linked.get(facts.id);
    const strongest =
      prior !== undefined
      && ATTRIBUTION_RANK[prior.attribution] > ATTRIBUTION_RANK[attribution]
        ? prior.attribution
        : attribution;
    // Facts: freshest wins. Attribution: strongest wins. Independently.
    const chosen = weak && prior !== undefined ? prior : facts;
    linked.set(facts.id, chosen.attribution === strongest ? chosen : { ...chosen, attribution: strongest });
    mutable.set(entityId, linked);
  };

  // ---------------------------------------------------------------------
  // TIER 3 — the task's own link. First, because the inheritance passes read
  // the task's assembled set, and because it is the only source that needs no
  // edge at all.
  // ---------------------------------------------------------------------
  for (const node of nodes) {
    for (const facts of badgePullRequestFactsOf(node)) add(node.id, facts);
  }

  for (const edge of edges) {
    if (edge.type !== 'tracks') continue;
    const source = nodeById.get(edge.source.id) ?? edge.source;
    const target = nodeById.get(edge.target.id) ?? edge.target;
    const sourceFacts = pullRequestFactsOf(source);
    const targetFacts = pullRequestFactsOf(target);
    const sourceIsSnapshot = !nodeById.has(edge.source.id);
    const targetIsSnapshot = !nodeById.has(edge.target.id);

    if (targetFacts !== null && sourceFacts === null) {
      add(source.id, targetFacts, { weak: targetIsSnapshot });
    }
    if (sourceFacts !== null && targetFacts === null) {
      add(target.id, sourceFacts, { weak: sourceIsSnapshot });
    }
  }

  // ---------------------------------------------------------------------
  // TIER 1 — `created_in`: the PR's BIRTH SESSION.
  //
  // Registered src `*` -> dst `work_session` (`066:63`), so the PR is always
  // the SOURCE. Reading it in only that direction is deliberate: the reverse
  // would mean a work_session was born in a PR, which the registry forbids,
  // and accepting it anyway would resurrect exactly the kind of shape-guessing
  // this repair removes.
  //
  // The edge is `origin: 'client_claim'` (`066:151-152`) — asserted by the CLI
  // from TM8_SESSION_ID, not verified. It is nonetheless the strongest thing
  // we have AND the database refuses a contradicting second claim, so it
  // outranks every branch-shaped inference.
  // ---------------------------------------------------------------------
  for (const edge of edges) {
    if (edge.type !== 'created_in') continue;
    const source = nodeById.get(edge.source.id) ?? edge.source;
    const facts = pullRequestFactsOf(source);
    if (facts === null) continue;
    // `created_in` also stamps docs, memories and commits; only a PR draws a
    // PR chip, and `pullRequestFactsOf` is the structural test for that.
    add(edge.target.id, facts, {
      weak: !nodeById.has(edge.source.id),
      attribution: 'authored',
    });
  }

  // ---------------------------------------------------------------------
  // TIER 2 — `in_worktree`, joined on the WORKTREE's branch.
  //
  // A worktree entity carries its own `branch` fact (contract `:373`), and it
  // is a real allocated lane rather than a directory several sessions were
  // spawned into. That is the whole difference from the deleted pass.
  //
  // AMBIGUITY IS REFUSED, NOT RANKED. 057:171 explicitly permits several
  // sessions to hold `in_worktree` on one worktree ("No unique index"), and
  // when they do, the branch no longer names a session — the identical
  // failure mode, one layer up. Those worktrees are dropped whole. The
  // residual this cannot see: if only ONE of several sharers won a seat on
  // the bounded graph page, it looks unambiguous here. That is why this is
  // tier 2 and `created_in` is tier 1.
  // ---------------------------------------------------------------------
  const worktreeBranch = new Map<string, string>();
  const worktreeSessions = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.type !== 'in_worktree') continue;
    const session = nodeById.get(edge.source.id) ?? edge.source;
    const sessionState = session.state as unknown as Record<string, unknown>;
    // src_kinds also allows task/pull_request/commit (057:175). Only a
    // session's worktree membership attributes a PR to a session.
    if (sessionState.kind !== 'work_session') continue;
    const worktree = nodeById.get(edge.target.id) ?? edge.target;
    const worktreeState = worktree.state as unknown as Record<string, unknown>;
    if (worktreeState.kind !== 'worktree') continue;
    const branch = typeof worktreeState.branch === 'string' ? worktreeState.branch : null;
    if (branch === null || branch === '') continue;
    worktreeBranch.set(worktree.id, branch);
    const sharers = worktreeSessions.get(worktree.id) ?? new Set<string>();
    sharers.add(session.id);
    worktreeSessions.set(worktree.id, sharers);
  }

  // The PRs reachable by branch, seeded from BOTH fact sources. A PR that
  // never won a seat on the bounded page has no node here to read a `headRef`
  // off; the badge carries it for exactly that case.
  const byHeadRef = new Map<string, LinkedPullRequestFacts[]>();
  if (worktreeBranch.size > 0) {
    const bucketed = new Set<string>();
    const bucketByHeadRef = (facts: LinkedPullRequestFacts): void => {
      // `headRef === null` is an unobserved branch, and absence is not a key.
      if (facts.headRef === null || bucketed.has(facts.id)) return;
      bucketed.add(facts.id);
      const bucket = byHeadRef.get(facts.headRef) ?? [];
      bucket.push(facts);
      byHeadRef.set(facts.headRef, bucket);
    };
    for (const node of nodes) {
      const facts = pullRequestFactsOf(node);
      if (facts !== null) bucketByHeadRef(facts);
    }
    // Second, so a PR node that IS on the page keeps seeding from its own live
    // summary; `bucketed` makes the badge fill that gap rather than double it.
    for (const node of nodes) {
      for (const facts of badgePullRequestFactsOf(node)) bucketByHeadRef(facts);
    }
  }

  for (const [worktreeId, branch] of worktreeBranch) {
    const sharers = worktreeSessions.get(worktreeId);
    // Shared lane: the branch names the worktree, not any one of them.
    if (sharers === undefined || sharers.size !== 1) continue;
    const [sessionId] = [...sharers];
    for (const facts of byHeadRef.get(branch) ?? []) {
      add(sessionId!, facts, { attribution: 'authored' });
    }
  }

  // ---------------------------------------------------------------------
  // TIER 4 — SESSIONS INHERIT THEIR TASKS' PRs.
  //
  // The session tile carries the task's chip vocabulary because the PR a
  // session's work tracks is related to that session — but it is a WEAKER
  // claim and now says so. 155 tasks have more than one session (up to 10),
  // so on a multi-session task this copies one PR onto every one of them.
  // `attribution: 'inherited'` is what lets the chip render that difference
  // instead of pretending a sibling's PR is this session's work.
  //
  // Forced, never propagated: a PR that is `authored` ON THE TASK (it cannot
  // be, today) must still arrive here as `inherited`, because inheritance is
  // a claim about the ROUTE, not about the task's own confidence.
  // ---------------------------------------------------------------------
  for (const edge of edges) {
    if (edge.type !== 'working_on') continue;
    const taskLinked = mutable.get(edge.target.id);
    if (taskLinked === undefined) continue;
    for (const facts of taskLinked.values()) {
      add(edge.source.id, facts, { attribution: 'inherited' });
    }
  }

  // AND FROM THE TASK'S OWN BADGES — the deterministic half. The graph page is
  // bounded (limit 150 on a space several times that size), so a live
  // session's `working_on` edge is a lottery ticket; but every LOADED task
  // summary carries `badges.workingActors[].actor.via.sessionId`, which names
  // the same session from the task's side. Measured live 2026-08-13: session
  // tiles rendered no chips while their tasks' did, purely because the edge
  // missed the page.
  for (const node of nodes) {
    const linked = mutable.get(node.id);
    if (linked === undefined) continue;
    for (const work of node.badges.workingActors ?? []) {
      const sessionId = work.actor.via?.sessionId;
      if (typeof sessionId === 'string' && sessionId !== '') {
        for (const facts of [...linked.values()]) {
          add(sessionId, facts, { attribution: 'inherited' });
        }
      }
    }
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
