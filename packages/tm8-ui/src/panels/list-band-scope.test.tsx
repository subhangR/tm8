// @vitest-environment jsdom
/**
 * BANDS INSIDE TIERS — a section must not be able to contradict its own label.
 *
 * A task list declares BOTH partitions: lifecycle TIERS across the top (Open ·
 * Done · Archived) and SECTIONS down the body (Current · Completed). Both name
 * `workStatus`, and `rowsForBand` used to compose them by spreading the tier's
 * filter AFTER the section's — so the tier silently overwrote the section.
 *
 * The result, on the DEFAULT tier of the DEFAULT list:
 *
 *   Open tier · band "CURRENT"    → queried with the open statuses  ✓
 *   Open tier · band "COMPLETED"  → queried with the open statuses  ✗
 *
 * The Completed band was a byte-for-byte duplicate of Current, permanently,
 * under a heading promising the opposite. A user who marked a task done saw it
 * remain in both bands — the reported "the complete task flow journey" defect,
 * and the reason "done" felt like it had not worked.
 *
 * WHY NO EXISTING TEST CAUGHT IT: the suite's `rowsFor` helper is
 * `(_filter) => rows` — it ignores the filter it is handed, so every band gets
 * every row and the composition is unobservable. The helper HERE honours the
 * filter, which is the only reason any of this is measurable.
 *
 * === RED-FIRST RECORD (measured; break applied to the fixed tree, run,
 * captured, reverted) ===
 * Instrument: `npx vitest run src/panels/list-band-scope.test.tsx` from
 * `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui`).
 *
 *   BREAK — 2026-08-04T19:35Z. Restore the old composition in `rowsForBand`
 *           (`{...filter, ...(tier?.filter ?? {})}`) and drop the disjoint
 *           section filter at the render site — i.e. HEAD.
 *     FAIL the Open tier does not draw a COMPLETED band at all
 *     FAIL a done task appears under Completed, and ONLY there
 *       both: AssertionError: expected [ 'CURRENT · 2', 'COMPLETED · 2' ]
 *             to have a length of 1 but got 2
 *     Tests  2 failed | 3 passed (5)
 *
 *   The counts in that failure ARE the bug, stated by the assertion itself:
 *   two bands, two rows each, on a fixture holding exactly two open tasks and
 *   two closed ones. "COMPLETED · 2" on the Open tier is the two OPEN tasks.
 *
 *   Restored: Tests  5 passed (5).
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import type { EntitySummary, QueryFilter } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries, taskUuidTitle } from '../fixtures';
import { getKind, type ActionContext } from '../domain';
import { EntityListPanel } from './index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TASK: EntitySummary = fixtureSummaries.find((s) => s.state.kind === 'task')!;

function task(id: string, title: string, workStatus: string, deleted = false): EntitySummary {
  return {
    ...TASK,
    id: id as EntitySummary['id'],
    title,
    deletedAt: deleted ? '2026-08-04T00:00:00.000Z' : null,
    state: { ...TASK.state, workStatus } as EntitySummary['state'],
  };
}

const ROWS: readonly EntitySummary[] = [
  task('t-open-1', 'Open one', 'open'),
  task('t-open-2', 'Open two', 'working'),
  task('t-done-1', 'Ship the thing', 'done'),
  task('t-done-2', 'Abandoned idea', 'cancelled'),
  task('t-arch-1', 'Archived and open', 'open', true),
  task('t-arch-2', 'Archived and done', 'done', true),
];

/**
 * A `rowsFor` that ACTUALLY APPLIES the filter — the same two clauses the real
 * seam applies (`domain-store.membershipOf`). Without this the composition
 * under test is invisible, which is precisely how the defect survived.
 */
function rowsFor(filter: QueryFilter): readonly EntitySummary[] {
  return ROWS.filter((row) => {
    const deleted = filter.deleted ?? 'exclude';
    if (deleted === 'exclude' && row.deletedAt !== null) return false;
    if (deleted === 'only' && row.deletedAt === null) return false;

    const status = (row.state as unknown as { workStatus?: string }).workStatus;
    if (filter.workStatus && !filter.workStatus.includes(status as never)) return false;
    return true;
  });
}

