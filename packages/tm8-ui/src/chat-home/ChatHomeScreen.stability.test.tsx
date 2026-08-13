// @vitest-environment jsdom
/**
 * Regression tests for the chat-home stability fixes: the done-during-read
 * phase race, lost mid-read frames, the missing detail-loading indicator,
 * plain-Enter send, and multiplayer frames referencing unseen messages.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { createChatHomeFixturePort } from './fixtures';
import type { ChatHomePort, ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const THREAD_ID = '019f0000-0000-7000-8000-000000000010' as EntityId;
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

/** Wraps a port so each readThread call can be released by the test. */
function gateReads(port: ChatHomePort): { port: ChatHomePort; release(): void; reads(): number } {
  let pending: Array<() => void> = [];
  let count = 0;
  return {
    port: {
      ...port,
      readThread: async (rootId) => {
        count += 1;
        await new Promise<void>((resolve) => pending.push(resolve));
        return port.readThread(rootId);
      },
    },
    release: () => {
      const waiting = pending;
      pending = [];
      for (const resolve of waiting) resolve();
    },
    reads: () => count,
  };
}

describe('Chat Home stability', () => {
  it('shows a loading indicator while the thread snapshot is read', async () => {
    const { port } = createChatHomeFixturePort();
    const gated = gateReads(port);
    const view = render(<ChatHomeScreen port={gated.port} spaceId={SPACE_ID} models={MODELS} />);

    await waitFor(() => expect(view.getByTestId('chat-detail-loading')).toBeTruthy());
    act(() => gated.release());
    await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
  });

  it('settles to idle when the done frame lands during the post-turn read', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const gated = gateReads(port);
    const view = render(<ChatHomeScreen port={gated.port} spaceId={SPACE_ID} models={MODELS} />);
    act(() => gated.release());
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Quick follow-up.' },
    });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.posts).toHaveLength(1));

    const messageId = '019f0000-0000-7000-8000-0000000000aa' as EntityId;
    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId,
        seq: 0,
        part: { kind: 'text', text: 'Fast answer.' },
      });
      controls.emit({
        type: 'chat.turn.done',
        threadRootId: THREAD_ID,
        messageId,
        usage: { output_tokens: 5 },
      });
    });
    act(() => gated.release());

    await waitFor(() => expect(view.getByText('Fast answer.')).toBeTruthy());
    expect(view.queryByText('Agent is working')).toBeNull();
    expect(view.queryByTestId('chat-thinking')).toBeNull();
  });

  it('sends on plain Enter and keeps Shift+Enter as a newline', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    const composer = view.getByLabelText('Message the chat agent');
    fireEvent.change(composer, { target: { value: 'Line one' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(controls.posts).toHaveLength(0);
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]?.body).toBe('Line one');
  });

  it('re-reads the thread when a frame references a message it has never seen', async () => {
    const { port, controls } = createChatHomeFixturePort();
    let reads = 0;
    const counting: ChatHomePort = {
      ...port,
      readThread: async (rootId) => {
        reads += 1;
        return port.readThread(rootId);
      },
    };
    const view = render(<ChatHomeScreen port={counting} spaceId={SPACE_ID} models={MODELS} />);
    // Wait for the transcript itself, not the sidebar title, so the detail
    // snapshot is loaded before the foreign frame arrives.
    await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
    await waitFor(() => expect(view.getByTestId('chat-usage-card')).toBeTruthy());
    const readsBefore = reads;

    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId: '019f0000-0000-7000-8000-0000000000bb' as EntityId,
        seq: 0,
        part: { kind: 'text', text: 'Reply to another member.' },
      });
    });

    await waitFor(() => expect(reads).toBe(readsBefore + 1));
    // The streamed part survives the refresh snapshot via frame replay.
    await waitFor(() => expect(view.getByText('Reply to another member.')).toBeTruthy());
  });

  it('marks a sidebar thread live when its frames stream while it is not active', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());

    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId: '019f0000-0000-7000-8000-0000000000cc' as EntityId,
        seq: 0,
        part: { kind: 'text', text: 'Working…' },
      });
    });
    await waitFor(() => expect(view.getAllByLabelText('Agent is working').length).toBeGreaterThan(0));
  });
});
