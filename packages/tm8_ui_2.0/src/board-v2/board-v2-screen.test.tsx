// @vitest-environment jsdom
/**
 * BOARD V2, MOUNTED — GateApp over the fixture seam at `#/s/{s}/board-v2`,
 * the same harness the v1 board proved. What these cases pin:
 *
 *  · the closed category skeleton in reading order, every column a REAL
 *    `filters.category` read (the fixture applies the predicate for real);
 *  · the kind selector making the board universal: a kind that carries no
 *    status WORD still lands under a real category — phase 5 (migration 152)
 *    gave every kind a status and refuses to apply while any row lacks one —
 *    and the categories it is NOT in stay empty rather than borrowing it. The
 *    'No status yet' column is a pre-phase-5 vestige and now renders for no
 *    kind, which is why it is asserted ABSENT rather than populated;
 *  · a real drag commit for tasks THROUGH the category drop seam (fallback
 *    'open', since the fixture space resolves to the global default);
 *  · a REFUSED move for a kind that cannot move yet — visible, with the
 *    reason, never a silent no-op;
 *  · archived as a FILTER that reaches the seam, never a column;
 *  · workflow columns: the global default's states, banded by category.
 *
 * Fixture dataset (fixtures/entities.ts), non-deleted tasks — all three sit
 * in `in_progress` under the ruled mapping:
 *   '4f8c2a9e…'                              in_review → in_progress
 *   'Session tree guide lines'               working   → in_progress
 *   'Wire palette to real command registry'  blocked   → in_progress
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { createFixtureSeam } from '../data';
import type { Seam } from '../data/seam';
import { FIXTURE_SPACE_ID, taskUuidTitle } from '../fixtures';

const SPACE = FIXTURE_SPACE_ID;
const GUIDE = 'Session tree guide lines';
const CATEGORY_KEYS = ['to_do', 'in_progress', 'done', 'cancelled'];

/** The router-mount storage double — this runner's localStorage lacks setItem. */
function installStorage(): void {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
}

beforeEach(() => {
  installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
});

afterEach(() => {
  cleanup();
});

async function mountBoard(seam?: Seam): Promise<RenderResult> {
  const view = render(
    <GateApp
      routerTarget={createMemoryTarget(`#/s/${SPACE}/board-v2`)}
      {...(seam ? { seam } : {})}
    />,
  );
  await waitFor(() => view.getByTestId('board-v2-screen'));
  // Loaded, not just mounted: skeletons gone means the first reads answered.
  await waitFor(() => expect(view.queryAllByTestId('b2-skeleton')).toHaveLength(0));
  return view;
}

const columnKeys = (view: RenderResult): string[] =>
  view.getAllByTestId('b2-column').map((c) => c.getAttribute('data-column') ?? '');

/** Every axis is a dropdown: its options do not exist until it is open. */
const openAxis = (view: RenderResult, testId: string) => {
  fireEvent.click(view.getByTestId(testId));
  return view.getByTestId(`${testId}-menu`);
};

const column = (view: RenderResult, key: string) => {
  const col = view.getAllByTestId('b2-column').find((c) => c.getAttribute('data-column') === key);
  expect(col).toBeDefined();
  return within(col!);
};

const cardButton = (view: RenderResult, title: string): HTMLButtonElement =>
  view.getByRole('button', { name: title }) as HTMLButtonElement;

