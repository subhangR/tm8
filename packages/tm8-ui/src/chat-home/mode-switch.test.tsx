// @vitest-environment jsdom
/**
 * THE CHAT MODE CHIP IS A CONTROL ON AN OPEN CHAT TOO.
 *
 * Reported alongside the model defect: the composer offers ask / explain / plan
 * / build / orchestrate / craft, and once a thread had started none of them
 * could be chosen — the chip was `disabled={pinned}`, like the model chip beside
 * it.
 *
 * Unlike the model, though, nothing in the runtime had to change to allow this.
 * The per-turn carrier has been live since 153/154: `messages.requested_chat_mode`
 * is stamped by the server, the same post queues the turn with it as
 * `chat_turns.mode` (`w2_post_message_batch` since 176; 153's enqueue trigger
 * before that), and the claim resolves `coalesce(turn.mode,
 * chat.chat_mode)`. `PostMessageInput.mode` already accepted it on the wire. The
 * launched system prompt is mode-INDEPENDENT by design ("input.chatMode is not
 * read here") and carries a guide to all six modes, each turn's `[mode: x]`
 * envelope line selecting one; and no mode narrows the tool surface, because
 * `toolPermission` returns 'allow' for every mode, making `exposedToolNames` the
 * identity filter. A mode states INTENT, not permission.
 *
 * So there is no relaunch here and no new operation — the whole fix is that the
 * composer now uses a door that was already open. These tests pin that: the chip
 * is live on an open chat, a pick rides the NEXT turn, and a turn nobody
 * redirected still carries nothing so the thread's default applies.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const FIXTURE_CHAT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

afterEach(cleanup);

/** Mount with the fixture chat already open, so the chip is on a PINNED chat. */
async function openChat() {
  const { port, controls } = createChatHomeFixturePort();
  const view = render(
    <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} routeThreadId={FIXTURE_CHAT} />,
  );
  /* The fixture thread's DEFAULT mode is `plan`; waiting for it is waiting for
     the served config, which is what makes `pinned` true. */
  await waitFor(() => expect(view.getByTestId('tch-mode').textContent).toContain('plan'));
  return { view, controls };
}

async function send(view: Awaited<ReturnType<typeof openChat>>['view'], body: string) {
  fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: body } });
  fireEvent.click(view.getByRole('button', { name: /send/i }));
}

describe('changing an open chat’s mode from the composer', () => {
  it('leaves the mode chip ENABLED on an open chat', async () => {
    const { view } = await openChat();
    // The regression this guards is the reported defect verbatim.
    expect(view.getByTestId('tch-mode').hasAttribute('disabled')).toBe(false);
  });

  it('carries the picked mode on the NEXT turn, and shows it on the chip', async () => {
    const { view, controls } = await openChat();
    fireEvent.click(view.getByTestId('tch-mode'));
    fireEvent.click(view.getByTestId('tch-mode-build'));
    // The trigger states the pick without being reopened.
    expect(view.getByTestId('tch-mode').textContent).toContain('build');

    await send(view, 'Now actually make the change.');
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]).toMatchObject({ mode: 'build' });
  });

  it('sends NO mode when nobody redirected the turn, so the thread default applies', async () => {
    const { view, controls } = await openChat();
    await send(view, 'Just continue.');
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    /* Absent, not `plan`. `coalesce(turn.mode, chat.chat_mode)` already says
       "the thread's default" in SQL; restating it would write a
       requested_chat_mode onto every turn and lose the distinction between a
       turn that chose plan and a turn that chose nothing. */
    expect(controls.posts[0]!.mode).toBeUndefined();
    expect('mode' in controls.posts[0]!).toBe(false);
  });

  it('does not consume the pick with the turn that used it, and re-picking replaces it', async () => {
    const { view, controls } = await openChat();
    fireEvent.click(view.getByTestId('tch-mode'));
    fireEvent.click(view.getByTestId('tch-mode-build'));
    await send(view, 'First.');
    await waitFor(() => expect(controls.posts).toHaveLength(1));

    /* A pick says how to WORK, not how to write one message, so it survives the
       turn that carried it. This stops at the chip rather than sending a second
       turn on purpose: once a turn is in flight the composer is busy and offers
       no send button at all, so a two-send assertion here would be asserting
       against the fixture's settle sequence instead of against the pick. */
    expect(view.getByTestId('tch-mode').textContent).toContain('build');

    fireEvent.click(view.getByTestId('tch-mode'));
    fireEvent.click(view.getByTestId('tch-mode-ask'));
    expect(view.getByTestId('tch-mode').textContent).toContain('ask');
  });

  it('accepts the `/build` shortcut on an open chat, not just a new one', async () => {
    const { view, controls } = await openChat();
    const box = view.getByLabelText('Message the chat agent');
    fireEvent.change(box, { target: { value: '/build' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    // The slash consumed the draft and set the pick rather than posting '/build'.
    expect(view.getByTestId('tch-mode').textContent).toContain('build');
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(controls.posts).toHaveLength(0);

    await send(view, 'Go.');
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]).toMatchObject({ mode: 'build' });
  });
});
