// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import type { ActionContext, QueryFilter } from '../../domain';
import { FIXTURE_SPACE_ID, taskGuideLines } from '../../fixtures';
import { EntityListPanel } from '../index';

/**
 * A task row shows its acceptance count ONCE — on the progress bar under the
 * title. The Work browser's row (`rowLead="icon"`) used to repeat it as a
 * trailing `done/total` beside the title; that copy is gone.
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

describe('task row acceptance count', () => {
  it.each([
    ['Work browser', 'icon' as const],
    ['Home', undefined],
  ])('%s: no trailing done/total beside the title', (_name, rowLead) => {
    expect(figure(renderRow(taskWith({ completed: 3, total: 8 }), rowLead).container)).toBeNull();
  });
});
