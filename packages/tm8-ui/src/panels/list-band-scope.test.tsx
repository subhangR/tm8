// @vitest-environment jsdom
/**
 * THE CATEGORY TAB ∩ THE ARCHIVE CHIP — the composition phase 7 created, and
 * the successor to the test that stood here.
 *
 * ## What this file used to guard, and why it changed
 *
 * A task list declared BOTH partitions: lifecycle TIERS across the top (Open ·
 * Done · Archived) and SECTIONS down the body (Current · Completed). Both named
 * `status`, and `rowsForBand` composed them by spreading the tier's filter
 * AFTER the section's — so the tier silently overwrote the section, the
 * Completed band was a byte-for-byte duplicate of Current under a heading
 * promising the opposite, and a task marked done stayed in both. `narrow()`
 * fixed that by intersecting arrays and letting only SCALARS take the later
 * value.
 *
 * PHASE 7 DELETED THE SECTIONS. They partitioned on precisely the axis the four
 * category tabs now partition on, and one axis gets one control. So the pair
 * this file measures is the pair that is left, and it is the harder one:
 *
 *   · the TAB carries `category: [...]` — an ARRAY, so it intersects
 *   · the CHIP carries `deleted: 'only' | 'include'` — a SCALAR, so it wins
 *
 * That asymmetry is the whole design. Archived is ORTHOGONAL to status, so
 * "archived AND in progress" must be askable; if `deleted` intersected like an
 * array, the chip and the tab would contradict and the band would go empty.
 * And it is why archived could never be a fourth TAB: a tab row is a partition
 * of one axis, and a partition member that means "regardless of status" is not
 * a member of that partition.
 *
 * WHY NO EXISTING TEST CAUGHT THE ORIGINAL DEFECT: the suite's `rowsFor`
 * helper is `(_filter) => rows` — it ignores the filter it is handed, so every
 * band gets every row and the composition is unobservable. The helper HERE
 * honours the filter, which is the only reason any of this is measurable.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import { getKind, type ActionContext } from '../domain';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;

function task(
  id: string,
  title: string,
  status: string,
  category: StatusCategory,
  deleted = false,
): EntitySummary {
  return {
    ...TASK,
    id: id as EntitySummary['id'],
    title,
    deletedAt: deleted ? '2026-08-04T00:00:00.000Z' : null,
    category,
    state: { ...TASK.state, status } as EntitySummary['state'],
  };
}

const ROWS: readonly EntitySummary[] = [
  task('t-todo-1', 'Open one', 'open', 'to_do'),
  task('t-prog-1', 'Open two', 'working', 'in_progress'),
  task('t-done-1', 'Ship the thing', 'done', 'done'),
  task('t-canc-1', 'Abandoned idea', 'cancelled', 'cancelled'),
  task('t-arch-1', 'Archived and open', 'open', 'to_do', true),
  task('t-arch-2', 'Archived and working', 'working', 'in_progress', true),
  task('t-arch-3', 'Archived and done', 'done', 'done', true),
];

/**
 * A `rowsFor` that ACTUALLY APPLIES the filter — the same clauses the real
 * seam applies (`domain-store.membershipOf`). Without this the composition
 * under test is invisible, which is precisely how the original defect
 * survived.
 */
function rowsFor(filter: QueryFilter): readonly EntitySummary[] {
  return ROWS.filter((row) => {
    const deleted = filter.deleted ?? 'exclude';
    if (deleted === 'exclude' && row.deletedAt !== null) return false;
    if (deleted === 'only' && row.deletedAt === null) return false;

    if (filter.category && !filter.category.includes(row.category as StatusCategory)) return false;

    const status = (row.state as unknown as { status?: string }).status;
    if (filter.status && !filter.status.includes(status as never)) return false;
    return true;
  });
}

function list() {
  return render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
}

function tab(getByRole: ReturnType<typeof list>['getByRole'], label: string) {
  fireEvent.click(getByRole('tab', { name: new RegExp(`^${label}`) }));
}

