// @vitest-environment jsdom
/**
 * HOME'S HEADER STOPPED SAYING THE KIND TWICE.
 *
 * The left column drew five stacked rows: the root tabs `[Chats ＋][◫ Tasks ＋ ▾]`,
 * then the hosted list's own kind selector `◫ Tasks ▾`, then search, lifecycle
 * tiers and filters. The second row restated the first — same glyph, same
 * word, and BOTH carets opening a kind menu over one selection — and spent a
 * whole row doing it. The panel now yields that row to the host
 * (`selectorSlot: 'host'`). It used to hand its view switcher up to the header
 * line in exchange; that switcher was removed from every entity list on
 * 2026-08-19, so the header line is now the tablist and the ＋ alone.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. jsdom has no layout engine, so nothing
 * here can count a ROW: `getBoundingClientRect` returns zeros and two controls
 * on one line are indistinguishable from two stacked ones. The row count is
 * measured in a real browser by `e2e/measure-home-header.mjs`, which reports
 * 5 → 4 against a `?legacy=1` control in the same build (164.7px → 129.8px of
 * chrome at the 280px column the grid actually produces).
 *
 * What jsdom CAN prove is everything about identity and wiring, which is where
 * this change could go quietly wrong: that the duplicate is gone, that no
 * switcher came back on either row, and that the layout the host asks for
 * still reaches the list body now that no control writes it.
 */
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { ActionContext } from '../domain';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { EntityListPanel } from '../panels';
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

  it('no switcher on the header line either — it was removed, not relocated again', () => {
    // It DID live here: the panel yielded its header row and handed the
    // control up (task 01a00932). Both halves are gone now, so the assertion
    // is absence on the bar itself rather than absence somewhere in the tree —
    // this is the exact element a reintroduction would land in.
    const view = renderHome({ renderRootList: () => <div data-testid="hosted-panel" /> });
    const bar = view.container.querySelector('.tch-rootbar');
    expect(bar).toBeTruthy();
    expect(within(bar as HTMLElement).queryByTestId('view-switcher')).toBeNull();
    expect(view.queryByTestId('view-switcher')).toBeNull();
  });

  it('the tablist is roots and nothing else — a layout was never a root', () => {
    const view = renderHome({ renderRootList: () => <div data-testid="hosted-panel" /> });
    const tablist = view.getByRole('tablist', { name: 'Home roots' });
    // The hazard the switcher used to carry: every child of a tablist is
    // announced as a tab, and four layout buttons are not four roots. Pinned
    // after the removal too, because the bar is still where a future control
    // would be tempted to land.
    expect(tablist.querySelector('[data-testid="view-switcher"]')).toBeNull();
    expect(view.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chats', 'Tasks']);
  });

  it('the host still decides the layout — the mode prop reaches the body without a control', () => {
    /* WHAT SURVIVED THE REMOVAL. `mode` is route state (`?mode=board`), so it
       still has to cross the seam into the panel; only the control that WROTE
       it is gone. Asserted on the BODY, which is the only thing that can show
       the value arrived. */
    const listed = render(
      <EntityListPanel kind="task" rowsFor={() => tasks} ctx={ctx} selectorSlot="host" compact />,
    );
    expect(listed.container.querySelector('.lp__body .lp__board')).toBeNull();
    expect(listed.queryByTestId('view-switcher')).toBeNull();

    const boarded = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => tasks}
        ctx={ctx}
        selectorSlot="host"
        mode="board"
        boardFor={() => ({ groups: [], nextCursor: null, limit: 50 }) as never}
        compact
      />,
    );
    expect(boarded.container.querySelector('.lp__body .lp__board')).toBeTruthy();
    expect(boarded.queryByTestId('view-switcher')).toBeNull();
  });
});
