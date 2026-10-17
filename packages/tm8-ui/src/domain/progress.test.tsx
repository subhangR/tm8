// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { EntitySummary, TaskProgress, WeightedProgress } from '@tm8/contract';
import { fixtureSummaries, storyAsAnEntity } from '../fixtures';
import { TileProgressBar } from '../panels/list/TileProgressBar';
import { storyTileProgress, taskTileProgress } from './progress';

/**
 * 307: the task and story rows draw the server's weighted progress (spec doc
 * 01a111ba). The worked examples are the spec's; D3 is E2.
 */

const baseTask = fixtureSummaries.find((r) => r.kind === 'task')!;

function task(
  progress: Partial<TaskProgress> & { percent: number | null },
  o: { done?: boolean; criteria?: [number, number] } = {},
): EntitySummary {
  if (baseTask.state.kind !== 'task') throw new Error('fixture is not a task');
  const [completed, total] = o.criteria ?? [0, 0];
  return {
    ...baseTask,
    category: o.done ? 'done' : 'in_progress',
    state: {
      ...baseTask.state,
      acceptance: { completed, total },
      progress: { earned: 0, total: 1, size: 1, tasks: 1, open: 1, tents: 0, own: 0, tent: false, openSubtasks: 0, ...progress },
    },
  };
}

function story(weighted: WeightedProgress | undefined): EntitySummary {
  if (storyAsAnEntity.state.kind !== 'story') throw new Error('fixture is not a story');
  const { weighted: _w, ...rest } = storyAsAnEntity.state;
  return { ...storyAsAnEntity, state: weighted ? { ...rest, weighted } : rest };
}

afterEach(cleanup);

describe('task rows', () => {
  it('E1: the percent and the own criteria', () => {
    const p = taskTileProgress(task({ percent: 75, earned: 1.5, total: 2 }, { criteria: [3, 4] }))!;
    expect(p).toMatchObject({ percent: 75, detail: '3/4' });
    expect(p.marker).toBeUndefined();
  });

  it('E2 (D3): a done task with an open subtask keeps 11% and says why', () => {
    const p = taskTileProgress(task({ percent: 11, earned: 1, total: 9, own: 1, openSubtasks: 1 }, { done: true }))!;
    expect(p).toMatchObject({ percent: 11, marker: 'subtasks open' });
    const { getByTestId } = render(<TileProgressBar progress={p} />);
    expect(getByTestId('tile-progress').textContent).toBe('11%subtasks open');
  });

  it('an open parent with open subtasks gets no marker — the status already says it', () => {
    expect(taskTileProgress(task({ percent: 40, openSubtasks: 2 }))!.marker).toBeUndefined();
  });

  it('a missing estimate is named in the tooltip', () => {
    expect(taskTileProgress(task({ percent: 0, tent: true }))!.label).toContain('no estimate');
  });

  it('no figure (a cancelled task) draws nothing', () => {
    expect(taskTileProgress(task({ percent: null }))).toBeNull();
  });
});

describe('story rows', () => {
  it('E6: the percent and done/total weighted points', () => {
    const p = storyTileProgress(story({ percent: 66, earned: 2, total: 3, size: 3, tasks: 2, open: 1, tents: 0 }))!;
    expect(p).toMatchObject({ percent: 66, detail: '2/3 pts' });
    const { getByTestId } = render(<TileProgressBar progress={p} />);
    expect(getByTestId('tile-progress').textContent).toBe('66% · 2/3 pts');
  });

  it('points round down, like the percent', () => {
    expect(storyTileProgress(story({ percent: 30, earned: 1.5, total: 5, size: 5, tasks: 3, open: 2, tents: 2 }))!.detail).toBe('1/5 pts');
  });

  it('an empty story draws nothing; an older summary keeps the task count', () => {
    expect(storyTileProgress(story({ percent: null, earned: 0, total: 0, size: 0, tasks: 0, open: 0, tents: 0 }))).toBeNull();
    const old = storyTileProgress(story(undefined))!;
    expect(old.percent).toBeUndefined();
    expect(old.noun).toBe('tasks');
  });

  it('the bar is full only at 100%', () => {
    const { container } = render(<TileProgressBar progress={{ done: 1, work: 1, percent: 100 }} />);
    expect(container.querySelector('.lp__progress--done')).not.toBeNull();
  });
});

/**
 * ON THE ROW, THE METER NEEDS A SUBTREE (§6; QA finding 3, ruled 2026-10-17).
 *
 * `taskTileProgress` above is unchanged and still answers for any task with a
 * percent. What changed is the ROW: `badges` IS the second line, so a slot that
 * was non-null on every task drew a second line on every task, and a leaf with
 * no counts measured 49.4px where §6 asks for 30. The row now draws the meter
 * only where the ▸ N chip is drawn, so these two cases give their parent a
 * subtask — which is what a weighted percent is a statement about anyway. The
 * leaf's side of the rule is `panels/list/row-line-two.test.tsx`.
 */
describe('the task list draws it (control card)', () => {
  it('E2 (D3): the bar, 11% and the marker on the row', async () => {
    const { EntityListPanel } = await import('../panels/index');
    const { FIXTURE_SPACE_ID } = await import('../fixtures');
    const row = { ...task({ percent: 11, earned: 1, total: 9, own: 1, openSubtasks: 1 }, { done: true }), id: 'd3', title: 'D3 root' };
    const kid = { ...task({ percent: 0 }), id: 'd3-kid', title: 'The open subtask', parentId: 'd3' };
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={() => [row, kid]} ctx={{ spaceId: FIXTURE_SPACE_ID }} />,
    );
    const bar = container.querySelector('[data-testid="tile-progress"]');
    expect(bar?.textContent).toBe('11%subtasks open');
  });

  /* The chips are the COUNTS LINE since the quiet tile (task 01a1469f): same
     slot, same reason for the order — the count set varies row to row, so a
     bar drawn after it would start at a different x on every task and the
     column could not be scanned. `messages: 3` is deliberately still on the
     row and deliberately draws nothing: the message tallies are cut. */
  it('the bar leads the counts line, so it starts at the same x on every task', async () => {
    const { EntityListPanel } = await import('../panels/index');
    const { FIXTURE_SPACE_ID } = await import('../fixtures');
    const base = task({ percent: 40, earned: 2, total: 5 });
    const row = { ...base, id: 'lead', title: 'Leads', counters: { ...base.counters, messages: 3, docs: 2 } };
    const kid = { ...base, id: 'lead-kid', title: 'Subtask', parentId: 'lead' };
    const { container } = render(
      <EntityListPanel kind="task" rowsFor={() => [row, kid]} ctx={{ spaceId: FIXTURE_SPACE_ID }} />,
    );
    const bar = container.querySelector('[data-testid="tile-progress"]');
    const counts = container.querySelector('[data-testid="tile-link-counts"]');
    expect(bar).not.toBeNull();
    expect(counts).not.toBeNull();
    expect(counts!.querySelector('[data-count-kind="docs"]')?.textContent).toContain('2');
    expect(counts!.textContent).not.toContain('3');
    expect(bar!.compareDocumentPosition(counts!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
