import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '../../../collab-v2/types/contract';
import type { SessionLinks } from '../useSessions';
import { buildSessionForest, SessionTree } from '../tabs/SessionTree';

function session(id: string, parentId: string | null): EntitySummary {
  return {
    id,
    spaceId: 'space-1',
    kind: 'work_session' as EntitySummary['kind'],
    title: id,
    parentId,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-30T00:00:00.000Z',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'owner', kind: 'member', displayName: 'Owner', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { status: 'running', agentTool: 'codex' } as EntitySummary['state'],
    badges: {},
  };
}

describe('workspace session tree', () => {
  it('builds the spawn chain even when children arrive before parents', () => {
    const sessions = [
      session('great-grandchild', 'grandchild'),
      session('child', 'root'),
      session('root', null),
      session('grandchild', 'child'),
    ];

    const forest = buildSessionForest(sessions);
    expect(forest).toHaveLength(1);
    expect(forest[0]?.session.id).toBe('root');
    expect(forest[0]?.children[0]?.session.id).toBe('child');
    expect(forest[0]?.children[0]?.children[0]?.session.id).toBe('grandchild');
    expect(forest[0]?.children[0]?.children[0]?.children[0]?.session.id).toBe('great-grandchild');
  });

  it('renders every depth instead of flattening or truncating descendants', () => {
    const sessions = [
      session('root', null),
      session('child', 'root'),
      session('grandchild', 'child'),
      session('great-grandchild', 'grandchild'),
    ];
    const links = new Map<string, SessionLinks>(
      sessions.map(({ id }) => [id, { agent: null, task: null }]),
    );

    const { container } = render(
      <SessionTree
        sessions={sessions}
        links={links}
        active={null}
        onOpen={() => undefined}
        lifecycle="open"
        liveOnly={false}
      />,
    );

    expect(container.querySelectorAll('[data-session-node]')).toHaveLength(4);
    const deepest = container.querySelector('[data-session-node="great-grandchild"]');
    expect(deepest?.closest('[data-session-node="grandchild"]')).not.toBeNull();
  });
});
