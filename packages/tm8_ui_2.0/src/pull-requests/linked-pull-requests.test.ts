import { describe, expect, it } from 'vitest';
import type { EdgeView, EntitySummary } from '@tm8/contract';
import {
  badgePullRequestFactsOf,
  chipsForPullRequest,
  indexLinkedPullRequests,
  pullRequestFactsOf,
} from './linked-pull-requests';

const ACTOR = {
  id: 'member-1',
  kind: 'member' as const,
  displayName: 'Ada',
  avatar: null,
  isAgent: false,
};

function summary(
  id: string,
  state: Record<string, unknown>,
  title = id,
): EntitySummary {
  return {
    id,
    spaceId: 'space-1',
    kind: state.kind as EntitySummary['kind'],
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-09T00:00:00.000Z',
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    deletedAt: null,
    createdBy: ACTOR,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: state as EntitySummary['state'],
    badges: {},
  };
}

const task = summary('task-1', {
  kind: 'task',
  status: 'working',
  priority: 'medium',
  axes: {},
  assignees: [],
  acceptance: { total: 0, completed: 0 },
});

function pullRequest(overrides: Record<string, unknown> = {}): EntitySummary {
  return summary('pr-1', {
    kind: 'pull_request',
    repository: 'acme/tm8',
    number: 42,
    state: 'open',
    stale: false,
    ciStatus: null,
    mergeState: null,
    ...overrides,
  }, 'Ship linked PR chips');
}

function tracks(source: EntitySummary, target: EntitySummary): EdgeView {
  return {
    id: 'edge-1',
    type: 'tracks',
    source,
    target,
    props: {},
    createdBy: ACTOR,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  };
}

describe('linked pull request facts', () => {
  it.each(['open', 'draft', 'merged', 'closed'] as const)(
    'renders the %s lifecycle chip',
    (lifecycle) => {
      const facts = pullRequestFactsOf(pullRequest({ state: lifecycle }));
      expect(chipsForPullRequest(facts!).map((chip) => chip.state)).toEqual([lifecycle]);
    },
  );

  it('maps the exact observer vocabulary and makes no claim for absent facts', () => {
    const oldNode = pullRequestFactsOf(pullRequest());
    expect(oldNode).toMatchObject({ lifecycle: 'open', ciStatus: null, mergeState: null });
    expect(chipsForPullRequest(oldNode!).map((chip) => chip.state)).toEqual(['open']);

    const observed = pullRequestFactsOf(pullRequest({
      state: 'draft',
      ciStatus: 'failing',
      mergeState: 'conflicted',
    }));
    expect(chipsForPullRequest(observed!).map((chip) => chip.state)).toEqual([
      'draft',
      'conflict',
      'ci-red',
    ]);
  });

  it('renders passing as CI-green and ignores pending/unknown rather than styling them as success', () => {
    const passing = pullRequestFactsOf(pullRequest({ ciStatus: 'passing', mergeState: 'clean' }));
    expect(chipsForPullRequest(passing!).map((chip) => chip.state)).toEqual(['open', 'ci-green']);

    const unknown = pullRequestFactsOf(pullRequest({ ciStatus: 'pending', mergeState: 'unknown' }));
    expect(chipsForPullRequest(unknown!).map((chip) => chip.state)).toEqual(['open']);
  });

  it('indexes the tracks edge and resolves a later observer summary over its stale endpoint snapshot', () => {
    const bootSnapshot = pullRequest({ state: 'open', ciStatus: null, mergeState: null });
    const observerUpdate = pullRequest({
      state: 'merged',
      ciStatus: 'passing',
      mergeState: 'clean',
    });

    const index = indexLinkedPullRequests(
      [task, observerUpdate],
      [tracks(task, bootSnapshot)],
    );

    expect(index.get(task.id)).toEqual([
      expect.objectContaining({
        id: 'pr-1',
        lifecycle: 'merged',
        ciStatus: 'passing',
        mergeState: 'clean',
      }),
    ]);
  });

  it('does not mistake a tracked commit for a pull request', () => {
    const commit = summary('commit-1', {
      kind: 'commit',
      repository: 'acme/tm8',
      sha: 'abc1234',
      message: 'Ship it',
    });
    expect(indexLinkedPullRequests([task, commit], [tracks(task, commit)]).get(task.id)).toBeUndefined();
  });
});

