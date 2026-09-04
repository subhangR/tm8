// @vitest-environment jsdom
/**
 * COMPLETED IS NOT ARCHIVED, AND CANCELLED IS NOT DONE.
 *
 * Sub-doc 5's collisions C2 and C3, pinned. Nothing pinned them before — this
 * file exists because a NEGATIVE CONTROL found that out.
 *
 * === NEGATIVE CONTROL (measured on the fixed tree, break applied, run,
 * reverted) ===
 * Instrument: `npx vitest run` from `packages/tm8-ui`.
 *
 *   BREAK — restore the pre-phase-9 definition in `EntityListPanel`:
 *           `const completed = archived || statusWord === 'done'`
 *           (i.e. HEAD before this change, with `done` renamed).
 *     Tests  3884 passed | 4 skipped (3888)   ← NOTHING RED.
 *
 *   THE ENTIRE SUITE PASSED WITH THE DEFECT IN PLACE. The single
 *   highest-risk collision in the vocabulary sweep — an ARCHIVED task
 *   rendering with the COMPLETED strikethrough — was invisible to ~3,900
 *   tests. So the fix alone was not the work; this file is.
 *
 *   With this file: the break reds exactly the four cases below that name it.
 *
 * ## The three definitions that used to disagree
 *
 *   · task tile   `completed={done || statusWord === 'done'}` where `done` was
 *     `deletedAt != null` — so ARCHIVED read as completed, and the other arm
 *     read a WORD off a badge that a liveness verdict may have replaced.
 *   · session tile `completed={recordedStatus === 'exited'}` — so a session
 *     that FAILED read as unfinished, while the Done tab above it counted the
 *     same row as done.
 *   · the Done tab itself, a third answer again.
 *
 * One definition now, for every kind: `summary.category === 'done'`.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary, QueryFilter, StatusCategory } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import type { ActionContext } from '../domain';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;
const SESSION: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'work_session')!;

function task(
  id: string,
  title: string,
  status: string,
  category: StatusCategory,
  archived = false,
): EntitySummary {
  return {
    ...TASK,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: archived ? '2026-08-18T00:00:00.000Z' : null,
    category,
    state: { ...TASK.state, status } as EntitySummary['state'],
  };
}

function session(
  id: string,
  title: string,
  status: string,
  category: StatusCategory,
): EntitySummary {
  return {
    ...SESSION,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    category,
    state: { ...SESSION.state, status } as EntitySummary['state'],
  };
}

/** Honours `category` and `deleted` the way the seam does. */
function rowsForOf(rows: readonly EntitySummary[]) {
  return (filter: QueryFilter): readonly EntitySummary[] =>
    rows.filter((row) => {
      const deleted = filter.deleted ?? 'exclude';
      if (deleted === 'exclude' && row.deletedAt !== null) return false;
      if (deleted === 'only' && row.deletedAt === null) return false;
      if (filter.category && !filter.category.includes(row.category as StatusCategory)) return false;
      return true;
    });
}

/** The tile element whose title is `title`, whatever anatomy drew it. */
function tileOf(container: HTMLElement, title: string): HTMLElement {
  const tile = [...container.querySelectorAll('[data-testid="list-tile"], .pn-st')].find((el) =>
    (el.textContent ?? '').includes(title),
  );
  if (!tile) throw new Error(`no tile rendered for ${title}\n${container.textContent}`);
  return tile as HTMLElement;
}

/** Struck through = the completed treatment, in either tile anatomy. */
function isStruck(tile: HTMLElement): boolean {
  return (
    tile.classList.contains('pn-tt--completed') ||
    tile.querySelector('.lp__title--completed') !== null ||
    tile.querySelector('.pn-st__tag--done') !== null
  );
}

function isDimmed(tile: HTMLElement): boolean {
  return (
    tile.classList.contains('pn-tt--archived') ||
    tile.classList.contains('pn-st--archived') ||
    tile.querySelector('.lp__title--archived') !== null
  );
}

/** Switch to a category tab by its visible word. */
function tab(view: { getByRole: (r: string, o: object) => HTMLElement }, label: string) {
  fireEvent.click(view.getByRole('tab', { name: new RegExp(`^${label}`) }));
}

/** Turn on the archive filter option by its visible label. */
function archiveFilter(view: {
  getByTestId: (id: string) => HTMLElement;
  getByRole: (r: string, o: object) => HTMLElement;
}, label: string) {
  fireEvent.click(view.getByTestId('filter-trigger'));
  fireEvent.click(view.getByRole('menuitemcheckbox', { name: label }));
}

