// @vitest-environment jsdom
/**
 * THE BOARD TAB, MOUNTED — GateApp over the fixture seam at `#/s/{s}/board`,
 * the same harness `router-mount.test.tsx` proved. What these cases pin:
 *
 *  · the canonical column skeletons per pivot (empty columns included);
 *  · filters that reach the SEAM (the fixture narrows rows for real, so an
 *    option that stopped binding would fail here, not just look unpressed);
 *  · the filter chrome staying ONE row whatever the roster size — every axis
 *    is a dropdown, so its options only exist once the menu is open, and
 *    that is exactly the property these cases have to keep true;
 *  · a real drag commit: the card moves optimistically, the fixture write
 *    lands, and the fresh read AGREES — a card still in its target after
 *    settle is the evidence, because a refused write snaps it home;
 *  · §8.1 — the keyboard path drives the SAME dispatch as a drop;
 *  · the assigned-by axis narrowing by 129's recorded provenance.
 *
 * Fixture dataset (fixtures/entities.ts), non-deleted tasks:
 *   '4f8c2a9e…'                              in_review / urgent
 *   'Session tree guide lines'               working   / medium
 *   'Wire palette to real command registry'  blocked   / high
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
  const view = render(<GateApp routerTarget={createMemoryTarget(`#/s/${SPACE}/board`)} />);
  await waitFor(() => view.getByTestId('board-screen'));
  // Loaded, not just mounted: skeletons gone means the first read answered.
  await waitFor(() => expect(view.queryAllByTestId('bd-skeleton')).toHaveLength(0));
  return view;
}

const columnKeys = (view: RenderResult): string[] =>
  view.getAllByTestId('bd-column').map((c) => c.getAttribute('data-column') ?? '');

/** Every axis is a dropdown now: its options do not exist until it is open. */
const openAxis = (view: RenderResult, testId: string) => {
  fireEvent.click(view.getByTestId(testId));
  return view.getByTestId(`${testId}-menu`);
};

const column = (view: RenderResult, key: string) => {
  const col = view.getAllByTestId('bd-column').find((c) => c.getAttribute('data-column') === key);
  expect(col).toBeDefined();
  return within(col!);
};

describe('the status board', () => {
  it('renders the FULL canonical vocabulary in reading order, empty columns included', async () => {
    const view = await mountBoard();
    expect(columnKeys(view)).toEqual(['open', 'pulled', 'working', 'in_review', 'blocked', 'done', 'cancelled']);
    // Cards landed where their state says; an empty column says so in words.
    // `open` HOLDS A CARD NOW (`taskQueued`, added with the four category tabs
    // — the fixtures had no unstarted task at all), so the empty-column
    // sentence is measured on `pulled`, which still has none.
    expect(column(view, 'working').getByText(GUIDE)).toBeTruthy();
    expect(column(view, 'open').getByText('Name the empty states')).toBeTruthy();
    expect(column(view, 'pulled').getByText('nothing in Pulled')).toBeTruthy();
    view.unmount();
  });

  it('a status option narrows BOTH the columns and the seam read', async () => {
    const view = await mountBoard();
    openAxis(view, 'bd-filter-status');
    fireEvent.click(view.getByTestId('bd-filter-status-working'));
    /* The filtered snapshot is a fresh cache key — the fixture applies
       `status` for real, so an option that stopped reaching the seam
       would leave the other tasks visible and fail here. */
    await waitFor(() => expect(columnKeys(view)).toEqual(['working']));
    await waitFor(() => expect(view.getAllByTestId('bd-card')).toHaveLength(1));
    expect(view.getByText(GUIDE)).toBeTruthy();
    fireEvent.click(view.getByTestId('bd-clear-filters'));
    await waitFor(() => expect(columnKeys(view)).toHaveLength(7));
    view.unmount();
  });

  it('the title search narrows cards without touching the seam', async () => {
    const view = await mountBoard();
    fireEvent.change(view.getByLabelText('Filter cards by title'), { target: { value: 'guide' } });
    await waitFor(() => expect(view.getAllByTestId('bd-card')).toHaveLength(1));
    expect(view.getByText(GUIDE)).toBeTruthy();
    view.unmount();
  });

  it('COMMITS a drag: optimistic move, real write, fresh read agrees', async () => {
    const view = await mountBoard();
    const card = view.getAllByTestId('bd-card').find((c) => c.textContent?.includes(GUIDE))!;
    const target = view
      .getAllByTestId('bd-column')
      .find((c) => c.getAttribute('data-column') === 'in_review')!;

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
    expect(column(view, 'in_review').getByText(GUIDE)).toBeTruthy();
    /* …and STILL there once the write's event-driven re-read lands, with the
       source column empty — a refused write would have snapped it home, so
       persistence through settle IS the commit evidence. */
    await waitFor(() => {
      expect(column(view, 'in_review').getByText(GUIDE)).toBeTruthy();
      expect(column(view, 'working').queryByText(GUIDE)).toBeNull();
    });
    view.unmount();
  });

  it('§8.1 — mod+arrow moves the focused card through the SAME dispatch', async () => {
    const view = await mountBoard();
    const body = view.getByLabelText('Task board');
    // Focus starts at Open (empty); walk right to Working, whose first card
    // is the guide-lines task, then move it one column right.
    fireEvent.keyDown(body, { key: 'ArrowRight' });
    fireEvent.keyDown(body, { key: 'ArrowRight' });
    fireEvent.keyDown(body, { key: 'ArrowRight', ctrlKey: true });
    await waitFor(() => {
      expect(column(view, 'in_review').getByText(GUIDE)).toBeTruthy();
      expect(column(view, 'working').queryByText(GUIDE)).toBeNull();
    });
    view.unmount();
  });
});