/** Open the filter menu and pick an option by its visible label. */
function chip(view: ReturnType<typeof list>, label: string) {
  fireEvent.click(view.getByTestId('filter-trigger'));
  fireEvent.click(view.getByRole('menuitemcheckbox', { name: label }));
}

/** The row titles the panel actually rendered. */
function titles(container: HTMLElement): string[] {
  return ROWS.map((row) => row.title).filter((title) =>
    (container.textContent ?? '').includes(title),
  );
}

describe('the category tab and the archive chip compose, never contradict', () => {
  /**
   * THE OPEN TAB IS NOW REMEMBERED PER KIND (task 01a02470), which makes it
   * viewer state that OUTLIVES A MOUNT — so a test that clicks a tab seeds the
   * next test's panel unless the slot is cleared. `test-setup.ts` installs
   * storage per FILE and deliberately does not clear between tests (files that
   * seed at module scope own their slot); this file seeds nothing at module
   * scope, so clearing here is free and it is what keeps each `it` reading the
   * kind's own default the way it says it does.
   */
  beforeEach(() => localStorage.clear());

  it('the task registry really does declare the four tabs and the archive chip', () => {
    // If either is dropped the composition below stops meaning anything, so
    // the premise is asserted rather than assumed.
    const config = getKind('task');
    expect(config.list.categories?.map((t) => t.id)).toEqual([
      'to_do',
      'in_progress',
      'done',
      'cancelled',
    ]);
    // …and the sections that used to fight them are gone, not merely unused.
    expect(config.list.sections).toBeUndefined();
    expect(config.list.filters.some((f) => f.id === 'archived')).toBe(true);
  });

  it('each tab shows its OWN category and nothing else', () => {
    const view = list();
    const { container, getByRole } = view;

    // The default tab is the first: To Do.
    expect(titles(container)).toEqual(['Open one']);

    tab(getByRole, 'In Progress');
    expect(titles(container)).toEqual(['Open two']);

    tab(getByRole, 'Done');
    expect(titles(container)).toEqual(['Ship the thing']);
  });

  it('CANCELLED IS ITS OWN TAB — it no longer hides inside Done', () => {
    /**
     * The visible half of the ruling (sub-doc 7 §3.4). Before phase 7 the Done
     * tab carried `['done','cancelled']`, so a cancelled task was counted and
     * displayed as finished work. A cancelled task STOPPED; it did not finish,
     * and the fourth tab is the product finally able to say so.
     */
    const view = list();
    const { container, getByRole } = view;

    tab(getByRole, 'Done');
    expect(container.textContent).not.toContain('Abandoned idea');

    tab(getByRole, 'Cancelled');
    expect(titles(container)).toEqual(['Abandoned idea']);
  });

  it('ARCHIVED COMPOSES WITH A CATEGORY — the question the tab row could not ask', () => {
    /**
     * The point of demoting archived from tab to chip. As a tab it REPLACED
     * the category, so "the archived in-progress work" was unreachable: the
     * Archived tab showed every archived row at every status, and the In
     * Progress tab showed none of them.
     */
    const view = list();
    const { container, getByRole } = view;

    tab(getByRole, 'In Progress');
    expect(titles(container)).toEqual(['Open two']);

    chip(view, 'Archived only');
    // The SCALAR `deleted` takes the chip's value; the ARRAY `category` still
    // intersects. One archived in-progress row, and only it.
    expect(titles(container)).toEqual(['Archived and working']);

    // The tab still works underneath — the chip narrowed, it did not take over.
    tab(getByRole, 'Done');
    expect(titles(container)).toEqual(['Archived and done']);
  });

  it('“Include archived” widens rather than replaces', () => {
    const view = list();
    const { container, getByRole } = view;

    tab(getByRole, 'To Do');
    expect(titles(container)).toEqual(['Open one']);

    chip(view, 'Include archived');
    expect(titles(container)).toEqual(['Open one', 'Archived and open']);
  });

  it('THE OPEN TAB IS PER KIND — remembered on its own, never bled onto another', () => {
    /**
     * TWO RULES IN ONE TEST, because they are the same rule read from both
     * sides, and holding one without the other is how this control has failed
     * before.
     *
     * THE BUG SUB-DOC 6 NAMED (still guarded, middle assertion): `tierId` was
     * seeded ONCE from the mounting kind's first tab while `onKindChange`
     * swapped the kind under it. The old ids overlapped between kinds — every
     * kind had `open`, `done`, `archived` — so a stale id kept resolving to *a*
     * tab and the panel degraded quietly. Under the closed four the ids overlap
     * ALWAYS, so the silence would be permanent: Tasks-on-Cancelled → Docs
     * would land on Docs' Cancelled tab, asked for by nobody.
     *
     * THE USER RULING (task 01a02470, last assertion): the fix for that was to
     * clear the selection on every kind change, and clearing is what Subhang
     * reported as the annoyance — "when i switch back from entity to entity, it
     * always falls back to TO DO status filter". Switching BACK is a return to
     * something you were already looking at, not the arrival the reset was
     * written for. Remembering PER KIND satisfies both: Docs never inherits
     * Tasks' tab, and Tasks still knows where you left it.
     */
    const view = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
    const openTab = () =>
      view
        .getAllByRole('tab')
        .find((t) => t.getAttribute('aria-selected') === 'true')
        ?.textContent?.replace(/\s*\d+\+?$/, '');

    expect(openTab()).toBe('To Do');
    tab(view.getByRole, 'Cancelled');
    expect(openTab()).toBe('Cancelled');

    // The host answers `onKindChange` by re-rendering with a different kind.
    view.rerender(<EntityListPanel kind="doc" rowsFor={rowsFor} ctx={ctx} />);
    expect(openTab(), 'a kind never inherits another kind’s tab').toBe('To Do');

    // …and coming back lands where this kind was left, not on its default.
    view.rerender(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
    expect(openTab(), 'switching back restores the kind’s own selection').toBe('Cancelled');
  });

  it('THE REMEMBERED TAB SURVIVES A REMOUNT — Home unmounts the list on every Chats hop', () => {
    /**
     * The reported gesture is not only a kind swap. Home's column A drops the
     * panel ENTIRELY while the Chats root is up (`ChatHomeScreen`'s
     * `hostedList` goes null), so returning to Tasks mounts a fresh component —
     * and a memory held in React state alone would be gone with the old one.
     * Storage-backed is what makes this survive; this is the assertion that
     * says so, and the reason the fix is not a `useRef`.
     */
    const first = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
    tab(first.getByRole, 'In Progress');
    first.unmount();

    const second = render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
    expect(titles(second.container)).toEqual(['Open two']);
  });

  it('A TAB ID THIS BUILD NO LONGER OFFERS reads as nothing remembered', () => {
    /**
     * The stored string is written by whichever build wrote it, and tab ids
     * have already been renamed once (`open`/`done`/`archived` → the closed
     * four). A retired id must fall to the kind's default rather than come back
     * as a selection no tab can show — the panel would draw a tab row with
     * nothing selected and a body filtered by a category the server does not
     * know.
     */
    localStorage.setItem('tm8ui.panel-choice.list-category.task', 'archived');
    const view = list();
    expect(
      view
        .getAllByRole('tab')
        .find((t) => t.getAttribute('aria-selected') === 'true')
        ?.textContent?.replace(/\s*\d+\+?$/, ''),
    ).toBe('To Do');
    expect(titles(view.container)).toEqual(['Open one']);
  });

  it('an archived task is REACHABLE — the way back is not a dead end', () => {
    /**
     * Archiving is a soft-delete tombstone, so an archived task leaves every
     * live list. That is correct, and it is only survivable because the
     * archive filter can still show it: this is where a user meets the row
     * they need to restore. A control that could only put things IN would be a
     * one-way door.
     */
    const view = list();
    expect(view.container.textContent).not.toContain('Archived and open');

    chip(view, 'Archived only');
    expect(view.container.textContent).toContain('Archived and open');
  });
});
