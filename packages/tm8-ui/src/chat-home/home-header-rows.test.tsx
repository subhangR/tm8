// @vitest-environment jsdom
/**
 * HOME'S HEADER STOPPED SAYING THE KIND TWICE.
 *
 * The left column drew five stacked rows: the root tabs `[Chats ＋][◫ Tasks ＋ ▾]`,
 * then the hosted list's own kind selector `◫ Tasks ▾`, then search, lifecycle
 * tiers and filters. The second row restated the first — same glyph, same
 * word, and BOTH carets opening a kind menu over one selection — and spent a
 * whole row doing it. The panel now yields that row to the host
 * (`selectorSlot: 'host'`) and hands its view switcher up to the header line.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine, so nothing
 * here can count a ROW: `getBoundingClientRect` returns zeros and two controls
 * on one line are indistinguishable from two stacked ones. The row count is
 * measured in a real browser by `e2e/measure-home-header.mjs`, which reports
 * 5 → 4 against a `?legacy=1` control in the same build (164.7px → 129.8px of
 * chrome at the 280px column the grid actually produces).
 *
 * What jsdom CAN prove is everything about identity and wiring, which is where
 * this change could go quietly wrong: that the duplicate is gone, that the
 * switcher survived rather than being deleted with the row it lived in, that
 * it still drives the list body from its new home, and that it did not get
 * nested inside the tablist on the way up.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { ActionContext, CollectionMode } from '../domain';
import { getKind } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { EntityListPanel, ListViewSwitcher } from '../panels';
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
];
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const tasks = fixtureSummaries.filter((s) => s.state.kind === 'task');

function renderHome(over: Partial<ChatHomeScreenProps> = {}) {
  const { port } = createChatHomeFixturePort([CHAT_HOME_FIXTURE_THREAD]);
  return render(
    <ChatHomeScreen
      port={port}
      spaceId={SPACE_ID}
      models={MODELS}
      root="task"
      kindCell={TASK_CELL}
      rootKindOptions={ROOT_OPTIONS}
      {...over}
    />,
  );
}

describe('Home header rows', () => {
  it('the hosted list draws no kind cell of its own — the header already names the kind', () => {
    const hosted = render(
      <EntityListPanel kind="task" rowsFor={() => tasks} ctx={ctx} selectorSlot="host" compact />,
    );
    // `.lp__kind` IS the duplicate: the panel's own kind button, glyph + plural
    // + caret, which read identically to the header's cell directly above it.
    expect(hosted.container.querySelectorAll('.lp__kind')).toHaveLength(0);
    expect(hosted.container.querySelectorAll('.lp__selector')).toHaveLength(0);
    // Everything BELOW the retired row is untouched — this is a header change,
    // not a list change.
    expect(hosted.getByTestId('list-search')).toBeTruthy();
    expect(hosted.container.querySelector('.lp__tierrow')).toBeTruthy();
    expect(hosted.container.querySelector('.lp__filters')).toBeTruthy();
  });

  it('every other surface keeps its kind cell — `host` is opt-in, and the default is `panel`', () => {
    const standalone = render(<EntityListPanel kind="task" rowsFor={() => tasks} ctx={ctx} />);
    expect(standalone.container.querySelectorAll('.lp__kind')).toHaveLength(1);
    expect(standalone.container.querySelector('.lp__selector')).toBeTruthy();
  });

  it('the switcher MOVED, it was not deleted: it renders on the header line with every position', () => {
    const view = renderHome({
      renderRootList: () => <div data-testid="hosted-panel" />,
      renderRootAside: (root) =>
        root === 'chats' ? null : (
          <ListViewSwitcher config={getKind(root)} mode="list" onMode={() => {}} />
        ),
    });
    const bar = view.container.querySelector('.tch-rootbar');
    expect(bar).toBeTruthy();
    const switcher = within(bar as HTMLElement).getByTestId('view-switcher');
    // All four registry positions survive the move, including the ones that
    // are visible-but-refused — that refusal is the control's whole point (C5),
    // and a host-rolled lookalike is exactly what would lose it.
    expect(switcher.children).toHaveLength(4);
  });

  it('the switcher sits BESIDE the tablist, never inside it — a layout is not a root', () => {
    const view = renderHome({
      renderRootList: () => <div data-testid="hosted-panel" />,
      renderRootAside: () => <ListViewSwitcher config={getKind('task')} mode="list" onMode={() => {}} />,
    });
    const tablist = view.getByRole('tablist', { name: 'Home roots' });
    // Nesting it would make `role="tablist"` a lie: every child of a tablist
    // is announced as a tab, and four layout buttons are not four roots.
    expect(tablist.querySelector('[data-testid="view-switcher"]')).toBeNull();
    expect(view.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chats', 'Tasks']);
  });

  it('Chats gets no switcher — it hosts no list, so there is no layout to switch', () => {
    const view = renderHome({
      root: 'chats',
      renderRootAside: (root) =>
        root === 'chats' ? null : (
          <ListViewSwitcher config={getKind(root)} mode="list" onMode={() => {}} />
        ),
    });
    expect(view.queryByTestId('view-switcher')).toBeNull();
  });

  it('the relocated switcher still drives the body — the lifted mode pair is wired', () => {
    /* THE REGRESSION THIS GUARDS. The panel's mode used to be its own local
       state, which worked because the switcher was inside it. Now the control
       is in the header and the body is in the column, so the value has to be
       lifted — and a lift that only reaches the switcher leaves four buttons
       that highlight themselves and change nothing. Driving the header control
       and asserting the BODY moved is the only thing that separates those. */
    function Host() {
      const [mode, setMode] = useState<CollectionMode>('list');
      return (
        <>
          <ListViewSwitcher config={getKind('task')} mode={mode} onMode={setMode} />
          <EntityListPanel
            kind="task"
            rowsFor={() => tasks}
            ctx={ctx}
            selectorSlot="host"
            mode={mode}
            onMode={setMode}
            boardFor={() => undefined}
            compact
          />
        </>
      );
    }
    const view = render(<Host />);
    expect(view.container.querySelector('.lp__body .lp__board')).toBeNull();

    fireEvent.click(view.getByRole('button', { name: /board/i }));

    /* Asserted on the BODY, not on the switcher's own highlight. The switcher
       is driven by this host's state directly, so `.lp__view--active` would
       read `▥` even if the panel ignored the `mode` prop entirely — that
       assertion cannot fail for the reason the test exists. The board body
       can only appear if the value crossed the seam. */
    expect(view.container.querySelector('.lp__body .lp__board')).toBeTruthy();
  });
});
