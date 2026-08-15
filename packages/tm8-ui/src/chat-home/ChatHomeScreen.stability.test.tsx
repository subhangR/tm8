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
    await waitFor(() => {
      act(() => gated.release());
      expect(view.queryByTestId('chat-detail-loading')).toBeNull();
    });
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

describe('Chat Home cross-thread and multiplayer safety', () => {
  it('does not paint a posted thread over the screen after switching away mid-send', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const gated = gateReads(port);
    const view = render(<ChatHomeScreen port={gated.port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => {
      act(() => gated.release());
      expect(view.getByTestId('chat-usage-card')).toBeTruthy();
    });

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Posted into thread A.' },
    });
    fireEvent.keyDown(view.getByLabelText('Message the chat agent'), { key: 'Enter' });
    await waitFor(() => expect(controls.posts).toHaveLength(1));

    // Switch to the new-thread composer while the post-send read is gated.
    fireEvent.click(view.getByRole('button', { name: /new/i }));
    await waitFor(() => expect(view.getByText('What should we work on?')).toBeTruthy());
    act(() => gated.release());

    // Thread A's snapshot must not overwrite the new-thread screen.
    await waitFor(() => expect(view.getByText('What should we work on?')).toBeTruthy());
    expect(view.queryByTestId('chat-usage-card')).toBeNull();
  });

  it('keeps the composer usable while another participant’s turn streams', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByTestId('chat-usage-card')).toBeTruthy());

    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId: '019f0000-0000-7000-8000-0000000000ff' as EntityId,
        seq: 0,
        part: { kind: 'text', text: 'Someone else’s agent is answering.' },
      });
    });

    await waitFor(() => expect(view.getByText('Agent is working')).toBeTruthy());
    const composer = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: 'I can still type and send.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]?.body).toBe('I can still type and send.');
  });
});

describe('Chat Home snapshot reconciliation', () => {
  it('never loses streamed content to a read that snapshotted before the stream', async () => {
    const { port, controls } = createChatHomeFixturePort();
    // Capture the snapshot IMMEDIATELY but delay resolution — the hostile
    // ordering: snapshot predates the frames, resolution postdates them.
    let holds: Array<() => void> = [];
    let arm = false;
    const hostile: ChatHomePort = {
      ...port,
      readThread: async (rootId) => {
        const snapshot = await port.readThread(rootId);
        if (arm) await new Promise<void>((resolve) => holds.push(resolve));
        return snapshot;
      },
    };
    const view = render(<ChatHomeScreen port={hostile} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.getByTestId('chat-usage-card')).toBeTruthy());

    arm = true;
    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Race me.' },
    });
    fireEvent.keyDown(view.getByLabelText('Message the chat agent'), { key: 'Enter' });
    await waitFor(() => expect(controls.posts).toHaveLength(1));

    const messageId = '019f0000-0000-7000-8000-00000000abab' as EntityId;
    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId,
        seq: 0,
        part: { kind: 'text', text: 'Streamed after the snapshot.' },
      });
      controls.emit({
        type: 'chat.turn.done',
        threadRootId: THREAD_ID,
        messageId,
        usage: { output_tokens: 3 },
      });
    });
    await waitFor(() => expect(view.getByText('Streamed after the snapshot.')).toBeTruthy());

    // Resolve the stale read: the streamed answer must survive it.
    act(() => {
      const waiting = holds;
      holds = [];
      for (const release of waiting) release();
    });
    await waitFor(() => expect(view.getByText('Streamed after the snapshot.')).toBeTruthy());
    expect(view.queryByText('Agent is working')).toBeNull();
  });

  it('keeps a newly typed draft when an older thread’s send resolves late', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const gated = gateReads(port);
    const view = render(<ChatHomeScreen port={gated.port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => {
      act(() => gated.release());
      expect(view.getByTestId('chat-usage-card')).toBeTruthy();
    });

    fireEvent.change(view.getByLabelText('Message the chat agent'), {
      target: { value: 'Sent into thread A.' },
    });
    fireEvent.keyDown(view.getByLabelText('Message the chat agent'), { key: 'Enter' });
    await waitFor(() => expect(controls.posts).toHaveLength(1));

    fireEvent.click(view.getByRole('button', { name: /new/i }));
    const composer = view.getByLabelText('Message the chat agent') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Fresh draft for a new conversation.' } });
    act(() => gated.release());

    await waitFor(() => expect(composer.value).toBe('Fresh draft for a new conversation.'));
  });
});

describe('Chat Home entity chip suppression', () => {
  it('never chips this thread’s own messages but keeps foreign entity chips', async () => {
    const { port, controls } = createChatHomeFixturePort();
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());

    const ownMessageId = '019f0000-0000-7000-8000-000000000011';
    const foreignId = '019f0000-0000-7000-8000-00000000dddd';
    const messageId = '019f0000-0000-7000-8000-0000000000ee' as EntityId;
    act(() => {
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId,
        seq: 0,
        part: {
          kind: 'tool_call',
          toolCallId: 'tc-sup',
          name: 'tm8_read',
          args: { ids: [ownMessageId, foreignId] },
          state: 'completed',
        },
      });
      controls.emit({
        type: 'chat.turn.delta',
        threadRootId: THREAD_ID,
        messageId,
        seq: 1,
        part: {
          kind: 'tool_result',
          toolCallId: 'tc-sup',
          content: { entity: { id: foreignId, kind: 'task', title: 'Foreign task' } },
        },
      });
    });

    // Scoped to the chips: the live graph draws the same titles, so a bare
    // getByText would now match the graph node too and say nothing about chips.
    await waitFor(() =>
      expect(
        view
          .getAllByTestId('chat-entity-chip')
          .some((chip) => chip.textContent?.includes('Foreign task')),
      ).toBe(true),
    );
    const chips = view.getAllByTestId('chat-entity-chip');
    expect(chips.some((chip) => chip.textContent?.includes('000000000011'))).toBe(false);
  });
});
