// @vitest-environment jsdom
/**
 * The craft's 2nd panel, "+ New session" (spec §3): the spawn runs on the
 * craft, its live terminal shows at once, and the session -[about]-> craft
 * edge is best-effort — refused until L3's migration 314, which must not fail
 * the session, only say so.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { HOUSE_TEAMMATE_NAMES } from '@tm8/contract';

/* The chat pane and the session's terminal body are the app's own, tested
   where they live; here they are stand-ins so the panel's flow is the subject. */
vi.mock('./CraftChatPane', () => ({ CraftChatPane: () => <div data-testid="stub-chat" /> }));
vi.mock('./use-embedded-tab', () => ({
  useEmbeddedTab: (_runtime: unknown, id: string | null, kind: string | null) =>
    id && kind ? { type: 'entity', id, kind } : null,
}));
vi.mock('../tab-workspace/embed', () => ({
  getKindAdapter: (kind: string) => ({ kind }),
  EntityTabBody: ({ tab }: { tab: { id: string } }) => <div data-testid="stub-terminal">{tab.id}</div>,
}));

import { CraftSidePanel } from './CraftSidePanel';

const CRAFT = 'craft-1' as EntityId;

afterEach(cleanup);

function mount() {
  const spawn = vi.fn(async () => 'session-9');
  const onNotice = vi.fn();
  const seam = {
    connections: vi.fn(async () => ({ items: [] })),
    commands: { createEdge: vi.fn(async () => ({})) },
  };
  const gate = {
    data: {
      spaceId: 'space-1',
      spawn,
      launch: {
        teammates: [
          { id: 'tm-arch', name: HOUSE_TEAMMATE_NAMES.graphArchitect, initial: 'G', model: 'opus', agentTool: 'claude-code', owner: 'me' },
        ],
        projects: [],
      },
    },
  };
  const view = render(
    <CraftSidePanel
      seam={seam as never}
      spaceId={'space-1' as SpaceId}
      nodeKey="fixture"
      craftId={CRAFT}
      title="Launch plan"
      gate={gate as never}
      runtime={{} as never}
      onPrompt={() => undefined}
      onOpenEntity={() => undefined}
      onNotice={onNotice}
    />,
  );
  return { view, spawn, onNotice, createEdge: seam.commands.createEdge };
}

describe('CraftSidePanel ＋ New session', () => {
  it('spawns on and about the craft, shows the live terminal, and writes no edge afterwards', async () => {
    const { view, spawn, onNotice, createEdge } = mount();
    const button = view.getByTestId('crf-new-session') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(view.getByTestId('stub-terminal').textContent).toBe('session-9'));
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ teamMemberId: 'tm-arch', taskIds: [CRAFT], aboutEntityId: CRAFT }));
    expect(view.getByTestId('crf-side-chat').hidden).toBe(true);
    expect(createEdge).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('says so and shows no terminal when the spawn is refused', async () => {
    const { view, spawn, onNotice } = mount();
    spawn.mockRejectedValueOnce(new Error('no node'));
    fireEvent.click(view.getByTestId('crf-new-session'));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Session refused')));
    expect(view.queryByTestId('stub-terminal')).toBeNull();
  });
});