describe('the pivots', () => {
  it('Priority: four columns in descending urgency, written through the version-guarded patch', async () => {
    const view = await mountBoard();
    fireEvent.click(view.getByTestId('bd-pivot-priority'));
    await waitFor(() => expect(columnKeys(view)).toEqual(['urgent', 'high', 'medium', 'low']));
    /* React 19: rows land a commit after the columns do. */
    await waitFor(() => expect(column(view, 'medium').getByText(GUIDE)).toBeTruthy());

    /* The write path is DIFFERENT here — a content patch that needs the
       detail's version, hydrated on demand — so it gets its own commit
       proof. The timeout covers the hydration poll. */
    const body = view.getByLabelText('Task board');
    fireEvent.keyDown(body, { key: 'ArrowRight' }); // urgent → high
    fireEvent.keyDown(body, { key: 'ArrowRight' }); // high → medium
    fireEvent.keyDown(body, { key: 'ArrowLeft', ctrlKey: true }); // medium card → high
    await waitFor(
      () => {
        expect(column(view, 'high').getByText(GUIDE)).toBeTruthy();
        expect(column(view, 'medium').queryByText(GUIDE)).toBeNull();
      },
      { timeout: 4000 },
    );
    view.unmount();
  });

  it('Assignee: Unassigned leads, and switching pivots clears the overlay state', async () => {
    const view = await mountBoard();
    fireEvent.click(view.getByTestId('bd-pivot-assignee'));
    await waitFor(() => expect(columnKeys(view)[0]).toBe(''));
    expect(column(view, '').getByText('Unassigned')).toBeTruthy();
    view.unmount();
  });
});

describe('the assigned-by axis (129 provenance)', () => {
  it('options render per roster actor and BIND the seam read to who assigned', async () => {
    /* Once §8.5's backend landed (PR #251), the disabled-with-reason chip
       became real options over the same roster as the people axis. The
       fixture dataset ships NO recorded provenance, so choosing one must
       empty the board — the honest answer, and proof the axis reaches the
       seam (an option that stopped binding would leave every card visible).
       The MATCHING side of the arm is proven at the seam
       (seam-fixture.test.ts, '129 parity'). */
    const view = await mountBoard();
    openAxis(view, 'bd-filter-assignedby');
    const option = await waitFor(() => view.getByTestId('bd-filter-assignedby-ent-member-ada'));
    expect(option.getAttribute('aria-pressed')).toBe('false');
    expect(view.getAllByTestId('bd-card').length).toBeGreaterThan(0);

    fireEvent.click(option);
    await waitFor(() => expect(option.getAttribute('aria-pressed')).toBe('true'));
    await waitFor(() => expect(view.queryAllByTestId('bd-card')).toHaveLength(0));

    // Unpressing restores the unfiltered snapshot — same cache key as untouched.
    fireEvent.click(option);
    await waitFor(() => expect(view.getAllByTestId('bd-card').length).toBeGreaterThan(0));
    view.unmount();
  });
});

describe('the filter chrome', () => {
  /* The rail this replaced drew every status, every priority and the whole
     roster TWICE as inline chips, so its height grew with the space. These
     cases pin the property that fixed it: what the bar renders does not
     depend on how many options an axis has. */

  it('renders one trigger per axis and NO options until a menu is opened', async () => {
    const view = await mountBoard();
    for (const axis of ['bd-filter-status', 'bd-filter-priority', 'bd-filter-person', 'bd-filter-assignedby']) {
      expect(view.getByTestId(axis)).toBeTruthy();
      expect(view.queryByTestId(`${axis}-menu`)).toBeNull();
    }
    // The whole vocabulary of the biggest static axis is behind ONE control.
    expect(view.queryByTestId('bd-filter-status-working')).toBeNull();
    expect(view.getByTestId('bd-filters').querySelectorAll('.bd__sel')).toHaveLength(4);
    view.unmount();
  });

  it('the trigger SAYS what is selected, and clears just its own axis', async () => {
    const view = await mountBoard();
    const trigger = view.getByTestId('bd-filter-status');
    expect(trigger.getAttribute('aria-label')).toBe('Status filter, nothing selected');
    expect(view.queryByTestId('bd-filter-status-clear')).toBeNull();

    openAxis(view, 'bd-filter-status');
    fireEvent.click(view.getByTestId('bd-filter-status-working'));
    fireEvent.click(view.getByTestId('bd-filter-status-blocked'));
    await waitFor(() => expect(trigger.getAttribute('aria-label')).toBe('Status filter, 2 selected'));

    // A per-axis clear is not the global one: search survives it.
    fireEvent.change(view.getByLabelText('Filter cards by title'), { target: { value: 'guide' } });
    fireEvent.click(view.getByTestId('bd-filter-status-clear'));
    await waitFor(() => expect(trigger.getAttribute('aria-label')).toBe('Status filter, nothing selected'));
    expect((view.getByLabelText('Filter cards by title') as HTMLInputElement).value).toBe('guide');
    view.unmount();
  });
});

describe('the create control', () => {
  /* The board shipped with seven columns of drop targets and no way to add a
     card — it looked like a working kanban that silently refused every task.
     The bar now carries the create control the screen was missing. */
  it('renders a live ＋ New task in the bar', async () => {
    const view = await mountBoard();
    const control = view.getByTestId('bd-new-task');
    expect(control).toBeTruthy();
    // Live, not a refused span: the fixture seam carries a command executor.
    expect(control.tagName).toBe('BUTTON');
    expect(control.textContent).toContain('New task');
    view.unmount();
  });
});
