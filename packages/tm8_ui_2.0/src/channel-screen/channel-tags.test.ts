import { describe, expect, it, vi } from 'vitest';
import type { CollectionQuery, CollectionResult, EntityDetail, EntitySummary } from '@tm8/contract';
import {
  dispatchTaggedChannelMessage,
  loadChannelAttachOptions,
  loadChannelTagOptions,
} from './channel-tags';

function row(id: string, kind: 'member' | 'team_member' | 'work_session', title: string): EntitySummary {
  const state = kind === 'member'
    ? { kind, role: 'member', score: 0, taskDoneCount: 0 }
    : kind === 'team_member'
      ? { kind, owner: { id: 'owner', displayName: 'Owner', isAgent: false }, liveWork: null }
      : {
          kind,
          status: id === 'ws-stale' ? 'exited' : 'running',
          agentTool: 'codex',
          model: null,
          shareMode: 'none',
          startedAt: null,
          exitedAt: null,
        };
  return { id, kind, title, state } as unknown as EntitySummary;
}

function collection(query: CollectionQuery, items: EntitySummary[]): CollectionResult {
  return { query, page: { items, nextCursor: null } };
}

describe('Channel @Tag discovery and routing', () => {
  it('offers members, teammates, and sessions while reusing only authoritatively live teammate sessions', async () => {
    const member = row('member-noor', 'member', 'Noor');
    const forge = row('team-forge', 'team_member', 'Forge');
    const scout = row('team-scout', 'team_member', 'Scout');
    const live = row('ws-live', 'work_session', 'Forge live');
    const stale = row('ws-stale', 'work_session', 'Old review');
    const port = {
      query: vi.fn(async (query: CollectionQuery) => collection(
        query,
        query.kinds?.includes('work_session') ? [live, stale] : [member, forge, scout],
      )),
      entity: vi.fn(async () => ({
        ...live,
        connections: {
          outgoing: [{
            type: 'relates_to',
            direction: 'outgoing',
            label: 'teammate',
            edges: [{ type: 'relates_to', target: forge }],
          }],
          incoming: [],
          unresolvedHardDependencyCount: 0,
        },
      } as unknown as EntityDetail)),
    };

    const options = await loadChannelTagOptions({
      port,
      spaceId: 'space-1',
      liveSessionIds: ['ws-live'],
    });

    expect(options.find((option) => option.id === 'member-noor')?.route).toBeUndefined();
    expect(options.find((option) => option.id === 'team-forge')?.route).toEqual({
      kind: 'existing-session',
      sessionId: 'ws-live',
    });
    expect(options.find((option) => option.id === 'team-scout')?.route).toEqual({
      kind: 'spawn-team-member',
      teamMemberId: 'team-scout',
    });
    expect(options.find((option) => option.id === 'ws-stale')?.meta).toMatch(/stores without waking/i);
    expect(port.entity).toHaveBeenCalledTimes(1);
  });

  it('posts once to the channel, reused sessions, and newly spawned teammate session', async () => {
    const candidates = [
      {
        id: 'team-forge', kind: 'team_member' as const, display: 'Forge',
        route: { kind: 'existing-session' as const, sessionId: 'ws-forge' },
      },
      {
        id: 'team-scout', kind: 'team_member' as const, display: 'Scout',
        route: { kind: 'spawn-team-member' as const, teamMemberId: 'team-scout' },
      },
      {
        id: 'ws-review', kind: 'work_session' as const, display: 'Review',
        route: { kind: 'existing-session' as const, sessionId: 'ws-review' },
      },
    ];
    const spawnTeamMember = vi.fn(async () => 'ws-scout');
    const post = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchTaggedChannelMessage({
      channelId: 'channel-1',
      body: '@Forge @Scout @Review check this',
      parentMessageId: null,
      selectedTagIds: ['team-forge', 'team-scout', 'ws-review'],
      candidates,
      mentionIds: ['member-noor'],
      attachmentIds: ['file-1'],
      spawnTeamMember,
      post,
    });

    expect(spawnTeamMember).toHaveBeenCalledWith('team-scout');
    expect(post).toHaveBeenCalledWith({
      anchorIds: ['channel-1', 'ws-forge', 'ws-review', 'ws-scout'],
      conversationAnchorId: 'channel-1',
      body: '@Forge @Scout @Review check this',
      parentMessageId: null,
      mentionIds: ['member-noor', 'team-forge', 'team-scout'],
      attachmentIds: ['file-1'],
    });
    expect(result.spawnedSessionIds).toEqual(['ws-scout']);
  });

  it('merges attached workspace entities into the batch anchors, after the channel', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    await dispatchTaggedChannelMessage({
      channelId: 'channel-1',
      body: '@Review with the task attached',
      parentMessageId: null,
      selectedTagIds: ['ws-review'],
      candidates: [{
        id: 'ws-review', kind: 'work_session', display: 'Review',
        route: { kind: 'existing-session', sessionId: 'ws-review' },
      }],
      // The channel id and a duplicate are dropped — anchors stay unique.
      extraAnchorIds: ['task-114', 'channel-1', 'task-114'],
      spawnTeamMember: vi.fn(async () => 'unused'),
      post,
    });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      anchorIds: ['channel-1', 'task-114', 'ws-review'],
    }));
  });

  it('offers tasks and docs as anchor attachments, and people as mention-only references', async () => {
    const task = {
      id: 'task-114', kind: 'task', title: 'Align the rail',
      state: { kind: 'task', status: 'in_progress' },
    } as unknown as EntitySummary;
    const doc = {
      id: 'doc-layout', kind: 'doc', title: 'Layout spec',
      state: { kind: 'doc', format: 'markdown' },
    } as unknown as EntitySummary;
    const port = {
      query: vi.fn(async (query: CollectionQuery) => collection(query, [task, doc])),
    };

    const options = await loadChannelAttachOptions({
      port,
      spaceId: 'space-1',
      mentionOptions: [
        { id: 'member-noor', kind: 'member', display: 'Noor' },
        {
          id: 'team-forge', kind: 'team_member', display: 'Forge',
          route: { kind: 'existing-session', sessionId: 'ws-forge' },
        },
        {
          id: 'ws-review', kind: 'work_session', display: 'Review',
          route: { kind: 'existing-session', sessionId: 'ws-review' },
        },
      ],
    });

    expect(port.query).toHaveBeenCalledWith(expect.objectContaining({ kinds: ['task', 'doc'] }));
    expect(options.find((option) => option.id === 'task-114')?.attach).toBe('anchor');
    expect(options.find((option) => option.id === 'doc-layout')?.attach).toBe('anchor');
    // People come through as references with their session routes STRIPPED —
    // attaching a teammate must never spawn or message a session.
    expect(options.find((option) => option.id === 'team-forge')?.route).toBeUndefined();
    expect(options.find((option) => option.id === 'member-noor')?.attach).toBeUndefined();
    // Sessions stay the @ picker's business entirely.
    expect(options.find((option) => option.id === 'ws-review')).toBeUndefined();
  });

  it('refuses reply routing before a teammate is spawned', async () => {
    const spawnTeamMember = vi.fn(async () => 'ws-new');
    const post = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchTaggedChannelMessage({
      channelId: 'channel-1',
      body: '@Scout reply',
      parentMessageId: 'message-1',
      selectedTagIds: ['team-scout'],
      candidates: [{
        id: 'team-scout', kind: 'team_member', display: 'Scout',
        route: { kind: 'spawn-team-member', teamMemberId: 'team-scout' },
      }],
      spawnTeamMember,
      post,
    })).rejects.toThrow(/top-level/i);
    expect(spawnTeamMember).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
