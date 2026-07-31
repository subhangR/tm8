import { describe, expect, it, vi } from 'vitest';
import type { CollectionQuery, EntityDetail, EntitySummary } from '../../collab-v2/types/contract';
import { createChannelTagCommandPort, loadChannelTagTargets } from '../channelTags';
import { RealFacade } from '../RealFacade';
import { TmClient } from '../TmClient';

const base = (id: string, kind: string, title: string): EntitySummary => ({
  id,
  spaceId: 'space-1',
  kind: kind as EntitySummary['kind'],
  title,
  parentId: null,
  position: 0,
  visibility: 'space',
  version: 1,
  activityAt: '2026-07-30T10:00:00.000Z',
  createdAt: '2026-07-30T09:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
  deletedAt: null,
  createdBy: { id: 'member-1', kind: 'member', displayName: 'Mira', isAgent: false },
  counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
  badges: {},
});

const teammate = (id: string, title: string) => ({
  ...base(id, 'team_member', title),
  state: {
    kind: 'team_member' as const,
    owner: { id: 'member-1', kind: 'member' as const, displayName: 'Mira', isAgent: false },
  },
});

const session = (id: string, title: string, status: string) => ({
  ...base(id, 'work_session', title),
  state: { kind: 'work_session', status, agentTool: 'codex', model: 'gpt-5' } as never,
});

function detailWithAgent(row: EntitySummary, agent: EntitySummary): EntityDetail {
  return {
    ...row,
    content: { kind: 'doc', body: '', format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: {
      outgoing: [{
        type: 'relates_to', direction: 'outgoing', label: 'Related', nextCursor: null as never,
        edges: [{
          id: `edge-${row.id}`,
          type: 'relates_to',
          source: row,
          target: agent,
          props: {},
          createdBy: row.createdBy,
          createdAt: row.createdAt,
        }],
      }],
      incoming: [],
      unresolvedHardDependencyCount: 0,
    },
    capabilities: {
      canEdit: false, canDelete: false, canAddChild: false, canLink: false,
      canPull: false, canReact: false, canGrantPoints: false, canComplete: false,
    },
  };
}

describe('real Channel @Tag targets', () => {
  it('offers team members and sessions, reusing only a teammate live session', async () => {
    const forge = teammate('tm-forge', 'Forge');
    const scout = teammate('tm-scout', 'Scout');
    const running = session('ws-live', 'Forge · current', 'running');
    const exited = session('ws-old', 'Scout · old', 'exited');
    const queryCollection = vi.fn(async (query: CollectionQuery) => ({
      query,
      page: {
        items: String(query.kinds?.[0]) === 'team_member' ? [forge, scout] : [running, exited],
        nextCursor: null,
      },
    }));
    const getEntity = vi.fn(async () => detailWithAgent(running, forge));

    const targets = await loadChannelTagTargets({ queryCollection, getEntity }, 'space-1');
    expect(targets.map((target) => [target.id, target.route.kind])).toEqual([
      ['tm-forge', 'existing-session'],
      ['tm-scout', 'spawn-team-member'],
      ['ws-live', 'existing-session'],
      ['ws-old', 'existing-session'],
    ]);
    expect(targets[0]?.meta).toMatch(/message Forge · current/i);
    expect(targets[1]?.meta).toMatch(/starts a session/i);
    expect(targets[2]?.meta).toMatch(/running · Forge/i);
    expect(targets[3]?.meta).toBe('exited');
    // Finished sessions never need an enrichment read to decide spawn reuse.
    expect(getEntity).toHaveBeenCalledTimes(1);
    expect(getEntity).toHaveBeenCalledWith('ws-live');
  });

  it('degrades a failed live-session enrichment to an explicit teammate spawn', async () => {
    const forge = teammate('tm-forge', 'Forge');
    const running = session('ws-live', 'Forge · current', 'running');
    const queryCollection = vi.fn(async (query: CollectionQuery) => ({
      query,
      page: { items: String(query.kinds?.[0]) === 'team_member' ? [forge] : [running], nextCursor: null },
    }));
    const getEntity = vi.fn(async () => { throw new Error('detail unavailable'); });
    const targets = await loadChannelTagTargets({ queryCollection, getEntity }, 'space-1');
    expect(targets[0]?.route).toEqual({ kind: 'spawn-team-member', teamMemberId: 'tm-forge' });
  });
});

describe('real Channel @Tag command port', () => {
  it('uses an already linked trusted project and returns the spawned session', async () => {
    const project = { id: 'project-1', name: 'tm8', trust: 'trusted' as const };
    const facade = {
      listProjects: vi.fn(async () => [project]),
      linkProject: vi.fn(async () => undefined),
      spawnSession: vi.fn(async () => ({ entity: { id: 'ws-new' }, patches: [] })),
      queryCollection: vi.fn(),
      promptSession: vi.fn(),
      terminateSession: vi.fn(),
      createProject: vi.fn(),
      createSpace: vi.fn(),
    } as never;
    const postBatch = vi.fn(async () => undefined);
    const port = createChannelTagCommandPort(facade, 'space-1', { postBatch });

    await expect(port.spawnTeamMember('tm-scout')).resolves.toBe('ws-new');
    expect(facade.listProjects).toHaveBeenCalledWith('space-1');
    expect(facade.linkProject).not.toHaveBeenCalled();
    expect(facade.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-1', projectId: 'project-1', teamMemberId: 'tm-scout', taskIds: [],
    }));
  });

  it('links a node-trusted project when the Space has none', async () => {
    const project = { id: 'project-2', name: 'shared', trust: 'trusted' as const };
    const listProjects = vi.fn(async (spaceId?: string) => spaceId ? [] : [project]);
    const facade = {
      listProjects,
      linkProject: vi.fn(async () => undefined),
      spawnSession: vi.fn(async () => ({ entity: { id: 'ws-new' }, patches: [] })),
      queryCollection: vi.fn(),
      promptSession: vi.fn(),
      terminateSession: vi.fn(),
      createProject: vi.fn(),
      createSpace: vi.fn(),
    } as never;
    const port = createChannelTagCommandPort(facade, 'space-1', { postBatch: vi.fn() });
    await port.spawnTeamMember('tm-scout');
    expect(facade.linkProject).toHaveBeenCalledWith('space-1', 'project-2');
  });
});

describe('real Channel @Tag batch writer', () => {
  it('posts every resolved anchor through the canonical message DTO', async () => {
    const client = new TmClient();
    const post = vi.spyOn(client, 'post').mockResolvedValue({
      messageBatchId: 'batch-1',
      messages: [],
    });
    const facade = new RealFacade(client);

    await facade.postMessageBatch({
      anchorIds: ['channel-1', 'session-1', 'session-2'],
      body: 'please investigate',
      mentionIds: ['teammate-1'],
      attachmentIds: ['file-1'],
      clientMutationId: 'channel-tag-message-1',
    });

    expect(post).toHaveBeenCalledWith('/v2/messages', {
      clientMutationId: 'channel-tag-message-1',
      anchorIds: ['channel-1', 'session-1', 'session-2'],
      body: 'please investigate',
      mentionIds: ['teammate-1'],
      attachmentIds: ['file-1'],
    });
  });
});
