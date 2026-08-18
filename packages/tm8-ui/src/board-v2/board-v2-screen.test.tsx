// @vitest-environment jsdom
/**
 * BOARD V2, MOUNTED — GateApp over the fixture seam at `#/s/{s}/board-v2`,
 * the same harness the v1 board proved. What these cases pin:
 *
 *  · the closed category skeleton in reading order, every column a REAL
 *    `filters.category` read (the fixture applies the predicate for real);
 *  · the kind selector making the board universal: a statusless kind's rows
 *    land in the honest 'No status yet' column, and the category columns
 *    stay empty rather than borrowing them;
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
import { cleanup, fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { GateApp } from '../views/GateApp';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { FIXTURE_SPACE_ID } from '../fixtures';

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

async function mountBoard(): Promise<RenderResult> {
  const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/board-v2`)} />);
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
    const body = view.getByLabelText('Tasks board');
    // Focus starts at To Do (empty); walk right to In Progress, walk DOWN to
    // the guide-lines card (order is the server's), then move it one LEFT.
    fireEvent.keyDown(body, { key: 'ArrowRight' });
    const focusedIsGuide = () =>
      view
        .getAllByTestId('b2-card')
        .some((c) => c.className.includes('b2__card--focused') && c.textContent?.includes(GUIDE));
    for (let i = 0; i < 4 && !focusedIsGuide(); i += 1) {
      fireEvent.keyDown(body, { key: 'ArrowDown' });
    }
    expect(focusedIsGuide()).toBe(true);
    fireEvent.keyDown(body, { key: 'ArrowLeft', ctrlKey: true });
    await waitFor(() => {
      expect(column(view, 'to_do').getByText(GUIDE)).toBeTruthy();
      expect(column(view, 'in_progress').queryByText(GUIDE)).toBeNull();
    });
    view.unmount();
  });
});

describe('the universal kind selector', () => {
  it('a statusless kind shows its rows in the honest No-status-yet column, and nothing borrows a category', async () => {
    const view = await mountBoard();
    openAxis(view, 'b2-kind');
    fireEvent.click(view.getByTestId('b2-kind-doc'));
    /* The category reads answer EMPTY for docs (a NULL category never matches
       the predicate) while the base read fills the uncategorised column with
       the server-computed absence — never a client-invented bucket. */
    await waitFor(() => expect(columnKeys(view)).toEqual([...CATEGORY_KEYS, 'uncategorised']));
    await waitFor(() => {
      const uncategorised = column(view, 'uncategorised');
      expect(uncategorised.getAllByTestId('b2-card').length).toBeGreaterThan(0);
    });
    expect(column(view, 'in_progress').queryAllByTestId('b2-card')).toHaveLength(0);
    view.unmount();
  });

  it('a kind that cannot move yet REFUSES the drop visibly — with the reason, not a silent no-op', async () => {
    const view = await mountBoard();
    openAxis(view, 'b2-kind');
    fireEvent.click(view.getByTestId('b2-kind-doc'));
    await waitFor(() => expect(columnKeys(view)).toContain('uncategorised'));
    await waitFor(() =>
      expect(column(view, 'uncategorised').getAllByTestId('b2-card').length).toBeGreaterThan(0));

    const body = view.getByLabelText('Docs board');
    // Walk to the uncategorised column (index 4) and push its first card left
    // into Cancelled: docs have a status from phase 5 (migration 152) but no
    // settable CONTROL yet, so the drop must still refuse — with that reason.
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(body, { key: 'ArrowRight' });
    fireEvent.keyDown(body, { key: 'ArrowLeft', ctrlKey: true });
    const refusal = await waitFor(() => view.getByTestId('b2-refusal'));
    expect(refusal.textContent).toMatch(/no settable control yet/i);
    // And nothing moved: every doc still sits in No status yet.
    expect(column(view, 'cancelled').queryAllByTestId('b2-card')).toHaveLength(0);
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
  it('sits right after Board in the tab row, opens the v2 screen, and reads current there', async () => {
    /* Mounted on Board V1 first: the seat must exist WITHOUT the route ever
       having been visited (it is appended client-side, not menu data), and
       clicking it must navigate — the store write is the navigation. */
    const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/board`)} />);
    await waitFor(() => view.getByTestId('board-screen'));
    const tabs = view.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs.indexOf('Board v2')).toBe(tabs.indexOf('Board') + 1);

    fireEvent.click(view.getByRole('tab', { name: 'Board v2' }));
    await waitFor(() => view.getByTestId('board-v2-screen'));
    // …and the tab claims the route: v2 highlights, Board v1 does not.
    expect(view.getByRole('tab', { name: 'Board v2' }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('tab', { name: 'Board' }).getAttribute('aria-selected')).toBe('false');
    view.unmount();
  });
});

describe('the create control', () => {
  it('renders a live ＋ New control that follows the selected kind', async () => {
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
