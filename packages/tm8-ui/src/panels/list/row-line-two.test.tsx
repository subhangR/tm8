// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';
import { resetRowViewCache } from './row-view';

/**
 * LINE 2 EXISTS ONLY WHEN SOMETHING IS ON IT (design doc 01a1465d §6; QA
 * findings 2 and 3, ruled 2026-10-17).
 *
 * §6's anatomy is one line, with a second line for the counts. Two ways of
 * breaking it shipped on the navigator branch and BOTH passed a green suite,
 * for the reason `row-height-parity.test.ts` spells out: jsdom loads no
 * stylesheets and lays nothing out, so no assertion in 8000 could see a row's
 * height. The two defects were found in a browser screenshot and measured in
 * CSS px on a live node.
 *
 *   1. Every task row drew a second line. `taskTileProgress` returns a figure
 *      as soon as the summary carries a percent — true of a leaf with nothing
 *      in it — so the `0%` meter was unconditional and a task with no counts
 *      and no children measured 49.4px where §6 asks for 30.
 *   2. Every NON-task row was 34px against the task row's 30, because §6
 *      retired the `.lp__rowactions` wrapper that used to float the row's
 *      verbs out of the flow and left the 22px disclosure chevron a direct
 *      child of `.lp__row1`. Only `(hover: hover) and (pointer: fine)` takes
 *      it out again, so anything reporting no hover laid it out and the row
 *      grew by 22 - 12 = 4px.
 *
 * ONLY DEFECT 1 IS TESTABLE HERE. "Is there a second line" is a DOM fact and
 * this file answers it. "How tall is the row" is not, so defect 2's invariant
 * lives in `row-height-parity.test.ts` beside the other floor assertions,
 * which read the stylesheet because nothing else in-repo can.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

/** A task carrying a weighted-progress figure, which every real summary does. */
function taskWithProgress(
  patch: Partial<EntitySummary> & { id: string; title: string },
  counters?: Record<string, number>,
): EntitySummary {
  const state = taskGuideLines.state as unknown as Record<string, unknown>;
  return {
    ...taskGuideLines,
    parentId: null,
    ...patch,
    state: {
      ...state,
      progress: { percent: 0, earned: 0, total: 1, own: 1, openSubtasks: 0, tent: true },
    },
    ...(counters ? { counters: { ...taskGuideLines.counters, ...counters } } : {}),
  } as unknown as EntitySummary;
}

function tileTitled(container: HTMLElement, title: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('[data-testid="list-tile"]')].find(
    (el) => el.querySelector('.pn-tt__title, .lp__title')?.textContent === title,
  );
  if (!found) throw new Error(`no tile titled ${title}`);
  return found;
}

const lineTwo = (tile: HTMLElement) => tile.querySelector('.pn-tt__badges');
const meter = (tile: HTMLElement) => tile.querySelector('[data-testid="tile-progress"]');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetRowViewCache();
});

describe('a task row draws a second line only when it has one to draw', () => {
  it('a leaf with no counts gets no second line and no meter', () => {
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([taskWithProgress({ id: 't-leaf', title: 'Leaf' })])}
        ctx={ctx}
      />,
    );
    const tile = tileTitled(container, 'Leaf');
    expect(lineTwo(tile)).toBeNull();
    expect(meter(tile)).toBeNull();
  });

  it('a task WITH subtasks gets the meter — the ▸ N chip and the meter are one answer', () => {
    const parent = taskWithProgress({ id: 't-parent', title: 'Parent' });
    const kid = taskWithProgress({ id: 't-kid', title: 'Kid' });
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([parent, { ...kid, parentId: 't-parent' } as EntitySummary])}
        ctx={ctx}
      />,
    );
    const tile = tileTitled(container, 'Parent');
    /* The chip is the row's claim that there are children; the meter is how
       far they have got. Either both or neither. */
    expect(tile.querySelector('[data-testid="child-count"]')).not.toBeNull();
    expect(meter(tile)).not.toBeNull();
    expect(lineTwo(tile)).not.toBeNull();
  });

  it('a LEAF with counts still gets the line — counts are §6’s second row, for any kind', () => {
    const { container } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rowsFor([taskWithProgress({ id: 't-docs', title: 'Documented' }, { docs: 2 })])}
        ctx={ctx}
      />,
    );
    const tile = tileTitled(container, 'Documented');
    expect(lineTwo(tile)).not.toBeNull();
    expect(tile.querySelector('[data-count-kind="docs"]')).not.toBeNull();
    /* …and still no meter: the counts are the reason the line exists, not the
       meter, so a leaf's `0%` does not come back in through the side door. */
    expect(meter(tile)).toBeNull();
  });
});
