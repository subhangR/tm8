// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';

/**
 * The Work browser's task row (`rowLead="icon"`) carries the task's
 * acceptance progress as a trailing `done/total`: quiet while open, the run
 * tone once every criterion is met, absent when the task has no criteria.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

function taskWith(acceptance: { completed: number; total: number } | undefined): EntitySummary {
  const state = { ...(taskGuideLines.state as unknown as Record<string, unknown>) };
  if (acceptance) state.acceptance = acceptance;
  else delete state.acceptance;
  return { ...taskGuideLines, state } as unknown as EntitySummary;
}

function renderRow(row: EntitySummary, rowLead?: 'icon') {
  const rowsFor = (_filter: QueryFilter): readonly EntitySummary[] => [row];
  return render(<EntityListPanel kind="task" rowsFor={rowsFor} ctx={ctx} rowLead={rowLead} />);
}

const figure = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="list-tile"] [data-testid="task-progress"]');

describe('task row acceptance progress (rowLead="icon")', () => {
  it.each([
    ['none done', 0, 8, '0/8', 'false'],
    ['some done', 3, 8, '3/8', 'false'],
    ['all done', 8, 8, '8/8', 'true'],
  ])('%s: draws %s/%s', (_name, completed, total, text, complete) => {
    const { container } = renderRow(taskWith({ completed, total }), 'icon');
    const el = figure(container);
    expect(el?.textContent).toBe(text);
    expect(el?.getAttribute('data-complete')).toBe(complete);
    expect(el?.classList.contains('pn-tt__progress--done')).toBe(complete === 'true');
    expect(el?.getAttribute('aria-label')).toBe(`${completed} of ${total} acceptance criteria done`);
  });

  it('draws nothing when the task has no criteria', () => {
    expect(figure(renderRow(taskWith(undefined), 'icon').container)).toBeNull();
    expect(figure(renderRow(taskWith({ completed: 0, total: 0 }), 'icon').container)).toBeNull();
  });

  it('follows the row when a criterion is ticked', () => {
    const { container, rerender } = renderRow(taskWith({ completed: 2, total: 3 }), 'icon');
    expect(figure(container)?.textContent).toBe('2/3');
    const ticked = taskWith({ completed: 3, total: 3 });
    rerender(<EntityListPanel kind="task" rowsFor={() => [ticked]} ctx={ctx} rowLead="icon" />);
    expect(figure(container)?.textContent).toBe('3/3');
    expect(figure(container)?.getAttribute('data-complete')).toBe('true');
  });

  it('Home (no rowLead) is unchanged', () => {
    expect(figure(renderRow(taskWith({ completed: 3, total: 8 })).container)).toBeNull();
  });
});
