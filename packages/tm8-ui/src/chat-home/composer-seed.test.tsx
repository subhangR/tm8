// @vitest-environment jsdom
/**
 * THE HOST HOOKS CRAFT ADDED TO THE SHARED CHAT SURFACE — and that every
 * other host is untouched by them (coordinator: "minimal and additive, test
 * that Home/Channel chats are unaffected").
 *
 *  · `composerSeed` appends to the CURRENT draft once per nonce, never
 *    replacing what the viewer typed; absent, the composer is exactly as before.
 *  · `pinnedMode` now drops the mode chip (the host IS the mode); a host that
 *    pins nothing still gets it.
 *  · `newThreadIntro` replaces the greeting only where passed.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000091';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

afterEach(cleanup);

const draftOf = (view: ReturnType<typeof render>) =>
  (view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).value;

describe('composer seed (host hook)', () => {
  it('without a seed or a pin, the composer is exactly as before: empty draft, mode chip present', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => view.getByLabelText('Message the chat agent'));
    expect(draftOf(view)).toBe('');
    expect(view.getByTestId('tch-mode')).toBeTruthy();
  });

  it('appends once per nonce, after what the viewer typed, and never on a re-render', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => view.getByLabelText('Message the chat agent'));
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Look at' } });

    view.rerender(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} composerSeed={{ text: '[Brief](tm8://node/g/d-brief)', nonce: 1 }} />);
    await waitFor(() => expect(draftOf(view)).toBe('Look at [Brief](tm8://node/g/d-brief)'));

    /* Same nonce, new render: nothing is appended twice. */
    view.rerender(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} composerSeed={{ text: '[Brief](tm8://node/g/d-brief)', nonce: 1 }} />);
    expect(draftOf(view)).toBe('Look at [Brief](tm8://node/g/d-brief)');

    view.rerender(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} composerSeed={{ text: 'and this', nonce: 2 }} />);
    await waitFor(() => expect(draftOf(view)).toBe('Look at [Brief](tm8://node/g/d-brief) and this'));
  });

  it('a host-pinned mode has no chip', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} pinnedMode="craft" />);
    await waitFor(() => view.getByLabelText('Message the chat agent'));
    expect(view.queryByTestId('tch-mode')).toBeNull();
  });
});
