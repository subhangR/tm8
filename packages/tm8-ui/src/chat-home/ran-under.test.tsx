// @vitest-environment jsdom
/**
 * EACH ANSWER SAYS WHAT IT RAN UNDER, from its own turn record.
 *
 * A chat's model and mode can both change between any two turns (a mode per
 * turn since 154, a model since 276), so the chat's config describes the NEXT
 * turn, not the ones already on screen. The byline used to print the chat's
 * default mode on every turn and title it "This answer ran in … mode", which
 * was false for any turn sent in another mode and for every message a worker
 * posted into the chat. These pin the replacement: the label is copied from
 * `ChatTurn.ranUnder`, appears only on answers, and draws nothing when the
 * record is absent rather than falling back to the default.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_SWITCHED_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatThreadDetail } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
/* The catalog spells the provider for display; the turn row carries the
   runtime's own id. The label must not depend on the two agreeing. */
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
  { model: 'claude-opus-4-1', label: 'Opus 4.1', provider: 'Anthropic', agentTool: 'claude-code' },
];

afterEach(cleanup);

async function renderTurns(thread: ChatThreadDetail = CHAT_HOME_FIXTURE_SWITCHED_THREAD) {
  const { port } = createChatHomeFixturePort([thread]);
  const view = render(
    <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} routeThreadId={thread.summary.rootId} />,
  );
  await waitFor(() =>
    expect(view.container.querySelectorAll('article.tch-turn')).toHaveLength(thread.turns.length));
  return [...view.container.querySelectorAll('article.tch-turn')];
}

const labelOf = (turn: Element) => {
  const label = turn.querySelector('[data-testid="chat-turn-ran-under"]');
  return label
    ? {
        mode: label.querySelector('.tch-mode-chip')?.textContent,
        model: label.querySelector('.tch-turn__model')?.textContent,
        title: label.getAttribute('title'),
      }
    : null;
};

describe('the per-answer model and mode label', () => {
  it('labels each answer with its own model and mode, not the chat default', async () => {
    const turns = await renderTurns();
    expect(turns.map(labelOf)).toEqual([
      null, // a human turn asks; it did not run under anything
      { mode: 'plan', model: 'Sonnet 4.5', title: 'This answer ran in plan mode on Sonnet 4.5' },
      null,
      /* The fact the old byline got wrong: the chat's default is still Plan on
         Sonnet, and this answer ran in Build on Opus. */
      { mode: 'build', model: 'Opus 4.1', title: 'This answer ran in build mode on Opus 4.1' },
      null, // a worker's report is nobody's answer in this chat
      null, // an answer read from an older server: no record, so no label
    ]);
    expect(turns.map((turn) => turn.getAttribute('data-mode'))).toEqual([null, 'plan', null, 'build', null, null]);
  });

  it('never prints the chat default where the record is missing', async () => {
    const turns = await renderTurns();
    // Two answers carry a record, and exactly two chips are drawn in the
    // transcript. The default (`plan`) is not painted onto the others.
    expect(turns.flatMap((turn) => [...turn.querySelectorAll('.tch-mode-chip')])).toHaveLength(2);
  });

  it('names a model the catalog does not list by its id', async () => {
    const thread = structuredClone(CHAT_HOME_FIXTURE_SWITCHED_THREAD);
    thread.turns[3]!.ranUnder = { model: 'claude-retired-3', provider: 'anthropic', mode: 'build' };
    const turns = await renderTurns(thread);
    expect(labelOf(turns[3]!)).toMatchObject({ mode: 'build', model: 'claude-retired-3' });
  });
});