describe('the category board', () => {
  it('renders the closed four in reading order; empty categories included, no uncategorised column for a fully-categorised kind', async () => {
    const view = await mountBoard();
    /* The uncategorised column earns its width only when it has something to
       say — every fixture task carries a category, so it must be absent. */
    expect(columnKeys(view)).toEqual(CATEGORY_KEYS);
    // Cards landed where the SERVER's category says; empties say so in words.
    // `to_do` HOLDS A CARD NOW (`taskQueued`, added with the four category
    // tabs — the fixtures had no unstarted task at all), so the empty-column
    // sentence is measured on `cancelled`, whose only member is archived.
    expect(column(view, 'in_progress').getByText(GUIDE)).toBeTruthy();
    expect(column(view, 'to_do').getByText('Name the empty states')).toBeTruthy();
    expect(column(view, 'cancelled').getByText('nothing in Cancelled')).toBeTruthy();
    view.unmount();
  });

  it('the title search narrows cards without touching the seam', async () => {
    const view = await mountBoard();
    fireEvent.change(view.getByLabelText('Filter cards by title'), { target: { value: 'guide' } });
    await waitFor(() => expect(view.getAllByTestId('b2-card')).toHaveLength(1));
    expect(view.getByText(GUIDE)).toBeTruthy();
    view.unmount();
  });

  it('COMMITS a drag: optimistic move, real write through the category drop seam, fresh read agrees', async () => {
    const view = await mountBoard();
    const card = view.getAllByTestId('b2-card').find((c) => c.textContent?.includes(GUIDE))!;
    const target = view
      .getAllByTestId('b2-column')
      .find((c) => c.getAttribute('data-column') === 'to_do')!;

    const dataTransfer = {
      data: new Map<string, string>(),
      setData(type: string, v: string) {
        this.data.set(type, v);
      },
      getData(type: string) {
        return this.data.get(type) ?? '';
      },
      effectAllowed: 'move',
      dropEffect: 'move',
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    // Optimistically there at once…
    expect(column(view, 'to_do').getByText(GUIDE)).toBeTruthy();
    /* …and STILL there once the write's event-driven re-read lands (the seam
       wrote `open`, the ruled mapping derives to_do) with the source column
       empty of it — a refused write would have snapped it home, so
       persistence through settle IS the commit evidence. */
    await waitFor(() => {
      expect(column(view, 'to_do').getByText(GUIDE)).toBeTruthy();
      expect(column(view, 'in_progress').queryByText(GUIDE)).toBeNull();
    });
    view.unmount();
  });

  it('§8.1 — mod+arrow moves the focused card through the SAME dispatch', async () => {
    const view = await mountBoard();
    const trigger = cardButton(view, GUIDE);
    act(() => trigger.focus());
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowLeft', ctrlKey: true });
    await waitFor(() => {
      expect(column(view, 'to_do').getByText(GUIDE)).toBeTruthy();
      expect(column(view, 'in_progress').queryByText(GUIDE)).toBeNull();
    });
    view.unmount();
  });
});

describe('the universal kind selector', () => {
  it('a kind carrying no status WORD still lands under a real category — after phase 5 there is no statusless kind', async () => {
    const view = await mountBoard();
    openAxis(view, 'b2-kind');
    fireEvent.click(view.getByTestId('b2-kind-doc'));
    /*
     * THIS CASE ASSERTED THE OPPOSITE AND IS REVERSED DELIBERATELY, not
     * loosened and not deleted. It read: "a statusless kind shows its rows in
     * the honest No-status-yet column, and nothing borrows a category", on the
     * premise that a kind whose rows carry no status word has no category for
     * the four reads to match.
     *
     * PHASE 5 (migration 152) ended that premise, and the record of the
     * reversal belongs here because this case IS where the old one was
     * written down. Birth widened from `kind = 'task'` to EVERY kind, the
     * backfill gave every pre-existing row of every kind a status, and the
     * migration REFUSES TO APPLY while any row still has a null
     * `status_category`:
     *
     *     raise exception '152: % entities have a status but no category'
     *
     * So a doc HAS a category on any live node — `to_do`, its seed, since docs
     * are not one of the facts-about-the-past kinds — and the fixture says so
     * too now that `categoryOf` mirrors 152's seeding table instead of
     * modelling a phase-1 node.
     *
     * The uncategorised column therefore earns no width here, for exactly the
     * reason it earns none on a fully-categorised task board above: it renders
     * only when it has something to say. That it is now silent for EVERY kind
     * is the honest report, not a regression.
     */
    await waitFor(() => expect(columnKeys(view)).toEqual(CATEGORY_KEYS));
    await waitFor(() =>
      expect(column(view, 'to_do').getAllByTestId('b2-card').length).toBeGreaterThan(0));
    // And still nothing BORROWS: the categories no doc is in stay empty, which
    // is the half of the original assertion that survives phase 5 unchanged.
    expect(column(view, 'in_progress').queryAllByTestId('b2-card')).toHaveLength(0);
    expect(column(view, 'done').queryAllByTestId('b2-card')).toHaveLength(0);
    view.unmount();
  });

  it('a kind that cannot move yet REFUSES the drop visibly — with the reason, not a silent no-op', async () => {
    const view = await mountBoard();
    openAxis(view, 'b2-kind');
    fireEvent.click(view.getByTestId('b2-kind-doc'));
    await waitFor(() =>
      expect(column(view, 'to_do').getAllByTestId('b2-card').length).toBeGreaterThan(0));

    /* THE COLUMN MOVED, THE ASSERTION DID NOT. This walked four columns right
       to reach 'No status yet' and pushed LEFT out of it. Docs sit in To Do
       now — their phase-5 seed — and To Do is where focus already is, because
       a kind switch resets it to {col: 0, row: 0} (BoardV2Screen.tsx:203). So
       the push is one step RIGHT, into In Progress.

       What is being pinned is unchanged and is the whole point of the case:
       docs have a status since phase 5 but no settable CONTROL yet, so the
       move must REFUSE VISIBLY WITH ITS REASON rather than no-op. The comment
       this case already carried — "docs have a status from phase 5 (migration
       152) but no settable CONTROL yet" — was true when it was written and
       sat one line under an assertion that docs were uncategorised. Only one
       of those two could be right. */
    const trigger = within(column(view, 'to_do').getAllByTestId('b2-card')[0]!).getByRole('button');
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowRight', ctrlKey: true });
    const refusal = await waitFor(() => view.getByTestId('b2-refusal'));
    expect(refusal.textContent).toMatch(/no settable control yet/i);
    // And nothing moved: every doc still sits in To Do.
    expect(column(view, 'in_progress').queryAllByTestId('b2-card')).toHaveLength(0);
    view.unmount();
  });
});

describe('archived is a filter, never a column', () => {
  it('the toggle swaps the whole board onto `deleted: only` through the seam', async () => {
    const view = await mountBoard();
    expect(columnKeys(view)).toEqual(CATEGORY_KEYS);
    fireEvent.click(view.getByTestId('b2-filter-archived'));
    /* The live GUIDE task is not archived, so it must leave the board — proof
       the filter reached the seam — and the columns stay the categories:
       archived never becomes one. */
    await waitFor(() => expect(view.queryByText(GUIDE)).toBeNull());
    expect(columnKeys(view).every((k) => k !== 'archived')).toBe(true);
    fireEvent.click(view.getByTestId('b2-filter-archived'));
    await waitFor(() => expect(view.getByText(GUIDE)).toBeTruthy());
    view.unmount();
  });
});

describe('workflow columns', () => {
  it('the resolved workflow’s states become the columns, banded by category, cards placed by real reads', async () => {
    const view = await mountBoard();
    /* The fixture space defines no task workflows, so the kind resolves to
       the ONE global default — four display-named states, one per category,
       exactly queryable through the category predicate itself. */
    const toggle = await waitFor(() => {
      const t = view.getByTestId('b2-workflow-toggle');
      expect(t.tagName).toBe('BUTTON');
      return t;
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(columnKeys(view)).toEqual([
        'wfs-default-to_do',
        'wfs-default-in_progress',
        'wfs-default-done',
        'wfs-default-cancelled',
      ]));
    expect(view.getAllByTestId('b2-col-band').length).toBe(4);
    expect(column(view, 'wfs-default-in_progress').getByText(GUIDE)).toBeTruthy();
    view.unmount();
  });
});

describe('the client-appended tab', () => {
  it('is the only Board tab, sits after Work, opens v2, and reads current there', async () => {
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/home`)} />);
    await waitFor(() => view.getByTestId('space-tab-bar'));
    const tabs = view.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs.filter((label) => label === 'Board')).toHaveLength(1);
    expect(tabs.indexOf('Board')).toBe(tabs.indexOf('Work') + 1);
    expect(tabs).not.toContain('Board v2');

    fireEvent.click(view.getByRole('tab', { name: 'Board' }));
    await waitFor(() => view.getByTestId('board-v2-screen'));
    expect(view.getByRole('tab', { name: 'Board' }).getAttribute('aria-selected')).toBe('true');
    view.unmount();
  });
});

describe('a card opens its entity ON the board', () => {
  it('uses the Astryx Card root without losing tm8 list, drag, or containment hooks', async () => {
    const view = await mountBoard();
    const card = view.getAllByTestId('b2-card')[0]!;

    expect(card.classList.contains('astryx-card')).toBe(true);
    expect(card.getAttribute('data-variant')).toBe('default');
    expect(card.getAttribute('role')).toBe('listitem');
    expect(card.getAttribute('draggable')).toBe('true');
    expect(card.getAttribute('data-entity')).toBeTruthy();
    expect(within(card).getByRole('button')).toBeTruthy();
    expect(view.getByLabelText('Tasks board').getAttribute('role')).toBe('region');
    view.unmount();
  });

  it('keeps roving state on the actually focused card trigger', async () => {
    const view = await mountBoard();
    const queued = cardButton(view, 'Name the empty states');
    act(() => queued.focus());

    fireEvent.keyDown(queued, { key: 'ArrowRight' });

    const focused = await waitFor(() => {
      expect(document.activeElement).not.toBe(queued);
      return document.activeElement as HTMLElement;
    });
    expect(focused.matches('[data-b2-card-trigger]')).toBe(true);
    expect(focused).not.toBe(queued);
    expect(focused.closest('[data-column="in_progress"]')).not.toBeNull();
    expect(focused.closest('[data-testid="b2-card"]')?.classList.contains('b2__card--focused')).toBe(true);
    view.unmount();
  });

  it('tracks the moving entity, blocks a pending repeat, announces it, then moves it again', async () => {
    const base = createFixtureSeam();
    const realWork = base.commands.work.bind(base.commands);
    let releaseWrite: (() => void) | undefined;
    const seam: Seam = {
      ...base,
      commands: {
        ...base.commands,
        work: (...args: Parameters<typeof base.commands.work>) =>
          new Promise((resolve, reject) => {
            releaseWrite = () => void realWork(...args).then(resolve, reject);
          }),
      },
    };
    const view = await mountBoard(seam);
    let trigger = cardButton(view, GUIDE);
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowLeft', ctrlKey: true });

    trigger = cardButton(view, GUIDE);
    const pendingCard = trigger.closest('[data-testid="b2-card"]')!;
    expect(pendingCard.getAttribute('draggable')).toBe('false');
    expect(pendingCard.getAttribute('aria-busy')).toBe('true');
    expect(view.getByTestId('b2-move-status').textContent).toMatch(/^Moving /);

    // A second command while the first write is live does not retarget from
    // the optimistic column or launch another write.
    fireEvent.keyDown(trigger, { key: 'ArrowRight', ctrlKey: true });
    expect(column(view, 'to_do').getByText(GUIDE)).toBeTruthy();
    expect(view.getByTestId('b2-move-status').textContent).toMatch(/already moving/i);

    expect(releaseWrite).toBeTypeOf('function');
    releaseWrite!();
    await waitFor(() => expect(cardButton(view, GUIDE).closest('[data-testid="b2-card"]')?.getAttribute('draggable')).toBe('true'));
    expect(view.getByTestId('b2-move-status').textContent).toMatch(/^Moved /);

    trigger = cardButton(view, GUIDE);
    act(() => trigger.focus());
    fireEvent.keyDown(trigger, { key: 'ArrowRight', ctrlKey: true });
    await waitFor(() => expect(column(view, 'in_progress').getByText(GUIDE)).toBeTruthy());
    expect(document.activeElement?.getAttribute('data-entity')).toBe(trigger.getAttribute('data-entity'));
    view.unmount();
  });

  it('renders the summary metadata matrix structurally from fields, not task-specific branches', async () => {
    const view = await mountBoard();
    const card = cardButton(view, taskUuidTitle.title).closest('[data-testid="b2-card"]')!;

    expect(within(card).getByText('urgent').classList.contains('astryx-badge')).toBe(true);
    expect(card.querySelector('.b2__card-due time')).not.toBeNull();
    const progress = within(card).getByRole('progressbar', { name: 'Acceptance: 2 of 4 met' });
    expect(progress.getAttribute('aria-valuenow')).toBe('2');
    expect(progress.getAttribute('aria-valuemax')).toBe('4');
    expect(within(card).getByText('2/4')).toBeTruthy();
    expect(within(card).getByTestId('avatar-stack').children).toHaveLength(2);
    view.unmount();
  });

  it('omits the default medium priority while keeping exceptional priority visible', async () => {
    const view = await mountBoard();
    const defaultCard = cardButton(view, GUIDE).closest('[data-testid="b2-card"]')!;
    const urgentCard = cardButton(view, taskUuidTitle.title).closest('[data-testid="b2-card"]')!;

    expect(within(defaultCard).queryByText('medium')).toBeNull();
    expect(within(urgentCard).getByText('urgent').classList.contains('astryx-badge')).toBe(true);
    view.unmount();
  });

  it('renders Astryx ProgressBar under a div wrapper, never invalid span > div markup', async () => {
    const view = await mountBoard();
    const progress = view.getAllByRole('progressbar')[0]!;
    const wrapper = progress.closest('.b2__card-accept');
    expect(wrapper?.tagName).toBe('DIV');
    expect(wrapper?.querySelector(':scope > div')).not.toBeNull();
    view.unmount();
  });

  it('presses a card into the shared detail panel WITHOUT leaving the board, and Esc gives the board back', async () => {
    const view = await mountBoard();
    expect(view.queryByTestId('b2-entity-panel')).toBeNull();

    /* The state the old handoff destroyed: a board narrowed to one card. If
       pressing it navigates, this search box is gone with the screen. */
    fireEvent.change(view.getByLabelText('Filter cards by title'), { target: { value: 'guide' } });
    await waitFor(() => expect(view.getAllByTestId('b2-card')).toHaveLength(1));

    const opener = cardButton(view, GUIDE);
    act(() => opener.focus());
    fireEvent.click(opener);

    // The panel is open, and the board it opened over is still underneath.
    const panel = await waitFor(() => view.getByTestId('b2-entity-panel'));
    expect(panel.getAttribute('aria-labelledby')).toBe('b2-entity-panel-title');
    expect(document.activeElement).toBe(panel);
    expect(view.getByTestId('board-v2-screen')).toBeTruthy();
    expect(columnKeys(view)).toEqual(CATEGORY_KEYS);
    expect((view.getByLabelText('Filter cards by title') as HTMLInputElement).value).toBe('guide');
    // It is the app's ONE panel, not a board-local summary.
    await waitFor(() =>
      expect(within(view.getByTestId('b2-entity-panel')).getAllByText(GUIDE).length)
        .toBeGreaterThan(0),
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(view.queryByTestId('b2-entity-panel')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(view.getByTestId('board-v2-screen')).toBeTruthy();
    view.unmount();
  });

  it('does not steal hjkl, arrows, or Enter from editable descendants in the detail panel', async () => {
    const view = await mountBoard();
    const opener = cardButton(view, GUIDE);
    fireEvent.click(opener);
    const panel = await waitFor(() => view.getByTestId('b2-entity-panel'));
    const editor = document.createElement('input');
    panel.append(editor);
    editor.focus();

    for (const key of ['h', 'j', 'k', 'l', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter']) {
      expect(fireEvent.keyDown(editor, { key })).toBe(true);
      expect(document.activeElement).toBe(editor);
      expect(view.getByTestId('b2-entity-panel')).toBe(panel);
    }
    expect(column(view, 'in_progress').getByText(GUIDE)).toBeTruthy();
    view.unmount();
  });

  it('publishes the column count so the panel can be exactly one column wide', async () => {
    const view = await mountBoard();
    const stage = view.getByTestId('board-v2-screen').querySelector('.b2__stage') as HTMLElement;
    // Four category columns ⇒ the panel's width calc divides by four.
    expect(stage.style.getPropertyValue('--b2-cols')).toBe(String(CATEGORY_KEYS.length));
    view.unmount();
  });
});

describe('the create control', () => {
  it('renders a live + New control that follows the selected kind', async () => {
    const view = await mountBoard();
    const control = view.getByTestId('b2-new-task');
    expect(control.tagName).toBe('BUTTON');
    expect(control.textContent).toContain('New task');
    openAxis(view, 'b2-kind');
    fireEvent.click(view.getByTestId('b2-kind-doc'));
    await waitFor(() => expect(view.getByTestId('b2-new-task').textContent).toContain('New doc'));
    view.unmount();
  });
});

// ===========================================================================
// THE TIMELINE VIEW (owner request 2026-08-31), MOUNTED
// ===========================================================================
//
// WHAT THESE CASES CAN AND CANNOT PROVE. vitest here runs with `css: false`,
// so none of them sees a stylesheet: nothing below claims a bar LOOKS dashed
// or that a colour rendered. What they pin is the STRUCTURE the stylesheet
// keys on — `data-inferred`, `data-stated`, `data-tone`, and the sentence on
// `title`/`aria-label` — plus the wiring: which view is default, that
// switching keeps the board's state, and that the strip's numbers are the
// board's own. The rules themselves are asserted as source in
// `board-timeline-style.test.ts`.

const showTimeline = (view: RenderResult) => {
  fireEvent.click(view.getByTestId('b2-view-timeline'));
  return view.getByTestId('b2-timeline');
};

const barFor = (view: RenderResult, title: string): HTMLElement => {
  const row = view
    .getAllByTestId('b2tl-row')
    .find((node) => node.textContent?.includes(title));
  expect(row, `timeline row for ${title}`).toBeDefined();
  const id = row!.getAttribute('data-entity');
  const bar = view
    .getAllByTestId('b2tl-bar')
    .find((node) => node.getAttribute('data-entity') === id);
  expect(bar, `bar for ${title}`).toBeDefined();
  return bar!;
};

describe('the view switch', () => {
  it('offers Columns and Timeline on the board\'s OWN header, with Columns the default', async () => {
    const view = await mountBoard();
    expect(view.getByTestId('b2-view-columns').getAttribute('aria-pressed')).toBe('true');
    expect(view.getByTestId('b2-view-timeline').getAttribute('aria-pressed')).toBe('false');
    expect(view.queryByTestId('b2-timeline')).toBeNull();
    expect(view.getAllByTestId('b2-column').length).toBeGreaterThan(0);
    view.unmount();
  });

  it('swaps the surface without unmounting the board, and swaps back', async () => {
    const view = await mountBoard();
    showTimeline(view);
    expect(view.queryAllByTestId('b2-column')).toHaveLength(0);
    expect(view.getByTestId('b2-view-timeline').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(view.getByTestId('b2-view-columns'));
    expect(view.queryByTestId('b2-timeline')).toBeNull();
    expect(columnKeys(view)).toEqual(CATEGORY_KEYS);
    view.unmount();
  });

  it('KEEPS the question when it changes the shape of the answer: the search survives the switch', async () => {
    const view = await mountBoard();
    fireEvent.change(view.getByLabelText('Filter cards by title'), { target: { value: 'guide' } });
    await waitFor(() => expect(view.getAllByTestId('b2-card')).toHaveLength(1));
    showTimeline(view);
    // One row, and it is the one the search left standing.
    expect(view.getAllByTestId('b2tl-row')).toHaveLength(1);
    expect(view.getAllByTestId('b2tl-row')[0]!.textContent).toContain(GUIDE);
    view.unmount();
  });

  it('a timeline row opens the SAME panel a card does', async () => {
    const view = await mountBoard();
    showTimeline(view);
    fireEvent.click(view.getByRole('button', { name: GUIDE }));
    await waitFor(() => view.getByTestId('b2-entity-panel'));
    // …and the timeline is still behind it, which is the whole point.
    expect(view.getByTestId('b2-timeline')).toBeTruthy();
    view.unmount();
  });
});

describe('the timeline itself', () => {
  it('draws a dated axis with today on it, inside its own horizontal scroller', async () => {
    const view = await mountBoard();
    showTimeline(view);
    const scroll = view.getByTestId('b2tl-scroll');
    expect(scroll).toBeTruthy();
    // Today is marked once, not per row and not never.
    expect(view.getAllByTestId('b2tl-today')).toHaveLength(1);
    /* THE TODAY RULE SPANS EVERY ROW, counted rather than `-1`: the body rows
       are IMPLICIT grid rows, and `-1` resolves against the explicit grid —
       which declares none — so it would collapse onto the axis header alone. */
    const rule = view.getByTestId('b2tl-todayrule');
    const rows = view.getAllByTestId('b2tl-row').length;
    const groups = view.getAllByTestId('b2tl-group').length;
    const empties = view.getAllByTestId('b2tl-group').length; // one line each, empty or not
    expect(rule.style.gridRow).not.toContain('-1');
    expect(Number(rule.style.gridRow.split('/')[1]!.trim()))
      .toBeGreaterThanOrEqual(1 + rows + groups);
    expect(empties).toBeGreaterThan(0);
    view.unmount();
  });

  it('groups by the board\'s OWN columns, so both views answer the same question', async () => {
    const view = await mountBoard();
    showTimeline(view);
    expect(view.getAllByTestId('b2tl-group').map((g) => g.getAttribute('data-group')))
      .toEqual(CATEGORY_KEYS);
    view.unmount();
  });

  it('colours each bar by its category tone AND keeps the status WORD on it', async () => {
    const view = await mountBoard();
    showTimeline(view);
    const bar = barFor(view, GUIDE);
    // `Session tree guide lines` is `working` ⇒ in_progress ⇒ the run ramp.
    expect(bar.getAttribute('data-tone')).toBe('run');
    // Colour reinforces the word; it never replaces it.
    expect(bar.textContent).toContain('In Progress');
    view.unmount();
  });
});

describe('the undated case — a guess must never read as a fact', () => {
  it('gives a task with NO dates a default week, MARKED as inferred in the DOM', async () => {
    const view = await mountBoard();
    showTimeline(view);
    // Every fixture task but one carries `dueDate: null` and no startDate.
    const bar = barFor(view, GUIDE);
    expect(bar.getAttribute('data-stated')).toBe('none');
    expect(bar.getAttribute('data-inferred')).toBe('true');
    view.unmount();
  });

  it('SAYS what it is — the sentence rides both the tooltip and the accessible name', async () => {
    const view = await mountBoard();
    showTimeline(view);
    const bar = barFor(view, GUIDE);
    expect(bar.getAttribute('title')).toContain('No dates set');
    expect(bar.getAttribute('title')).toContain('default 7-day week');
    // Not pixels-only: a reader who cannot see the dash pattern still gets it.
    expect(bar.getAttribute('aria-label')).toBe(bar.getAttribute('title'));
    // And it is legible on the bar itself, not only on hover.
    expect(bar.textContent).toContain('default week');
    view.unmount();
  });

  it('a STATED range carries none of those marks — the two are distinguishable in the DOM alone', async () => {
    const view = await mountBoard();
    showTimeline(view);
    // The one fixture task with a real date: `4f8c2a9e…`, dueDate 2026-07-30.
    const stated = barFor(view, taskUuidTitle.title);
    expect(stated.getAttribute('data-stated')).toBe('end');
    expect(stated.getAttribute('title')).toContain('2026-07-30');

    const guessed = barFor(view, GUIDE);
    expect(guessed.getAttribute('data-stated')).toBe('none');
    // The discriminator a stylesheet keys on, and it differs.
    expect(stated.getAttribute('data-stated')).not.toBe(guessed.getAttribute('data-stated'));
    view.unmount();
  });
});

describe('the live filter and the summary strip', () => {
  it('offers a Live axis for a kind that can answer one, and none for a kind that cannot', async () => {
    const view = await mountBoard();
    // A task carries `workingActors`, so it can answer "is a live session on it".
    expect(view.getByTestId('b2-filter-live')).toBeTruthy();
    openAxis(view, 'b2-kind');
    fireEvent.click(view.getByTestId('b2-kind-doc'));
    // A doc has no verdict and no working_on badge: the axis is not drawn at
    // all, rather than drawn and always answering nothing.
    await waitFor(() => expect(view.queryByTestId('b2-filter-live')).toBeNull());
    view.unmount();
  });

  it('narrows to the task a LIVE session is running on — the verdict, not the edge', async () => {
    const view = await mountBoard();
    // The fixture's `workingActors` edge names `sessionLive`, whose seam
    // verdict is `live`; every other task carries no working_on actor at all.
    fireEvent.click(view.getByTestId('b2-filter-live'));
    fireEvent.click(view.getByTestId('b2-filter-live-worked-on'));
    await waitFor(() => expect(view.getAllByTestId('b2-card')).toHaveLength(1));
    expect(view.getAllByTestId('b2-card')[0]!.textContent).toContain(GUIDE);
    view.unmount();
  });

  it('the live narrowing composes with the timeline, and the row wears the word', async () => {
    const view = await mountBoard();
    fireEvent.click(view.getByTestId('b2-filter-live'));
    fireEvent.click(view.getByTestId('b2-filter-live-worked-on'));
    await waitFor(() => expect(view.getAllByTestId('b2-card')).toHaveLength(1));
    showTimeline(view);
    expect(view.getAllByTestId('b2tl-row')).toHaveLength(1);
    expect(view.getAllByTestId('b2tl-live')).toHaveLength(1);
    view.unmount();
  });

  it('the strip counts what the board DREW — a column header and a strip figure agree', async () => {
    const view = await mountBoard();
    const strip = view.getByTestId('b2-summary');
    const drawn = view.getAllByTestId('b2-card').length;
    expect(view.getByTestId('b2sum-total').textContent).toContain(String(drawn));

    // Per-category, against the column that produced it.
    for (const key of CATEGORY_KEYS) {
      const inColumn = within(
        view.getAllByTestId('b2-column').find((c) => c.getAttribute('data-column') === key)!,
      ).queryAllByTestId('b2-card').length;
      expect(within(strip).getByTestId(`b2sum-cat-${key}`).textContent)
        .toContain(String(inColumn));
    }
    view.unmount();
  });

  it('the strip\'s live and no-dates figures are real reads, and they MOVE with a filter', async () => {
    const view = await mountBoard();
    const liveBefore = view.getByTestId('b2sum-live').textContent ?? '';
    expect(liveBefore).toContain('1');
    // Only the live-worked-on task survives, and it has no dates of its own.
    fireEvent.click(view.getByTestId('b2-filter-live'));
    fireEvent.click(view.getByTestId('b2-filter-live-worked-on'));
    await waitFor(() => expect(view.getAllByTestId('b2-card')).toHaveLength(1));
    expect(view.getByTestId('b2sum-total').textContent).toContain('1');
    expect(view.getByTestId('b2sum-live').textContent).toContain('1');
    expect(view.getByTestId('b2sum-undated').textContent).toContain('1');
    view.unmount();
  });
});
