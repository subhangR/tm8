// @vitest-environment jsdom
/**
 * A STAGE HAS A WAY BACK AND SAYS WHETHER THE AGENT IS WORKING (ruling D18).
 *
 * Reproduced live: with the Graph stage opened while a turn streamed, nothing
 * on screen said the agent was still at it (the tray's pulse could never
 * mount), there was no exit control, and Escape did nothing — the tab that had
 * focus unmounted with the tray and focus fell to <body>, outside the section
 * that handles Escape.
 */
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { StageExit } from './StageExit';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';
import type { CockpitStage } from '../routes/types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];
const ROOT = CHAT_HOME_FIXTURE_THREAD.summary.rootId;
const TURN = '019f0000-0000-7000-8000-0000000000e2' as EntityId;

describe('StageExit', () => {
  it('says nothing when nothing ran, “Agent working…” while busy, and “Agent finished” after', () => {
    const view = render(<StageExit busy={false} onExit={vi.fn()} />);
    // The live region exists EMPTY, so its first sentence is announced.
    const status = view.getByRole('status');
    expect(status.textContent).toBe('');
    view.rerender(<StageExit busy onExit={vi.fn()} />);
    expect(view.getByRole('status').textContent).toBe('Agent working…');
    expect(view.getByRole('status').getAttribute('data-state')).toBe('working');
    view.rerender(<StageExit busy={false} onExit={vi.fn()} />);
    expect(view.getByRole('status').textContent).toBe('Agent finished');
    expect(view.getByRole('status').getAttribute('data-state')).toBe('finished');
  });

  it('is the exit: `← Chat` calls the same verb Escape does', () => {
    const onExit = vi.fn();
    const view = render(<StageExit busy={false} onExit={onExit} />);
    fireEvent.click(view.getByRole('button', { name: 'Back to chat' }));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('stage-exit-back').textContent).toBe('← Chat');
  });
});

/** A host that owns the address the way the shell does: the stage comes back
 *  down as a prop after `onStageChange`. */
function Host({ port, initial = null }: { port: ReturnType<typeof createChatHomeFixturePort>['port']; initial?: CockpitStage | null }) {
  const [stage, setStage] = useState<CockpitStage | null>(initial);
  return (
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      routeThreadId={ROOT}
      stage={stage}
      onStageChange={setStage}
      onShowChat={() => setStage(null)}
    />
  );
}

describe('the stage on the screen', () => {
  it('opening Graph from its tab lands focus in the stage, so Escape leaves it — and focus returns to the composer', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    render(<Host port={port} />);
    const tab = await screen.findByText('Graph');
    tab.closest('button')!.focus();
    fireEvent.click(tab);
    await screen.findByTestId('cockpit-graph');
    const centre = screen.getByTestId('tch-center-override');
    // Not <body>: the tab that had focus is gone with the tray.
    expect(document.activeElement).toBe(centre);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('cockpit-graph')).toBeNull());
    expect(document.activeElement).toBe(screen.getByLabelText('Message the chat agent'));
  });

  it('closing a stage by picking a row in column A leaves focus on that row — only ADRIFT focus is moved', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    render(<Host port={port} initial="graph" />);
    await screen.findByTestId('cockpit-graph');
    const row = screen.getByRole('button', { name: /Plan the launch sequence/ });
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(screen.queryByTestId('cockpit-graph')).toBeNull());
    expect(document.activeElement).toBe(row);
  });

  it('`← Chat` in the stage header closes it', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    render(<Host port={port} initial="graph" />);
    await screen.findByTestId('cockpit-graph');
    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    await waitFor(() => expect(screen.queryByTestId('cockpit-graph')).toBeNull());
    expect(screen.getByLabelText('Message the chat agent')).toBeTruthy();
  });

  it('the fleet stage carries the same line', async () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    render(<Host port={port} initial="fleet" />);
    await screen.findByTestId('cockpit-fleet');
    expect(screen.getByRole('button', { name: 'Back to chat' })).toBeTruthy();
  });

  it('a turn streaming behind the stage reads “Agent working…”, then “Agent finished”', async () => {
    const { port, controls } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    render(<Host port={port} initial="graph" />);
    await screen.findByTestId('cockpit-graph');
    await waitFor(() => expect(screen.getByTestId('stage-exit')).toBeTruthy());
    expect(screen.getByTestId('stage-exit').querySelector('[role="status"]')!.textContent).toBe('');

    act(() => {
      controls.emit({
        type: 'chat.turn.delta', chatId: ROOT, messageId: TURN, seq: 0,
        part: { kind: 'text', text: 'Answering behind the stage.' },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('stage-exit').querySelector('[role="status"]')!.textContent).toBe('Agent working…'));
    act(() => {
      controls.emit({ type: 'chat.turn.done', chatId: ROOT, messageId: TURN, usage: {} });
    });
    await waitFor(() =>
      expect(screen.getByTestId('stage-exit').querySelector('[role="status"]')!.textContent).toBe('Agent finished'));
  });
});