describe('sessions inherit their tasks\' PRs (working_on second pass)', () => {
  const session = summary('ws-1', {
    kind: 'work_session',
    status: 'running',
    agentTool: 'claude-code',
    shareMode: 'none',
    sessionKind: 'agent',
  });

  function workingOn(source: EntitySummary, target: EntitySummary): EdgeView {
    return { ...tracks(source, target), id: 'edge-wo-1', type: 'working_on' };
  }

  it('indexes the session with the PRs its working_on task tracks', () => {
    const pr = pullRequest({ ciStatus: 'failing', state: 'merged' });
    const index = indexLinkedPullRequests(
      [task, pr, session],
      [tracks(task, pr), workingOn(session, task)],
    );
    expect(index.get('task-1')?.map((f) => f.id)).toEqual(['pr-1']);
    // The session carries the SAME facts — merged, ci-red and all.
    expect(index.get('ws-1')?.[0]).toMatchObject({ id: 'pr-1', lifecycle: 'merged', ciStatus: 'failing' });
  });

  it('edge order does not matter — working_on before tracks still resolves', () => {
    const pr = pullRequest();
    const index = indexLinkedPullRequests(
      [task, pr, session],
      [workingOn(session, task), tracks(task, pr)],
    );
    expect(index.get('ws-1')?.map((f) => f.id)).toEqual(['pr-1']);
  });

  it('a session working an untracked task inherits nothing', () => {
    const index = indexLinkedPullRequests([task, session], [workingOn(session, task)]);
    expect(index.get('ws-1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TIER 1 — `created_in`, the PR's birth session (066). The tier the client
// never read, and the whole of the reported bug.
// ---------------------------------------------------------------------------

const laneSession = summary('ws-lane-1', {
  kind: 'work_session',
  status: 'running',
  agentTool: 'claude-code',
  shareMode: 'none',
});

function edgeOf(type: string, source: EntitySummary, target: EntitySummary, id: string): EdgeView {
  return { ...tracks(source, target), id, type: type as EdgeView['type'] };
}

function createdIn(pr: EntitySummary, session: EntitySummary, id = 'edge-ci-1'): EdgeView {
  return edgeOf('created_in', pr, session, id);
}

describe('created_in is tier 1 — provenance, not a branch name', () => {
  it('puts a PR on its BIRTH SESSION with no task, no tracks edge and no branch anywhere', () => {
    const pr = pullRequest({ ciStatus: 'passing', state: 'merged' });
    const index = indexLinkedPullRequests([pr, laneSession], [createdIn(pr, laneSession)]);
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({
      id: 'pr-1',
      lifecycle: 'merged',
      ciStatus: 'passing',
      attribution: 'authored',
    });
  });

  it('NEGATIVE CONTROL — without the edge the same page answers nothing', () => {
    // The honest degradation 066:39-45 forces: no provenance, no chip. If this
    // ever starts passing a chip through, some branch-shaped guess came back.
    const pr = pullRequest();
    expect(indexLinkedPullRequests([pr, laneSession], []).get('ws-lane-1')).toBeUndefined();
  });

  it('reads created_in in ONE direction — the registry says PR -> session', () => {
    // 066:63 registers src `*` -> dst `work_session`. A reversed edge would
    // mean a session was born in a PR; honouring it would be shape-guessing.
    const pr = pullRequest();
    const reversed = edgeOf('created_in', laneSession, pr, 'edge-ci-rev');
    const index = indexLinkedPullRequests([pr, laneSession], [reversed]);
    expect(index.get('ws-lane-1')).toBeUndefined();
    expect(index.get('pr-1')).toBeUndefined();
  });

  it('ignores a created_in edge whose source is not a pull request', () => {
    // The same edge type stamps docs, memories and commits. Only a PR draws
    // a PR chip.
    const doc = summary('doc-1', { kind: 'doc', format: 'markdown', childCount: 0 });
    const index = indexLinkedPullRequests([doc, laneSession], [createdIn(doc, laneSession, 'e-doc')]);
    expect(index.get('ws-lane-1')).toBeUndefined();
  });

  it('resolves a live PR summary over the created_in edge\'s stale endpoint snapshot', () => {
    const observerUpdate = pullRequest({ state: 'merged', ciStatus: 'passing', mergeState: 'clean' });
    const bootSnapshot = pullRequest({ state: 'open', ciStatus: null });
    const index = indexLinkedPullRequests(
      [observerUpdate, laneSession],
      [createdIn(bootSnapshot, laneSession)],
    );
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({
      lifecycle: 'merged', ciStatus: 'passing', attribution: 'authored',
    });
  });

  it('a STALE endpoint still proves authorship even when its facts are discarded', () => {
    // The two orderings are independent: the live badge wins the FACTS, the
    // weak created_in endpoint still wins the ATTRIBUTION.
    const workingTask = withBadges(task, {
      pullRequests: [badge({ state: 'merged', ciStatus: 'passing' })],
      workingActors: [{
        actor: { ...ACTOR, via: { sessionId: 'ws-lane-1' } },
        task,
        startedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    const index = indexLinkedPullRequests(
      [workingTask, laneSession],
      [createdIn(pullRequest({ state: 'open', ciStatus: null }), laneSession)],
    );
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({
      lifecycle: 'merged', ciStatus: 'passing', attribution: 'authored',
    });
  });

  it('THE REPORTED BUG: four PRs on one branch land on four DIFFERENT sessions', () => {
    // The original screenshot, reduced. #324/#335/#340/#345 all carry head
    // `tm8/01a00bbd` and eleven sessions shared that checkout, so every
    // branch-shaped rule put all four on all eleven. Their created_in edges
    // name four different sessions and are 1:1 by construction —
    // `edges_created_in_source_idx` (066:82-83) is a UNIQUE index.
    const numbers = [324, 335, 340, 345];
    const prs = numbers.map((n) => summary(`pr-${n}`, {
      kind: 'pull_request', repository: 'subhangR/tm8', number: n, state: 'merged',
      headRef: 'tm8/01a00bbd', ciStatus: null, mergeState: null,
    }));
    // Eleven sessions on the one shared checkout; four of them authored.
    const sessions = Array.from({ length: 11 }, (_, i) => summary(`ws-${i}`, {
      kind: 'work_session', status: 'running',
    }));
    const edges = prs.map((pr, i) => createdIn(pr, sessions[i]!, `e-${i}`));
    const index = indexLinkedPullRequests([...prs, ...sessions], edges);

    // Each author gets exactly its own one.
    for (const [i, n] of numbers.entries()) {
      expect(index.get(`ws-${i}`)?.map((f) => f.number), `ws-${i}`).toEqual([n]);
    }
    // And the seven non-authors get NOTHING — the fan-out is gone.
    for (let i = 4; i < 11; i += 1) {
      expect(index.get(`ws-${i}`), `ws-${i}`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// TIER 2 — `in_worktree`, joined on the WORKTREE's branch (not the session's).
// ---------------------------------------------------------------------------

describe('in_worktree is tier 2 — a worktree\'s branch, never a session\'s', () => {
  const worktree = summary('wt-1', {
    kind: 'worktree', status: 'active', branch: 'tm8/abc12345', baseRef: 'main',
  });

  function inWorktree(session: EntitySummary, tree: EntitySummary, id = 'edge-iw-1'): EdgeView {
    return edgeOf('in_worktree', session, tree, id);
  }

  it('attributes a PR to the session whose worktree is on the PR\'s branch', () => {
    const pr = pullRequest({ headRef: 'tm8/abc12345', ciStatus: 'passing' });
    const index = indexLinkedPullRequests(
      [pr, laneSession, worktree],
      [inWorktree(laneSession, worktree)],
    );
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({
      id: 'pr-1', attribution: 'authored', ciStatus: 'passing',
    });
  });

  it('NEGATIVE CONTROL — a different branch on the worktree answers nothing', () => {
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    const elsewhere = summary('wt-2', {
      kind: 'worktree', status: 'active', branch: 'main', baseRef: 'main',
    });
    const index = indexLinkedPullRequests(
      [pr, laneSession, elsewhere],
      [inWorktree(laneSession, elsewhere)],
    );
    expect(index.get('ws-lane-1')).toBeUndefined();
  });

  it('makes no association from an unobserved headRef — absence is not a key', () => {
    const pr = pullRequest({ headRef: null });
    const index = indexLinkedPullRequests(
      [pr, laneSession, worktree],
      [inWorktree(laneSession, worktree)],
    );
    expect(index.get('ws-lane-1')).toBeUndefined();
  });

  it('REFUSES a SHARED worktree — 057:171 permits several sessions per tree', () => {
    // The same failure mode as the deleted pass, one layer up: when two
    // sessions hold `in_worktree` on one tree, its branch stops naming a
    // session. Ambiguity is dropped whole rather than fanned out.
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    const other = summary('ws-lane-2', { kind: 'work_session', status: 'running' });
    const index = indexLinkedPullRequests(
      [pr, laneSession, other, worktree],
      [inWorktree(laneSession, worktree), inWorktree(other, worktree, 'edge-iw-2')],
    );
    expect(index.get('ws-lane-1')).toBeUndefined();
    expect(index.get('ws-lane-2')).toBeUndefined();
  });

  it('ignores in_worktree from a non-session source', () => {
    // src_kinds also allows task/pull_request/commit (057:175). Only a
    // session's membership attributes a PR to a session.
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    const index = indexLinkedPullRequests(
      [pr, task, worktree],
      [inWorktree(task, worktree)],
    );
    expect(index.get('task-1')).toBeUndefined();
  });

  it('seeds from the BADGE too — the PR node need not be on the page', () => {
    const workingTask = withBadges(task, {
      pullRequests: [badge({ headRef: 'tm8/abc12345', state: 'merged' })],
    });
    const index = indexLinkedPullRequests(
      [workingTask, laneSession, worktree],
      [inWorktree(laneSession, worktree)],
    );
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({ id: 'pr-1', attribution: 'authored' });
  });

  it('created_in OUTRANKS in_worktree when they disagree about the claim', () => {
    // Both name the same session here, so the assertion is about RANK, not
    // routing: the settled attribution is `authored` either way, and the PR
    // appears exactly once.
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    const index = indexLinkedPullRequests(
      [pr, laneSession, worktree],
      [inWorktree(laneSession, worktree), createdIn(pr, laneSession)],
    );
    expect(index.get('ws-lane-1')).toHaveLength(1);
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({ attribution: 'authored' });
  });
});

// ---------------------------------------------------------------------------
// THE DELETED PASS — a session's own branch fact is not a key any more.
// ---------------------------------------------------------------------------

describe('a session\'s own branch fact attributes NOTHING (pass 6 deleted)', () => {
  it('makes no association even for a session that OWNS its worktree lane', () => {
    // PR #350 narrowed this pass to `workdirMode: 'worktree'`; D4 deletes it.
    // A branch name is not an identity — `tm8/xxxxxxxx` is the top 32 bits of
    // a uuidv7 millisecond clock and repeats about every 65 seconds — and on
    // a session whose task carries no `tracks` edge this was the ONLY pass,
    // so "it cannot outrank the others" was never a guarantee.
    //
    // The honest replacement is the in_worktree tier above: the same lane,
    // proven by an EDGE to a worktree entity, not by a matching string.
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    for (const mode of ['worktree', 'project', 'scratch'] as const) {
      const session = summary('ws-branchy', {
        kind: 'work_session',
        status: 'running',
        checkoutBranch: 'tm8/abc12345',
        workdirMode: mode,
      });
      expect(indexLinkedPullRequests([pr, session], []).get('ws-branchy'), mode).toBeUndefined();
    }
  });

  it('the eleven-session shared checkout draws nothing at all', () => {
    const pr = pullRequest({ headRef: 'tm8/01a00bbd' });
    const shared = Array.from({ length: 11 }, (_, i) => summary(`ws-${i}`, {
      kind: 'work_session',
      status: 'running',
      checkoutBranch: 'tm8/01a00bbd',
      workdirMode: 'project',
    }));
    const index = indexLinkedPullRequests([pr, ...shared], []);
    for (const s of shared) expect(index.get(s.id), s.id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4d — an inherited chip is a different claim from an authored one.
// ---------------------------------------------------------------------------

describe('attribution distinguishes inherited work from authored work', () => {
  function workingOn(source: EntitySummary, target: EntitySummary): EdgeView {
    return edgeOf('working_on', source, target, 'edge-wo-attr');
  }

  it('a task\'s own tracks link is `tracked`, and a session inheriting it is `inherited`', () => {
    const pr = pullRequest();
    const index = indexLinkedPullRequests(
      [task, pr, laneSession],
      [tracks(task, pr), workingOn(laneSession, task)],
    );
    expect(index.get('task-1')?.[0]).toMatchObject({ attribution: 'tracked' });
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({ attribution: 'inherited' });
  });

  it('inheritance is about the ROUTE — a session inherits `inherited`, never the task\'s rank', () => {
    const pr = pullRequest();
    const index = indexLinkedPullRequests(
      [task, pr, laneSession],
      [createdIn(pr, laneSession), tracks(task, pr), workingOn(laneSession, task)],
    );
    // laneSession authored it, so IT keeps `authored`...
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({ attribution: 'authored' });
    // ...while a sibling session on the same task only inherits.
    const sibling = summary('ws-sibling', { kind: 'work_session', status: 'running' });
    const withSibling = indexLinkedPullRequests(
      [task, pr, laneSession, sibling],
      [createdIn(pr, laneSession), tracks(task, pr),
        workingOn(laneSession, task), edgeOf('working_on', sibling, task, 'edge-wo-sib')],
    );
    expect(withSibling.get('ws-sibling')?.[0]).toMatchObject({ attribution: 'inherited' });
    expect(withSibling.get('ws-lane-1')?.[0]).toMatchObject({ attribution: 'authored' });
  });

  it('the strongest claim wins REGARDLESS of edge order', () => {
    // The bug an order-dependent merge would produce: `inherited` written
    // after `authored` silently downgrades a true claim.
    const pr = pullRequest();
    const authoredFirst: EdgeView[] = [
      createdIn(pr, laneSession), tracks(task, pr), workingOn(laneSession, task)];
    const inheritedFirst: EdgeView[] = [
      tracks(task, pr), workingOn(laneSession, task), createdIn(pr, laneSession)];
    for (const edges of [authoredFirst, inheritedFirst]) {
      expect(indexLinkedPullRequests([task, pr, laneSession], edges).get('ws-lane-1')?.[0])
        .toMatchObject({ attribution: 'authored' });
    }
  });

  it('a badge-inherited PR (via.sessionId, no edges) is `inherited` too', () => {
    const workingTask = withBadges(task, {
      pullRequests: [badge()],
      workingActors: [{
        actor: { ...ACTOR, via: { sessionId: 'ws-badge-1' } },
        task,
        startedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    const index = indexLinkedPullRequests([workingTask], []);
    expect(index.get('task-1')?.[0]).toMatchObject({ attribution: 'tracked' });
    expect(index.get('ws-badge-1')?.[0]).toMatchObject({ attribution: 'inherited' });
  });
});

describe('sessions resolve from task badges when the working_on edge missed the graph page', () => {
  it('badges.workingActors[].actor.via.sessionId carries the PRs without any working_on edge', () => {
    const pr = pullRequest({ state: 'merged', ciStatus: 'failing' });
    const workingTask = {
      ...task,
      badges: {
        workingActors: [{
          actor: { ...ACTOR, via: { sessionId: 'ws-badge-1' } },
          task,
          startedAt: '2026-08-13T00:00:00.000Z',
        }],
      },
    } as EntitySummary;
    const index = indexLinkedPullRequests([workingTask, pr], [tracks(workingTask, pr)]);
    expect(index.get('ws-badge-1')?.[0]).toMatchObject({ id: 'pr-1', lifecycle: 'merged', ciStatus: 'failing' });
  });
});

// ---------------------------------------------------------------------------
// badges.pullRequests — the edge-free source
// ---------------------------------------------------------------------------

function badge(overrides: Record<string, unknown> = {}): NonNullable<EntitySummary['badges']['pullRequests']>[number] {
  return {
    entityId: 'pr-1',
    repository: 'acme/tm8',
    number: 42,
    title: 'Ship linked PR chips',
    state: 'open',
    url: 'https://github.com/acme/tm8/pull/42',
    ciStatus: null,
    mergeState: null,
    headRef: null,
    ...overrides,
  } as NonNullable<EntitySummary['badges']['pullRequests']>[number];
}

function withBadges(row: EntitySummary, badges: EntitySummary['badges']): EntitySummary {
  return { ...row, badges: { ...row.badges, ...badges } };
}

describe('badges.pullRequests carries the facts without any edge', () => {
  it('maps a badge onto the same facts the graph read produces', () => {
    expect(badgePullRequestFactsOf(withBadges(task, {
      pullRequests: [badge({
        state: 'draft', ciStatus: 'failing', mergeState: 'conflicted', headRef: 'tm8/abc12345',
      })],
    }))).toEqual([{
      id: 'pr-1',
      title: 'Ship linked PR chips',
      repository: 'acme/tm8',
      number: 42,
      lifecycle: 'draft',
      url: 'https://github.com/acme/tm8/pull/42',
      ciStatus: 'failing',
      mergeState: 'conflicted',
      headRef: 'tm8/abc12345',
      // The badge IS the server's projection of the task's `tracks` edge, so
      // it can never be stronger than `tracked`. This pin is exhaustive on
      // purpose: a new fact must be declared here, not arrive unnoticed.
      attribution: 'tracked',
    }]);
  });

  it('normalises an empty headRef to null — a blank branch is not a key', () => {
    // The fourth pass buckets by headRef; `''` carried through from either side
    // would bucket every unobserved PR together.
    expect(badgePullRequestFactsOf(withBadges(task, { pullRequests: [badge({ headRef: '' })] }))[0])
      .toMatchObject({ headRef: null });
  });

  it('an ABSENT badge array is no claim, not an empty one', () => {
    expect(badgePullRequestFactsOf(task)).toEqual([]);
    expect(indexLinkedPullRequests([task], []).get('task-1')).toBeUndefined();
  });

  it('drops a lifecycle word outside the four rather than rendering an unknown chip', () => {
    // `state` is a free string on the wire; a forge word we do not model must
    // render nothing rather than a chip labelled with it.
    expect(badgePullRequestFactsOf(withBadges(task, {
      pullRequests: [badge({ state: 'locked' })],
    }))).toEqual([]);
  });

  it('indexes chips from the badge alone — no tracks edge, no PR node on the page', () => {
    // THE RELOAD CASE, in miniature: the bounded graph page seated the task and
    // nothing else. Before badges this returned undefined.
    const index = indexLinkedPullRequests(
      [withBadges(task, { pullRequests: [badge({ state: 'merged', ciStatus: 'failing' })] })],
      [],
    );
    expect(index.get('task-1')?.map((f) => f.id)).toEqual(['pr-1']);
    expect(chipsForPullRequest(index.get('task-1')![0]).map((c) => c.state))
      .toEqual(['merged', 'ci-red']);
  });

  it('a PR reached by BOTH badge and edge is enriched, never duplicated', () => {
    const pr = pullRequest();
    const index = indexLinkedPullRequests(
      [withBadges(task, { pullRequests: [badge()] }), pr],
      [tracks(task, pr)],
    );
    expect(index.get('task-1')).toHaveLength(1);
  });

  it('a LIVE node summary overwrites the badge — an entity.upsert since the row was read', () => {
    // The badge was computed when the task row was read; the PR node may have
    // moved since. Source (2) beats source (1) for exactly that reason.
    const index = indexLinkedPullRequests(
      [
        withBadges(task, { pullRequests: [badge({ state: 'open' })] }),
        pullRequest({ state: 'merged', ciStatus: 'passing', mergeState: 'clean' }),
      ],
      [tracks(task, pullRequest({ state: 'open' }))],
    );
    expect(index.get('task-1')?.[0]).toMatchObject({ lifecycle: 'merged', ciStatus: 'passing' });
  });

  it('a STALE endpoint snapshot does NOT overwrite the badge', () => {
    // The edge endpoint was frozen when the edge was written; the badge was
    // computed on this read. Source (3) fills gaps only.
    const index = indexLinkedPullRequests(
      [withBadges(task, { pullRequests: [badge({ state: 'merged', ciStatus: 'passing' })] })],
      [tracks(task, pullRequest({ state: 'open', ciStatus: null }))],
    );
    expect(index.get('task-1')?.[0]).toMatchObject({ lifecycle: 'merged', ciStatus: 'passing' });
  });

  it('a session inherits badge-sourced facts through via.sessionId, with no edges at all', () => {
    const workingTask = withBadges(task, {
      pullRequests: [badge({ state: 'merged', ciStatus: 'failing' })],
      workingActors: [{
        actor: { ...ACTOR, via: { sessionId: 'ws-badge-1' } },
        task,
        startedAt: '2026-08-13T00:00:00.000Z',
      }],
    });
    const index = indexLinkedPullRequests([workingTask], []);
    expect(index.get('ws-badge-1')?.[0]).toMatchObject({ id: 'pr-1', lifecycle: 'merged', ciStatus: 'failing' });
  });
});
