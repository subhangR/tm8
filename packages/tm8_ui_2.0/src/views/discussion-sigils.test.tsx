// @vitest-environment jsdom
/**
 * WAVE 3 — THE DISCUSSION COMPOSER'S SIGILS.
 *
 * `discussionSurfaceFor` never passed `mentionOptions`/`skillOptions`, so `@`
 * and `/` typed as plain text in every panel Discussion composer while the
 * input advertised both. The composer now self-loads its trigger subjects
 * through the `channelFeedPort` every host bundle already carries.
 *
 * `DiscussionSurface` is stubbed at the module seam: what this file pins is
 * the WRAPPER's contract — what it loads, what it maps, and what it hands the
 * surface — not the feed stack underneath (ChannelScreen's own suites hold
 * the composer's behaviour once options arrive).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { EntityDetail, EntityId } from '@tm8/contract';
import type { ComposerMentionOption } from '../channel-screen/channel-tags';
import { fixtureDetails, taskUuidTitle } from '../fixtures';

/* Captured per render — the stub's whole job. */
const captured: Array<Record<string, unknown>> = [];
vi.mock('../channel-screen/DiscussionSurface', () => ({
  DiscussionSurface: (props: Record<string, unknown>) => {
    captured.push(props);
    return <div data-testid="discussion-stub" />;
  },
}));

// Imported AFTER the mock so the wrapper composes the stub.
import {
  discussionMentionOptions,
  discussionSurfaceFor,
  type ConversationSurfaceHost,
} from './conversationSurface';

afterEach(() => {
  cleanup();
  captured.length = 0;
});

const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

const member: ComposerMentionOption = {
  id: 'member-ada' as EntityId,
  kind: 'member',
  display: 'Ada',
  group: 'People',
  meta: 'Mention in this message',
};
const routedTeammate: ComposerMentionOption = {
  id: 'tm-forge' as EntityId,
  kind: 'team_member',
  display: 'Forge',
  group: 'Team members',
  meta: 'Start a work session when sent',
  route: { kind: 'spawn-team-member', teamMemberId: 'tm-forge' as EntityId },
};
const routedSession: ComposerMentionOption = {
  id: 'ws-1' as EntityId,
  kind: 'work_session',
  display: 'forge · run',
  group: 'Work sessions',
  meta: 'Live · message this session',
  route: { kind: 'existing-session', sessionId: 'ws-1' as EntityId },
};

describe('discussionMentionOptions — durable mentions only', () => {
  it('keeps members, strips teammate routes, drops session targets', () => {
    const mapped = discussionMentionOptions([member, routedTeammate, routedSession]);
    // The member rides through verbatim.
    expect(mapped[0]).toEqual(member);
    // The teammate survives as a plain durable mention — the DB validates
    // mentionIds to member|team_member, so the form is real — but its route
    // (and the spawn it promises) is gone: the Discussion post path forwards
    // mentionIds and DROPS tagTargetIds, so a kept route would promise a
    // spawn and store a plain message.
    expect(mapped[1]).toEqual({
      id: routedTeammate.id,
      kind: 'team_member',
      display: 'Forge',
      group: 'Team members',
      meta: 'Mention in this message',
    });
    // A session has no durable-mention form at all.
    expect(mapped).toHaveLength(2);
  });
});

/** One summary-ish row, as the loaders read them (id/title/state only). */
function summary(id: string, title: string, state: Record<string, unknown>) {
  return { id, title, state } as unknown as import('@tm8/contract').EntitySummary;
}

function stubHost(): ConversationSurfaceHost {
  const query = vi.fn(async (input: { kinds?: readonly string[] }) => {
    const kinds = input.kinds ?? [];
    if (kinds.includes('skill')) {
      return {
        page: {
          items: [summary('skill-1', 'triage', { kind: 'skill', description: 'sort the inbox' })],
          nextCursor: null,
        },
      };
    }
    if (kinds.includes('member')) {
      return {
        page: {
          items: [
            summary('member-ada', 'Ada', { kind: 'member' }),
            summary('tm-forge', 'Forge', { kind: 'team_member' }),
          ],
          nextCursor: null,
        },
      };
    }
    // The sessions page the tag loader always asks for.
    return {
      page: {
        items: [summary('ws-1', 'forge · run', { kind: 'work_session', status: 'running' })],
        nextCursor: null,
      },
    };
  });
  const port = {
    seam: { query, entity: vi.fn() },
    spaceId: 'space-1',
    liveIds: [],
    postMessage: vi.fn(),
    spawn: vi.fn(),
    projects: [],
  };
  return {
    seam: {} ,
    spaceId: 'space-1',
    connection: 'live',
    livenessOf: () => 'unknown',
    channelFeedPort: port,
    viewerMemberId: 'member-ada',
    onOpenEntity: vi.fn(),
    onSwitchToTerminal: vi.fn(),
  } as unknown as ConversationSurfaceHost;
}

describe('discussionSurfaceFor — the sigils reach the composer', () => {
  it('starts NOT-ESTABLISHED (sigils type plain text), then threads both option sets', async () => {
    const host = stubHost();
    render(<>{discussionSurfaceFor(TASK, TASK.id, host)}</>);

    // Before any read answers, neither prop is passed — `undefined` is the
    // capability-absent posture, exactly `useChannelFeed`'s semantics.
    expect(captured[0]?.mentionOptions).toBeUndefined();
    expect(captured[0]?.skillOptions).toBeUndefined();

    await waitFor(() => {
      const last = captured.at(-1)!;
      expect(last.mentionOptions).toBeDefined();
      expect(last.skillOptions).toBeDefined();
    });

    const last = captured.at(-1)!;
    // Mapped: the member and the route-stripped teammate; the session dropped.
    expect(last.mentionOptions).toEqual([
      { id: 'member-ada', kind: 'member', display: 'Ada', group: 'People', meta: 'Mention in this message' },
      { id: 'tm-forge', kind: 'team_member', display: 'Forge', group: 'Team members', meta: 'Mention in this message' },
    ]);
    expect(last.skillOptions).toEqual([
      { id: 'skill-1', display: 'triage', meta: 'sort the inbox' },
    ]);
    // No per-session detail reads were spent: routes are stripped anyway.
    const port = host.channelFeedPort;
    expect(port.seam.entity).not.toHaveBeenCalled();
  });

  it('a failed skills read stays NOT-ESTABLISHED; a failed mention read is a measured zero', async () => {
    const host = stubHost();
    (host.channelFeedPort.seam.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('node unreachable'),
    );
    render(<>{discussionSurfaceFor(TASK, TASK.id, host)}</>);

    await waitFor(() => {
      expect(captured.at(-1)?.mentionOptions).toEqual([]);
    });
    // `[]` keeps the `@` control able to say "no options"; skills stay
    // undefined — a failed read measured nothing, and `/` types plain text
    // rather than reporting "No matching skills" about an outage.
    expect(captured.at(-1)?.skillOptions).toBeUndefined();
  });
});
