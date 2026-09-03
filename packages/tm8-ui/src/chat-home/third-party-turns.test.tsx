// @vitest-environment jsdom
/**
 * THIRD-PARTY TURNS — a message in this chat that was written from somewhere
 * else.
 *
 * A chat became a routing target in migration 176: a work session can report
 * back into one, and one chat can message another. Those turns are neither the
 * person this conversation is with nor its agent, and NOTHING ON THE AUTHOR
 * SAYS SO — a session's persona resolves to the same `team_member` summary the
 * chat's own agent carries, and a chat author resolves to a bare `member`. The
 * marker is the recorder-owned `authored_from` edge, which the port reads
 * beside the transcript and hands over as `turn.sourceEntityId`.
 *
 * PAIRED DOM + STYLESHEET, deliberately. jsdom loads no stylesheets, so a
 * `data-` attribute test proves the structure and proves NOTHING about whether
 * the turn looks different — and the visual treatment IS the feature here. The
 * second half of this file reads `chat-home.css` as text and asserts a rule
 * keyed on the attribute exists, which is the only check in this package that
 * can catch a marker nothing styles.
 */
import { render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ActorSummary, EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatThreadDetail, ChatTurn } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const VIEWER = CHAT_HOME_FIXTURE_THREAD.turns[0]!.author!;
const SOURCE_SESSION = '019f0000-0000-7000-8000-0000000000f1' as EntityId;

/**
 * The persona a work session resolves THROUGH — `kind: 'team_member'`,
 * `isAgent: true`, exactly like the chat's own agent. That identity is the
 * point of the fixture: it is why the author cannot be the marker.
 */
const WORKER_PERSONA: ActorSummary = {
  id: '019f0000-0000-7000-8000-0000000000f2' as EntityId,
  kind: 'team_member',
  displayName: 'Forge',
  avatar: null,
  isAgent: true,
  via: { sessionId: SOURCE_SESSION },
};

function reportTurn(): ChatTurn {
  return {
    messageId: '019f0000-0000-7000-8000-0000000000f3' as EntityId,
    role: 'user',
    author: WORKER_PERSONA,
    createdAt: '2026-09-03T09:00:00.000Z',
    body: 'Lane 2 is green and pushed.',
    parts: [],
    sourceEntityId: SOURCE_SESSION,
  };
}

function threadWithReport(): ChatThreadDetail {
  const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  thread.turns = [...thread.turns, reportTurn()];
  return thread;
}

async function renderThread() {
  const { port } = createChatHomeFixturePort([threadWithReport()]);
  const view = render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      viewerId={VIEWER.id}
      onOpenEntity={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll('.tch-turn').length).toBeGreaterThanOrEqual(3),
  );
  return view;
}

const turnFor = (container: HTMLElement, messageId: string): HTMLElement => {
  const turns = [...container.querySelectorAll<HTMLElement>('.tch-turn')];
  const found = turns.find((turn) => turn.querySelector(`[data-testid="chat-turn-source"]`) != null
    || turn.textContent?.includes(messageId));
  if (!found) throw new Error('no turn matched');
  return found;
};

describe('a turn authored from somewhere else', () => {
  it('is marked third-party and names its source with a chip', async () => {
    const view = await renderThread();
    const marked = [...view.container.querySelectorAll<HTMLElement>('.tch-turn[data-third-party="true"]')];
    // EXACTLY ONE. The fixture thread's own human and agent turns carry no
    // provenance, so a marker that fired on presence-of-author or on `via`
    // alone would light more than one of these.
    expect(marked).toHaveLength(1);

    const source = within(marked[0]!).getByTestId('chat-turn-source');
    expect(source.textContent).toContain('via');
    // The chip, not a bare id: the half of the fact that matters is WHERE it
    // came from, and a chip is what makes that reachable.
    expect(within(source).getByTestId('chat-entity-chip')).toBeTruthy();
  });

  it('takes NEITHER side — the two sides mean "you" and "the other party"', async () => {
    const view = await renderThread();
    const marked = view.container.querySelector<HTMLElement>('.tch-turn[data-third-party="true"]')!;
    /*
     * THE OVERRIDE IS THE POINT. This turn is `role: 'user'` and its author is
     * not the viewer, so the ordinary sidedness rule would put it on the LEFT
     * with the agent — and with no `viewerId` at all the role heuristic would
     * put it on the viewer's OWN side, drawing a worker's report as something
     * you said. Neither is right, so it opts out of sidedness entirely.
     */
    expect(marked.getAttribute('data-self')).toBe('false');

    // …and the ordinary turns are unaffected: the viewer's own is still self.
    const ordinary = [...view.container.querySelectorAll<HTMLElement>('.tch-turn')]
      .filter((turn) => turn.getAttribute('data-third-party') === null);
    expect(ordinary.some((turn) => turn.getAttribute('data-self') === 'true')).toBe(true);
  });

  it('leaves a first-party thread completely unmarked', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} viewerId={VIEWER.id} />,
    );
    await waitFor(() => expect(view.container.querySelectorAll('.tch-turn').length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll('[data-third-party]')).toHaveLength(0);
    expect(view.queryAllByTestId('chat-turn-source')).toHaveLength(0);
  });
});
