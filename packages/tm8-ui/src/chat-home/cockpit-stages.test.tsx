// @vitest-environment jsdom
/**
 * THE COCKPIT'S NON-ENTITY STAGES, mounted.
 *
 * The panes have their own suites; this one pins the MOUNT — the part where a
 * stage, an entity and the conversation all want region B and only one may
 * have it. The failure modes here are structural rather than cosmetic: two
 * panes stacked silently, a transcript unmounted mid-stream, or a way back
 * that is not on screen.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

function mount(over: Partial<Parameters<typeof ChatHomeScreen>[0]> = {}) {
  const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
  return render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId}
      {...over}
    />,
  );
}

describe('the stage tabs', () => {
  it('are absent without a host verb — the tray never draws a dead control', async () => {
    mount();
    await screen.findByTestId('chat-entity-tray');
    expect(screen.queryByText('Fleet')).toBeNull();
  });

  it('ask the HOST to change the address rather than swapping locally', async () => {
    const onStageChange = vi.fn();
    mount({ onStageChange });
    fireEvent.click(await screen.findByText('Fleet'));
    expect(onStageChange).toHaveBeenCalledWith('fleet');
    // Nothing rendered yet: the stage follows the address coming back down,
    // so Back and a reload land on the same screen the click produced.
    expect(screen.queryByTestId('cockpit-fleet')).toBeNull();
  });
});

describe('region B has exactly one occupant', () => {
  it('the fleet renders in the transcript’s berth', async () => {
    mount({ stage: 'fleet', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-fleet');
    expect(screen.getByTestId('tch-center-override')).toBeTruthy();
  });

  it('the graph renders there too, and only one at a time', async () => {
    mount({ stage: 'graph', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-graph');
    expect(screen.queryByTestId('cockpit-fleet')).toBeNull();
  });

  it('AN ENTITY WINS. A host that hands both gets the entity, never both stacked', async () => {
    mount({
      stage: 'fleet',
      onStageChange: vi.fn(),
      centerOverride: <div data-testid="host-entity-panel" />,
    });
    await screen.findByTestId('host-entity-panel');
    expect(screen.queryByTestId('cockpit-fleet')).toBeNull();
  });

  it('THE TRANSCRIPT IS HIDDEN, NOT UNMOUNTED — a streaming thread survives a stage', async () => {
    const { container } = mount({ stage: 'graph', onStageChange: vi.fn() });
    await screen.findByTestId('cockpit-graph');
    const transcript = container.querySelector('.tch-transcript');
    expect(transcript).not.toBeNull();
    expect(transcript?.getAttribute('hidden')).not.toBeNull();
  });
});

describe('the way back is always on screen', () => {
  it('Esc leaves a stage by NAVIGATING, not by resetting local state', async () => {
    /* A stage is addressed. Clearing it locally would leave the URL pointing
       at a stage the viewer just dismissed, and Back would walk into it. */
    const onStageChange = vi.fn();
    const onShowChat = vi.fn();
    const { container } = mount({ stage: 'fleet', onStageChange, onShowChat });
    await screen.findByTestId('cockpit-fleet');
    fireEvent.keyDown(container.querySelector('.tch-conversation')!, { key: 'Escape' });
    expect(onStageChange).toHaveBeenCalledWith(null);
    expect(onShowChat).not.toHaveBeenCalled();
  });

  it('Esc over a HOST entity still uses the host’s own way back', async () => {
    const onStageChange = vi.fn();
    const onShowChat = vi.fn();
    const { container } = mount({
      onStageChange,
      onShowChat,
      centerOverride: <div data-testid="host-entity-panel" />,
    });
    await screen.findByTestId('host-entity-panel');
    fireEvent.keyDown(container.querySelector('.tch-conversation')!, { key: 'Escape' });
    expect(onShowChat).toHaveBeenCalled();
    expect(onStageChange).not.toHaveBeenCalled();
  });
});

describe('the retired inline graph', () => {
  it('is gone from the transcript — the graph is a stage, not a strip', async () => {
    mount();
    await waitFor(() => expect(screen.queryByTestId('chat-thinking')).toBeNull());
    // The strip's own testid and the fullscreen dialog's both die with it.
    expect(screen.queryByTestId('chat-entity-graph')).toBeNull();
    expect(screen.queryByTestId('chat-entity-graph-fullscreen')).toBeNull();
  });
});
