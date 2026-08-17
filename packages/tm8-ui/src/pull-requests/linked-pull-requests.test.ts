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
  workStatus: 'working',
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

describe('mechanical headRef association (fourth pass, 107)', () => {
  const laneSession = summary('ws-lane-1', {
    kind: 'work_session',
    status: 'running',
    agentTool: 'claude-code',
    shareMode: 'none',
    checkoutBranch: 'tm8/abc12345',
    workdirMode: 'worktree',
  });

  it('associates a PR to a session by headRef == checkoutBranch, with no edge and no task', () => {
    const pr = pullRequest({ headRef: 'tm8/abc12345', ciStatus: 'passing' });
    const index = indexLinkedPullRequests([pr, laneSession], []);
    expect(index.get('ws-lane-1')?.[0]).toMatchObject({
      id: 'pr-1',
      headRef: 'tm8/abc12345',
      ciStatus: 'passing',
    });
  });

  it('makes no association for a SHARED checkout — the branch names a directory, not a session', () => {
    // The reported bug, reduced. Three sessions, one shared project checkout,
    // therefore one identical `checkoutBranch`; the PR's headRef matches it.
    // Rendering a chip here puts one PR on every tile. Measured 2026-08-17:
    // eleven sessions on `tm8/01a00bbd` each drew #324/#335/#340/#345, while
    // the graph already held a 1:1 `created_in` edge naming four DIFFERENT
    // sessions. No chip beats a wrong chip.
    const pr = pullRequest({ headRef: 'tm8/01a00bbd' });
    const shared = ['ws-a', 'ws-b', 'ws-c'].map((id) => summary(id, {
      kind: 'work_session',
      status: 'running',
      checkoutBranch: 'tm8/01a00bbd',
      workdirMode: 'project',
    }));
    const index = indexLinkedPullRequests([pr, ...shared], []);
    for (const s of shared) expect(index.get(s.id)).toBeUndefined();

    // The same branch in a lane the session OWNS still answers — this pass is
    // narrowed, not removed.
    const owned = summary('ws-lane', {
      kind: 'work_session',
      status: 'running',
      checkoutBranch: 'tm8/01a00bbd',
      workdirMode: 'worktree',
    });
    expect(indexLinkedPullRequests([pr, owned], []).get('ws-lane')?.[0]).toMatchObject({ id: 'pr-1' });
  });

  it('makes no association when the branch fact is absent, null, or different', () => {
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    const noFact = summary('ws-old', { kind: 'work_session', status: 'running' });
    const nullFact = summary('ws-scratch', { kind: 'work_session', status: 'running', checkoutBranch: null });
    const otherBranch = summary('ws-other', { kind: 'work_session', status: 'running', checkoutBranch: 'main' });
    const index = indexLinkedPullRequests([pr, noFact, nullFact, otherBranch], []);
    expect(index.get('ws-old')).toBeUndefined();
    expect(index.get('ws-scratch')).toBeUndefined();
    expect(index.get('ws-other')).toBeUndefined();
  });

  it('makes no association from an unobserved headRef — absence is not a key', () => {
    const pr = pullRequest({ headRef: null });
    const index = indexLinkedPullRequests([pr, laneSession], []);
    expect(index.get('ws-lane-1')).toBeUndefined();
  });

  it('deduplicates against the higher-precedence passes — one PR, once', () => {
    // Same PR reaches the session via working_on AND via headRef; the map
    // keys on PR id, so the mechanical pass merely confirms the linked one.
    const pr = pullRequest({ headRef: 'tm8/abc12345' });
    const workingOn: EdgeView = { ...tracks(laneSession, task), id: 'edge-wo-2', type: 'working_on' };
    const index = indexLinkedPullRequests(
      [task, pr, laneSession],
      [tracks(task, pr), workingOn],
    );
    expect(index.get('ws-lane-1')?.map((f) => f.id)).toEqual(['pr-1']);
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
