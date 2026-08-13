import { describe, expect, it } from 'vitest';
import type { EdgeView, EntitySummary } from '@tm8/contract';
import {
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
