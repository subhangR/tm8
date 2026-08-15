// @vitest-environment jsdom
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  {
    model: 'claude-sonnet-4-5',
    label: 'Sonnet 4.5',
    provider: 'Anthropic',
    agentTool: 'claude-code',
  },
  {
    model: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    provider: 'OpenAI',
    agentTool: 'codex',
  },
];

describe('Chat Home', () => {
  it('renders a thread, one stateful tool card, and actual usage', async () => {
    const { port } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getAllByTestId('chat-tool-card')).toHaveLength(1));
    expect(within(view.getByTestId('chat-tool-card')).getByText('completed')).toBeTruthy();
    expect(view.getByTestId('chat-usage-card').textContent).toContain('$0.0073');
    expect((view.getByLabelText('Chat teammate') as HTMLSelectElement).disabled).toBe(true);
    expect((view.getByLabelText('Chat mode') as HTMLSelectElement).disabled).toBe(true);
    expect(view.getAllByText('plan').length).toBeGreaterThan(0);
    expect(view.getByText('pinned for this thread')).toBeTruthy();
  });

  it('posts the first prompt as the root before configuring the thread', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        newMutationId={(prefix) => `${prefix}:test`}
      />,
    );

    await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    /* R4: a NEW thread's teammate and mode are composer chips (the TO row and
       the mode radios); the model keeps its header select. */
    const toRow = view.getByRole('radiogroup', { name: 'Send to teammate' });
    expect(within(toRow).getAllByRole('radio').length).toBeGreaterThan(0);
    fireEvent.change(view.getByLabelText('Chat model'), { target: { value: 'gpt-5.6-sol' } });
    fireEvent.click(
      within(view.getByRole('radiogroup', { name: 'Chat mode' })).getByRole('radio', { name: 'build' }),
    );
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Audit the release blockers.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.configs).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({
      spaceId: SPACE_ID,
      anchorId: SPACE_ID,
      body: 'Audit the release blockers.',
      clientMutationId: 'chat-root:test',
    });
    expect(controls.configs[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      mode: 'build',
      clientMutationId: 'chat-config:test',
    });
    expect(controls.configs[0]?.rootMessageId).toMatch(/^019f/);
    expect(controls.posts).toHaveLength(0);
    expect(view.getByText('Agent is working')).toBeTruthy();
  });

  it('offers Explain and persists it in the write-once thread configuration', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        newMutationId={(prefix) => `${prefix}:explain-test`}
      />,
    );

    await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new chat/i }));
    const modeRow = view.getByRole('radiogroup', { name: 'Chat mode' });
    const explain = within(modeRow).getByRole('radio', { name: 'explain' });
    fireEvent.click(explain);
    expect(explain.getAttribute('aria-checked')).toBe('true');
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Explain the request flow with a diagram.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(controls.configs).toHaveLength(1));
    expect(controls.configs[0]).toMatchObject({ mode: 'explain' });
    await waitFor(() => {
      expect((view.getByLabelText('Chat mode') as HTMLSelectElement).disabled).toBe(true);
    });
    expect((view.getByLabelText('Chat mode') as HTMLSelectElement).value).toBe('explain');
    expect(view.getByText('pinned for this thread')).toBeTruthy();
  });

  it('appends a streamed part by seq and settles on done', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    const rootId = controls.roots[0]?.anchorId ?? '019f0000-0000-7000-8000-000000000010';
    const messageId = '019f0000-0000-7000-8000-000000000077' as EntityId;

    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: rootId as EntityId,
        messageId,
        seq: 0,
        part: { kind: 'text', text: 'Live result arrived.' },
      });
    });
    await waitFor(() => expect(view.getByText('Live result arrived.')).toBeTruthy());
    expect(view.getByText('Agent is working')).toBeTruthy();

    act(() => {
      controls.emit({
        type: 'chat.turn.done',
        threadRootId: rootId as EntityId,
        messageId,
        usage: {},
      });
    });
    await waitFor(() => expect(view.queryByText('Agent is working')).toBeNull());
    expect(view.getAllByTestId('chat-usage-card')).toHaveLength(1);
  });

  it('keeps new chat visibly unavailable when the config op is absent', async () => {
    const fixture = createChatHomeFixturePort();
    const port: ChatHomePort = {
      ...fixture.port,
      startThread: {
        ...fixture.port.startThread,
        unavailableReason: 'This node does not expose chat thread configuration yet.',
      },
    };
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByRole('button', { name: /new/i })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /new/i }));
    expect(view.getByText(/does not expose chat thread configuration/i)).toBeTruthy();
    expect(view.getByRole('button', { name: /send/i }).getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps an interrupted thread continuable with its persisted partial turn and usage', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(
      <ChatHomeScreen
        port={port}
        spaceId={SPACE_ID}
        models={MODELS}
        newMutationId={(prefix) => `${prefix}:interrupt-test`}
      />,
    );
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Read the current context.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(view.getByText('Agent is working')).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /stop/i }));

    await waitFor(() => expect(view.getByText('Stopped · continuable')).toBeTruthy());
    expect(view.getByText(/this thread is continuable/i)).toBeTruthy();
    expect((view.getByLabelText('Message the chat agent') as HTMLTextAreaElement).disabled).toBe(false);
    expect(controls.interrupts).toEqual(['019f0000-0000-7000-8000-000000000010']);
    expect(view.getByText('I found the current context before the turn was stopped.')).toBeTruthy();
    expect(view.getAllByTestId('chat-usage-card')).toHaveLength(2);
    expect(view.getAllByTestId('chat-usage-card')[1]?.textContent).toContain('$0.0012');

    const stopped = await port.readThread(controls.interrupts[0]!);
    const interruptedTurn = stopped.turns.at(-1)!;
    expect(stopped.summary.state).toBe('stopped-continuable');
    expect(interruptedTurn.parts.at(-2)).toMatchObject({ kind: 'tool_result', isError: true });
    expect(interruptedTurn.parts.at(-1)).toMatchObject({ kind: 'done' });

    act(() => {
      controls.emit({
        type: 'chat.turn.done',
        threadRootId: stopped.summary.rootId,
        messageId: interruptedTurn.messageId,
        usage: {},
      });
    });
    expect(view.getByText('Stopped · continuable')).toBeTruthy();

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Continue from the persisted result.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.posts).toHaveLength(2));
    expect(controls.posts[1]).toMatchObject({
      threadRootId: stopped.summary.rootId,
      body: 'Continue from the persisted result.',
    });
    expect(view.getByText('Agent is working')).toBeTruthy();
  });
});
