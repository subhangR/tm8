// @vitest-environment jsdom
/**
 * The host tells each turn whether it can still be running. A runtime that
 * died without writing `done` leaves its calls stored as `running` forever;
 * only the thread's own state knows the turn is over.
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatThreadDetail } from './types';

afterEach(cleanup);

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-opus-5', label: 'Opus 5', provider: 'anthropic', agentTool: 'claude-code' },
];

/** The fixture thread plus one assistant turn whose shell call never closed. */
function threadWithOpenCall(state: ChatThreadDetail['summary']['state']): ChatThreadDetail {
  const thread = structuredClone(CHAT_HOME_FIXTURE_THREAD);
  thread.summary.state = state;
  thread.turns = [
    thread.turns[0]!,
    {
      messageId: '019f0000-0000-7000-8000-0000000000b3' as EntityId,
      role: 'assistant',
      author: thread.turns[1]!.author,
      createdAt: '2026-08-13T08:20:00.000Z',
      body: '',
      // The server's in-flight marker (133) is present only while the turn
      // is still claimed — which is exactly when the thread streams.
      ...(state === 'streaming' ? { turnInFlight: true } : {}),
      parts: [
        { seq: 0, kind: 'text', text: 'Building it now.' },
        {
          seq: 1,
          kind: 'tool_call',
          toolCallId: 'c1',
          name: 'Bash',
          args: { command: 'make', description: 'Build the app' },
          state: 'running',
        },
      ],
    },
  ];
  return thread;
}

describe('the host settles every turn but the live one', () => {
  it('an IDLE thread shows a never-closed call as stopped, not running', async () => {
    const { port } = createChatHomeFixturePort([threadWithOpenCall('idle')]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    const line = await waitFor(() => view.getByTestId('chat-step-line'));
    expect(line.dataset.state).toBe('stopped');
    expect(line.textContent).toContain('Stopped while running a shell command');
    expect(view.container.querySelector('.tch-steps__line[data-state="running"]')).toBeNull();
  });

  it('a STOPPED thread shows the call it abandoned as stopped', async () => {
    const { port } = createChatHomeFixturePort([threadWithOpenCall('stopped-continuable')]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    const line = await waitFor(() => view.getByTestId('chat-step-line'));
    expect(line.dataset.state).toBe('stopped');
  });

  it('a STREAMING thread keeps its newest assistant turn live', async () => {
    const { port } = createChatHomeFixturePort([threadWithOpenCall('streaming')]);
    const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
    const line = await waitFor(() => view.getByTestId('chat-step-line'));
    expect(line.dataset.state).toBe('running');
    expect(line.textContent).toContain('Running a shell command…');
  });
});
