import type { EntitySummary } from '@tm8/contract';

import type { TileProgress } from './types';

/**
 * 307: what a task or story row shows of its points-weighted progress (spec
 * doc 01a111ba; owner answers on form 01a111b7). The numbers are the server's
 * (`internal.task_progress` / `story_summary.weighted`) — nothing is computed
 * here but the words.
 *
 * - Task row: the bar, `N%` and its OWN criteria ticked/total. A done task
 *   whose subtree is not (D3) keeps its done status and adds `subtasks open`.
 * - Story row: the bar, `N%` and done/total weighted points.
 * - No countable work draws nothing.
 */
export function taskTileProgress(row: EntitySummary): TileProgress | null {
  if (row.state.kind !== 'task') return null;
  const p = row.state.progress;
  if (!p || p.percent === null) return null;
  const { completed, total } = row.state.acceptance;
  const subtasksOpen = row.category === 'done' && p.openSubtasks > 0;
  const parts = [`${p.percent}% of ${points(p.total)} weighted`];
  if (total > 0) parts.push(`${completed}/${total} own criteria`);
  if (p.openSubtasks > 0) parts.push(`${p.openSubtasks} ${p.openSubtasks === 1 ? 'subtask' : 'subtasks'} open`);
  if (p.tent) parts.push('no estimate (weight 1)');
  return {
    done: p.earned,
    work: p.total,
    percent: p.percent,
    ...(total > 0 ? { detail: `${completed}/${total}` } : {}),
    ...(subtasksOpen ? { marker: 'subtasks open' } : {}),
    label: parts.join(' · '),
  };
}

export function storyTileProgress(row: EntitySummary): TileProgress | null {
  if (row.state.kind !== 'story') return null;
  const w = row.state.weighted;
  if (!w) {
    // An older summary without `weighted`: the task counts, as before 307.
    const t = row.state.taskProgress;
    return { done: t.done, work: t.work, inProgress: t.inProgress, blocked: t.blocked, noun: 'tasks' };
  }
  if (w.percent === null) return null;
  const detail = `${Math.floor(w.earned)}/${points(w.total)} pts`;
  return {
    done: w.earned,
    work: w.total,
    percent: w.percent,
    detail,
    label: `${w.percent}% · ${detail} · ${w.tasks - w.open} of ${w.tasks} tasks done`,
  };
}

function points(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
