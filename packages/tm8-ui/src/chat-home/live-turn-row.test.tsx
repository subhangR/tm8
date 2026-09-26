// @vitest-environment jsdom
/**
 * THE LIVE ROW THROUGH THE REAL SCREEN — Subhang's report, as a test.
 *
 * "Sending a message should immediately show the agent's turn; the agent does
 * a lot of background work and nothing is shown on screen for long periods,
 * only the composer button changes." Before this lane the transcript said
 * "Agent is thinking…" until the first part landed and then NOTHING for the
 * rest of the turn — the one live signal left was the Send button turned Stop.
 *
 * This drives a whole multi-step turn through `ChatHomeScreen` with real
 * frames and asserts that at every stage the transcript itself says what is
 * happening, and that the row leaves cleanly when the turn is done.
 */
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import { describeToolStep } from './turn-steps';
import type { ChatModelOption, ChatTurnItem } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const ROOT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const AGENT = '019f0000-0000-7000-8004-000000000001' as EntityId;

const BASH_ARGS = { command: 'bun run build', description: 'Build the workspace' };
const CREATE_ARGS = { operation: 'entities.create', body: { kind: 'task', title: 'Provider interface' } };

async function sendAndStream() {
  const { port, controls } = createChatHomeFixturePort();
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} />);
  await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  await waitFor(() => expect(view.queryByTestId('chat-detail-loading')).toBeNull());
  fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Build it.' } });
  fireEvent.click(view.getByRole('button', { name: /send/i }));
  let seq = 0;
  const emit = async (part: ChatTurnItem) =>
    act(async () => {
      controls.emit({ type: 'chat.turn.delta', chatId: ROOT, messageId: AGENT, seq: seq++, part });
    });
  const done = async () =>
    act(async () => {
      controls.emit({ type: 'chat.turn.done', chatId: ROOT, messageId: AGENT, usage: { output_tokens: 9 } });
    });
  return { view, emit, done };
}

const now = (view: ReturnType<typeof render>) => view.getByTestId('chat-live-now').textContent;

describe('the transcript always says what the agent is doing', () => {
  it('from Send, through every step, to done — and then the row is gone', async () => {
    const { view, emit, done } = await sendAndStream();

    // Send: the row is there at once, in the transcript, under the last turn.
    const pending = await view.findByTestId('chat-thinking');
    expect(pending.closest('.tch-transcript')).not.toBeNull();
    expect(['Sending your message…', 'Thinking…']).toContain(now(view));

    // A step starts: its words, not the tool's name.
    await emit({ kind: 'tool_call', toolCallId: 'b1', name: 'Bash', args: BASH_ARGS, state: 'running' });
    const row = await view.findByTestId('chat-live-turn');
    expect(row.dataset.phase).toBe('streaming');
    expect(now(view)).toBe(`${describeToolStep('Bash', BASH_ARGS).active}…`);
    expect(view.getByTestId('chat-live-meta').textContent).toMatch(/^step 1 · \d+s$/);

    // The step settles: the model is thinking, and the step it finished is named.
    await emit({ kind: 'tool_result', toolCallId: 'b1', content: 'built' });
    await waitFor(() => expect(now(view)).toBe('Thinking…'));
    expect(view.getByTestId('chat-live-aside').textContent).toContain(
      describeToolStep('Bash', BASH_ARGS, 'built').done,
    );

    // A second step — a create — carries its title.
    await emit({ kind: 'tool_call', toolCallId: 'c1', name: 'mcp__tm8__tm8_act', args: CREATE_ARGS, state: 'running' });
    await waitFor(() => expect(now(view)).toContain('Provider interface'));
    expect(view.getByTestId('chat-live-meta').textContent).toMatch(/^step 2 · /);

    // A text block: writing.
    await emit({ kind: 'tool_result', toolCallId: 'c1', content: { id: '019f0000-0000-7000-8005-000000000001', kind: 'task', title: 'Provider interface' } });
    await emit({ kind: 'text', text: 'Done — the build is green.' });
    await waitFor(() => expect(now(view)).toBe('Writing…'));

    // R8, over the whole run: no tool name ever reached the row.
    expect(view.getByTestId('chat-dock').textContent).not.toMatch(/Bash|tm8_act|mcp__|entities\./);

    // Done: the row leaves cleanly, with nothing standing in for it.
    await done();
    await waitFor(() => expect(view.queryByTestId('chat-live-turn')).toBeNull());
    expect(view.queryByTestId('chat-thinking')).toBeNull();
    expect(view.queryByTestId('chat-dock')).toBeNull();
  });

  /** D20: one wait line, not two — the old `Agent is thinking…` pulse is the
   *  row now, and nothing else in the transcript says it again. */
  it('never shows two status lines for one turn', async () => {
    const { view } = await sendAndStream();
    await view.findByTestId('chat-thinking');
    const transcript = view.container.querySelector('.tch-transcript')!;
    expect(transcript.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(transcript.textContent).not.toContain('Agent is thinking');
  });
});
