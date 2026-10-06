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

describe('the task list draws it (control card)', () => {
  it('E2 (D3): the bar, 11% and the marker on the row', async () => {
    const { EntityListPanel } = await import('../panels/index');
    const { FIXTURE_SPACE_ID } = await import('../fixtures');
    const row = { ...task({ percent: 11, earned: 1, total: 9, own: 1, openSubtasks: 1 }, { done: true }), id: 'd3', title: 'D3 root' };
    const { container } = render(<EntityListPanel kind="task" rowsFor={() => [row]} ctx={{ spaceId: FIXTURE_SPACE_ID }} />);
    const bar = container.querySelector('[data-testid="tile-progress"]');
    expect(bar?.textContent).toBe('11%subtasks open');
  });
});