function list() {
  return render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} />);
}

/**
 * The band headings actually drawn, in document order, caret stripped.
 *
 * BOTH vocabularies, deliberately. A section with `collapsedByDefault` (the
 * task list's "Completed" is one) reduces to a single `.lp__collapsed` line
 * instead of an `.lp__eyebrow` — still a heading, still counted, still
 * reachable. Reading only the eyebrow would report a collapsed band as ABSENT
 * and turn "correctly collapsed" into a false failure.
 */
function bands(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.lp__eyebrow, .lp__collapsed')]
    .map((el) => (el.textContent ?? '').replace(/^[▾▸]\s*/, '').trim())
    .filter((text) => !text.startsWith('NEEDS ATTENTION'));
}

function tier(getByRole: ReturnType<typeof list>['getByRole'], label: string) {
  fireEvent.click(getByRole('tab', { name: new RegExp(`^${label}`) }));
}

/** Open every collapsed band, so its rows are assertable rather than counted. */
function expandBands(container: HTMLElement) {
  for (const line of [...container.querySelectorAll('.lp__collapsed')]) {
    fireEvent.click(line);
  }
}

describe('a section band is scoped BY its tier, never overwritten by it', () => {
  it('the task registry really does declare both partitions', () => {
    // If either is dropped the composition below stops meaning anything, so
    // the premise is asserted rather than assumed.
    const config = getKind('task');
    expect(config.list.sections?.map((s) => s.id)).toEqual(['current', 'completed']);
    expect(config.list.lifecycle?.map((t) => t.id)).toEqual(['open', 'done', 'archived']);
  });

  it('the Open tier does not draw a COMPLETED band at all', () => {
    // Open ∩ Completed is empty, so the honest rendering is NO heading —
    // not "COMPLETED · 0", which would state something false about the tier.
    const { container } = list();
    expect(bands(container)).toHaveLength(1);
    expect(bands(container)[0]).toMatch(/^CURRENT/);
  });

  it('a done task appears under Completed, and ONLY there', () => {
    const { container, getByRole } = list();

    // On Open, the done task is absent entirely.
    expect(container.textContent).not.toContain('Ship the thing');
    expect(container.textContent).toContain('Open one');

    tier(getByRole, 'Done');

    // ONE band, and it is the right one: Current ∩ Done is empty, so the
    // "Current" heading is not drawn at all.
    expect(bands(container)).toHaveLength(1);
    expect(bands(container)[0]).toBe('COMPLETED · 2');

    // It arrives collapsed (`collapsedByDefault`), so the count in the heading
    // is the claim and expanding is what checks it.
    expandBands(container);
    expect(container.textContent).toContain('Ship the thing');
    expect(container.textContent).toContain('Abandoned idea');
    expect(container.textContent).not.toContain('Open one');
  });

  it('the ARCHIVED tier keeps BOTH bands — its partition still works', () => {
    /**
     * The regression guard on the fix. `deleted` must let the TIER win rather
     * than intersect: the sections carry `deleted: 'exclude'` and the Archived
     * tier carries `'only'`, so intersecting that axis would make every
     * section disjoint and empty the one tier whose partition was already
     * correct.
     */
    const { container, getByRole } = list();
    tier(getByRole, 'Archived');

    expect(bands(container)).toEqual(['CURRENT · 1', 'COMPLETED · 1']);

    expandBands(container);
    expect(container.textContent).toContain('Archived and open');
    expect(container.textContent).toContain('Archived and done');
    // …and nothing live leaks into it.
    expect(container.textContent).not.toContain('Open one');
  });

  it('an archived task is REACHABLE — the way back is not a dead end', () => {
    /**
     * Archiving is a soft-delete tombstone, so an archived task leaves every
     * live list. That is correct, and it is only survivable because the
     * Archived tier can still show it: this is where a user meets the row they
     * need to restore. A tier that could only put things IN would be a
     * one-way door.
     */
    const { container, getByRole } = list();
    expect(container.textContent).not.toContain('Archived and open');

    tier(getByRole, 'Archived');
    expect(container.textContent).toContain('Archived and open');
  });
});
