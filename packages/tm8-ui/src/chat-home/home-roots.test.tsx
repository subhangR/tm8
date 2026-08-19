// @vitest-environment jsdom
/**
 * Home's ROOT column (task 01a006f8's three-tab column, generalized by task
 * 01a00932 — rulings R3/R4/R5, plus the surviving lettered rulings D6–D10,
 * D15/D16).
 *
 * The header is two cells: [Chats ＋] and [Kind ＋ ▾]. A cell's LABEL
 * switches the root (browsing, D6); its ＋ creates (the D10 exception); the
 * caret menu only ever SWITCHES — picking a kind never creates (R5). Every
 * kind root's list content is the host's `renderRootList` (the workspace's
 * own EntityListPanel); the tab-era built-in task/session rows are retired.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatHomeScreen, type ChatHomeScreenProps } from './ChatHomeScreen';
import type { ListRootOption } from '../panels/ListRootHeader';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from './fixtures';
import type { ChatModelOption } from './types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code' },
];

const TASK_CELL: ListRootOption = { kind: 'task', label: 'Tasks', single: 'Task' };
const ROOT_OPTIONS: ListRootOption[] = [
  TASK_CELL,
  { kind: 'work_session', label: 'Sessions', single: 'Session' },
  { kind: 'doc', label: 'Docs', single: 'Doc' },
];

function renderHome(over: Partial<ChatHomeScreenProps> = {}) {
  const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
  return render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      kindCell={TASK_CELL}
      rootKindOptions={ROOT_OPTIONS}
      {...over}
    />,
  );
}

describe('Home root column', () => {
  it('R5/D16: the header is [Chats ＋][Kind ＋ ▾] — two root tabs, labels only, no counts', () => {
    const view = renderHome();
    const tabs = view.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Chats', 'Tasks']);
    expect(view.getByRole('button', { name: 'New chat' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'New task' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Choose which list to show' })).toBeTruthy();
  });

  it('D15 default: an uncontrolled mount opens on Chats', async () => {
    const view = renderHome();
    expect(view.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('tab', { name: /Tasks/ }).getAttribute('aria-selected')).toBe('false');
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
  });

  it('D6: the kind cell LABEL switches the root — it re-lists the column and never touches B', () => {
    const onRoot = vi.fn();
    const onShowChat = vi.fn();
    const onSelectEntity = vi.fn();
    const view = renderHome({ root: 'chats', onRoot, onShowChat, onSelectEntity });
    fireEvent.click(view.getByRole('tab', { name: /Tasks/ }));
    expect(onRoot).toHaveBeenCalledWith('task');
    expect(onShowChat).not.toHaveBeenCalled();
    expect(onSelectEntity).not.toHaveBeenCalled();
  });

  it('R5: picking a kind from the caret menu SWITCHES the root and never creates', () => {
    const onRoot = vi.fn();
    const onNewEntity = vi.fn();
    const view = renderHome({ root: 'task', onRoot, onNewEntity });
    fireEvent.click(view.getByRole('button', { name: 'Choose which list to show' }));
    const menu = view.getByRole('menu', { name: 'Entity lists' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Tasks', 'Sessions', 'Docs']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Docs' }));
    expect(onRoot).toHaveBeenCalledWith('doc');
    expect(onNewEntity).not.toHaveBeenCalled();
    // The menu closed on pick.
    expect(view.queryByRole('menu', { name: 'Entity lists' })).toBeNull();
  });

  it('D10/D3: the kind cell ＋ creates immediately AND lands the column on its root', () => {
    const onNewEntity = vi.fn();
    const onRoot = vi.fn();
    const view = renderHome({ root: 'chats', onRoot, onNewEntity });
    fireEvent.click(view.getByRole('button', { name: 'New task' }));
    expect(onNewEntity).toHaveBeenCalled();
    expect(onRoot).toHaveBeenCalledWith('task');
  });

  it('D10: ＋ New chat takes B AND flips the column to Chats — the one D6 exception', () => {
    const onShowChat = vi.fn();
    const onRoot = vi.fn();
    const view = renderHome({ root: 'task', onRoot, onShowChat });
    fireEvent.click(view.getByRole('button', { name: 'New chat' }));
    expect(onShowChat).toHaveBeenCalled();
    expect(onRoot).toHaveBeenCalledWith('chats');
  });

  /**
   * THE MENU'S PER-ROW ＋ (user ruling 2026-08-19).
   *
   * This NARROWS R5 rather than reversing it — the row's LABEL still only ever
   * switches, which the test above pins. What is new is a SECOND control per
   * row, so making a doc from a list of tasks costs one press instead of
   * switch-then-find-the-＋.
   *
   * The rows are queried by `aria-label` and never by position: the birth
   * control is deliberately not a `menuitem` (the label is the menu item), so
   * a positional query would silently start reading the label the day the
   * order changed.
   */
  describe('the kind menu’s per-row birth verb', () => {
    const openMenu = (view: ReturnType<typeof renderHome>) => {
      fireEvent.click(view.getByRole('button', { name: 'Choose which list to show' }));
      return within(view.getByRole('menu', { name: 'Entity lists' }));
    };

    it('every row carries one, and SESSIONS carry a terminal rather than a ＋', () => {
      const view = renderHome({ root: 'task', onCreateKind: vi.fn() });
      const menu = openMenu(view);
      expect(menu.getByRole('button', { name: 'New task' })).toBeTruthy();
      expect(menu.getByRole('button', { name: 'New doc' })).toBeTruthy();
      /* Sessions are STARTED, not authored — the registry says so through
         `list.quickStart`, and the row wears that verb's own label. A ＋ here
         would promise an entity this flow cannot make. */
      expect(menu.queryByRole('button', { name: 'New session' })).toBeNull();
      expect(menu.getByRole('button', { name: 'Terminal' })).toBeTruthy();
    });

    it('pressing a row’s ＋ births THAT kind and lands the column on its root', () => {
      const onCreateKind = vi.fn();
      const onRoot = vi.fn();
      const view = renderHome({ root: 'task', onRoot, onCreateKind });
      fireEvent.click(openMenu(view).getByRole('button', { name: 'New doc' }));
      expect(onCreateKind).toHaveBeenCalledWith('doc');
      /* D10, same as the cell's ＋: a new doc landing in a list of tasks would
         be a row the column cannot show. */
      expect(onRoot).toHaveBeenCalledWith('doc');
      expect(view.queryByRole('menu', { name: 'Entity lists' })).toBeNull();
    });

    it('honesty per row: a refused kind is disabled WITH its reason and does not fire', () => {
      const onCreateKind = vi.fn();
      const view = renderHome({
        root: 'task',
        onCreateKind,
        createKindUnavailable: (kind) =>
          kind === 'doc' ? { cause: 'Docs aren’t created from here', remedy: 'ask an owner' } : null,
      });
      const menu = openMenu(view);
      const refused = menu.getByRole('button', { name: 'New doc' });
      expect(refused.getAttribute('aria-disabled')).toBe('true');
      expect(refused.getAttribute('title')).toContain('Docs aren’t created from here');
      fireEvent.click(refused);
      expect(onCreateKind).not.toHaveBeenCalled();
      /* Its neighbour is unaffected — one refused kind must not refuse the menu. */
      expect(menu.getByRole('button', { name: 'New task' }).getAttribute('aria-disabled')).toBeNull();
    });

    it('an unwired host draws NO row controls — one refusal on the cell, not fourteen in a popover', () => {
      const view = renderHome({ root: 'task' });
      const menu = openMenu(view);
      expect(menu.queryByRole('button', { name: 'New doc' })).toBeNull();
      /* The cell's own ＋ still says it, once, out loud. */
      expect(view.getByRole('button', { name: 'New task' })).toBeTruthy();
    });

    it('the CELL wears the same verb its menu row does — a sessions cell is a terminal', () => {
      const view = renderHome({
        root: 'work_session',
        kindCell: { kind: 'work_session', label: 'Sessions', single: 'Session' },
        onNewEntity: vi.fn(),
      });
      expect(view.queryByRole('button', { name: 'New session' })).toBeNull();
      expect(view.getByRole('button', { name: 'Terminal' })).toBeTruthy();
    });
  });

  it('honesty: the kind ＋ without a wire renders disabled WITH the reason, never hidden', () => {
    const view = renderHome({
      newEntityUnavailable: { cause: 'Creating is not wired here', remedy: 'no executor' },
    });
    const button = view.getByRole('button', { name: 'New task' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toContain('Creating is not wired here');
  });

  it('a kind root mounts the host renderRootList and stands the find box down', () => {
    const view = renderHome({
      root: 'task',
      renderRootList: (root) => (root === 'task' ? <div data-testid="hosted-panel" /> : null),
    });
    expect(view.getByTestId('tch-hosted-list')).toBeTruthy();
    expect(view.getByTestId('hosted-panel')).toBeTruthy();
    expect(view.queryByRole('searchbox')).toBeNull();
  });

  it('a kind root with no hosted list says so — absent is not an empty list', () => {
    const view = renderHome({ root: 'task' });
    expect(view.getByText('This list isn’t wired on this surface.')).toBeTruthy();
  });

  it('D4 survives on Chats: one find box, filtering only what is loaded', async () => {
    const view = renderHome({ root: 'chats' });
    const input = view.getByRole('searchbox');
    expect(input.getAttribute('aria-label')).toContain('filters what is already loaded');
    expect(input.getAttribute('title')).toContain('not a server search');
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    fireEvent.change(input, { target: { value: 'zzz-no-match' } });
    /* The ROW is filtered out of the column; the open conversation's own
       header keeps its title — the filter touches the list, not region B. */
    expect(view.container.querySelector('.tch-thread-list .tch-thread')).toBeNull();
    expect(view.getByText('Nothing loaded here matches.')).toBeTruthy();
  });

  it('D8 revised (Cockpit 2026-08-18): an entity in B hides the TRANSCRIPT without unmounting it — but nothing of the chat is DRAWN', () => {
    const view = renderHome({
      root: 'task',
      centerOverride: <div data-testid="fake-center">terminal here</div>,
    });
    expect(view.getByTestId('tch-center-override')).toBeTruthy();
    // The transcript hides but keeps its mount — D8's reason is unchanged: a
    // streaming thread must not tear down while you look at something else.
    const conversation = view.container.querySelector('.tch-conversation');
    expect(conversation).not.toBeNull();
    expect(conversation?.hasAttribute('hidden')).toBe(false);
    const transcript = view.container.querySelector('.tch-transcript');
    expect(transcript).not.toBeNull();
    expect(transcript?.getAttribute('data-hidden')).toBe('true');
    expect(transcript?.hasAttribute('hidden')).toBe(true);
    /* WHAT CHANGED (task 01a017d3): the bottom berth no longer stays. The
       first pass kept the tray there as the way back; the user's answer to
       shipping that was `why still the chat, fleet, graph is showing at the
       bottom`. Hidden-not-unmounted is about the TRANSCRIPT's state, and it
       never required drawing the chat's chrome around someone else's panel. */
    expect(view.container.querySelector('.tch-composer-wrap')).toBeNull();
    expect(view.queryByTestId('chat-entity-tray')).toBeNull();
  });

  it('D9: while an entity occupies B, no chat row draws active', async () => {
    const view = renderHome({
      root: 'chats',
      selectedEntityId: 'ws-1',
      centerOverride: <div>terminal</div>,
    });
    await waitFor(() => expect(view.getByText('Plan the launch sequence')).toBeTruthy());
    expect(view.container.querySelector('.tch-thread[data-active]')).toBeNull();
  });

  it('the slots foot draws a real cap as a fraction, and absence as nothing', () => {
    const view = renderHome({ slots: { used: 3, total: 8 } });
    expect(view.getByText('3/8')).toBeTruthy();
    expect(view.container.querySelector('.tch-slots__bar')).not.toBeNull();

    const bare = renderHome();
    expect(bare.container.querySelector('.tch-slots')).toBeNull();
  });

  it('an uncapped node (int4-max sentinel total) never renders the sentinel as a denominator', () => {
    const view = renderHome({ slots: { used: 9, total: 2_147_483_647 } });
    expect(view.getByText('9 in use · no cap')).toBeTruthy();
    expect(view.container.querySelector('.tch-slots__bar')).toBeNull();
    expect(view.container.textContent).not.toContain('2147483647');
  });
});
