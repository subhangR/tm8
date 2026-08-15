// @vitest-environment jsdom
/**
 * Home's three-tab left column (task 01a006f8, ruled 2026-08-16).
 *
 * Every case here pins a lettered ruling from the task body — D1 order,
 * D2 buttons, D4 scoped search, D6 browsing vs D7 selecting, D8 the chat
 * stays mounted, D9 the honest highlight, D10 the ＋ exception, D11 Run,
 * D16 no counts, D17 view-only sessions — so a later redesign has to argue
 * with the ruling, not just move JSX.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatHomeScreen, type ChatHomeScreenProps } from './ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption, ChatSessionRow, ChatTaskRow } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const SESSIONS: ChatSessionRow[] = [
  {
    id: 'ws-1',
    title: 'Fix the flaky migration',
    statusWord: 'working',
    tone: 'run',
    live: true,
    detail: 'claude-code · sonnet-4-5',
    updatedAt: '2026-08-16T09:00:00.000Z',
  },
  {
    id: 'ws-2',
    title: 'Another member’s run',
    statusWord: 'idle',
    tone: 'idle',
    live: true,
    updatedAt: '2026-08-16T08:00:00.000Z',
    viewOnly: true,
  },
];

const TASKS: ChatTaskRow[] = [
  { id: 'task-1', title: 'Ship the tab column', statusWord: 'open', tone: 'wait', updatedAt: '2026-08-16T09:30:00.000Z' },
  { id: 'task-2', title: 'Retire the merged list', statusWord: 'done', tone: 'idle', updatedAt: '2026-08-16T07:00:00.000Z' },
];

function renderHome(over: Partial<ChatHomeScreenProps> = {}) {
  const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
  return render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      sessions={SESSIONS}
      tasks={TASKS}
      {...over}
    />,
  );
}

describe('Home three-tab column', () => {
  it('D1/D16: Tasks | Chats | Sessions, in that order, labels only — no counts', () => {
    const view = renderHome();
    const tabs = view.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Tasks', 'Chats', 'Sessions']);
  });

  it('D15 default: an uncontrolled mount opens on Chats', async () => {
    const view = renderHome();
    expect(view.getByRole('tab', { name: 'Tasks' }).getAttribute('aria-selected')).toBe('false');
    expect(view.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected')).toBe('true');
    // And the chats list is what renders.
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  });

  it('D2: New chat and New task exist; there is NO New session button', () => {
    const view = renderHome();
    expect(view.getByRole('button', { name: /New chat/ })).toBeTruthy();
    expect(view.getByRole('button', { name: /New task/ })).toBeTruthy();
    expect(view.queryByRole('button', { name: /^Session$/ })).toBeNull();
    expect(view.container.querySelector('.tch-new--session')).toBeNull();
  });

  it('D2 honesty: New task without a wire renders disabled WITH the reason, never hidden', () => {
    const view = renderHome({
      newTaskUnavailable: { cause: 'Creating is not wired here', remedy: 'no executor' },
    });
    const button = view.getByRole('button', { name: /New task/ });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toContain('Creating is not wired here');
  });

  it('D6: switching a tab is BROWSING — it re-lists the column and never touches B', async () => {
    const onShowChat = vi.fn();
    const onSelectEntity = vi.fn();
    const onTab = vi.fn();
    const view = renderHome({ tab: 'chats', onTab, onShowChat, onSelectEntity });
    fireEvent.click(view.getByRole('tab', { name: 'Sessions' }));
    expect(onTab).toHaveBeenCalledWith('sessions');
    // Browsing selected nothing and cleared nothing.
    expect(onShowChat).not.toHaveBeenCalled();
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it('D7: clicking a task or session row SELECTS it into B', () => {
    const onSelectEntity = vi.fn();
    const view = renderHome({ tab: 'tasks', onSelectEntity });
    fireEvent.click(view.getByRole('button', { name: /^Ship the tab column/ }));
    expect(onSelectEntity).toHaveBeenCalledWith('task-1');

    const sessionsView = renderHome({ tab: 'sessions', onSelectEntity });
    fireEvent.click(sessionsView.getByRole('button', { name: /Fix the flaky migration/ }));
    expect(onSelectEntity).toHaveBeenCalledWith('ws-1');
  });

  it('D7 honesty: rows without a selection wire are disabled-with-reason, not dead', () => {
    const view = renderHome({ tab: 'sessions' });
    const row = view.getByRole('button', { name: /Fix the flaky migration/ });
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.getAttribute('title')).toContain('isn’t wired');
  });

  it('D8: an entity in B hides the conversation pane WITHOUT unmounting it', async () => {
    const view = renderHome({
      tab: 'sessions',
      centerOverride: <div data-testid="fake-center">terminal here</div>,
    });
    expect(view.getByTestId('tch-center-override')).toBeTruthy();
    const conversation = view.container.querySelector('.tch-conversation');
    // Still in the tree (mounted — a streaming thread survives)…
    expect(conversation).not.toBeNull();
    // …but honestly hidden.
    expect(conversation?.getAttribute('data-hidden')).toBe('true');
    expect(conversation?.hasAttribute('hidden')).toBe(true);
  });

  it('D9: while an entity occupies B, no chat row draws active', async () => {
    const view = renderHome({
      tab: 'chats',
      selectedEntityId: 'ws-1',
      centerOverride: <div>terminal</div>,
    });
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    expect(view.container.querySelector('.tch-thread[data-active]')).toBeNull();
  });

  it('D9: the active row is per-tab and matches the B subject exactly', () => {
    const view = renderHome({ tab: 'sessions', selectedEntityId: 'ws-1', centerOverride: <div /> });
    const active = view.container.querySelectorAll('.tch-thread[data-active]');
    expect(active).toHaveLength(1);
    expect(active[0].textContent).toContain('Fix the flaky migration');
  });

  it('D10: ＋ New chat takes B AND flips the column to Chats — the one D6 exception', () => {
    const onShowChat = vi.fn();
    const onTab = vi.fn();
    const view = renderHome({ tab: 'sessions', onTab, onShowChat });
    fireEvent.click(view.getByRole('button', { name: /New chat/ }));
    expect(onShowChat).toHaveBeenCalled();
    expect(onTab).toHaveBeenCalledWith('chats');
  });

  it('D10/D3: ＋ New task creates immediately and flips the column to Tasks', () => {
    const onNewTask = vi.fn();
    const onTab = vi.fn();
    const view = renderHome({ tab: 'sessions', onTab, onNewTask });
    fireEvent.click(view.getByRole('button', { name: /New task/ }));
    expect(onNewTask).toHaveBeenCalled();
    expect(onTab).toHaveBeenCalledWith('tasks');
  });

  it('D11: a task row carries Run wired to the host launch sheet', () => {
    const onRunTask = vi.fn();
    const view = renderHome({ tab: 'tasks', onRunTask });
    fireEvent.click(view.getByRole('button', { name: 'Run Ship the tab column' }));
    expect(onRunTask).toHaveBeenCalledWith('task-1');
  });

  it('D4: one search box, scoped to the active tab, never claiming server search', () => {
    const view = renderHome({ tab: 'tasks' });
    const input = view.getByRole('searchbox');
    expect(input.getAttribute('aria-label')).toContain('filters what is already loaded');
    expect(input.getAttribute('title')).toContain('not a server search');
    fireEvent.change(input, { target: { value: 'merged' } });
    expect(view.queryByText('Ship the tab column')).toBeNull();
    expect(view.getByText('Retire the merged list')).toBeTruthy();
  });

  it('D17: another member’s session keeps its view-only label on the Sessions tab', () => {
    const view = renderHome({ tab: 'sessions' });
    expect(view.getByText('view only')).toBeTruthy();
  });

  it('host-composed tile badges render BESIDE the row button, never inside it', () => {
    // PR chips carry real <a> links — an <a> inside a <button> is invalid
    // HTML and breaks both. The badge node must land as a sibling.
    const withBadges: ChatSessionRow[] = [
      {
        ...SESSIONS[0],
        badges: <a href="https://example.test/pr/1" data-testid="fake-pr-chip">#1</a>,
      },
    ];
    const tasksWithBadges: ChatTaskRow[] = [
      { ...TASKS[0], badges: <span data-testid="fake-count-badge">2 docs</span> },
    ];

    const sessionsView = renderHome({ tab: 'sessions', sessions: withBadges });
    const chip = sessionsView.getByTestId('fake-pr-chip');
    expect(chip.closest('button')).toBeNull();
    expect(chip.closest('.tch-tile')).not.toBeNull();

    const tasksView = renderHome({ tab: 'tasks', tasks: tasksWithBadges });
    const count = tasksView.getByTestId('fake-count-badge');
    expect(count.closest('button')).toBeNull();
    expect(count.closest('.tch-tile')).not.toBeNull();
    // And the row itself still selects.
    const onSelectEntity = vi.fn();
    const live = renderHome({ tab: 'tasks', tasks: tasksWithBadges, onSelectEntity });
    fireEvent.click(
      within(live.container).getByRole('button', { name: /^Ship the tab column/ }),
    );
    expect(onSelectEntity).toHaveBeenCalledWith('task-1');
  });

  it('a host renderTabList REPLACES the tab list AND the find box; null keeps both', () => {
    // Uncontrolled tab so the strip itself can browse between the two states.
    const view = renderHome({
      renderTabList: (tab) => (tab === 'tasks' ? <div data-testid="hosted-panel" /> : null),
    });
    fireEvent.click(within(view.container).getByRole('tab', { name: 'Tasks' }));
    // Tasks: the workspace panel takes the whole tab — the built-in rows and
    // this screen's find box stand down (the panel brings its own search).
    expect(within(view.container).getByTestId('tch-hosted-list')).toBeTruthy();
    expect(within(view.container).getByTestId('hosted-panel')).toBeTruthy();
    expect(
      within(view.container).queryByRole('button', { name: /^Ship the tab column/ }),
    ).toBeNull();
    expect(within(view.container).queryByRole('searchbox')).toBeNull();
    // Chats returned null: the built-in column and find box come back.
    fireEvent.click(within(view.container).getByRole('tab', { name: 'Chats' }));
    expect(within(view.container).queryByTestId('tch-hosted-list')).toBeNull();
    expect(within(view.container).getByRole('searchbox')).toBeTruthy();
  });

  it('an unwired tab says so — absent is not an empty list', () => {
    const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} tab="tasks" />,
    );
    expect(view.getByText('Tasks aren’t wired on this surface.')).toBeTruthy();
  });
});