describe('C2 — an ARCHIVED row is dimmed, never struck through', () => {
  const ROWS = [
    task('t-arch-todo', 'Archived but never started', 'open', 'to_do', true),
    task('t-arch-done', 'Archived after finishing', 'done', 'done', true),
  ];

  it('an archived TO-DO task does NOT render as completed', () => {
    /**
     * THE DEFECT, EXACTLY. `const done = row.deletedAt != null` fed the tile's
     * `completed` prop, so archiving an untouched task drew a line through it
     * — the product telling a user work was finished when it was filed away.
     * It would have kept doing so the moment a real `done` entered this file,
     * which is why the rename could not ship after the tabs.
     */
    const view = render(
      <EntityListPanel kind="task" rowsFor={rowsForOf(ROWS)} ctx={ctx} />,
    );
    archiveFilter(view, 'Archived only');
    tab(view, 'To Do');

    const tile = tileOf(view.container, 'Archived but never started');
    expect(isStruck(tile), 'archived is not completed').toBe(false);
    expect(isDimmed(tile), 'archived reads as archived').toBe(true);
  });

  it('a row that is BOTH archived and done reads as both', () => {
    // The two are orthogonal axes, so they compose rather than override. This
    // is the case the single `--done` class could not express at all.
    const view = render(
      <EntityListPanel kind="task" rowsFor={rowsForOf(ROWS)} ctx={ctx} />,
    );
    archiveFilter(view, 'Archived only');
    tab(view, 'Done');

    const tile = tileOf(view.container, 'Archived after finishing');
    expect(isStruck(tile), 'done is completed, archived or not').toBe(true);
    expect(isDimmed(tile), 'and archived is still archived').toBe(true);
  });
});

describe('C3 — ONE definition of completed, for every kind', () => {
  it('DONE is struck; CANCELLED is not', () => {
    /**
     * The semantic change the fourth category exists to make (sub-doc 5's
     * "worth saying out loud"): a cancelled task STOPPED, it did not finish.
     * `cancelled` used to ride inside Done and inside the Completed band, so
     * abandoned work and shipped work wore the same mark.
     */
    const rows = [
      task('t-done', 'Shipped it', 'done', 'done'),
      task('t-cancelled', 'Abandoned it', 'cancelled', 'cancelled'),
    ];
    const view = render(<EntityListPanel kind="task" rowsFor={rowsForOf(rows)} ctx={ctx} />);

    tab(view, 'Done');
    expect(isStruck(tileOf(view.container, 'Shipped it'))).toBe(true);

    tab(view, 'Cancelled');
    expect(isStruck(tileOf(view.container, 'Abandoned it')), 'cancelled is not completed').toBe(
      false,
    );
  });

  it('a FAILED session is completed — the session tile no longer excludes it', () => {
    /**
     * The other half of C3. The session tile read
     * `completed={recordedStatus === 'exited'}`, so a crashed run rendered as
     * unfinished — while the Done tab 36 lines up the file counted it as done.
     * Under the model `failed` is a runtime FACT that gets a badge, and the
     * run's category is `done`: it ended.
     */
    const rows = [
      session('ws-failed', 'The run that crashed', 'failed', 'done'),
      session('ws-running', 'The run still going', 'running', 'in_progress'),
    ];
    const view = render(
      <EntityListPanel kind="work_session" rowsFor={rowsForOf(rows)} ctx={ctx} />,
    );

    /* PIN MOVED (wave 3, deliberately). This used to assert the crashed run
       rendered STRUCK: category `done` was the point being tested, and the
       strike rode along because lifecycle defaulted to 'work'. The category
       half still holds — the row files under Done, asserted by finding it on
       that tab — but the registry now declares `lifecycle: 'record'` for
       work_session (a done session is the record of a run, not crossed-out
       work; 471 of 477 rows on the launch node wore the strike), so the
       completed TREATMENT is suppressed the same way it is for library kinds.
       Failure stays visible as the `failed` status badge, not as a strike. */
    tab(view, 'Done');
    expect(isStruck(tileOf(view.container, 'The run that crashed'))).toBe(false);

    tab(view, 'In Progress');
    expect(isStruck(tileOf(view.container, 'The run still going'))).toBe(false);
  });

  it('a row with NO category is not completed — absence is not a verdict', () => {
    // `EntitySummary.category` is optional and its absence means "this entity
    // has no position in a workflow". Reading that as `done` would strike
    // through every row a rolling node could not categorise.
    const uncategorised: EntitySummary = {
      ...task('t-none', 'No status at all', 'open', 'to_do'),
    };
    delete (uncategorised as { category?: StatusCategory }).category;

    const view = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => [uncategorised]}
        ctx={ctx}
      />,
    );
    expect(isStruck(tileOf(view.container, 'No status at all'))).toBe(false);
  });
});
