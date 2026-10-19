// @vitest-environment jsdom
/**
 * A NEW CHAT STARTS ON THE LAST MODE, MODEL AND EFFORT THE VIEWER CHOSE.
 *
 * Reported by Subhang: once a mode and model were set in a chat, the next new
 * chat reset to `ask` and the first-listed model. The picks are now remembered
 * per Space and viewer (`chat-defaults/lastUsed` `lastComposerPicks`), from a
 * new chat AND from a switch on a running one, and survive a reload. A host's
 * seed and a pick on the new chat itself still win; a model the catalog no
 * longer lists is never offered back.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-0000000000c1';
const OTHER_SPACE = '019f0000-0000-7000-8000-0000000000c2';
const FIXTURE_CHAT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
  { model: 'claude-opus-4-1', label: 'Opus 4.1', provider: 'Anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const modeOf = (view: ReturnType<typeof render>) =>
  view.getByTestId('tch-settings-role').getAttribute('data-mode');
const modelOf = (view: ReturnType<typeof render>) => view.getByTestId('tch-model').textContent ?? '';

function pickWorker(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByTestId('tch-settings'));
  fireEvent.click(view.getByTestId('tch-settings-worker'));
}

function pickOpus(view: ReturnType<typeof render>, effort?: 'max') {
  fireEvent.click(view.getByLabelText('Chat model'));
  fireEvent.click(view.getByTestId('tch-model-claude-opus-4-1'));
  if (effort) {
    /* The popover stays open after a model pick when effort lives in it. */
    if (!view.queryByTestId(`tch-model-effort-${effort}`)) fireEvent.click(view.getByLabelText('Chat model'));
    fireEvent.click(view.getByTestId(`tch-model-effort-${effort}`));
  }
}

async function newChat(port: ChatHomePort, props: Partial<Parameters<typeof ChatHomeScreen>[0]> = {}) {
  const view = render(
    <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} coldStart="composer" {...props} />,
  );
  await waitFor(() => view.getByLabelText('Message the chat agent'));
  return view;
}

describe('a new chat starts on the last chosen mode and model', () => {
  it('starts with the built-in defaults when nothing was ever chosen', async () => {
    const { port } = createChatHomeFixturePort();
    const view = await newChat(port);
    expect(modeOf(view)).toBe('ask');
    expect(modelOf(view)).toContain('Sonnet 4.5');
  });

  it('picks made on a new chat are the next chat’s defaults, after a reload, and are what it starts with', async () => {
    const { port } = createChatHomeFixturePort();
    const first = await newChat(port);
    pickWorker(first);
    pickOpus(first);
    first.unmount();

    const { port: again, controls } = createChatHomeFixturePort();
    const view = await newChat(again);
    expect(modeOf(view)).toBe('build');
    expect(modelOf(view)).toContain('Opus 4.1');

    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Go.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ mode: 'build', model: 'claude-opus-4-1' });
  });

  it('a switch on a RUNNING chat is the next new chat’s default too, without a reload', async () => {
    const { port } = createChatHomeFixturePort();
    function Host() {
      const [threadId, setThreadId] = useState<EntityId | null>(FIXTURE_CHAT as EntityId);
      return (
        <>
          <button type="button" onClick={() => setThreadId(null)}>Host new conversation</button>
          <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} soloConversation
            routeThreadId={threadId} onSelectionChange={setThreadId} />
        </>
      );
    }
    const view = render(<Host />);
    await waitFor(() => expect(modeOf(view)).toBe('plan'));
    pickWorker(view);
    pickOpus(view);
    await waitFor(() => expect(modelOf(view)).toContain('Opus 4.1'));

    fireEvent.click(view.getByRole('button', { name: 'Host new conversation' }));
    await waitFor(() => expect(view.queryByText(/Plan the launch sequence/)).toBeNull());
    expect(modeOf(view)).toBe('build');
    expect(modelOf(view)).toContain('Opus 4.1');
    view.unmount();

    const reloaded = await newChat(createChatHomeFixturePort().port);
    expect(modeOf(reloaded)).toBe('build');
    expect(modelOf(reloaded)).toContain('Opus 4.1');
  });

  it('remembers the reasoning effort picked in the same control', async () => {
    const first = await newChat(createChatHomeFixturePort().port);
    pickOpus(first, 'max');
    first.unmount();

    const view = await newChat(createChatHomeFixturePort().port);
    fireEvent.click(view.getByLabelText('Chat model'));
    expect(view.getByTestId('tch-model-effort-now').textContent).toBe('Max');
  });

  it('a host seed still wins over the remembered picks', async () => {
    const first = await newChat(createChatHomeFixturePort().port);
    pickWorker(first);
    pickOpus(first);
    first.unmount();

    const view = await newChat(createChatHomeFixturePort().port, {
      newChatSeed: { mode: 'plan', model: 'claude-sonnet-4-5' },
    });
    expect(modeOf(view)).toBe('plan');
    expect(modelOf(view)).toContain('Sonnet 4.5');
  });

  it('is kept per Space', async () => {
    const first = await newChat(createChatHomeFixturePort().port);
    pickWorker(first);
    pickOpus(first);
    first.unmount();

    const view = await newChat(createChatHomeFixturePort().port, { spaceId: OTHER_SPACE });
    expect(modeOf(view)).toBe('ask');
    expect(modelOf(view)).toContain('Sonnet 4.5');
  });

  it('falls back to the first listed model when the remembered one is no longer offered', async () => {
    const first = await newChat(createChatHomeFixturePort().port);
    pickOpus(first);
    first.unmount();

    const view = await newChat(createChatHomeFixturePort().port, { models: [MODELS[0]!] });
    expect(modelOf(view)).toContain('Sonnet 4.5');
  });

  it('a host-pinned mode (Craft) neither reads nor writes the picks', async () => {
    const first = await newChat(createChatHomeFixturePort().port, { pinnedMode: 'craft' });
    pickOpus(first);
    first.unmount();

    const view = await newChat(createChatHomeFixturePort().port);
    expect(modelOf(view)).toContain('Sonnet 4.5');
  });
});
