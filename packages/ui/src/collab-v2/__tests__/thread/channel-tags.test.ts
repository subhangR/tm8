import { describe, expect, it, vi } from 'vitest';
import {
  assertChannelTagLimits,
  buildChannelTagPlan,
  dispatchTaggedChannelMessage,
  mentionsForTaggedDraft,
  tagIdsFromMarkup,
  type ChannelTagTarget,
} from '../../subsystems/thread/tags';

const targets: ChannelTagTarget[] = [
  {
    id: 'tm-forge',
    display: 'Forge',
    group: 'Team members',
    meta: 'message running session',
    route: { kind: 'existing-session', sessionId: 'ws-forge' },
    mention: { entityId: 'tm-forge', kind: 'team_member', display: 'Forge' },
  },
  {
    id: 'tm-scout',
    display: 'Scout',
    group: 'Team members',
    meta: 'starts a session when sent',
    route: { kind: 'spawn-team-member', teamMemberId: 'tm-scout' },
    mention: { entityId: 'tm-scout', kind: 'team_member', display: 'Scout' },
  },
  {
    id: 'ws-review',
    display: 'Review session',
    group: 'Work sessions',
    meta: 'running · Forge',
    route: { kind: 'existing-session', sessionId: 'ws-review' },
  },
];

describe('Channel @Tag selection', () => {
  it('derives current selections from markup, so removing a token removes its route', () => {
    const markup = '@[Forge](tm-forge) please pair with @[Review session](ws-review)';
    expect(tagIdsFromMarkup(markup, targets)).toEqual(['tm-forge', 'ws-review']);
    expect(tagIdsFromMarkup('@[Forge](tm-forge) only', targets)).toEqual(['tm-forge']);
  });

  it('ignores ordinary mentions and de-duplicates a repeated target', () => {
    const markup = '@[Mira](member-mira) @[Forge](tm-forge) @[Forge](tm-forge)';
    expect(tagIdsFromMarkup(markup, targets)).toEqual(['tm-forge']);
  });

  it('keeps human/teammate mentions but removes the synthetic work-session mention', () => {
    expect(mentionsForTaggedDraft([
      { entityId: 'member-mira', kind: 'member', display: 'Mira' },
      { entityId: 'tm-forge', kind: 'team_member', display: 'Forge stale label' },
      // react-mentions parses this editor token before routing identifies it as
      // a session. Its temporary kind must never cross the wire.
      { entityId: 'ws-review', kind: 'member', display: 'Review session' },
    ], ['tm-forge', 'ws-review'], targets)).toEqual([
      { entityId: 'member-mira', kind: 'member', display: 'Mira' },
      { entityId: 'tm-forge', kind: 'team_member', display: 'Forge' },
    ]);
  });

  it('plans existing-session messages separately from teammate spawns', () => {
    expect(buildChannelTagPlan(['tm-forge', 'tm-scout', 'ws-review'], targets)).toEqual({
      existingSessionIds: ['ws-forge', 'ws-review'],
      spawnTeamMemberIds: ['tm-scout'],
      mentionIds: ['tm-forge', 'tm-scout'],
    });
  });

  it('refuses server-limit violations before any spawn can happen', () => {
    expect(() => assertChannelTagLimits({
      plan: {
        existingSessionIds: Array.from({ length: 15 }, (_, index) => `ws-${index}`),
        spawnTeamMemberIds: ['tm-over'],
        mentionIds: [],
      },
    })).toThrow(/at most 15 session targets/i);

    expect(() => assertChannelTagLimits({
      plan: { existingSessionIds: ['ws-1', 'ws-2', 'ws-3', 'ws-4'], spawnTeamMemberIds: [], mentionIds: [] },
      attachmentIds: Array.from({ length: 13 }, (_, index) => `file-${index}`),
    })).toThrow(/more than 64 message-file copies/i);
  });
});

describe('Channel @Tag routing', () => {
  it('reuses live targets, spawns missing teammates, then posts one channel+sessions batch', async () => {
    const spawnTeamMember = vi.fn(async (id: string) => `spawned-${id}`);
    const post = vi.fn(async () => undefined);

    const result = await dispatchTaggedChannelMessage({
      channelId: 'channel-design',
      body: '@Forge and @Scout please review',
      selectedTagIds: ['tm-forge', 'tm-scout', 'ws-review'],
      candidates: targets,
      mentionIds: ['member-mira'],
      attachmentIds: ['file-plan'],
    }, { spawnTeamMember, post });

    expect(spawnTeamMember).toHaveBeenCalledTimes(1);
    expect(spawnTeamMember).toHaveBeenCalledWith('tm-scout');
    expect(post).toHaveBeenCalledWith({
      anchorIds: ['channel-design', 'ws-forge', 'ws-review', 'spawned-tm-scout'],
      body: '@Forge and @Scout please review',
      mentionIds: ['member-mira', 'tm-forge', 'tm-scout'],
      attachmentIds: ['file-plan'],
    });
    expect(result).toEqual({
      anchorIds: ['channel-design', 'ws-forge', 'ws-review', 'spawned-tm-scout'],
      spawnedSessionIds: ['spawned-tm-scout'],
    });
  });

  it('does not spawn when every target already has a session', async () => {
    const spawnTeamMember = vi.fn(async () => 'unreachable');
    const post = vi.fn(async () => undefined);
    await dispatchTaggedChannelMessage({
      channelId: 'channel-design',
      body: '@Forge check this',
      selectedTagIds: ['tm-forge'],
      candidates: targets,
    }, { spawnTeamMember, post });
    expect(spawnTeamMember).not.toHaveBeenCalled();
    expect(post.mock.calls[0]?.[0].anchorIds).toEqual(['channel-design', 'ws-forge']);
  });
});
