// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ActorSummary, EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatThreadDetail, ChatTurn } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

/** The fixture thread's human — the signed-in viewer in these tests. */
const VIEWER = CHAT_HOME_FIXTURE_THREAD.turns[0]!.author!;

/** A DIFFERENT human in the same thread. Their turn is also `role: 'user'`,
 *  which is exactly why role alone cannot decide sidedness. */
const OTHER_HUMAN: ActorSummary = {
  id: '019f0000-0000-7000-8000-0000000000e1',
  kind: 'member',
  displayName: 'Priya',
  avatar: null,
  isAgent: false,
};

function turnBy(author: ActorSummary | null, role: 'user' | 'assistant', suffix: string): ChatTurn {
  return {
    messageId: `019f0000-0000-7000-8000-0000000000${suffix}` as EntityId,
    role,
    author,
    createdAt: '2026-08-13T09:00:00.000Z',
    body: `Message from ${author?.displayName ?? 'nobody'} (${suffix}).`,
    parts: [],
  };
}

function sharedThread(): ChatThreadDetail {
  const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  thread.turns = [
    ...thread.turns, // viewer-authored user turn + agent turn from the fixture
    turnBy(OTHER_HUMAN, 'user', 'b1'),
    turnBy(null, 'user', 'b2'), // optimistic local echo: no author yet
  ];
  return thread;
}

async function renderThread(viewerId?: string) {
  const { port } = createChatHomeFixturePort([sharedThread()]);
  const view = render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      {...(viewerId === undefined ? {} : { viewerId })}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll('.tch-turn').length).toBeGreaterThanOrEqual(4),
  );
  return [...view.container.querySelectorAll('.tch-turn')];
}

describe('chat byline sidedness', () => {
  it('marks only the viewer-authored turn as self; other humans and agents are other', async () => {
    const [viewerTurn, agentTurn, otherHumanTurn] = await renderThread(VIEWER.id);
    expect(viewerTurn!.getAttribute('data-self')).toBe('true');
    expect(agentTurn!.getAttribute('data-self')).toBe('false');
    // The trap this feature exists to avoid: another human is also
    // `role: 'user'`, but they are NOT the viewer.
    expect(otherHumanTurn!.getAttribute('data-role')).toBe('user');
    expect(otherHumanTurn!.getAttribute('data-self')).toBe('false');
  });

  it('treats a null-author user turn as self (optimistic echo — no left→right flip)', async () => {
    const turns = await renderThread(VIEWER.id);
    const echo = turns[3]!;
    expect(echo.getAttribute('data-role')).toBe('user');
    expect(echo.getAttribute('data-self')).toBe('true');
  });

  it('falls back to the role heuristic without throwing when viewerId is missing', async () => {
    const turns = await renderThread(undefined);
    expect(turns.map((t) => t.getAttribute('data-self'))).toEqual([
      'true', // viewer's user turn — role fallback
      'false', // agent turn
      'true', // other human degrades to role heuristic; identity is unknowable here
      'true', // null-author user turn
    ]);
  });

  it('keeps DOM order identical on both sides — sidedness is purely visual', async () => {
    // Viewer vs ANOTHER HUMAN: identical role and provenance, only authorship
    // (and therefore side) differs — so any structural difference between the
    // two bylines could only come from the sidedness change itself.
    const turns = await renderThread(VIEWER.id);
    const [viewerTurn, otherHumanTurn] = [turns[0]!, turns[2]!];
    expect(viewerTurn.getAttribute('data-self')).toBe('true');
    expect(otherHumanTurn.getAttribute('data-self')).toBe('false');
    const shape = (turn: Element) =>
      [...turn.querySelector('.tch-turn__byline')!.children].map(
        (child) =>
          // The avatar's tone class is a hash of the actor id — per-actor by
          // design, not a sidedness artefact — so it is excluded from the shape.
          `${child.tagName.toLowerCase()}.${child.className.replace(/kit-avatar--tone-\d+\s*/, '')}`,
      );
    // Same children, same order: screen-reader and tab order cannot differ.
    // `row-reverse` would pass a visual check and fail this one.
    expect(shape(otherHumanTurn)).toEqual(shape(viewerTurn));
  });

  it('renders identical tch-parts markup in both variants', async () => {
    const parts = CHAT_HOME_FIXTURE_THREAD.turns[1]!.parts;
    const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
    thread.turns = [
      { ...turnBy(VIEWER, 'user', 'c1'), body: 'same body', parts: structuredClone(parts) },
      { ...turnBy(OTHER_HUMAN, 'user', 'c2'), body: 'same body', parts: structuredClone(parts) },
    ];
    const { port } = createChatHomeFixturePort([thread]);
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} viewerId={VIEWER.id} />,
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll('.tch-turn').length).toBe(2),
    );
    const [self, other] = [...view.container.querySelectorAll('.tch-turn')];
    expect(self!.getAttribute('data-self')).toBe('true');
    expect(other!.getAttribute('data-self')).toBe('false');
    expect(other!.querySelector('.tch-parts')!.innerHTML).toBe(
      self!.querySelector('.tch-parts')!.innerHTML,
    );
  });
});
